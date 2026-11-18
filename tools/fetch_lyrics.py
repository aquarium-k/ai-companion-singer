#!/usr/bin/env python3
"""从网易云音乐抓 LRC 歌词（B1 的歌词自动化）。

为什么走网易云
--------------
歌词本身不难找，难的是「怎么知道是哪首歌」。手工复制链接再整理格式的流程
（社区里流传的那套）能用，但要人工参与；这里把它自动化：先用搜索接口按
「标题 + 歌手」拿到候选，再用音频时长做交叉验证，最后下载歌词。

接口（都不需要登录，加浏览器 UA + Referer 即可）
------------------------------------------------
- 搜索：`/api/search/get/web?s=<query>&type=1&limit=N`
- 歌词：`/api/song/media?id=<songId>` → `.lyric` 字段就是 LRC 文本

注意：这两个接口是网易云网页版自己用的，随时可能变。变了就换回「手动下 LRC」
那条路，`parse_lyrics.py` 照样吃得下。

用法
----
    python tools/fetch_lyrics.py --query "白花 鈴木このみ" --list
    python tools/fetch_lyrics.py --query "白花 鈴木このみ" --auto --duration 230 --out a.lrc
    python tools/fetch_lyrics.py --song-id 2117484911 --out a.lrc
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from difflib import SequenceMatcher
from pathlib import Path

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
)
TIMESTAMP = re.compile(r"\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]")
# 伴奏/纯音乐版本要排除，它们的歌词是空的
INSTRUMENTAL = re.compile(r"instrumental|inst\b|off\s*vocal|カラオケ|伴奏|纯音乐", re.I)


def http_get(url: str, timeout: float = 15.0) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Referer": "https://music.163.com/",
            "Accept": "application/json, text/plain, */*",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def search(query: str, limit: int = 10) -> list[dict]:
    url = "https://music.163.com/api/search/get/web?" + urllib.parse.urlencode(
        {"s": query, "type": 1, "offset": 0, "total": "true", "limit": limit}
    )
    data = json.loads(http_get(url))
    songs = (data.get("result") or {}).get("songs") or []
    return [
        {
            "id": song.get("id"),
            "name": song.get("name") or "",
            "artists": "/".join(a.get("name") or "" for a in (song.get("artists") or [])),
            "album": (song.get("album") or {}).get("name") or "",
            "duration": round((song.get("duration") or 0) / 1000, 1),
        }
        for song in songs
    ]


def fetch(song_id: int) -> str:
    data = json.loads(http_get(f"https://music.163.com/api/song/media?id={song_id}"))
    if data.get("code") != 200:
        raise RuntimeError(f"接口返回 code={data.get('code')}（可能需要登录或已失效）")
    return data.get("lyric") or ""


def lyric_lines(lyric: str) -> int:
    return sum(1 for line in lyric.splitlines() if TIMESTAMP.search(line))


def _norm(text: str) -> str:
    return re.sub(r"[\s\W_]+", "", text.lower())


def score(candidate: dict, query: str, duration: float | None) -> float:
    """候选打分：名字像、歌手出现在查询里、时长接近，三条都是强信号。"""
    name = _norm(candidate["name"])
    artists = _norm(candidate["artists"])
    wanted = _norm(query)

    value = 0.0
    if name and name in wanted:
        value += 1.0
    else:
        value += SequenceMatcher(None, name, wanted).ratio() * 0.6
    if artists and artists in wanted:
        value += 0.8
    if INSTRUMENTAL.search(candidate["name"]):
        value -= 2.0
    if duration and candidate["duration"] > 0:
        diff = abs(candidate["duration"] - duration)
        # 30 秒以内越高越好，超过 90 秒基本可以认为不是同一首
        value += max(0.0, 1.0 - diff / 90.0) * 1.5
    return value


def pick(candidates: list[dict], query: str, duration: float | None) -> dict | None:
    scored = [(score(item, query, duration), item) for item in candidates]
    scored.sort(key=lambda pair: pair[0], reverse=True)
    if not scored or scored[0][0] <= 0:
        return None
    return scored[0][1]


def clean_lrc(lyric: str) -> str:
    """去掉只有时间戳没有文字的行，保留 [by:] 这类头信息（parse_lyrics 会跳过）。"""
    kept = []
    for line in lyric.splitlines():
        if TIMESTAMP.search(line) and not TIMESTAMP.sub("", line).strip():
            continue
        kept.append(line)
    return "\n".join(kept).strip() + "\n"


def main() -> int:
    # Windows 控制台默认 GBK，日文歌名/歌词直接 print 会 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="网易云 LRC 歌词抓取")
    ap.add_argument("--query", help="搜索关键词，如「白花 鈴木このみ」")
    ap.add_argument("--song-id", type=int, help="直接指定歌曲 id")
    ap.add_argument("--out", help="把 LRC 写到这里")
    ap.add_argument("--json-out", help="把结果写成 JSON 文件（给主进程读，避免走管道）")
    ap.add_argument("--list", action="store_true", help="只列出搜索结果（JSON）")
    ap.add_argument("--json", action="store_true", help="输出结果 JSON")
    ap.add_argument("--auto", action="store_true", help="自动挑最匹配的一条")
    ap.add_argument("--duration", type=float, help="音频时长（秒），用于交叉验证")
    ap.add_argument("--limit", type=int, default=10)
    args = ap.parse_args()

    try:
        if args.song_id:
            lyric = fetch(args.song_id)
            count = lyric_lines(lyric)
            if count == 0:
                print("这首歌没有可用歌词（纯音乐或未收录）", file=sys.stderr)
                return 2
            if args.out:
                Path(args.out).parent.mkdir(parents=True, exist_ok=True)
                Path(args.out).write_text(clean_lrc(lyric), encoding="utf-8")
                print(f"写入 {args.out}（{count} 行）")
            else:
                print(clean_lrc(lyric), end="")
            if args.json_out:
                Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
                Path(args.json_out).write_text(
                    json.dumps({"id": args.song_id, "lines": count}, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
            return 0

        if not args.query:
            ap.error("要么给 --query，要么给 --song-id")

        candidates = search(args.query, args.limit)
        if not candidates:
            print(f"搜不到：{args.query}", file=sys.stderr)
            return 2

        if args.list or not args.auto:
            if args.json_out:
                Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
                Path(args.json_out).write_text(
                    json.dumps(candidates, ensure_ascii=False, indent=2), encoding="utf-8"
                )
            print(json.dumps(candidates, ensure_ascii=False, indent=2))
            if not args.auto:
                return 0

        best = pick(candidates, args.query, args.duration)
        if not best:
            print("没有足够可信的候选", file=sys.stderr)
            return 2

        lyric = fetch(best["id"])
        count = lyric_lines(lyric)
        if count == 0:
            print(f"选中「{best['name']}」但没有歌词", file=sys.stderr)
            return 2

        if args.json:
            print(json.dumps({**best, "lines": count}, ensure_ascii=False))
        else:
            print(f"选中：{best['name']} - {best['artists']}（{best['duration']}s，{count} 行）")

        if args.json_out:
            Path(args.json_out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.json_out).write_text(
                json.dumps({**best, "lines": count}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

        if args.out:
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out).write_text(clean_lrc(lyric), encoding="utf-8")
            print(f"写入 {args.out}")
        return 0
    except Exception as err:  # noqa: BLE001
        print(f"抓取失败：{err}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
