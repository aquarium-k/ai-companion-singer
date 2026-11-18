#!/usr/bin/env python3
"""整首翻唱烘焙：分块转换 + 断点续跑 + 交叉淡化拼接。

为什么不在一次调用里转完整首：230s 的歌在 8 线程 CPU 上要 ~85 分钟，
中途任何失败都得从头再来；分成 60s 一段就变成「每段 ~20 分钟、可续跑」。

用法：
    py tools/bake_cover.py --source <vocals.mp3|wav> --ref <参考.wav> --out <成品.wav>
    # 只跑前两段： --segments 0,1
    # 全部跑完后只做拼接： --join-only

中间产物在 `--work`（默认 shots/cover/），每段一个 part_XX.wav。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

import numpy as np  # noqa: E402

import extract_f0  # noqa: E402

SR = 44100


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as handle:
        assert handle.getframerate() == SR
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.abs(x).max()) or 1.0
    y = x if peak <= 0.999 else x * (0.999 / peak)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def plan(total: int, seg: int, overlap: int) -> list[tuple[int, int, int]]:
    """返回 [(index, start, end)]，end 含 overlap。"""
    parts = []
    start = 0
    i = 0
    while start < total:
        end = min(total, start + seg + overlap)
        parts.append((i, start, end))
        i += 1
        start += seg
    return parts


def join(parts: list[np.ndarray], overlap: int) -> np.ndarray:
    if not parts:
        return np.zeros(0, dtype=np.float32)
    out = parts[0].copy()
    fade = min(overlap, len(out))
    ramp = np.linspace(0.0, np.pi / 2, fade)
    for nxt in parts[1:]:
        f = min(fade, len(nxt))
        if f < 2:
            out = np.concatenate([out, nxt])
            continue
        tail = out[-f:]
        head = nxt[:f]
        blended = tail * np.cos(ramp[:f]) ** 2 + head * np.sin(ramp[:f]) ** 2
        out = np.concatenate([out[:-f], blended, nxt[f:]])
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="整首翻唱烘焙（分块 + 续跑）")
    ap.add_argument("--source", required=True, help="源人声（原唱分离出来的 vocals）")
    ap.add_argument("--ref", required=True, help="音色参考（干净人声）")
    ap.add_argument("--out", required=True)
    ap.add_argument("--work", default="shots/cover")
    ap.add_argument("--seg", type=float, default=60.0, help="每段长度（秒）")
    ap.add_argument("--overlap", type=float, default=4.0, help="段间重叠（秒）")
    ap.add_argument("--steps", type=int, default=25)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--cfg-rate", type=float, default=1.2)
    ap.add_argument("--segments", default="", help="只跑指定段，如 0,1")
    ap.add_argument("--join-only", action="store_true")
    args = ap.parse_args()

    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    seg = int(args.seg * SR)
    overlap = int(args.overlap * SR)

    src = extract_f0.decode_mono(args.source, SR).astype(np.float32)
    parts_plan = plan(len(src), seg, overlap)
    print(f"源 {len(src)/SR:.1f}s → {len(parts_plan)} 段（每段 {args.seg:.0f}s + 重叠 {args.overlap:.0f}s）")

    only = None
    if args.segments:
        only = {int(v) for v in args.segments.split(",") if v.strip()}

    engine = None
    todo = [p for p in parts_plan if not (work / f"part_{p[0]:02d}.wav").exists()]
    if only is not None:
        todo = [p for p in todo if p[0] in only]
    if todo and not args.join_only:
        from svc_engine import Engine

        print(f"需要转换 {len(todo)} 段：{[p[0] for p in todo]}")
        t0 = time.time()
        engine = Engine(threads=args.threads, steps=args.steps, cfg_rate=args.cfg_rate)
        print(f"模型加载 {time.time()-t0:.1f}s")
        ref_audio = extract_f0.decode_mono(args.ref, SR).astype(np.float32)
        for idx, a, b in todo:
            t1 = time.time()
            part = src[a:b]
            out = engine.convert(part, ref_audio)
            write_wav(work / f"part_{idx:02d}.wav", out)
            el = time.time() - t1
            print(
                f"[{idx:02d}] {a/SR:.0f}-{b/SR:.0f}s  {len(out)/SR:.1f}s  "
                f"{el:.0f}s  RTF={el/(len(out)/SR):.1f}x",
                flush=True,
            )

    missing = [p[0] for p in parts_plan if not (work / f"part_{p[0]:02d}.wav").exists()]
    if missing:
        print(f"还有 {len(missing)} 段没转：{missing}（先别拼接）")
        return 0

    if args.join_only or True:
        joined = join([read_wav(work / f"part_{p[0]:02d}.wav") for p in parts_plan], overlap)
        write_wav(Path(args.out), joined)
        print(f"拼接完成 {len(joined)/SR:.1f}s -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
