"""给循环采样「修音」：把每个采样的音高锁到它的 root 上，并把颤音抹平。

为什么要做（2026-11-17 用户点出来的方向）：库里的循环采样是从她的翻唱里截的**真唱**，
自带原唱的颤音（实测音分起伏 std 2–35 音分，3–8 Hz 能量占 8–46%）。运行时和声还会
再叠一层自己的 LFO 颤音 —— 两层不同步的颤音 = 「不自然」，而且那层颤音是**录死在
循环里**的，每 0.32 s 原样重复一次。

做法：不是简单的匀速变调，而是**变速重采样**——逐帧量出 f0 的起伏，按 f0/root 的
比例改变读取速度，让输出音高恒定在 root 上。颤音（±30 音分 = 1.7%）会连带把共振峰
挪动同样的比例，这个量级听不出来；换来的是「干净、稳定、能在运行时统一加颤音」的样本。

    python tools/tune_loops.py            # 只量，写到 .tmp/tuned/ 供对比
    python tools/tune_loops.py --apply    # 覆盖 public/voices/loop_*.wav（原文件备份到 _orig/）
"""
import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import librosa
import soundfile as sf
from scipy.interpolate import CubicSpline

VOICES = Path("public/voices")
BACKUP = VOICES / "_orig"
TMP = Path(".tmp/tuned")


