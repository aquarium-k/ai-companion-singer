#!/usr/bin/env python3
"""双轨合并：混音和人声各跑一遍对齐，逐行选匹配质量更高的那个。

动机
----
实测两条音轨**失败的地方不一样**：

- 混音在 12–36s、168–192s 更好（分离人声在那些段被重复锁定吞掉）
- 分离人声在 84–96s、156–168s 更好（混音那边 ASR 几乎没输出）

单纯换轨是零和的，但两边都有「这一行我听见了」的证据。
所以按行取质量高者，理论上能同时拿到两边的好处。

用法：
    python tools/merge_tracks.py \
        --lyrics public/songpacks/demo/lyrics.json \
        --track mix=.tmp/asr.refined.json \
        --track vocals=.tmp/words_v.json \
        --out lyrics.merged.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_align as A  # noqa: E402


def load_words(path: str) -> list[tuple[str, float, float]]:
    return [tuple(w) for w in json.loads(Path(path).read_text(encoding="utf-8"))["words"]]


def track_anchors(
    lines: list[dict], words: list[tuple[str, float, float]]
) -> tuple[list[dict], float]:
    """给每行算出 (时间, 匹配质量)。质量 = 真正匹配上的字所占比例。"""
    conv = A.kana_conv
    lyric_text = ""
    spans: list[tuple[int, int]] = []
    for line in lines:
        body = conv(line["text"])
        spans.append((len(lyric_text), len(lyric_text) + len(body)))
        lyric_text += body

    usable = [w for w in words if w[2] - w[1] >= A.MIN_WORD_DURATION]
    asr_text, owner = A.build_char_map(usable, conv)
    if not asr_text:
        return [{"at": None, "q": 0.0} for _ in lines], 0.0

    mapping, matched = A.map_lyric_to_asr(lyric_text, asr_text)

    out = []
    total_q = 0.0
    for start, end in spans:
        if start >= end:
            out.append({"at": None, "q": 0.0})
            continue
        quality = sum(1 for i in range(start, end) if matched[i]) / (end - start)
        asr_pos = mapping[start]
        when = usable[owner[asr_pos]][1] if 0 <= asr_pos < len(owner) else None
        out.append({"at": when, "q": quality})
        total_q += quality
    return out, total_q / max(1, len(out))


def main() -> int:
    ap = argparse.ArgumentParser(description="双轨逐行合并")
    ap.add_argument("--lyrics", required=True)
    ap.add_argument("--track", action="append", required=True, help="名字=词缓存路径，可重复")
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-quality", type=float, default=0.08, help="低于此质量不接受该轨的锚点")
    ap.add_argument("--prefer", help="优先采用的轨（默认第一条 --track）")
    ap.add_argument(
        "--fallback-quality",
        type=float,
        default=0.20,
        help="优先轨在这一行的匹配质量低于此值时才换用其他轨",
    )
    ap.add_argument("--explain", action="store_true", help="打印两轨分歧较大的行")
    ap.add_argument("--keep-user", help="已有的输出文件；里面 src=user 的行保持不动")
    args = ap.parse_args()

    data = json.loads(Path(args.lyrics).read_text(encoding="utf-8"))
    lines = data.get("lines", [])
    if not lines:
        print("歌词里没有 lines", file=sys.stderr)
        return 1

    names: list[str] = []
    per_track: list[list[dict]] = []
    for spec in args.track:
        name, _, path = spec.partition("=")
        anchors, mean_q = track_anchors(lines, load_words(path))
        names.append(name)
        per_track.append(anchors)
        anchored = sum(1 for a in anchors if a["at"] is not None)
        print(f"{name:>10}: 可锚定 {anchored}/{len(lines)} 行，平均匹配质量 {mean_q:.2f}")

    prefer_index = 0
    if args.prefer:
        prefer_index = names.index(args.prefer)

    if args.explain and len(per_track) >= 2:
        print("\n两轨分歧 >1s 的行：")
        print(" 行   混音/质量      人声/质量     差")
        for index in range(len(lines)):
            a, b = per_track[0][index], per_track[1][index]
            if a["at"] is None or b["at"] is None:
                continue
            if abs(a["at"] - b["at"]) <= 1.0:
                continue
            print(
                f"{index + 1:>3}  {a['at']:>7.2f}/{a['q']:.2f}   "
                f"{b['at']:>7.2f}/{b['q']:.2f}   {b['at'] - a['at']:+.2f}"
            )

    picks = {name: 0 for name in names}
    merged = []
    for index, line in enumerate(lines):
        # 优先轨质量够就用它；不够才看别的轨
        primary = per_track[prefer_index][index]
        choice = None
        if primary["at"] is not None and primary["q"] >= args.fallback_quality:
            choice = (primary["at"], names[prefer_index])
        else:
            for track_index, name in enumerate(names):
                anchor = per_track[track_index][index]
                if anchor["at"] is None or anchor["q"] < args.min_quality:
                    continue
                if choice is None or anchor["q"] > per_track[track_index][index]["q"]:
                    choice = (anchor["at"], name)
            if choice is None and primary["at"] is not None and primary["q"] >= args.min_quality:
                choice = (primary["at"], names[prefer_index])

        if choice is None:
            merged.append({"at": None, "src": None})
        else:
            picks[choice[1]] += 1
            merged.append({"at": choice[0], "src": choice[1]})

    # 合并会把两条轨的时间拼在一起，可能出现倒序。
    # 倒序行直接作废成插值——它一定是其中一条轨错了，不如让邻行插值。
    for index in range(1, len(merged)):
        if (
            merged[index]["at"] is not None
            and merged[index - 1]["at"] is not None
            and merged[index]["at"] < merged[index - 1]["at"]
        ):
            merged[index] = {"at": None, "src": None}

    for index, line in enumerate(lines):
        if merged[index]["at"] is None:
            line["at"] = None
            line.pop("src", None)
        else:
            line["at"] = round(merged[index]["at"], 2)
            line["src"] = merged[index]["src"]

    fixed = A.repair_unmapped(lines)
    for line in lines:
        # repair 补出来的统一标 interp，和单轨流程保持一致
        if line.get("src") is None and line.get("at") is not None:
            line["src"] = "interp"

    # 手工打点的行优先：合并结果不该覆盖人工校准过的行
    kept = 0
    if args.keep_user:
        previous = json.loads(Path(args.keep_user).read_text(encoding="utf-8")).get("lines", [])
        for old, new in zip(previous, lines):
            if old.get("src") == "user" and old.get("at") is not None:
                new["at"] = old["at"]
                new["src"] = "user"
                kept += 1
        if kept:
            print(f"保留手工打点的 {kept} 行")

    inversions = sum(
        1
        for i in range(1, len(lines))
        if lines[i]["at"] is not None
        and lines[i - 1]["at"] is not None
        and lines[i]["at"] < lines[i - 1]["at"]
    )

    out_path = Path(args.out)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"\n逐行来源: " + "  ".join(f"{k}={v}" for k, v in picks.items()) + f"  插值={fixed}")
    print(f"时间倒序: {inversions}")
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
