"""把循环采样「拉长」：TD-PSOLA 按周期重复（保音高、保共振峰）。

用户 2026-11-17 的想法：把样本慢放再截取需要的部分。
**字面做法**（变速慢放、再按原速播回去）是信息等价的——重采样不生成新细节；
但它有一个真实的收益：**把录音里本来就有的周期级微起伏放慢**，于是「每 0.32 s
重复一次」的循环感变成「每 0.96 s 重复一次」。这个工具做的就是这件事，且不靠
重采样：按整周期重复 grain，音高和共振峰都不动。

为什么用「逐周期相位跟踪」而不是 j*T 栅格：循环起点是任意相位，T 也不是整数样本。
栅格法会把相位误差摊到每个 grain 上（PSOLA 的老毛病，听感是「毛」）。
这里每个周期都用**上一周期标记 + 与首周期波形的互相关**去找，相位连续。

    python tools/stretch_loops.py                 # 只量，写 .tmp/long/
    python tools/stretch_loops.py --factor 2      # 拉 2×
    python tools/stretch_loops.py --apply         # 覆盖 public/voices/loop_*.wav
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
VOICES = ROOT / "public/voices"
# 备份放 .tmp/：public/ 会被 vite 原样拷进 dist，备份不该进发行包
BACKUP = ROOT / ".tmp/voices-065"
TMP = ROOT / ".tmp/long"


# ------------------------------------------------------------------ 周期标记
def period_marks(x: np.ndarray, period: float) -> np.ndarray:
    """逐周期相位标记（样本下标，环绕）。

    第一个标记取全曲能量最大的周期起点；之后每个标记在
    「上一个标记 + period ± 0.25 period」里找**与首周期波形最相关**的位置。
    用相关而不是取绝对峰：正弦式波形正负峰一样高，取绝对峰会在两极之间反复横跳
    （实测旧工具就是这么把 loop_210 的「周期抖动」量成 13% 的）。
    """
    n = len(x)
    half = int(round(period * 1.2))
    ref = None
    # 首周期：取全局 |sm| 最大处
    sm = np.convolve(np.concatenate([x[-64:], x, x[:64]]), np.ones(5) / 5, mode="same")[64:-64]
    first = int(np.argmax(np.abs(sm)))
    win = np.hanning(2 * half + 1)

    def grain(c: int) -> np.ndarray:
        idx = (np.arange(-half, half + 1) + c) % n
        return x[idx] * win

    ref = grain(first)
    ref_e = float(np.dot(ref, ref)) or 1.0

    marks = [first]
    # 绝对下标一直往前推（可以越过 n，取波形时再取模）——只往前推到遍历满一整圈为止。
    # 旧版推到 n-1 就停，于是从全曲最大峰（大约中点）起只能覆盖半圈，k_in 少一半，
    # 拉长倍数就变成了 1.4–1.6×（不是设定的 3×）。
    guard = 0
    while marks[-1] - marks[0] < n:
        prev = marks[-1]
        base = prev + period
        lo = int(round(base - 0.25 * period))
        hi = int(round(base + 0.25 * period))
        best, best_c = -2.0, int(round(base))
        for c in range(lo, hi + 1):
            g = grain(c % n)
            cval = float(np.dot(g, ref)) / (np.sqrt(float(np.dot(g, g)) * ref_e) + 1e-12)
            if cval > best:
                best, best_c = cval, c
        marks.append(best_c)
        guard += 1
        if guard > 4 * n:
            break
    return np.array(marks, dtype=np.int64)


# ------------------------------------------------------------------ 拉长
def stretch(x: np.ndarray, sr: int, f0: float, factor: float) -> tuple[np.ndarray, float]:
    """按整周期重复 grain，把 x 拉长 factor 倍；返回 (新波形, 实际根音)。"""
    period = sr / f0
    n = len(x)
    marks = period_marks(x, period)
    if len(marks) < 4:
        raise SystemExit(f"只找到 {len(marks)} 个周期，太短了")

    k_in = len(marks)
    k_out = max(4, int(round(k_in * factor)))
    # 长度取整数个周期，再反推根音（和 build_loop_library 同一套约定）
    length = int(round(k_out * period))
    f0_out = sr * k_out / length
    t_out = sr / f0_out

    half = int(round(period * 1.1))
    win = np.hanning(2 * half + 1)
    wsum = np.zeros(length + 2 * half + 2)
    acc = np.zeros(length + 2 * half + 2)

    for m in range(k_out):
        # 输出第 m 个 grain 取输入的第几个周期（线性映射 = 慢放该起伏）
        src_m = int(round(m * (k_in - 1) / max(1, k_out - 1)))
        c = int(marks[src_m])
        idx = (np.arange(-half, half + 1) + c) % n
        pos = int(round(m * t_out)) + half
        acc[pos - half : pos + half + 1] += x[idx] * win
        wsum[pos - half : pos + half + 1] += win
        if pos - half >= length:  # 尾部的环绕部分
            break

    # 环绕折叠（循环必须首尾接得上）
    out = np.zeros(length)
    ws = np.zeros(length)
    head_a, head_w = acc[:half], wsum[:half]
    out[-half:] += head_a
    ws[-half:] += head_w
    body_a, body_w = acc[half : half + length], wsum[half : half + length]
    out += body_a
    ws += body_w
    tail_a, tail_w = acc[half + length :], wsum[half + length :]
    m = min(len(tail_a), length)
    out[:m] += tail_a[:m]
    ws[:m] += tail_w[:m]

    y = out / np.maximum(ws, 1e-6)

    # 电平对齐原 RMS（混音比例不能被拉长悄悄改掉）
    rms_in = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) or 1.0
    rms_out = float(np.sqrt(np.mean(y.astype(np.float64) ** 2))) or 1.0
    y *= rms_in / rms_out
    peak = float(np.abs(y).max())
    if peak > 0.98:
        y *= 0.98 / peak
    return y.astype(np.float32), float(f0_out)


# ------------------------------------------------------------------ 测量
def sync_average(x: np.ndarray, sr: int, f0: float, period: float | None = None) -> np.ndarray:
    """周期同步平均的一个周期波形（相位对齐后的「音色」）。"""
    p = period or sr / f0
    marks = period_marks(x, p)
    ln = int(round(p))
    acc = np.zeros(ln)
    cnt = 0
    for c in marks:
        idx = (np.arange(ln) + c) % len(x)
        acc += x[idx]
        cnt += 1
    return acc / max(1, cnt)


def measure(x: np.ndarray, sr: int, root: float) -> dict:
    import librosa

    f0, _, _ = librosa.pyin(x, fmin=70, fmax=1000, sr=sr, frame_length=2048, hop_length=128)
    ok = ~np.isnan(f0)
    std = float(np.std(1200 * np.log2(f0[ok] / root))) if ok.sum() > 8 else float("nan")
    # 周期同步平均的谐波幅度（音色的干净定义；逐 bin 的 LTAS 对块相位太敏感，
    # 上一版就是拿它量出 11 dB 的假差异）
    p = sr / root
    syn = sync_average(x, sr, root, p)
    spec = np.abs(np.fft.rfft(syn * np.hanning(len(syn))))
    harm = []
    for h in range(1, 12):
        lo = int(round(h * len(syn) / p)) - 1
        hi = lo + 3
        if hi < len(spec):
            harm.append(float(spec[lo:hi].max()))
    harm = np.array(harm)
    timbre = 20 * np.log10(harm / (harm[0] + 1e-12) + 1e-12)
    return dict(std=std, timbre=timbre, syn=syn)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="覆盖 public/voices（备份到 _orig_stretch/）")
    ap.add_argument("--factor", type=float, default=3.0, help="拉长倍数（默认 3×：0.32 s → 0.96 s）")
    ap.add_argument("--out", default=str(TMP), help="不 apply 时的输出目录")
    ap.add_argument("--only", default="", help="只做这几个音高，如 210,850")
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.apply:
        BACKUP.mkdir(parents=True, exist_ok=True)

    files = sorted(VOICES.glob("loop_[0-9]*.wav"))
    if args.only:
        want = [float(v) for v in args.only.split(",") if v.strip()]
        keep = []
        for f in files:
            root = float(json.loads(f.with_suffix(".json").read_text(encoding="utf-8"))["rootHz"])
            if any(abs(1200 * np.log2(root / w)) < 60 for w in want):
                keep.append(f)
        files = keep
    print(f"{'文件':16s}{'Hz':>7s}{'原长':>6s}{'新长':>6s}{'音高std':>8s}{'音色差dB':>9s}{'接缝':>7s}")
    rows = []
    for wav in files:
        meta = json.loads(wav.with_suffix(".json").read_text(encoding="utf-8"))
        root = float(meta["rootHz"])
        y, sr = sf.read(wav, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        try:
            y2, f0_out = stretch(y, sr, root, args.factor)
        except SystemExit as e:
            print(f"{wav.name:16s} 跳过：{e}")
            continue
        a = measure(y, sr, root)
        b = measure(y2, sr, f0_out)
        # 音色差：谐波幅度（相对 H1）的平均绝对差
        n = min(len(a["timbre"]), len(b["timbre"]))
        tdiff = float(np.mean(np.abs(a["timbre"][:n] - b["timbre"][:n])))
        # 接缝
        d = np.abs(np.diff(np.concatenate([y2, y2[:1]])))
        seam = float(d[-1] / (np.percentile(np.abs(np.diff(y2)), 99.9) + 1e-9))
        rows.append(dict(name=wav.name, root=root, f0_out=f0_out, tdiff=tdiff, seam=seam, len=len(y2)))
        print(
            f"{wav.name:16s}{root:7.1f}{len(y)/sr:6.2f}{len(y2)/sr:6.2f}"
            f"{b['std']:8.1f}{tdiff:9.2f}{seam:7.2f}"
        )
        if args.apply:
            shutil.copy2(wav, BACKUP / wav.name)
            sf.write(wav, y2, sr, subtype="PCM_16")
            meta2 = dict(meta)
            meta2.update(
                lengthSec=round(len(y2) / sr, 4),
                rootHz=round(f0_out, 2),
                periods=int(round(len(y2) / (sr / f0_out))),
                stretched=args.factor,
                method="td-psola-stretch",
            )
            wav.with_suffix(".json").write_text(
                json.dumps(meta2, ensure_ascii=False, indent=1), encoding="utf-8"
            )
        else:
            sf.write(out_dir / wav.name, y2, sr, subtype="PCM_16")

    if rows:
        print(
            f"\n{len(rows)} 段：音色差中位 {np.median([r['tdiff'] for r in rows]):.2f} dB，"
            f"接缝中位 {np.median([r['seam'] for r in rows]):.2f}×99.9 分位"
        )
    if args.apply:
        print("已覆盖 public/voices（同时更新 .json 的 lengthSec/rootHz/periods）")
    else:
        print(f"（只写了 {out_dir}；加 --apply 才覆盖）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
