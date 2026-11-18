#!/usr/bin/env python3
"""用本机日语 TTS 的音节 + TD-PSOLA 改音高/时长来「唱」。

## 为什么换这条路

源-滤波器合成（`sing_synth.py`）的上限已经摸到了：辅音是手工拼的噪声/浊音段，
换成浊塞音/破擦音/拨音之后听感也没变好——问题不在分类，而在「用公式造辅音」
这件事本身。TTS 的音节是**真人录音驱动**的，辅音、协同发音、元音过渡都是自带的。

## 做法

1. 准备一份假名 → 音频的缓存（`shots/tts/kana/*.wav`，由 SAPI 的 Haruka 合成）
2. 对每个 mora：
   - 取该假名的音频，估 F0（复用 `extract_f0.yin`）
   - **TD-PSOLA**：按源音频的基音标记切片，在目标 F0 / 目标时长的位置叠回去
     —— 改音高不改共振峰，改时长不改音高
   - 套上 mora 的起落包络，放到时间轴上的 unit 位置
3. 拼接、归一化

## 用法

    py tools/tts_sing.py --pack <曲包目录> --kana shots/tts/kana --out out.wav
"""
from __future__ import annotations

import argparse
import os
import sys
import wave
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".pylibs"))

import numpy as np  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract_f0
import sing_synth as ss

SR = ss.SR
HOP = 256


