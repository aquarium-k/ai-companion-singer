#!/usr/bin/env python3
"""auto_align.py 的对齐逻辑自测（不需要 faster-whisper）。

用合成数据验证：已知歌词 + 有错漏的 ASR 词序列 → 每行起点是否落在正确时间。

用法: python tools/test_align_mapping.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from auto_align import build_char_map, map_lyric_to_asr, normalize  # noqa: E402


def synth_words(text: str, start: float, per_char: float):
    """把一串字符变成「每字一个词」的 ASR 输出。"""
    words = []
    t = start
    for ch in text:
        if ch in " \t\n":
            continue
        words.append((ch, t, t + per_char))
        t += per_char
    return words


def align(lines, words):
    """复刻 auto_align 里把行映射到词的核心逻辑。"""
    asr_text, owner = build_char_map(words)
    lyric_text = ""
    spans = []
    for line in lines:
        norm = normalize(line)
        spans.append((len(lyric_text), len(lyric_text) + len(norm)))
        lyric_text += norm

    mapping = map_lyric_to_asr(lyric_text, asr_text)

    result = []
    for start, _end in spans:
        if start >= len(mapping):
            result.append(None)
            continue
        pos = mapping[start]
        result.append(words[owner[pos]][1] if 0 <= pos < len(owner) else None)
    return result


def check(name, lines, words, expected, tolerance=0.35):
    got = align(lines, words)
    ok = True
    details = []
    for i, (g, e) in enumerate(zip(got, expected)):
        if g is None:
            ok = False
            details.append(f"  行{i + 1}: 无结果（期望 {e:.2f}）")
            continue
        diff = abs(g - e)
        mark = "ok" if diff <= tolerance else "FAIL"
        if mark == "FAIL":
            ok = False
        details.append(f"  行{i + 1}: {g:6.2f}  期望 {e:6.2f}  差 {g - e:+.2f}  {mark}")
    print(f"[{'PASS' if ok else 'FAIL'}] {name}")
    for line in details:
        print(line)
    print()
    return ok


def main() -> int:
    per = 0.1
    lines = ["あいうえお", "かきくけこ", "さしすせそ", "たちつてと"]
    expected = [i * len(lines[0]) * per for i in range(len(lines))]

    # 1. 完美识别
    perfect = synth_words("".join(lines), 0.0, per)
    ok1 = check("完美识别", lines, perfect, expected)

    # 2. ASR 漏了一个字
    dropped = synth_words("あいうえおかきくけさしすせそたちつてと", 0.0, per)
    ok2 = check("中间漏字", lines, dropped, [0.0, 0.5, 0.9, 1.4], tolerance=0.45)

    # 3. ASR 多识别了一个字
    extra = synth_words("あいうえおかきくけこさしすせそたたちつてと", 0.0, per)
    ok3 = check("多识别一个字", lines, extra, expected, tolerance=0.45)

    # 4. 前面有一段噪声（ASR 把前奏识别成了别的东西）
    noisy = synth_words("ららら" + "".join(lines), 0.0, per)
    ok4 = check("前奏噪声", lines, noisy, [0.3 + e for e in expected], tolerance=0.45)

    # 5. 标点和空格不影响匹配
    punctuated = [l + "、" for l in lines]
    ok5 = check("忽略标点", punctuated, perfect, expected)

    total = all([ok1, ok2, ok3, ok4, ok5])
    print("全部通过" if total else "有失败用例")
    return 0 if total else 1


if __name__ == "__main__":
    raise SystemExit(main())
