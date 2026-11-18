#!/usr/bin/env python3
"""重造「え」库：和「あ」同一套思路（SVC 直出），但源不一样。

「え」的现状比旧「あ」还差：24 档里只有 `loop_e_465` 是真唱（白花 190.49 s 那句，467 Hz），
其余 23 档都是从它链式 PSOLA 派生，实测相位相关 0.65–0.88（「あ」旧库是 0.90–0.99）。

难点：SVC 要一段不短于 1.5 s 的源，而真素材只有 0.32 s。做法是**先按周期拉长到 1.44 s**
（`stretch_loops.stretch`，只重复整周期、音高和共振峰都不动），再喂 SVC 换成她的音色。
拉长的 OLA 痕迹会被 SVC 重合成一遍，所以不像拉长后直接用那样有「重复感」。

    python tools/rebake_e.py --only 210,850 --out .tmp/rebake-e   # 试点
    python tools/rebake_e.py --all --out .tmp/rebake-e            # 全 24 档

**状态（2026-11-17）：先搁置。** 用户说「え 这边可以暂时不做」。试点的 210 档正常
（209.76 Hz，−1.6 音分），但 850 档量出来是 293 Hz——拉长后的源在 850 上只剩很短的
高音段，pyin 锁到了分谐波。要接着做得先解决「高音档的源」这件事（例如用 `loop_e_465`
之外的高音「え」，或者给 `tune_audio` 换上谐波梳）。别直接 --all 装库。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

from rebake_loops import (  # noqa: E402
    CUT_SEC,
    REF,
    SR,
    measure_f0,
    read_wav,
    steady_window,
    write_wav,
)
from stretch_loops import stretch  # noqa: E402

VOICES = ROOT / "public/voices"
SEED = VOICES / "loop_e_465.wav"
SEED_ROOT = 466.97
SRC_SEC = 1.44


def build_source() -> np.ndarray:
    """把 0.32 s 的「え」种子按整周期拉到 1.44 s，作为 SVC 的源。"""
    y = read_wav(SEED)
    y2, f0 = stretch(y, SR, SEED_ROOT, SRC_SEC / (len(y) / SR))
    print(f"源：{SEED.name} {len(y)/SR*1000:.0f}ms → {len(y2)/SR*1000:.0f}ms（f0 {f0:.2f} Hz）")
    return y2


def resample_by(y: np.ndarray, rate: float) -> np.ndarray:
    import librosa

    if abs(rate - 1.0) < 1e-5:
        return y
    return librosa.resample(y, orig_sr=SR, target_sr=int(round(SR / rate))).astype(np.float32)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=str(ROOT / ".tmp/rebake-e"))
    ap.add_argument("--steps", type=int, default=24)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--keep-raw", action="store_true")
    args = ap.parse_args()

    doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
    targets = sorted({float(l["rootHz"]) for l in doc["loops"] if l.get("vowel") == "e"})
    if args.only:
        want = [float(v) for v in args.only.split(",") if v.strip()]
        targets = [t for t in targets if any(abs(12 * np.log2(t / w)) < 0.2 for w in want)]
    if not targets:
        print("没有目标")
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    src = build_source()
    f0_src = measure_f0(src) or SEED_ROOT
    print(f"源实测 {f0_src:.2f} Hz；目标 {len(targets)} 档：{', '.join(f'{t:.0f}' for t in targets)}")

    from svc_engine import Engine

    t0 = time.time()
    engine = Engine(threads=args.threads, steps=args.steps)
    ref = read_wav(REF)
    print(f"模型 {time.time()-t0:.1f}s")

    from tune_loops import tune_audio

    for target in targets:
        part = resample_by(src, target / f0_src)
        t1 = time.time()
        conv = engine.convert(part, ref).astype(np.float32)
        a, b = steady_window(conv, CUT_SEC + 0.06, target)
        if args.keep_raw:
            raw = ROOT / ".tmp/svc-raw-e"
            raw.mkdir(parents=True, exist_ok=True)
            write_wav(raw / f"raw_e_{int(round(target))}.wav", conv)
        body, info = tune_audio(conv[a:b], SR, target)
        got = measure_f0(body) or 0.0
        name = f"loop_e_{int(round(target))}.wav"
        write_wav(out_dir / name, body)
        print(
            f"{name:18s} {target:7.1f}Hz → 实测 {got:7.2f}（{1200*np.log2(got/target) if got else float('nan'):+5.1f}） "
            f"{len(body)/SR*1000:5.0f}ms  {time.time()-t1:5.1f}s"
        )
    print(f"\n共 {len(targets)} 档，{time.time()-t0:.0f}s → {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