def load_kana(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with wave.open(str(path)) as handle:
        assert handle.getframerate() == SR, f"{path} 采样率不是 {SR}"
        raw = handle.readframes(handle.getnframes())
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    x = trim_silence(x)
    rms = float(np.sqrt((x**2).mean())) or 1.0
    x = x / rms * 0.1
    f0, _clarity, _rms = extract_f0.yin(x.astype(np.float32))
    return x, f0


def trim_silence(x: np.ndarray, thresh_db: float = -40.0) -> np.ndarray:
    if len(x) < 1024:
        return x
    win, hop = 512, 128
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    e = np.sqrt((x[idx] ** 2).mean(axis=1))
    db = 20 * np.log10(e / (e.max() + 1e-9) + 1e-9)
    loud = np.flatnonzero(db > thresh_db)
    if len(loud) == 0:
        return x
    a = max(0, loud[0] * hop - 256)
    b = min(len(x), loud[-1] * hop + win + 256)
    return x[a:b]


def mark_positions(x: np.ndarray, f0: np.ndarray, sr: int, hop: int = HOP) -> np.ndarray:
    """基音标记：按 F0 的周期走，并对到波形的局部极值上（PSOLA 的「相位对齐」）。"""
    marks: list[int] = []
    t = 0
    n = len(x)
    while t < n:
        frame = min(len(f0) - 1, t // hop)
        f = float(f0[frame])
        if f < 60.0:
            # 清音段：按 8ms 走，标记置 0 表示「没有浊音标记」
            t += int(0.008 * sr)
            continue
        period = sr / f
        lo = int(max(0, t - period * 0.25))
        hi = int(min(n, t + period * 0.25))
        if hi > lo + 1:
            t = lo + int(np.argmax(np.abs(x[lo:hi])))
        marks.append(t)
        t = int(round(t + period))
    return np.array(marks, dtype=int)


def psola(
    x: np.ndarray,
    f0_src: np.ndarray,
    f0_tgt: np.ndarray,
    out_len: int,
    sr: int,
    hop: int = HOP,
    warp=None,
) -> np.ndarray:
    """把 x 改成「音高 = f0_tgt、长度 = out_len」，共振峰不变。

    `warp(t)` 给出输出时刻 t 对应的**源**时刻；不给就按线性缩放。
    """
    marks = mark_positions(x, f0_src, sr, hop)
    if len(marks) < 4 or out_len <= 16:
        return np.interp(np.linspace(0, len(x) - 1, out_len), np.arange(len(x)), x)

    out = np.zeros(out_len)
    wsum = np.zeros(out_len)   # 窗口叠加的权重和：用来消掉「叠加不均」造成的梳状起伏
    scale = len(x) / out_len
    t = 0.0
    while t < out_len:
        f = float(f0_tgt[min(out_len - 1, int(t))])
        step = sr / f if f > 40.0 else 0.005 * sr
        src_t = float(warp(t)) if warp is not None else t * scale
        src_t = min(max(src_t, 0.0), len(x) - 2.0)
        src_frame = min(len(f0_src) - 1, max(0, int(src_t) // hop))
        if f0_src[src_frame] < 60.0:
            # 清音（辅音）段：不要拿最近的基音标记去填——那会把辅音换成浊音。
            # 直接在源位置取一小段原样搬过来。
            c = int(src_t)
            half = int(0.004 * sr)
            a, b = max(0, c - half), min(len(x), c + half)
            if b > a:
                seg = x[a:b]
                win = np.hanning(len(seg))
                o0 = int(round(t)) - (c - a)
                lo = max(0, -o0)
                hi = min(len(seg), out_len - o0)
                if hi > lo:
                    out[o0 + lo : o0 + hi] += seg[lo:hi] * win[lo:hi]
                    wsum[o0 + lo : o0 + hi] += win[lo:hi]
            t += 0.004 * sr
            continue

        k = int(np.searchsorted(marks, src_t))
        cand = [c for c in (k - 1, k) if 0 <= c < len(marks)]
        m = int(marks[min(cand, key=lambda c: abs(marks[c] - src_t))])
        pf = float(f0_src[min(len(f0_src) - 1, m // hop)])
        if pf < 60.0:
            pf = 200.0
        half = max(32, int(sr / pf))
        a, b = max(0, m - half), min(len(x), m + half)
        seg = x[a:b]
        if len(seg) < 8:
            t += step
            continue
        win = np.hanning(len(seg))
        o0 = int(round(t)) - (m - a)
        lo = max(0, -o0)
        hi = min(len(seg), out_len - o0)
        if hi > lo:
            out[o0 + lo : o0 + hi] += seg[lo:hi] * win[lo:hi]
            wsum[o0 + lo : o0 + hi] += win[lo:hi]
        t += step
    return out / np.maximum(wsum, 0.15)


def logmel_feats(x: np.ndarray, hop: int = 512, win: int = 1024, n_mel: int = 40) -> np.ndarray:
    """(n_mel, frames) 的 log-mel，做逐帧归一化后用于 DTW。"""
    if len(x) < win:
        x = np.pad(x, (0, win - len(x)))
    n = 1 + (len(x) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(win), axis=1)) ** 2
    freqs = np.fft.rfftfreq(win, 1.0 / SR)

    def hz2mel(f):
        return 2595 * np.log10(1 + f / 700)

    def mel2hz(m):
        return 700 * (10 ** (m / 2595) - 1)

    edges = mel2hz(np.linspace(hz2mel(80.0), hz2mel(7600.0), n_mel + 2))
    bins = np.floor(edges / SR * win).astype(int)
    fb = np.zeros((n_mel, spec.shape[1]))
    for m in range(n_mel):
        lo, ce, hi = bins[m], max(bins[m + 1], bins[m] + 1), max(bins[m + 2], bins[m + 1] + 1)
        fb[m, lo:ce] = np.linspace(0, 1, max(1, ce - lo))[: len(fb[m, lo:ce])]
        fb[m, ce:hi] = np.linspace(1, 0, max(1, hi - ce))[: len(fb[m, ce:hi])]
    mel = np.log(spec @ fb.T + 1e-8).T
    mel = mel - mel.mean(axis=0, keepdims=True)
    return mel / (np.linalg.norm(mel, axis=0, keepdims=True) + 1e-9)


def dtw_map(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """把源序列 A 对齐到目标序列 B，返回长度 = B 的帧数，值是 A 的帧号（单调）。"""
    n, m = A.shape[1], B.shape[1]
    cost = 1.0 - A.T @ B                       # n × m，余弦距离
    inf = 1e18
    acc = np.full((n, m), inf)
    ptr = np.zeros((n, m), dtype=np.int8)
    acc[0, 0] = cost[0, 0]
    for i in range(1, n):
        acc[i, 0] = acc[i - 1, 0] + cost[i, 0]
    for j in range(1, m):
        acc[0, j] = acc[0, j - 1] + cost[0, j]
    for i in range(1, n):
        row = cost[i]
        for j in range(1, m):
            diag = acc[i - 1, j - 1]
            up = acc[i - 1, j]
            left = acc[i, j - 1]
            if diag <= up and diag <= left:
                acc[i, j] = diag + row[j]
                ptr[i, j] = 2
            elif up <= left:
                acc[i, j] = up + row[j]
                ptr[i, j] = 0
            else:
                acc[i, j] = left + row[j]
                ptr[i, j] = 1

    path = np.zeros(m, dtype=int)
    i, j = n - 1, m - 1
    while j >= 0:
        path[j] = i
        if i == 0 and j == 0:
            break
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            p = ptr[i, j]
            if p == 2:
                i, j = i - 1, j - 1
            elif p == 0:
                i -= 1
            else:
                j -= 1
    return np.maximum.accumulate(path)


def render_lines(pack: Path, lines_dir: Path, t_from, t_to) -> np.ndarray:
    """逐行 TTS + 用原唱人声做 DTW 对齐，再把整行「唱」出来。"""
    import json

    meta_path = Path(__file__).resolve().parent.parent / "shots" / "tts" / "lines.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    lines, f0_data = ss.load_pack(pack)
    duration = float(f0_data["duration"])
    total = int(duration * SR) + SR
    track = ss.f0_track(f0_data, total)
    out = np.zeros(total)

    orig = extract_f0.decode_mono(str(pack / "stems" / "vocals.mp3"), SR)
    hop = 512
    done = 0
    for item in meta:
        idx = int(item["i"])
        t0, t1 = float(item["t0"]), float(item["t1"])
        path = lines_dir / f"line{idx}.wav"
        if not path.exists():
            continue
        tts, f0s = load_kana(path)
        i0, i1 = int(t0 * SR), min(total, int(t1 * SR))
        out_len = i1 - i0
        if out_len <= 64:
            continue

        x0, x1 = max(0, i0 - 2048), min(len(orig), i1 + 2048)
        A = logmel_feats(tts, hop)
        B = logmel_feats(orig[x0:x1], hop)
        m = B.shape[1]
        if m < 4 or A.shape[1] < 4:
            continue
        src_frame = dtw_map(A, B)
        tgt_times = t0 + (np.arange(m) * hop) / SR
        src_times = (src_frame * hop) / SR

        def warp(t_local, tgt_times=tgt_times, src_times=src_times, t0=t0):
            return float(np.interp(t0 + t_local / SR, tgt_times, src_times))

        seg = psola(tts, f0s, track[i0:i1], out_len, SR, warp=warp)
        fade = int(0.02 * SR)
        env = np.ones(out_len)
        if out_len > 2 * fade:
            env[:fade] = np.linspace(0.0, 1.0, fade)
            env[-fade:] = np.linspace(1.0, 0.0, fade)
        out[i0:i1] += seg * env
        done += 1

    peak = float(np.max(np.abs(out))) or 1.0
    out *= 0.5 / peak
    print(f"{done} 行用 TTS + DTW 对齐渲染，{len(out)/SR:.1f}s")
    if t_from is not None or t_to is not None:
        a = int((t_from or 0.0) * SR)
        b = int((t_to if t_to is not None else len(out) / SR) * SR)
        out = out[max(0, a) : max(0, b)]
        print(f"导出片段 {a/SR:.2f}–{b/SR:.2f}s")
    return out


def render(pack: Path, kana_dir: Path, t_from: float | None, t_to: float | None) -> np.ndarray:
    lines, f0_data = ss.load_pack(pack)
    duration = float(f0_data["duration"])
    total = int(duration * SR) + SR
    track = ss.f0_track(f0_data, total)
    out = np.zeros(total)

    units = ss.morae_of(lines)
    cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    missing = set()
    placed = 0

    for index, (start, dur, vowel, kana) in enumerate(units):
        i0 = int(start * SR)
        n = int(dur * SR)
        i1 = min(total, i0 + n)
        n = i1 - i0
        if n <= 32 or vowel == "" or not kana:
            continue
        path = kana_dir / f"{kana}.wav"
        if kana not in cache:
            if not path.exists():
                missing.add(kana)
                continue
            cache[kana] = load_kana(path)
        x, f0s = cache[kana]

        prev = units[index - 1] if index > 0 else None
        nxt = units[index + 1] if index + 1 < len(units) else None
        legato_in = prev is not None and (start - (prev[0] + prev[1])) < 0.02
        legato_out = nxt is not None and (nxt[0] - (start + dur)) < 0.02

        # 连唱处做交叉淡化：后一个 mora 的尾巴延伸 fade 个采样，和前一个的
        # 淡入叠在一起（sin²+cos²=1）。不做的话每个 mora 边界都是一次台阶，
        # 频谱上就是一排竖条，听感「一顿一顿」。
        fade = int(0.012 * SR)
        ext = 0 if legato_out else fade
        n_ext = n + ext
        seg = psola(x, f0s, track[i0 : i0 + n_ext], n_ext, SR)
        env = np.ones(n_ext)
        if legato_in:
            env[:fade] *= np.sin(np.linspace(0.0, np.pi / 2, fade)) ** 2
        else:
            env[:fade] *= np.linspace(0.0, 1.0, fade)
        if ext:
            env[-fade:] *= np.cos(np.linspace(0.0, np.pi / 2, fade)) ** 2
        else:
            env[-fade:] *= np.linspace(1.0, 0.0, fade)

        end = min(total, i0 + n_ext)
        out[i0:end] += seg[: end - i0] * env[: end - i0]
        placed += 1

    if missing:
        print(f"缺 {len(missing)} 个假名样本: {''.join(sorted(missing))}")

    peak = float(np.max(np.abs(out))) or 1.0
    out *= 0.5 / peak
    print(f"{placed} 个 mora 用 TTS 音节渲染，{len(out)/SR:.1f}s")

    if t_from is not None or t_to is not None:
        a = int((t_from or 0.0) * SR)
        b = int((t_to if t_to is not None else len(out) / SR) * SR)
        out = out[max(0, a) : max(0, b)]
        print(f"导出片段 {a/SR:.2f}–{b/SR:.2f}s")
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="TTS 音节 + PSOLA 的「唱」法")
    ap.add_argument("--pack", required=True)
    ap.add_argument("--kana", default="shots/tts/kana", help="假名样本目录（mora 模式）")
    ap.add_argument("--lines", default="shots/tts/lines", help="整行样本目录（line 模式）")
    ap.add_argument("--mode", choices=("mora", "line"), default="mora")
    ap.add_argument("--out", required=True)
    ap.add_argument("--from", dest="t_from", type=float, default=None)
    ap.add_argument("--to", dest="t_to", type=float, default=None)
    args = ap.parse_args()

    pack = Path(args.pack)
    root = Path(__file__).resolve().parent.parent

    def resolve(p: str) -> Path:
        q = Path(p)
        return q if q.is_absolute() else (root / q)

    if args.mode == "line":
        signal = render_lines(pack, resolve(args.lines), args.t_from, args.t_to)
    else:
        signal = render(pack, resolve(args.kana), args.t_from, args.t_to)
    path = resolve(args.out)
    path.parent.mkdir(parents=True, exist_ok=True)
    ss.write_any(path, signal)
    print(f"写入 {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