def tune_audio(y: np.ndarray, sr: int, root: float) -> tuple[np.ndarray, dict]:
    """变速重采样，把音高锁到 root；返回新波形和统计。"""
    f0, vf, _ = librosa.pyin(
        y, fmin=80, fmax=900, sr=sr, frame_length=2048, hop_length=256
    )
    hop = 256
    ok = ~np.isnan(f0)
    if ok.sum() < 20:
        return y, {"skipped": "pyin 没测出音高"}

    # 只保留有效段：pyin 的头尾常常是 nan，会污染插值
    idx = np.flatnonzero(ok)
    lo, hi = int(idx[0]), int(idx[-1]) + 1
    f0v = f0[lo:hi]
    okv = ok[lo:hi]
    # 无效帧用线性插值补齐（不要在有效段里留 nan）
    x = np.arange(len(f0v))
    f0v = np.interp(x, x[okv], f0v[okv])

    # 轻度中值平滑：压掉 pyin 的单帧毛刺，但**保留**几赫兹的颤音（那是要消掉的东西）
    k = 5
    pad = np.pad(f0v, (k // 2, k // 2), mode="edge")
    f0s = np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)

    # 再低通到 12 Hz（零相位）：pyin 的高频毛刺会变成「修出来的抖动」，
    # 而颤音只有 3–8 Hz，低通不会把它滤掉。
    from scipy.signal import butter, filtfilt

    fs = sr / hop  # f0 序列的帧率（约 172 Hz）
    b, a = butter(2, min(0.9, 12 / (fs / 2)), btype="low")
    f0s = filtfilt(b, a, f0s)

    # 变速：每个输出样本，输入前进 rate 个样本；播得越快音高越高，
    # 所以要把 f0 拉到 root，rate = root / f0。（反了的话修完偏差会翻倍——第一版就错了）
    ratio = root / f0s
    ratio = np.clip(ratio, 0.9, 1.1)
    # 逐样本比例：帧间线性插值
    frame_t = (np.arange(len(ratio)) * hop + hop / 2)
    sample_t = np.arange(len(y))
    r = np.interp(sample_t, frame_t, ratio, left=ratio[0], right=ratio[-1])

    # 变速：每输出一个样本，输入前进 r 个样本（这样输入音高 f0 会被拉到 root）
    pos = np.cumsum(r) - r[0]
    pos = pos[pos < len(y) - 2]
    if len(pos) < int(sr * 0.05):
        return y, {"skipped": "重采样后太短"}
    spline = CubicSpline(np.arange(len(y)), y)
    out = spline(pos).astype(np.float32)

    # 截成整数个 root 周期（循环才无缝），再用一个周期交叉淡化接缝
    period = sr / root
    nper = max(2, int(len(out) / period))
    n = int(round(nper * period))
    if n >= len(out):
        n = len(out) - int(period)
    body = out[:n].copy()
    fade = int(round(period))
    if fade > 1 and len(body) > fade * 2 and len(out) >= n + fade:
        body[:fade] = body[:fade] * np.linspace(0, 1, fade) + out[n : n + fade] * np.linspace(1, 0, fade)

    # 音量对齐到原文件（别让修音顺手改了电平）
    rms_in = float(np.sqrt(np.mean(y**2)) + 1e-9)
    rms_out = float(np.sqrt(np.mean(body**2)) + 1e-9)
    body *= rms_in / rms_out

    cents = 1200 * np.log2(f0v / root)
    med = float(np.median(cents))
    std = float(np.std(cents - med))
    return body, {"medianCents": round(med, 1), "stdCents": round(std, 1), "len": len(body)}


def measure(y: np.ndarray, sr: int, root: float) -> dict:
    f0, _, _ = librosa.pyin(y, fmin=80, fmax=900, sr=sr, frame_length=2048, hop_length=256)
    ok = ~np.isnan(f0)
    if ok.sum() < 10:
        return {"std": 0.0, "vib": 0.0}
    cents = 1200 * np.log2(f0[ok] / root)
    c = cents - np.median(cents)
    spec = np.abs(np.fft.rfft(c * np.hanning(len(c))))
    fr = np.fft.rfftfreq(len(c), 256 / sr)
    band = (fr >= 3) & (fr <= 8)
    return {
        "std": round(float(np.std(c)), 1),
        "vib": round(float(spec[band].sum() / (spec.sum() + 1e-9)) * 100, 1),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="覆盖 public/voices 里的文件")
    args = ap.parse_args()

    files = sorted(VOICES.glob("loop_[0-9]*.wav"))
    if not files:
        print("没有找到 loop_*.wav")
        return 1
    if args.apply:
        BACKUP.mkdir(parents=True, exist_ok=True)
    TMP.mkdir(parents=True, exist_ok=True)

    print(f"{'文件':16s} {'root':>7s}  {'修前 std':>8s} {'修后':>6s}  {'修前颤音%':>8s} {'修后':>5s}")
    before_all, after_all = [], []
    for wav in files:
        meta = json.loads(wav.with_suffix(".json").read_text(encoding="utf-8"))
        root = float(meta["rootHz"])
        y, sr = sf.read(wav, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        b = measure(y, sr, root)
        # 已经很稳的（std < 2 音分、几乎在 root 上）就别动——修音只会往干净的样本里
        # 注入 pyin 的测量噪声（实测 loop_210 本来 std 0.0，修完变 1.3）
        cents0 = 1200 * np.log2(
            np.nanmedian(librosa.pyin(y, fmin=80, fmax=900, sr=sr, frame_length=2048, hop_length=256)[0]) / root
        )
        if b["std"] < 2 and abs(cents0) < 5:
            tuned, info = y, {"skipped": "本来就稳/已经准"}
        else:
            tuned, info = tune_audio(y, sr, root)
        a = measure(tuned, sr, root)
        before_all.append(b["std"])
        after_all.append(a["std"])
        flag = "" if "skipped" not in info else "  ＝ " + info["skipped"]
        print(
            f"{wav.name:16s} {root:7.1f}  {b['std']:8.1f} {a['std']:6.1f}  {b['vib']:8.1f} {a['vib']:5.1f}{flag}"
        )
        if args.apply:
            shutil.copy2(wav, BACKUP / wav.name)
            if "skipped" not in info:
                sf.write(wav, tuned, sr, subtype="PCM_16")
        elif "skipped" not in info:
            sf.write(TMP / wav.name, tuned, sr, subtype="PCM_16")

    if before_all:
        print(
            f"\n{len(before_all)} 段：音高起伏 std 中位 {np.median(before_all):.1f} → {np.median(after_all):.1f} 音分"
        )
    if not args.apply:
        print("（只写了 .tmp/tuned/；加 --apply 才覆盖，原文件会备份到 public/voices/_orig/）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
