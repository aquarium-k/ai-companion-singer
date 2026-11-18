#!/usr/bin/env python3
"""统计 actions.json 里「基础层动作」覆盖了多少时长。

基础层 = dance.bounce / dance.spin 这类驱动全身的动作。剩下的时间只有 idle，
也就是「身体不动的空档」。P1 的验收就是把这个空档压下去。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

BASE = {"dance.bounce", "dance.spin"}
KNOWN_DURATION = {"dance.spin": 1.3, "dance.wave": 1.6, "pose.peace": 2.2,
                  "gesture.nod": 0.9, "gesture.shake": 0.9}


def measure(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    duration = float(data.get("duration") or 0)
    cues = sorted(data.get("cues") or [], key=lambda c: c["at"])

    spans: list[tuple[float, float]] = []
    open_clip: str | None = None
    open_at = 0.0

    def close(at: float) -> None:
        nonlocal open_clip
        if open_clip is None:
            return
        end = max(at, open_at)
        if end - open_at > 0.05:
            spans.append((open_at, end))
        open_clip = None

    for cue in cues:
        clip = cue.get("clip")
        at = float(cue["at"])
        if cue.get("action") == "stop":
            if clip == open_clip:
                close(at)
            continue
        if clip in BASE:
            close(at)
            open_clip = clip
            open_at = at
            if clip in KNOWN_DURATION:
                close(at + KNOWN_DURATION[clip])

    close(duration)

    # 合并区间
    merged: list[tuple[float, float]] = []
    for start, end in sorted(spans):
        if merged and start <= merged[-1][1] + 0.05:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))

    covered = sum(e - s for s, e in merged)
    longest_gap = 0.0
    prev = 0.0
    for s, e in merged:
        longest_gap = max(longest_gap, s - prev)
        prev = e
    longest_gap = max(longest_gap, duration - prev)

    counts: dict[str, int] = {}
    for cue in cues:
        counts[cue.get("clip", "?")] = counts.get(cue.get("clip", "?"), 0) + 1

    return {
        "duration": duration,
        "cues": len(cues),
        "base_spans": len(merged),
        "covered": covered,
        "ratio": covered / duration if duration else 0.0,
        "longest_gap": longest_gap,
        "counts": counts,
    }


def main() -> int:
    for arg in sys.argv[1:]:
        path = Path(arg)
        m = measure(path)
        top = sorted(m["counts"].items(), key=lambda kv: -kv[1])
        summary = "  ".join(f"{k}×{v}" for k, v in top)
        print(
            f"{path.parent.name[:34]:36s} {m['duration']:6.1f}s  cue={m['cues']:3d}  "
            f"基础层 {m['ratio'] * 100:5.1f}%（{m['base_spans']} 段，最长空档 {m['longest_gap']:4.1f}s）"
        )
        print(f"{'':36s} {summary}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
