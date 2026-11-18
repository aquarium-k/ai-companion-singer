#!/usr/bin/env python3
"""把循环采样的**慢速幅度起伏**展平（循环级「呼吸/晃动」）。

问题（2026-11-17 夜）：用户指出 G#4 和 C#5 上「不稳」。实测抓音包络的 1–6 Hz 抖动：
415 Hz 5.66 dB、466 Hz 4.36、554 Hz 3.91，而 392/523/587 只有 2.2–2.8。
415 Hz 只有**一档**采样在响（419 Hz），所以不是家族混合、也不是双声部（`?dbl=0` 时还是 5.5 dB）。

真因是采样自带的慢速幅度起伏，而且被 **×3 拉长**放到了 1.17 Hz——正好落在「听得见」的低频区。
（拉长前它大约在 3.5 Hz，混在颤音里不明显；拉慢之后变成慢呼吸。）

做法：算逐 5 ms 的 RMS 包络 → 用 200 ms 的圆窗（环绕，保证循环接缝连续）平滑成「慢趋势」
→ 除以趋势把慢起伏压掉（增益限幅 ±60%，避免把安静段抬噪）→ 再按原 RMS 归一。
只动 3 Hz 以下的慢变化，逐周期的细节和音色都不动。

    python tools/flatten_loops.py --dry
    python tools/flatten_loops.py
"""
from __future__ import annotations

import argparse
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
VOICES = ROOT / "public/voices"
BACKUP = ROOT / ".tmp/voices-preflat"

HOP_MS = 5
SMOOTH_MS = 200
GAIN_MIN, GAIN_MAX = 0.55, 1.85


def am_peak(y: np.ndarray, sr: int, lo: float = 1.0, hi: float = 6.0) -> float:
    """1–6 Hz 包络起伏峰峰值（dB）——「晃」的直接量。"""
    m = int(0.004 * sr)
    fr = y[: (len(y) // m) * m].astype(np.float64).reshape(-1, m)
    env = np.sqrt((fr**2).mean(axis=1)) + 1e-9
    db = 20 * np.log10(env)
    db = db - db.mean()
    spec = np.abs(np.fft.rfft(db * np.hanning(len(db))))
    f = np.fft.rfftfreq(len(db), 0.004)
    band = (f >= lo) & (f <= hi)
    if not band.any():
        return 0.0
    amp = spec[band] / (len(db) / 4)
    return float(2 * np.sqrt(2) * np.sqrt((amp**2).sum()))


def flatten(y: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    hop = int(HOP_MS / 1000 * sr)
    n = len(y)
    nh = int(np.ceil(n / hop))
    pad = nh * hop - n
    yy = np.concatenate([y, np.zeros(pad, dtype=y.dtype)]) if pad else y
    frames = yy.astype(np.float64).reshape(nh, hop)
    env = np.sqrt((frames**2).mean(axis=1)) + 1e-6

    # 圆滑（环绕）→ 慢趋势
    k = max(3, int(SMOOTH_MS / HOP_MS) | 1)
    win = np.hanning(k)
    win /= win.sum()
    idx = (np.arange(nh)[:, None] + np.arange(-(k // 2), k // 2 + 1)[None, :]) % nh
    trend = (env[idx] * win).sum(axis=1)

    target = float(np.median(trend))
    gain = np.clip(target / np.maximum(trend, 1e-9), GAIN_MIN, GAIN_MAX)
    # 增益曲线回到逐样本（线性插值），并保证首尾一致（循环）
    gx = np.arange(nh) * hop
    g = np.interp(np.arange(n), np.concatenate([gx, [nh * hop]]), np.concatenate([gain, [gain[0]]]))
    out = y.astype(np.float64) * g

    rms_in = float(np.sqrt(np.mean(y.astype(np.float64) ** 2))) or 1.0
    rms_out = float(np.sqrt(np.mean(out**2))) or 1.0
    out *= rms_in / rms_out
    peak = float(np.abs(out).max())
    if peak > 0.98:
        out *= 0.98 / peak
    return out.astype(np.float32), float(np.max(np.abs(np.log(gain))))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--only", default="")
    args = ap.parse_args()

    files = sorted(VOICES.glob("loop_[0-9]*.wav"))
    if args.only:
        want = [float(v) for v in args.only.split(",") if v.strip()]
        import json

        keep = []
        for f in files:
            root = float(json.loads(f.with_suffix(".json").read_text(encoding="utf-8"))["rootHz"])
            if any(abs(1200 * np.log2(root / w)) < 60 for w in want):
                keep.append(f)
        files = keep

    print(f"{'文件':16s}{'Hz':>7s}{'AM前':>7s}{'AM后':>7s}{'增益范围':>9s}")
    todo = []
    for f in files:
        y, sr = sf.read(f, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        before = am_peak(y, sr)
        out, gspan = flatten(y, sr)
        after = am_peak(out, sr)
        import json

        root = float(json.loads(f.with_suffix(".json").read_text(encoding="utf-8"))["rootHz"])
        print(f"{f.name:16s}{root:7.1f}{before:7.2f}{after:7.2f}{gspan:9.2f}")
        todo.append((f, out))

    if args.dry:
        print("\n（干跑，没写文件）")
        return 0

    BACKUP.mkdir(parents=True, exist_ok=True)
    for f, out in todo:
        if not (BACKUP / f.name).exists():
            shutil.copy2(f, BACKUP / f.name)
        sf.write(f, out, sr, subtype="PCM_16")
    print(f"\n写了 {len(todo)} 档（备份在 {BACKUP}）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
