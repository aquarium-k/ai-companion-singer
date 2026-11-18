#!/usr/bin/env python3
"""把一段循环采样按「保共振峰」的方式变调（TD-PSOLA），用来扩音域。

为什么需要它
------------
和声靠 `playbackRate` 变调——**共振峰跟着一起走**。目标音高离采样根音越远，
声音越像花栗鼠：现在库里 258–575 Hz，唱到 895 Hz（白花最高音）就是 +7.7 个半音，
共振峰整体上移 55%，听感已经不是「她」了。

TD-PSOLA 的做法是把波形按**周期**重新摆一遍，每个 grain 都是原波形的复制，
所以基频变了、频谱包络（共振峰）没变。离线跑一次，成品当新的循环采样用，
运行时不需要任何改动。

判据（`--check` 会一起打印）
----------------------------
  音高    YIN 逐帧中位 ≈ 目标（≤5 音分）
  共振峰  与原始采样的「倒谱平滑包络」最贴合的**频率位移 ≈ 0 半音**
          （重采样会显示 ≈ 变调量，这就是两者的区别）
  接缝    环绕点的样本跳变 ≤ 全曲 99.9 分位
  电平    RMS 与原始一致（±0.3 dB）

用法
----
    py tools/make_pitch_variants.py --wav public/voices/loop_575.wav \
        --shifts 2,4,6 --out-dir public/voices/ext
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

import numpy as np  # noqa: E402

SR = 44100


# ---------------------------------------------------------------- 读写
def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path)) as h:
        assert h.getframerate() == SR, h.getframerate()
        raw = h.readframes(h.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def write_wav(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.abs(x).max()) or 1.0
    y = x if peak <= 0.98 else x * (0.98 / peak)
    with wave.open(str(path), "wb") as h:
        h.setnchannels(1)
        h.setsampwidth(2)
        h.setframerate(SR)
        h.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


# ---------------------------------------------------------------- 周期标记
def pitch_marks(x: np.ndarray, period: float) -> np.ndarray:
    """每个周期一个标记点：取 ±0.25 周期内「(去低频后) 波形最大峰」。

    为什么不直接用 j*T：循环起点是任意相位，`T` 也不是整数样本，
    严格等间隔的 grain 会把相位噪声摊到每个周期上（PSOLA 的老毛病）。
    咬到波峰上，重叠相加的相位才对得齐。
    """
    n = len(x)
    # 一个很轻的低通（3 点滑动），免得标记被高频毛刺带跑
    sm = np.convolve(np.concatenate([x[-8:], x, x[:8]]), np.ones(5) / 5, mode="same")[8:-8]
    marks = []
    j = 0
    while j * period < n:
        c = j * period
        lo = int(max(0, c - 0.25 * period))
        hi = int(min(n - 1, c + 0.25 * period))
        if hi <= lo:
            marks.append(int(round(c)) % n)
        else:
            marks.append(int(lo + np.argmax(np.abs(sm[lo:hi]))))
        j += 1
    return np.array(marks, dtype=np.int64)


# ---------------------------------------------------------------- PSOLA
def psola_shift(x: np.ndarray, f0: float, semitones: float) -> tuple[np.ndarray, float]:
    """把 x 变调 `semitones` 个半音（保共振峰），返回 (新循环, 新根音 Hz)。

    输出长度故意保持「和原来差不多」——因为它是**循环**，长度只要仍是
    整数个新周期就行，不需要和输入等长。
    """
    n = len(x)
    period = SR / f0
    r = 2 ** (semitones / 12)
    t_out = period / r  # 输出周期

    # 输出周期数按「长度尽量不变」取整，再反推真正的输出长度/根音
    k_out = max(4, int(round(n / t_out)))
    length = int(round(k_out * t_out))
    f0_out = SR * k_out / length  # 由长度和周期数精确反推

    marks = pitch_marks(x, period)
    win = np.hanning(int(2 * period))
    half = len(win) // 2

    # 累积到一张带边距的画布上，最后按 length 环绕折回来——
    # 折回来保证「首尾接得上」，因为这段本来就是周期性的
    pad = int(2 * period) + 2
    acc = np.zeros(length + 2 * pad)
    wsum = np.zeros(length + 2 * pad)
    idx = np.arange(len(win))

    for i in range(k_out):
        pos = int(round(i * t_out))
        j = int(round(pos / period)) % len(marks)
        center = int(marks[j])
        # 环绕取 grain
        src = (center - half + idx) % n
        start = pos - half + pad
        acc[start : start + len(win)] += x[src] * win
        wsum[start : start + len(win)] += win

    # 环绕折叠
    out = np.zeros(length)
    ws = np.zeros(length)
    a = acc[:pad]
    out[-pad:] += a
    ws[-pad:] += wsum[:pad]
    out[:length] += acc[pad : pad + length]
    ws[:length] += wsum[pad : pad + length]
    tail = acc[pad + length :]
    out[: len(tail)] += tail
    ws[: len(tail)] += wsum[pad + length :]

    y = out / np.maximum(ws, 1e-6)

    # 电平回到原始 RMS（循环之间混音时比例不能被变调悄悄改掉）
    rms_in = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) or 1.0
    rms_out = float(np.sqrt(np.mean(y.astype(np.float64) ** 2))) or 1.0
    y *= rms_in / rms_out
    return y.astype(np.float32), float(f0_out)


# ---------------------------------------------------------------- 校验用
def f0_median(x: np.ndarray) -> float:
    """YIN 逐帧中位（和烤制时同一个量法）。"""
    from make_harmony_voice import f0_frames

    frames = f0_frames(x, SR, 0.03, 0.01)
    frames = frames[frames > 0]
    return float(np.median(frames)) if len(frames) else 0.0


def envelope_db(x: np.ndarray, n_fft: int = 4096, quefrency: int = 40) -> tuple[np.ndarray, np.ndarray]:
    """倒谱平滑的频谱包络（dB）。这就是「共振峰形状」，和基频位置无关。"""
    win = np.hanning(n_fft)
    acc = np.zeros(n_fft // 2 + 1)
    cnt = 0
    for i in range(0, max(1, len(x) - n_fft), n_fft // 4):
        seg = x[i : i + n_fft]
        if len(seg) < n_fft:
            break
        acc += np.abs(np.fft.rfft(seg * win)) ** 2
        cnt += 1
    psd = np.maximum(acc / max(1, cnt), 1e-20)
    logmag = np.log(psd)
    ceps = np.fft.irfft(logmag)
    ceps[quefrency:-quefrency] = 0.0  # 只留慢变部分 = 包络
    env = np.fft.rfft(ceps).real
    freqs = np.fft.rfftfreq(n_fft, 1 / SR)
    return freqs, env


def best_shift(env_a: np.ndarray, env_b: np.ndarray, freqs: np.ndarray) -> float:
    """b 相对 a 的包络位移（半音）。formant 保持 = 0，重采样 = 变调量。"""
    band = (freqs >= 150) & (freqs <= 8000)
    f, ea, eb = freqs[band], env_a[band] - env_a[band].mean(), env_b[band] - env_b[band].mean()
    best, best_shift_cents = -1e9, 0.0
    for cents in np.arange(-900, 901, 5.0):
        k = 2 ** (cents / 1200)
        shifted = np.interp(f * k, f, eb, left=np.nan, right=np.nan)
        ok = ~np.isnan(shifted)
        if ok.sum() < 20:
            continue
        score = float(np.corrcoef(ea[ok], shifted[ok])[0, 1])
        if score > best:
            best, best_shift_cents = score, float(cents)
    return best_shift_cents / 100.0, best  # 返回 (半音, 相关系数)


def seam_jump(x: np.ndarray) -> float:
    d = np.abs(np.diff(np.concatenate([x, x[:1]])))
    return float(d[-1])


def resample_shift(x: np.ndarray, semitones: float) -> np.ndarray:
    """对照组：模拟 playbackRate 变调（线性插值重采样），共振峰会跟着走。"""
    r = 2 ** (semitones / 12)
    n_out = int(round(len(x) / r))
    idx = np.arange(n_out) * r
    i0 = np.floor(idx).astype(int)
    frac = idx - i0
    return (x[i0 % len(x)] * (1 - frac) + x[(i0 + 1) % len(x)] * frac).astype(np.float32)


# ---------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser(description="TD-PSOLA 保共振峰变调（扩循环采样音域）")
    ap.add_argument("--wav", required=True)
    ap.add_argument("--shifts", default="", help="半音列表，如 2,4,-3")
    ap.add_argument("--out-dir", default="public/voices/ext")
    ap.add_argument("--check", action="store_true", help="打印音高/包络/接缝校验")
    args = ap.parse_args()

    src = Path(args.wav)
    meta = json.loads(src.with_suffix(".json").read_text(encoding="utf-8"))
    x = read_wav(src)
    f0 = float(meta.get("rootHz") or f0_median(x))
    print(f"{src.name}  {len(x)/SR*1000:.0f} ms  根音 {f0:.2f} Hz")
    if args.check:
        print(f"  实测根音 {f0_median(x):.2f} Hz  接缝跳变 {seam_jump(x):.4f}")

    shifts = [float(s) for s in args.shifts.split(",") if s.strip()]
    if not shifts:
        print("没给 --shifts，什么都不做")
        return 0

    out_dir = Path(args.out_dir)
    base = src.stem
    freqs, env_src = envelope_db(x)

    for s in shifts:
        y, f0_out = psola_shift(x, f0, s)
        name = f"{base}_{s:+.0f}" if s.is_integer() else f"{base}_{s:+.1f}"
        name = name.replace("+", "p").replace("-", "m")
        wav_out = out_dir / f"{name}.wav"
        write_wav(wav_out, y)
        (out_dir / f"{name}.json").write_text(
            json.dumps(
                {
                    "source": src.name,
                    "rootHz": round(f0_out, 2),
                    "lengthSec": round(len(y) / SR, 4),
                    "sampleRate": SR,
                    "periods": int(round(len(y) / (SR / f0_out))),
                    "shiftSemitones": s,
                    "method": "psola",
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        print(f"\n{s:+g} 半音 → {wav_out.name}  {f0_out:.2f} Hz  {len(y)/SR*1000:.0f} ms")

        if args.check:
            got = f0_median(y)
            cents = 1200 * np.log2(got / f0_out) if got > 0 else 0
            _, env_y = envelope_db(y)
            shift_psola, corr_psola = best_shift(env_src, env_y, freqs)
            # 对照：同一段用重采样变调（playbackRate 那条路）
            z = resample_shift(x, s)
            _, env_z = envelope_db(z)
            shift_resamp, corr_resamp = best_shift(env_src, env_z, freqs)
            print(f"  音高实测 {got:.2f} Hz（差 {cents:+.1f} 音分）")
            print(f"  包络位移：PSOLA {shift_psola:+.2f} 半音（相关 {corr_psola:.3f}）"
                  f" | 重采样 {shift_resamp:+.2f} 半音（相关 {corr_resamp:.3f}）")
            print(f"  接缝跳变 {seam_jump(y):.4f}（原始 {seam_jump(x):.4f}）")
            print(f"  RMS {20*np.log10(np.sqrt(np.mean(y**2))):.1f} dB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
