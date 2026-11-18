"""把起音片段库（ら/は/あ）整体「抛光」：去直流、淡入、响度归一、谱线对齐。

为什么：这 52 段是**不同时间、不同素材**切出来的（用户录音 + 白花原曲 + 两次 SVC），
响度差好几 dB，高频沙的程度也不一样。和声循环已经统一过（−16 dBFS + 谱线对齐到
`timbre-target.json`），起音片段不统一的话，每个字一进来音色就变一下——
用户 2026-11-15「顺带把ら和は也做好」。

只改音色/电平，**不动音高和时长**：片段的 rootHz 在 json 里，播放速率按它算，
所以抛光不影响咬字的音准和时值。
"""
import json, os, sys, wave
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
from make_harmony_voice import match_curve, load_curve, third_octave  # noqa: E402

V = os.path.join(ROOT, "public", "voices")
BANK = os.path.join(V, "bank.json")
TARGET = os.path.join(V, "timbre-target.json")
TARGET_RMS = 10 ** (-16 / 20)


def read(path):
    with wave.open(path, "rb") as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"{path}: 只处理 16-bit")
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def write(path, x, sr):
    pcm = np.clip(x, -1, 1)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((pcm * 32767).astype("<i2").tobytes())


def tilt(x, sr):
    """(2–4k)/(0.3–1k) 与 (4–8k)/(0.3–1k)，dB"""
    n = 1 << 15 if len(x) >= 4096 else 1 << 12
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), n)) ** 2
    fr = np.fft.rfftfreq(n, 1 / sr)
    def e(lo, hi):
        m = (fr >= lo) & (fr < hi)
        return float(spec[m].sum())
    lo = max(e(300, 1000), 1e-20)
    return 10 * np.log10(e(2000, 4000) / lo), 10 * np.log10(e(4000, 8000) / lo)


def closure_ms(x, sr):
    """片段开头那段「静音」有多长（ら 的闭塞）。2% 峰值以下算静音。"""
    if len(x) == 0:
        return 0.0
    peak = float(np.max(np.abs(x))) or 1e-9
    thr = peak * 0.02
    k = int(0.002 * sr)
    idx = None
    for i in range(0, len(x) - k, k):
        if np.sqrt(np.mean(x[i:i + k] ** 2)) > thr:
            idx = i
            break
    return (idx or 0) / sr * 1000


def main() -> int:
    doc = json.loads(open(BANK, encoding="utf-8").read())
    centers, target_db = load_curve(TARGET)
    before, after = [], []
    per_kind = {}
    for s in doc["samples"]:
        path = os.path.join(V, os.path.basename(s["url"]))
        x, sr = read(path)
        # 1) 去直流 + 2 ms 淡入（切片的第一个样本常常带一个跳变，一进来就是咔哒）
        x = x - np.mean(x)
        fade = max(4, int(0.002 * sr))
        x[:fade] *= np.linspace(0.0, 1.0, fade)
        rms0 = float(np.sqrt(np.mean(x ** 2))) or 1e-9
        before.append((20 * np.log10(rms0), *tilt(x, sr)))
        # 2) 谱线对齐：**只对有元音的片段做**
        #
        # 気声（[h]）是宽带噪声，把它对齐到元音的形状会变成「闷响」，
        # 反而把 は 的那口气弄没了。所以 aspirate 只做电平/淡入，不 EQ。
        if s["kind"] != "aspirate":
            x = match_curve(x, sr, centers, target_db, limit_up=3.0, limit_down=12.0, hf_cut=9.0)
        else:
            # 气声只在 8 kHz 以上做一点缓降，压掉嘶声的毛刺
            x = match_curve(x, sr, centers, target_db, limit_up=0.0, limit_down=0.0, hf_cut=3.0)
        # 3) 响度归一
        rms1 = float(np.sqrt(np.mean(x ** 2))) or 1e-9
        x = x * (TARGET_RMS / rms1)
        peak = float(np.max(np.abs(x))) or 1.0
        if peak > 0.95:
            x = x * (0.95 / peak)
        after.append((20 * np.log10(float(np.sqrt(np.mean(x ** 2)))), *tilt(x, sr)))
        per_kind.setdefault(s["kind"], []).append(closure_ms(x, sr))
        write(path, x, sr)

    b = np.array(before)
    a = np.array(after)
    print(f"处理 {len(before)} 段")
    for i, name in enumerate(["响度 dB", "2–4k/0.3–1k", "4–8k/0.3–1k"]):
        print(f"  {name:<14} 前：中位 {np.median(b[:,i]):+6.1f}  跨度 {np.ptp(b[:,i]):5.1f} dB   "
              f"后：中位 {np.median(a[:,i]):+6.1f}  跨度 {np.ptp(a[:,i]):5.1f} dB")
    for kind, vals in per_kind.items():
        v = np.array(vals)
        print(f"  {kind:<10} 开头静音：中位 {np.median(v):5.1f} ms  范围 {v.min():.1f}–{v.max():.1f} ms")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
