#!/usr/bin/env python3
"""对比两份歌词：文本覆盖率 + 时间误差。

主要用途：有标准歌词的歌，用它来量化「无歌词路径」到底有多准。

为什么按字符算而不是按行
------------------------
自动生成的断行和人工歌词几乎不可能一致（Whisper 按停顿切，人工按乐句切），
逐行配对会把「分句不同」误判成「文本错误」。
按字符算只关心两件事：**文字对不对得上**、**对上时时间差多少**。

时间按行内线性插值：同一行里第 k 个字符的时间 ≈ 行首 + (k/行长)×行时长。
"""

from __future__ import annotations

import argparse
import difflib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
from auto_align import normalize  # noqa: E402


def load(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [line for line in data.get("lines", []) if line.get("text") and line.get("at") is not None]


def make_normalizer(kana: bool):
    """返回把文本变成参与比对的字符串的函数。

    `--kana` 模式先转平假名再比对：只比读音，不比汉字。
    这正好对应「ASR 选错汉字但读音接近」的情况。
    """
    if not kana:
        return normalize

    from kana import normalize_kana, to_hiragana

    return lambda text: normalize_kana(to_hiragana(text))


def char_times(lines: list[dict], normalizer) -> tuple[str, list[float], list[int]]:
    """把整份歌词展开成字符序列，同时给出每个字符的估算时间和所属行号。"""
    text: list[str] = []
    times: list[float] = []
    owner: list[int] = []

    for index, line in enumerate(lines):
        body = normalizer(line["text"])
        if not body:
            continue
        start = float(line["at"])
        end = float(lines[index + 1]["at"]) if index + 1 < len(lines) else start + 3.0
        span = max(0.2, end - start)
        for k, ch in enumerate(body):
            text.append(ch)
            times.append(start + span * (k / len(body)))
            owner.append(index)

    return "".join(text), times, owner


def median(values: list[float]) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    mid = len(ordered) // 2
    return ordered[mid] if len(ordered) % 2 else (ordered[mid - 1] + ordered[mid]) / 2


def main() -> int:
    ap = argparse.ArgumentParser(description="对比两份歌词")
    ap.add_argument("--ref", required=True, help="标准/人工歌词")
    ap.add_argument("--gen", required=True, help="自动生成的歌词")
    ap.add_argument("--detail", action="store_true", help="打印最差的行")
    ap.add_argument("--kana", action="store_true", help="只比读音（转平假名后比对）")
    args = ap.parse_args()

    normalizer = make_normalizer(args.kana)
    ref_lines = load(Path(args.ref))
    gen_lines = load(Path(args.gen))
    if not ref_lines or not gen_lines:
        print("有一边是空的（或没有时间戳）", file=sys.stderr)
        return 1

    ref_text, ref_times, ref_owner = char_times(ref_lines, normalizer)
    gen_text, gen_times, _gen_owner = char_times(gen_lines, normalizer)

    matcher = difflib.SequenceMatcher(None, ref_text, gen_text, autojunk=False)
    matched_chars = 0
    deltas: list[float] = []
    per_line: dict[int, list[float]] = {}

    for i1, j1, size in matcher.get_matching_blocks():
        for offset in range(size):
            ri = i1 + offset
            matched_chars += 1
            delta = abs(gen_times[j1 + offset] - ref_times[ri])
            deltas.append(delta)
            per_line.setdefault(ref_owner[ri], []).append(delta)

    if not deltas:
        print("没有任何字符对上", file=sys.stderr)
        return 1

    coverage = matched_chars / len(ref_text) if ref_text else 0.0

    def within(threshold: float) -> float:
        return sum(1 for d in deltas if d <= threshold) / len(deltas) * 100

    print(f"标准 {len(ref_lines)} 行 / {len(ref_text)} 字，生成 {len(gen_lines)} 行 / {len(gen_text)} 字")
    print(f"文字覆盖    {coverage * 100:.1f}%（生成文本对上标准文本的比例）")
    print(f"时间误差    中位数 {median(deltas):.2f}s")
    print(f"            ≤0.5s {within(0.5):.0f}%   ≤1s {within(1.0):.0f}%   ≤2s {within(2.0):.0f}%")

    if args.detail:
        rows = []
        for index, ds in per_line.items():
            rows.append((median(ds), index, ref_lines[index]["at"], ref_lines[index]["text"]))
        rows.sort(reverse=True)
        print("\n误差最大的 15 行：")
        print(" 行   标准时间   中位误差   文本")
        for med, index, at, text in rows[:15]:
            print(f"{index + 1:>3}  {at:>8.2f}  {med:>8.2f}   {text[:40]}")

        never = [i for i in range(len(ref_lines)) if i not in per_line]
        if never:
            print(f"\n完全没对上的行 {len(never)} 行：")
            for index in never:
                print(f"{index + 1:>3}  {ref_lines[index]['at']:>8.2f}  {ref_lines[index]['text'][:40]}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
