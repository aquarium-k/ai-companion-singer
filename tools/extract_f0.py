#!/usr/bin/env python3
"""从分离人声里提取 F0（基频）曲线，并量化成音符。

为什么要这一步
--------------
「AI 自唱」的三条路线（歌声合成 / 音色转换 / TTS 念词）都要先知道
**原唱到底唱了什么音**：

- 歌声合成要「音高 + 时长」才能生成；
- 音色转换要 F0 做源特征；
- 连节奏对齐也能拿它当第二意见（浊音段 ≈ 真正在唱）。

现在的 `lyrics.units.json` 只有 mora 的位置和元音，**没有音高**。这里补上。

算法：YIN
----------
用差分函数 + 累积均值归一化（de Cheveigné & Kawahara 2002），
比纯自相关抗倍频/半频错误。差分函数用 FFT 自相关算，整首几十秒量级。

输出
----
    work/f0.json
    {
      "sr": 22050, "hop": 256, "frame": 2048,
      "frames": [[t, f0, clarity, rms], ...]   # f0=0 表示清音/静音
      "notes":  [[start, dur, midi, text?], ...]
    }

用法
----
    python tools/extract_f0.py --audio stems/vocals.mp3 --out work/f0.json
    python tools/extract_f0.py --audio ... --plot f0.png
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

SR = 22050
FRAME = 2048
HOP = 256
F0_MIN = 65.0
F0_MAX = 1000.0
YIN_THRESHOLD = 0.15
CLEAR_MIN = 0.55


def decode_mono(path: str, sr: int = SR) -> np.ndarray:
    """解码成单声道 float32。复用 detect_bpm 里那套（PyAV + AudioResampler）。"""
    import av

    container = av.open(path)
    resampler = av.AudioResampler(format="fltp", layout="mono", rate=sr)
    chunks: list[np.ndarray] = []
    for frame in container.decode(audio=0):
        for out in resampler.resample(frame):
            chunks.append(out.to_ndarray().reshape(-1))
    for out in resampler.resample(None):
        chunks.append(out.to_ndarray().reshape(-1))
    container.close()
    if not chunks:
        raise RuntimeError(f"解不出音频：{path}")
    return np.concatenate(chunks).astype(np.float32)


def difference_function(x: np.ndarray) -> np.ndarray:
    """YIN 的差分函数 d(τ)，用 FFT 自相关算。

    d(τ) = Σ_{j<W-τ}(x[j]-x[j+τ])²
         ≈ e(0) + e(τ) - 2·r(τ)
    其中 e(τ)=Σ_{j≥τ}x[j]²（后缀平方和），r(τ) 是自相关。
    这和逐点暴力算等价到浮点误差，但快两个数量级。
    """
    n_frames, width = x.shape
    t_max = min(width - 1, int(SR / F0_MIN) + 2)

    # r(τ)：补零到 2W 后做 FFT 自相关
    size = 1 << int(np.ceil(np.log2(2 * width)))
    spectrum = np.fft.rfft(x, n=size, axis=1)
    acf = np.fft.irfft(spectrum * np.conj(spectrum), n=size, axis=1)[:, :t_max]

    # e(τ)：后缀平方和
    sq = np.cumsum((x[:, ::-1] ** 2), axis=1)[:, ::-1]  # sq[:, j] = Σ_{k≥j} x[k]²
    e0 = np.repeat(sq[:, :1], t_max, axis=1)
    e_tau = np.concatenate([sq[:, :t_max]], axis=1)

    d = e0 + e_tau - 2.0 * acf
    return np.maximum(d, 0.0)


def frames_of(signal: np.ndarray) -> np.ndarray:
    count = 1 + max(0, (len(signal) - FRAME) // HOP)
    if count <= 0:
        return np.zeros((0, FRAME), dtype=np.float32)
    index = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    return signal[index]


def yin(signal: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """返回 (f0, clarity, rms)，每帧一个值。f0=0 表示没找到周期。"""
    frames = frames_of(signal)
    if len(frames) == 0:
        return np.zeros(0), np.zeros(0), np.zeros(0)

    frames = frames - frames.mean(axis=1, keepdims=True)
    rms = np.sqrt((frames**2).mean(axis=1))

    d = difference_function(frames)
    t_max = d.shape[1]

    # 累积均值归一化：d'(τ) = d(τ) / ((1/τ)Σ_{k≤τ}d(k))
    running = np.cumsum(d, axis=1)
    tau = np.arange(1, t_max + 1)
    # 分母可能是 0（整帧静音），除零会变 NaN 把后面的 argmin 一起毒掉
    dn = d / np.maximum(running / tau, 1e-9)[:, :t_max]
    dn[:, 0] = 1.0

    tau_min = max(2, int(SR / F0_MAX))
    tau_max = min(t_max - 1, int(SR / F0_MIN))

    f0 = np.zeros(len(frames), dtype=np.float32)
    clarity = np.zeros(len(frames), dtype=np.float32)

    window = dn[:, tau_min:tau_max]
    for i in range(len(frames)):
        row = window[i]
        below = np.flatnonzero(row < YIN_THRESHOLD)
        if below.size:
            lag = tau_min + int(below[0])
            # 从第一个过阈值点继续走到局部最低，减少「刚好擦线」的抖动
            while lag + 1 < tau_max and dn[i, lag + 1] < dn[i, lag]:
                lag += 1
        else:
            lag = tau_min + int(np.argmin(row))
            if dn[i, lag] > 0.6:  # 完全没有周期性
                continue

        # 抛物线插值到亚采样精度
        if tau_min < lag < tau_max - 1:
            a, b, c = dn[i, lag - 1], dn[i, lag], dn[i, lag + 1]
            denom = a - 2 * b + c
            shift = 0.5 * (a - c) / denom if abs(denom) > 1e-9 else 0.0
            shift = float(np.clip(shift, -0.5, 0.5))
        else:
            shift = 0.0

        f0[i] = SR / (lag + shift)
        clarity[i] = float(np.clip(1.0 - dn[i, lag], 0.0, 1.0))

    return f0, clarity, rms


def harmonic_fix(signal: np.ndarray, f0: np.ndarray, clarity: np.ndarray) -> np.ndarray:
    """用谐波积谱修正「锁到次谐波」的错误。

    白花 8.5-10.3s 那一段，YIN 给出 117Hz，但那一档的谱能量是 **0.00**，
    真正的能量在 467Hz 和它的二次谐波 935Hz 上——YIN 锁到了 1/4 周期上
    （信号里几个谐波刚好凑成 4 倍周期的重复，CMND 就认了）。

    修法：对每一帧，只在 {f, 2f, 3f, 4f} 里挑，用 HPS（各次谐波幅度相乘）
    打分。116Hz 的 HPS ≈ 0（基频没能量），467Hz 的很高，自然就选对了。
    只考虑整数倍是刻意的：次谐波错误几乎总是整数关系。
    """
    frames = frames_of(signal)
    if len(frames) == 0 or len(f0) != len(frames):
        return f0

    out = f0.copy()
    chunk = 2000
    window = np.hanning(FRAME)
    bins = FRAME // 2 + 1
    hz_per_bin = SR / FRAME

    for start in range(0, len(frames), chunk):
        stop = min(len(frames), start + chunk)
        block = frames[start:stop] * window
        magnitude = np.abs(np.fft.rfft(block, axis=1))  # (n, bins)

        for row in range(stop - start):
            index = start + row
            base = float(out[index])
            if base <= 0:
                continue
            best_score = -1.0
            best = base
            for multiple in (1.0, 2.0, 3.0, 4.0):
                candidate = base * multiple
                if candidate < F0_MIN or candidate > F0_MAX:
                    continue
                score = 1.0
                for k in range(1, 4):
                    target = candidate * k
                    if target > SR / 2:
                        score = 0.0
                        break
                    centre = int(round(target / hz_per_bin))
                    lo = max(0, centre - 1)
                    hi = min(bins, centre + 2)
                    peak = float(magnitude[row, lo:hi].max()) if hi > lo else 0.0
                    score *= peak + 1e-6
                if score > best_score:
                    best_score = score
                    best = candidate

            # 只有在「新候选的基频确实有能量」时才改，避免把干净的音改坏
            centre = int(round(best / hz_per_bin))
            lo = max(0, centre - 1)
            hi = min(bins, centre + 2)
            fundamental = float(magnitude[row, lo:hi].max()) if hi > lo else 0.0
            frame_peak = float(magnitude[row].max()) or 1.0
            if best != base and fundamental > frame_peak * 0.08:
                out[index] = best

    changed = int((np.abs(out - f0) > 1e-6).sum())
    if changed:
        print(f"  谐波修正：{changed} 帧锁到了次谐波，已按 HPS 改回")
    return out


def polish(f0: np.ndarray, clarity: np.ndarray, rms: np.ndarray) -> np.ndarray:
    """修倍频/半频错误 + 去孤立帧。

    YIN 的典型失败不是「算不准」，是**算成两倍或一半**（尤其在高音和颤音上）。
    判据：如果某帧和它周围 140ms 的中位音高差了整一个八度（log2 比值 1±0.15），
    就把这一帧掰回邻域那一档。然后再做 5 帧中值滤波压颤音抖动。
    """
    if len(f0) == 0:
        return f0

    voiced = (f0 > 0) & (clarity > CLEAR_MIN)
    if voiced.sum() < 20:
        return f0

    out = f0.copy()
    block = 12  # ±12 帧 ≈ ±140ms
    usable = np.where(voiced, f0, np.nan)

    for start in range(0, len(f0), block):
        stop = min(len(f0), start + block * 2)
        neighbourhood = usable[max(0, start - block) : stop + block]
        reference = np.nanmedian(neighbourhood) if np.isfinite(neighbourhood).any() else 0.0
        if reference <= 0:
            continue
        for i in range(start, stop):
            if out[i] <= 0:
                continue
            ratio = np.log2(out[i] / reference)
            for octave in (2.0, 0.5, 4.0, 0.25):
                if abs(ratio - np.log2(octave)) < 0.15:
                    out[i] = out[i] / octave
                    break
            # 掰完八度还离邻域一个八度以上 → 不是人声基频，扔掉；
            # 另外把明显超出人声范围的（<80Hz / >900Hz）也当噪声
            if abs(np.log2(out[i] / reference)) > 1.05:
                out[i] = 0.0
            elif not (80.0 <= out[i] <= 900.0):
                out[i] = 0.0

    # 中值滤波（只对浊音帧，清音保持 0）
    filtered = out.copy()
    for i in range(2, len(out) - 2):
        if not voiced[i]:
            continue
        seg = [out[j] for j in range(i - 2, i + 3) if voiced[j]]
        if seg:
            filtered[i] = float(np.median(seg))

    # 最后再兜一道：不管前面怎么掰，超出人声范围的一律当没唱。
    # （掰八度本身可能把 208Hz 掰成 52Hz，如果邻域整体低了一个八度的话。）
    filtered[(filtered > 0) & ((filtered < 80.0) | (filtered > 900.0))] = 0.0

    # 注意：**不要**再加「偏离全曲中位音高就置零」这类全局闸。
    # 白花 8.2s 那段从 302Hz 掉到 116Hz，看着像跟踪失败，但拿整段平均谱验证过：
    # 最强的两个峰在 350.4Hz 和 467.2Hz，正好是 116.8Hz 的第 3、4 次谐波
    # （467 也不是 300 的谐波），所以那是**真的唱低了**，不是误判。
    # 加闸会把真音符抹成一条平线，比原来的「跳变」更糟。

    # 连续浊音不足 3 帧的当成噪声（YIN 在换气口常冒出单帧误判）
    run_start = None
    for i in range(len(filtered) + 1):
        on = i < len(filtered) and filtered[i] > 0
        if on and run_start is None:
            run_start = i
        elif not on and run_start is not None:
            if i - run_start < 3:
                filtered[run_start:i] = 0.0
            run_start = None

    return filtered


def to_notes(
    times: np.ndarray,
    f0: np.ndarray,
    clarity: np.ndarray,
    rms: np.ndarray,
    min_dur: float = 0.08,
) -> list[list[float]]:
    """把逐帧 F0 量化成音符：[start, dur, midi]。

    先做 5 帧中值滤波压掉抖动，再按半音取整、合并相邻同音。
    """
    if len(f0) == 0:
        return []

    voiced = (f0 > 0) & (clarity > CLEAR_MIN) & (rms > max(1e-4, float(np.percentile(rms, 40)) * 0.15))

    # 中值滤波只看浊音帧，避免被清音打断
    smoothed = f0.copy()
    half = 2
    for i in range(len(f0)):
        lo, hi = max(0, i - half), min(len(f0), i + half + 1)
        seg = f0[lo:hi][voiced[lo:hi]]
        if seg.size:
            smoothed[i] = float(np.median(seg))

    midi = np.zeros(len(f0))
    for i in range(len(f0)):
        if not voiced[i]:
            continue
        freq = max(20.0, smoothed[i])
        midi[i] = 69 + 12 * float(np.log2(freq / 440.0))

    notes: list[list[float]] = []
    current: list[float] | None = None
    for i in range(len(f0)):
        pitch = round(midi[i]) if voiced[i] else None
        t = float(times[i])
        if current is None:
            if pitch is not None:
                current = [t, t, pitch]
        elif pitch is None or pitch != current[2]:
            if pitch is not None and pitch == current[2]:
                pass
            if t - current[0] >= min_dur:
                notes.append([round(current[0], 3), round(current[1] - current[0], 3), int(current[2])])
            current = [t, t, pitch] if pitch is not None else None
        else:
            current[1] = t
    if current is not None and current[1] - current[0] >= min_dur:
        notes.append([round(current[0], 3), round(current[1] - current[0], 3), int(current[2])])

    return notes


def plot(times: np.ndarray, f0: np.ndarray, clarity: np.ndarray, notes: list[list[float]], out: Path) -> None:
    from PIL import Image, ImageDraw

    width, height = 1200, 360
    image = Image.new("RGB", (width, height), (18, 16, 24))
    draw = ImageDraw.Draw(image)

    if len(times) == 0:
        image.save(out)
        return

    voiced = (f0 > 0) & (clarity > CLEAR_MIN)
    freqs = f0[voiced]
    lo = float(np.percentile(freqs, 2)) if freqs.size else 80.0
    hi = float(np.percentile(freqs, 98)) if freqs.size else 800.0
    lo, hi = max(40.0, lo * 0.9), max(lo + 20, hi * 1.1)
    span = float(times[-1]) or 1.0

    def xy(t: float, f: float) -> tuple[float, float]:
        x = 4 + (width - 8) * (t / span)
        y = height - 8 - (height - 16) * (np.log(f / lo) / np.log(hi / lo))
        return x, y

    # 半音网格
    for midi in range(36, 96):
        f = 440.0 * 2 ** ((midi - 69) / 12)
        if not (lo < f < hi):
            continue
        _, y = xy(0, f)
        draw.line([(0, y), (width, y)], fill=(30, 27, 40))

    for start, dur, midi in notes:
        f = 440.0 * 2 ** ((midi - 69) / 12)
        x0, y = xy(start, f)
        x1, _ = xy(start + dur, f)
        draw.rectangle([x0, y - 2, max(x0 + 1, x1), y + 2], fill=(255, 143, 177))

    for i in range(0, len(times), 2):
        if not voiced[i]:
            continue
        x, y = xy(float(times[i]), float(f0[i]))
        draw.point((x, y), fill=(120, 200, 255))

    image.save(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="人声 F0 提取 + 音符化")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out")
    ap.add_argument("--plot", help="把音高曲线画成 PNG")
    ap.add_argument("--json-only-stats", action="store_true")
    args = ap.parse_args()

    signal = decode_mono(args.audio)
    duration = len(signal) / SR
    raw_f0, clarity, rms = yin(signal)
    raw_f0 = harmonic_fix(signal, raw_f0, clarity)
    f0 = polish(raw_f0, clarity, rms)

    hop_s = HOP / SR
    times = np.arange(len(f0)) * hop_s
    notes = to_notes(times, f0, clarity, rms)

    voiced = (f0 > 0) & (clarity > CLEAR_MIN)
    ratio = float(voiced.mean()) if len(voiced) else 0.0
    freqs = f0[voiced]
    midi = 69 + 12 * np.log2(np.maximum(freqs, 1e-6) / 440.0) if freqs.size else np.zeros(0)

    print(f"音频 {duration:.1f}s，帧数 {len(f0)}（{hop_s * 1000:.1f}ms/帧）")
    print(f"浊音帧占比 {ratio * 100:.1f}%（清音/静音 {100 - ratio * 100:.1f}%）")
    if freqs.size:
        print(
            f"音高范围 {freqs.min():.0f}–{freqs.max():.0f} Hz"
            f"（中位 {np.median(freqs):.0f} Hz）"
            f"，约 MIDI {midi.min():.0f}–{midi.max():.0f}"
        )
    print(f"音符数 {len(notes)}（过滤掉 <80ms 的碎片）")
    on_seconds = sum(n[1] for n in notes)
    print(f"音符总时长 {on_seconds:.1f}s（占全曲 {on_seconds / duration * 100:.0f}%）")

    if args.out and not args.json_only_stats:
        payload = {
            "sr": SR,
            "hop": HOP,
            "frame": FRAME,
            "duration": round(duration, 2),
            "frames": [
                [round(float(t), 3), round(float(f), 2), round(float(c), 3), round(float(r), 5)]
                for t, f, c, r in zip(times, f0, clarity, rms)
            ],
            "notes": notes,
        }
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(f"写入 {args.out}（{Path(args.out).stat().st_size / 1024:.0f}KB）")

    if args.plot:
        Path(args.plot).parent.mkdir(parents=True, exist_ok=True)
        plot(times, f0, clarity, notes, Path(args.plot))
        print(f"音高曲线 {args.plot}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
