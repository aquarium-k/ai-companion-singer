#!/usr/bin/env python3
"""BPM 检测：谱通量 + 梳状自相关，只用 numpy。

为什么自己做而不用 librosa
--------------------------
librosa 会带进来 numba、soundfile 一整串依赖，而我们现在的 `.pylibs` 是
「numpy + onnxruntime + PyAV + faster-whisper」这个规模。BPM 检测本身不难，
没必要为它换一套环境。

算法
----
1. 解码成单声道 22050Hz（BPM 只需要节奏信息，不需要高频）。
2. 谱通量：STFT 幅度取 log 压缩后，逐帧求「正向增量」并跨频点求和。
   log 压缩是为了让弱拍（hi-hat）和强拍（kick）量级接近，不然只剩鼓点。
3. 对包络做自相关，在 50–190 BPM 对应的滞后范围内搜索。
4. **梳状打分**：候选速度 L 的分数 = 自相关在 L、2L、3L、4L 上的加权和。
   只用 L 的最大值会把 96 听成 192（因为 192 的滞后处也有峰），
   加上倍频一起打分才能分清「这个速度」和「它的两倍」。
5. 加一个以 120 BPM 为中心的先验（对数正态），压掉极端速度。
6. 抛物线插值细化峰值位置，得到小数 BPM。

用法
----
    python tools/detect_bpm.py --audio song.mp3
    python tools/detect_bpm.py --audio song.mp3 --json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

SR = 22050
N_FFT = 1024
HOP = 256


def decode_mono(path: str, sr: int = SR) -> np.ndarray:
    import av

    container = av.open(path)
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=sr)
    parts = []
    for frame in container.decode(stream):
        for out in resampler.resample(frame):
            parts.append(out.to_ndarray())
    for out in resampler.resample(None):
        parts.append(out.to_ndarray())
    container.close()
    if not parts:
        raise RuntimeError(f"解码失败：{path}")
    return np.concatenate(parts, axis=1).astype(np.float32).mean(axis=0)


def onset_envelope(x: np.ndarray) -> np.ndarray:
    """谱通量包络。帧率 = SR / HOP（22050/256 ≈ 86.1 fps）。"""
    window = np.hanning(N_FFT).astype(np.float32)
    padded = np.pad(x, (N_FFT // 2, N_FFT // 2), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT)[::HOP]
    mag = np.abs(np.fft.rfft(frames * window, axis=-1))

    # log 压缩：把动态范围压下来，弱拍才有贡献
    logmag = np.log1p(mag * 20.0)
    # 逐帧正向增量，只保留「变响」的部分
    flux = np.maximum(0.0, np.diff(logmag, axis=0)).sum(axis=1)

    # 去均值并归一化，方便后面做自相关
    flux = flux - flux.mean()
    peak = np.max(np.abs(flux))
    if peak > 0:
        flux = flux / peak
    return flux


def ac_at(ac: np.ndarray, pos: float) -> float:
    """自相关在非整数滞后上的线性插值取值。

    必须插值：96 BPM 对应 53.8 帧，150 BPM 对应 34.45 帧。
    只取 int(round()) 会让「真实拍点刚好落在半帧上」的速度吃亏，
    实测中 150 BPM 的节拍器会被判成 75 —— 因为 75 的滞后 68.9 恰好离整数更近。
    """
    if pos <= 0:
        return float(ac[0])
    i = int(np.floor(pos))
    if i + 1 >= len(ac):
        return float(ac[-1])
    frac = pos - i
    return float(ac[i] * (1.0 - frac) + ac[i + 1] * frac)


def comb_score(ac: np.ndarray, lag: float, harmonics: int = 4, decay: float = 0.6) -> float:
    """在 lag 及其倍频上取自相关加权和。越像一个真正的拍周期，分数越高。"""
    total = 0.0
    weight = 1.0
    for k in range(1, harmonics + 1):
        pos = lag * k
        if pos >= len(ac) - 1:
            break
        total += weight * ac_at(ac, pos)
        weight *= decay
    return total


def detect(path: str, min_bpm: float = 50.0, max_bpm: float = 190.0, prior_bpm: float = 120.0) -> dict:
    x = decode_mono(path)
    if len(x) < SR:
        raise ValueError("音频太短，至少 1 秒")

    env = onset_envelope(x)
    fps = SR / HOP

    # 自相关（只算正滞后那半边）
    ac = np.correlate(env, env, mode="full")[len(env) - 1 :]
    if ac[0] > 0:
        ac = ac / ac[0]

    # 候选滞后范围
    lag_hi = fps * 60.0 / min_bpm
    lag_lo = fps * 60.0 / max_bpm

    scored: list[tuple[float, float, float]] = []
    lag = lag_lo
    while lag <= lag_hi:
        bpm = fps * 60.0 / lag
        # 对数正态先验，用来压掉 192 这种「双倍速度」
        prior = float(np.exp(-0.5 * (np.log2(bpm / prior_bpm) / 0.9) ** 2))
        scored.append((comb_score(ac, lag) * prior, bpm, lag))
        lag += 0.25

    if not scored:
        raise RuntimeError("没有找到候选速度")

    scored.sort(key=lambda item: item[0], reverse=True)
    best_score, best_bpm, best_lag = scored[0]

    # 抛物线插值：用峰值左右两个滞后细化
    i = int(round(best_lag))
    refined = best_bpm
    if 0 < i < len(ac) - 1:
        a, b, c = ac[i - 1], ac[i], ac[i + 1]
        denom = a - 2 * b + c
        if abs(denom) > 1e-9:
            delta = 0.5 * (a - c) / denom
            if abs(delta) <= 1.0:
                refined = fps * 60.0 / (i + delta)

    # 置信度用 z 分数：最高分高出「全体分数」多少个标准差。
    # 不能用 best/median —— 自相关有负值，中位数可能是负的，比值会变成负数。
    scores = np.array([s for s, _, _ in scored], dtype=np.float64)
    confidence = float((best_score - np.median(scores)) / (np.std(scores) + 1e-9))

    # 同一速度附近只留一个，候选列表才有信息量
    picked: list[dict] = []
    for score, bpm, _lag in scored:
        if any(abs(bpm - item["bpm"]) < 4.0 for item in picked):
            continue
        picked.append({"bpm": round(float(bpm), 1), "score": round(float(score), 3)})
        if len(picked) >= 5:
            break

    return {
        "bpm": round(float(refined), 2),
        "confidence": round(confidence, 3),
        "candidates": picked,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="BPM 检测（numpy 版）")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--min-bpm", type=float, default=50.0)
    ap.add_argument("--max-bpm", type=float, default=190.0)
    ap.add_argument("--json", action="store_true", help="只输出 JSON")
    args = ap.parse_args()

    if not Path(args.audio).exists():
        print(f"找不到音频：{args.audio}", file=sys.stderr)
        return 1

    try:
        result = detect(args.audio, args.min_bpm, args.max_bpm)
    except Exception as err:  # noqa: BLE001
        print(f"检测失败：{err}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"BPM ≈ {result['bpm']}（置信度 {result['confidence']}）")
        for item in result["candidates"]:
            print(f"    {item['bpm']:6.1f}  score={item['score']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
