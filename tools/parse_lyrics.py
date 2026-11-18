#!/usr/bin/env python3
"""把用户手上的歌词文件转成曲包要的 `lyrics.json`。

为什么需要这一步
----------------
自动对齐要的是「纯文本 + 每行一条」的结构，而用户手里可能是 `.lrc`（带时间戳）、
`.txt`（纯文本）、甚至是直接拷来的 `.json`。让流水线统一入口，后面每一步就不用
各自判断格式了。

三种输入
--------
- `.lrc`：解析 `[mm:ss.xx]` 时间戳，一行多个时间戳会展开成多条（副歌重复是这么写的）。
  有时间的行标 `src: "user"`，自动对齐会保留它们。
- `.txt`：一行一句，时间留空，后面靠 ASR 对齐。
- `.json`：已经是本项目的歌词结构就直接用。

用法
----
    python tools/parse_lyrics.py --input song.lrc --out public/songpacks/x/lyrics.json
    python tools/parse_lyrics.py --input song.txt --out ... --language ja
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# [01:23.45] / [1:23] / [00:12] 都认
LRC_TAG = re.compile(r"\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]")
# [ti:xxx] [ar:xxx] [offset:0] 这类元信息
META_TAG = re.compile(r"^\[[a-zA-Z#]+:.*\]$")


def parse_lrc(text: str) -> list[dict]:
    lines: list[dict] = []
    for raw in text.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        if META_TAG.match(raw):
            continue

        stamps = list(LRC_TAG.finditer(raw))
        if not stamps:
            # 没有时间戳的行（有些 lrc 会漏）当作纯文本行，交给 ASR
            body = raw.strip()
            if body:
                lines.append({"at": None, "text": body})
            continue

        body = LRC_TAG.sub("", raw).strip()
        if not body:
            continue

        for match in stamps:
            minute = int(match.group(1))
            second = int(match.group(2))
            frac = match.group(3) or "0"
            # 两位是厘秒，三位是毫秒
            if len(frac) == 1:
                millis = int(frac) * 100
            elif len(frac) == 2:
                millis = int(frac) * 10
            else:
                millis = int(frac[:3])
            at = minute * 60 + second + millis / 1000.0
            lines.append({"at": round(at, 3), "text": body, "src": "user"})

    lines.sort(key=lambda item: (item["at"] is None, item["at"] or 0.0))
    return lines


def parse_txt(text: str) -> list[dict]:
    lines: list[dict] = []
    for raw in text.splitlines():
        body = raw.strip().lstrip("\ufeff")
        if not body or META_TAG.match(body):
            continue
        lines.append({"at": None, "text": body})
    return lines


def read_text_any(path: Path) -> str:
    """中文歌的 txt/lrc 经常是 GBK，直接按 UTF-8 读会满屏乱码。"""
    for encoding in ("utf-8-sig", "gbk"):
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def main() -> int:
    ap = argparse.ArgumentParser(description="歌词文件 → lyrics.json")
    ap.add_argument("--input", required=True, help=".lrc / .txt / .json")
    ap.add_argument("--out", required=True)
    ap.add_argument("--language", default="ja")
    ap.add_argument(
        "--offset",
        type=float,
        default=0.0,
        help="整体平移所有时间戳（秒）。LRC 轴和音频对不齐时用，比如 -0.4",
    )
    ap.add_argument("--title", default="")
    args = ap.parse_args()

    src = Path(args.input)
    if not src.exists():
        print(f"找不到歌词文件：{src}", file=sys.stderr)
        return 1

    text = read_text_any(src)
    suffix = src.suffix.lower()

    if suffix == ".json":
        try:
            data = json.loads(text)
        except json.JSONDecodeError as err:
            print(f"JSON 解析失败：{err}", file=sys.stderr)
            return 1
        if isinstance(data, dict) and isinstance(data.get("lines"), list):
            # 已经是本项目的结构，原样落盘（保留 at / src / kana）
            lines = data["lines"]
            language = data.get("language") or args.language
        else:
            print("JSON 里没有 lines 数组，无法识别", file=sys.stderr)
            return 1
    elif suffix in (".lrc", ".lr2", ".txt"):
        lines = parse_lrc(text) if suffix != ".txt" else parse_txt(text)
        language = args.language
    else:
        # 后缀不认识就按内容猜：有 [mm:ss] 当 lrc，否则当纯文本
        lines = parse_lrc(text) if LRC_TAG.search(text) else parse_txt(text)
        language = args.language

    lines = [line for line in lines if (line.get("text") or "").strip()]
    if not lines:
        print("歌词里一行有效文本都没解析出来", file=sys.stderr)
        return 1

    if args.offset:
        for line in lines:
            if line.get("at") is None:
                continue
            line["at"] = round(max(0.0, line["at"] + args.offset), 3)
        lines.sort(key=lambda item: (item["at"] is None, item["at"] or 0.0))
        print(f"时间轴整体平移 {args.offset:+.2f}s")

    timed = sum(1 for line in lines if line.get("at") is not None)

    # 口型是按日文假名算 mora 的（kana.py）。整篇没有假名基本可以断定不是日文，
    # 汉字会被按日语音读硬转，口型能对上节奏但对不上元音，这里先提醒一句。
    sample = "".join(line.get("text") or "" for line in lines)
    kana = sum(1 for ch in sample if "\u3040" <= ch <= "\u30ff")
    if kana < max(1, len(sample) // 50):
        print(
            "[warn] 歌词里几乎没有假名，可能不是日文：口型仍按日文假名规则生成，元音会对不上",
            file=sys.stderr,
        )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        json.dumps({"schema": 1, "language": language, "lines": lines}, ensure_ascii=False, indent=2)
        + "\n",
        encoding="utf-8",
    )

    print(f"解析 {len(lines)} 行（{timed} 行带时间戳）→ {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
