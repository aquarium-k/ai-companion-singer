#!/usr/bin/env python3
"""把已知歌词强制对齐到音频，生成带时间戳的 lyrics.json。

为什么不用 Whisper 直接「识别」歌词
------------------------------------
识别解决的是「音频 → 文字」，而你已经拿到文字了，缺的是「文字 → 时间」。
用 ASR 转写再用转写结果对齐，会引入两个额外误差：识别错误、以及
「转写文本和你手上歌词不一致」时的匹配失败。

强制对齐（forced alignment）直接把已知文本贴到音频上，不受识别错误影响。

安装
----
    pip install -U stable-ts

首次运行会下载 Whisper 模型。`medium` 约 1.5GB，CPU 也能跑但会慢。
日文建议 `medium` 或 `large-v3`；`small` 在音乐人声上经常对不准。

用法
----
    python tools/align_lyrics.py \\
        --audio public/songpacks/demo/stems/instrumental.mp3 \\
        --lyrics public/songpacks/demo/lyrics.json \\
        --language ja \\
        --model medium

默认会先备份原文件为 `lyrics.json.bak`，再原地写回。
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

# 日文/中文歌词里夹杂大量空格和标点，匹配时全部去掉再比
_IGNORED = set(" \t\r\n\u3000")


def normalize(text: str) -> str:
    return "".join(ch for ch in text if ch not in _IGNORED)


def interpolate(lines: list[dict]) -> int:
    """对没匹配上的行，用相邻已知行按行数线性插值。返回填充数量。"""
    known = [(i, line["at"]) for i, line in enumerate(lines) if line.get("at") is not None]
    if not known:
        return 0

    filled = 0
    for i, line in enumerate(lines):
        if line.get("at") is not None:
            continue

        prev = next(((k, t) for k, t in reversed(known) if k < i), None)
        nxt = next(((k, t) for k, t in known if k > i), None)

        if prev and nxt:
            span = nxt[0] - prev[0]
            step = (nxt[1] - prev[1]) / span if span else 0.0
            line["at"] = round(prev[1] + step * (i - prev[0]), 2)
        elif prev:
            line["at"] = round(prev[1] + 3.0 * (i - prev[0]), 2)
        elif nxt:
            line["at"] = round(max(0.0, nxt[1] - 3.0 * (nxt[0] - i)), 2)
        else:
            continue
        filled += 1

    return filled


def main() -> int:
    ap = argparse.ArgumentParser(description="已知歌词 → 音频的强制对齐")
    ap.add_argument("--audio", required=True, help="音频文件（建议用分离后的人声）")
    ap.add_argument("--lyrics", required=True, help="现有的 lyrics.json")
    ap.add_argument("--out", help="输出路径，默认原地覆盖（带 .bak 备份）")
    ap.add_argument("--model", default="medium", help="Whisper 模型名，默认 medium")
    ap.add_argument("--language", default="ja", help="语言码，默认 ja")
    args = ap.parse_args()

    try:
        import stable_whisper
    except ImportError:
        print("缺少依赖，请先执行：pip install -U stable-ts", file=sys.stderr)
        return 1

    lyrics_path = Path(args.lyrics)
    if not lyrics_path.exists():
        print(f"找不到歌词文件：{lyrics_path}", file=sys.stderr)
        return 1

    data = json.loads(lyrics_path.read_text(encoding="utf-8"))
    lines = data.get("lines", [])
    if not lines:
        print("歌词文件里没有 lines", file=sys.stderr)
        return 1

    print(f"载入 {len(lines)} 行歌词")
    print(f"加载模型 {args.model}（首次运行会下载）…")
    model = stable_whisper.load_model(args.model)

    full_text = "\n".join(line["text"] for line in lines)
    print("对齐中…")
    try:
        result = model.align(args.audio, full_text, language=args.language)
    except Exception as err:  # noqa: BLE001 - 对齐失败的原因五花八门，原样抛给用户
        print(f"对齐失败：{err}", file=sys.stderr)
        print("常见原因：音频里人声太小、歌词与音频不是同一首、模型太小", file=sys.stderr)
        return 2

    words: list[tuple[str, float]] = []
    for segment in result.segments:
        for word in segment.words or []:
            if word.word and word.start is not None:
                words.append((word.word, float(word.start)))

    if not words:
        print("对齐结果为空：音频里可能没有人声", file=sys.stderr)
        return 2

    # 把词序列拼成去空白的字符串，并记录每个字符属于第几个词
    joined: list[str] = []
    owner: list[int] = []
    for index, (word, _start) in enumerate(words):
        for ch in normalize(word):
            joined.append(ch)
            owner.append(index)
    joined_text = "".join(joined)

    cursor = 0
    matched = 0
    for line in lines:
        target = normalize(line["text"])
        if not target:
            line["at"] = None
            continue

        pos = joined_text.find(target, cursor)
        if pos < 0:
            # 漏唱、重复、或转写切分不同：留空交给插值
            line["at"] = None
            continue

        word_index = owner[min(pos, len(owner) - 1)]
        line["at"] = round(words[word_index][1], 2)
        cursor = pos + len(target)
        matched += 1

    print(f"精确匹配 {matched}/{len(lines)} 行")
    filled = interpolate(lines)
    if filled:
        print(f"插值补齐 {filled} 行")

    ordered = all(
        (lines[i].get("at") or 0) <= (lines[i + 1].get("at") or 0)
        for i in range(len(lines) - 1)
    )
    if not ordered:
        print("警告：存在时间倒序的行，建议用编辑器手工检查", file=sys.stderr)

    out_path = Path(args.out) if args.out else lyrics_path
    if out_path == lyrics_path:
        backup = lyrics_path.with_suffix(lyrics_path.suffix + ".bak")
        shutil.copy2(lyrics_path, backup)
        print(f"已备份到 {backup}")

    out_path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
