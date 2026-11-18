#!/usr/bin/env python3
"""把源音频的「清音段」混回转换结果里（类似 RVC 的 protect）。

## 为什么

音色转换模型对**浊音**（元音）学得很好，但清音（辅音、气声、呼吸）经常被抹平——
那些段落在源里本来就没有基频，模型倾向于用元音去填。结果是字变糊、气口消失。

这个工具做的事很窄：只在**源是清音**的帧上，把原音频按比例混回去；
浊音段完全用转换结果。掩码做 20–30ms 平滑，避免接缝。

用法：
    py tools/protect_blend.py --source 原唱.wav --input 转换后.wav --out 混合.wav --amount 0.6
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


def read(path: str) -> np.ndarray:
    return extract_f0.decode_mono(path, SR).astype(np.float64)


def write(path: str, x: np.ndarray) -> None:
    x = np.clip(x, -1, 1)
    peak = float(np.abs(x).max()) or 1.0
    y = x * (0.98 / peak) if peak > 0.98 else x
    with wave.open(path, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes((y * 32767).astype("<i2").tobytes())


def voicing_mask(source: np.ndarray, hop: int = 256) -> np.ndarray:
    """返回逐采样点的「清音程度」：1=清音，0=浊音。"""
    sig = np.interp(
        np.arange(int(len(source) * 22050 / SR)) / 22050,
        np.arange(len(source)) / SR,
        source,
    ).astype(np.float32)
    f0, clarity, _ = extract_f0.yin(sig)
    voiced = ((f0 > 0) & (clarity > 0.5)).astype(np.float64)
    unvoiced = 1.0 - voiced

    # 帧 → 采样
    centres = np.arange(len(unvoiced)) * hop + hop / 2
    times = centres / 22050 * SR
    mask = np.interp(np.arange(len(source)), times, unvoiced, left=unvoiced[0], right=unvoiced[-1])

    # 平滑（约 25ms），避免硬边界
    k = int(0.025 * SR)
    if k > 1:
        kernel = np.ones(k) / k
        mask = np.convolve(mask, kernel, mode="same")
    return np.clip(mask, 0.0, 1.0)


def main() -> int:
    ap = argparse.ArgumentParser(description="把源的清音段混回转换结果")
    ap.add_argument("--source", required=True)
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--amount", type=float, default=0.6, help="清音段混回的比例 0–1")
    ap.add_argument("--smooth-ms", type=float, default=25.0)
    args = ap.parse_args()

    src = read(args.source)
    vc = read(args.input)
    n = min(len(src), len(vc))
    src, vc = src[:n], vc[:n]

    mask = voicing_mask(src) * args.amount
    mixed = vc * (1.0 - mask) + src * mask

    # 保持和转换结果同响度
    r_vc = float(np.sqrt((vc**2).mean())) or 1.0
    r_mix = float(np.sqrt((mixed**2).mean())) or 1.0
    mixed *= r_vc / r_mix

    write(args.out, mixed)
    print(
        f"清音掩码均值 {mask.mean():.2f}（混回上限 {args.amount}）  "
        f"{n/SR:.1f}s -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
