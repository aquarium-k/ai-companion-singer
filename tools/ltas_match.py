#!/usr/bin/env python3
"""长时谱（LTAS）匹配：把转换结果的频谱包络拉向参考人声。

## 为什么

音色差异在频谱上主要表现成**长时平均谱的倾斜**（高频多/少、低频厚/薄）。
diffusion 步数不够时，输出常常整体偏亮（我们实测：15 步 1215 Hz vs 参考 790 Hz）。

这个工具算「输出的 LTAS − 参考的 LTAS」，把它反相应用到输出的每一帧上，
等于给输出加一条平滑的 EQ 曲线。只改频谱包络、不改音高/节奏，
所以对可懂度影响很小。

注意：它也把参考的录音条件（麦克风/房间）一起搬过来了——这是刻意的，
目标是「听起来像那个音色」，不是「保持原录音」。

用法：
    py tools/ltas_match.py --input 转换后.wav --ref 参考.wav --out 匹配后.wav --limit-db 9
"""
from __future__ import annotations

import argparse
import os
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

import numpy as np  # noqa: E402

import extract_f0  # noqa: E402

SR = 44100
N_FFT = 2048
HOP = 512


def read(path: str) -> np.ndarray:
    return extract_f0.decode_mono(path, SR).astype(np.float64)


def write(path: str, x: np.ndarray) -> None:
    peak = float(np.abs(x).max()) or 1.0
    y = x * (0.98 / peak) if peak > 0.98 else x
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def stft(x: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    win = np.hanning(n_fft)
    count = 1 + max(0, (len(x) - n_fft) // hop)
    pad = np.concatenate([x, np.zeros(max(0, (count - 1) * hop + n_fft - len(x)))])
    idx = np.arange(n_fft)[None, :] + hop * np.arange(count)[:, None]
    return np.fft.rfft(pad[idx] * win, axis=1).T  # (freq, frames)


def istft(spec: np.ndarray, length: int, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    win = np.hanning(n_fft)
    frames = np.fft.irfft(spec.T, n=n_fft, axis=1) * win
    out = np.zeros((spec.shape[1] - 1) * hop + n_fft)
    wsum = np.zeros_like(out)
    for i, frame in enumerate(frames):
        out[i * hop : i * hop + n_fft] += frame
        wsum[i * hop : i * hop + n_fft] += win**2
    out /= np.maximum(wsum, 1e-6)
    return out[:length]


def ltas_db(spec: np.ndarray, floor_db: float = -60.0) -> np.ndarray:
    mag = np.abs(spec)
    energy = 20 * np.log10(mag.mean(axis=1) + 1e-9)
    return energy


def main() -> int:
    ap = argparse.ArgumentParser(description="LTAS 匹配")
    ap.add_argument("--input", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit-db", type=float, default=9.0, help="EQ 曲线限幅（±dB）")
    ap.add_argument("--smooth-bins", type=int, default=24, help="频率方向平滑的 bin 数")
    args = ap.parse_args()

    x = read(args.input)
    r = read(args.ref)

    sx = stft(x)
    sr = stft(r)

    lx = ltas_db(sx)
    lr = ltas_db(sr)
    freqs = np.fft.rfftfreq(N_FFT, 1 / SR)

    diff = lr - lx
    # 只处理 80Hz 以上
    valid = freqs >= 80.0
    diff[~valid] = 0.0

    # 去掉整体电平差，只保留「谱形」差异（按输出的能量加权平均）
    weight = np.abs(sx[valid]).mean(axis=1)
    offset = float((diff[valid] * weight).sum() / (weight.sum() + 1e-9))
    diff = diff - offset

    # 频率方向平滑
    k = max(1, args.smooth_bins)
    kernel = np.ones(k) / k
    smooth = np.convolve(diff, kernel, mode="same")
    smooth[~valid] = 0.0
    smooth = np.clip(smooth, -args.limit_db, args.limit_db)

    gain = 10 ** (smooth / 20.0)
    out = istft(sx * gain[:, None], len(x))

    # 保持输入响度
    rms_in = float(np.sqrt((x**2).mean())) or 1.0
    rms_out = float(np.sqrt((out**2).mean())) or 1.0
    out *= rms_in / rms_out
    write(args.out, out)

    bands = [(80, 300), (300, 1000), (1000, 3000), (3000, 6000), (6000, 12000)]
    msg = "  ".join(
        f"{lo}-{hi}Hz:{smooth[(freqs >= lo) & (freqs < hi)].mean():+.1f}dB" for lo, hi in bands
    )
    print(f"应用 EQ（限幅 ±{args.limit_db:g}dB）：{msg}")
    print(f"写入 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
