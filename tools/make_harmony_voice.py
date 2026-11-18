#!/usr/bin/env python3
"""从 SVC 换音色的成品里抠一段「可循环的持续元音」，当和声的音色。

为什么不是直接播一段歌：和声要跟着旋律实时改音高，用不了现成的人声片段。
但**人声的长音是准周期信号**，抠一段出来首尾相接就能无限循环，再靠播放速率
改音高——这是采样器最老的办法，对「哼一个持续音」足够。
（要真正自然得做 PSOLA 重采样，那是 D2 实时变声那条线。）

怎么挑片段：
1. 按 0.35 s 窗、10 ms 步长粗扫，算能量和自相关基频；
2. 只保留「能量在前 30%」且「基频在窗口内变化 < 1.5%」的窗口；
3. 取能量最大的那个，把循环长度对齐到**整数个周期**（首尾相位连续，接缝不咔哒）；
4. 首尾各 6 ms 交叉淡化，抹掉残余的相位误差。

用法:
  python tools/make_harmony_voice.py --audio shots/svc/out_real30_refvoice2.wav \
      --out public/voices/harmony.wav --length 0.32
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np


def decode_mono(path: Path) -> tuple[np.ndarray, int]:
    import av

    with av.open(str(path)) as container:
        stream = container.streams.audio[0]
        sr = stream.rate
        chunks = []
        for frame in container.decode(stream):
            arr = frame.to_ndarray()
            if arr.ndim > 1:
                arr = arr.mean(axis=0)
            chunks.append(arr.astype(np.float64))
    data = np.concatenate(chunks) if chunks else np.zeros(1)
    # av 给的是 fltp，多数文件已在 [-1,1]；保险起见按峰值归一
    peak = float(np.max(np.abs(data))) or 1.0
    if peak > 1.5:
        data /= 32768.0
    return data, sr


def yin_f0(seg: np.ndarray, sr: int, fmin: float = 60.0, fmax: float = 1000.0,
           threshold: float = 0.15) -> float:
    """YIN 基频（累积均值归一化差分 + 抛物线插值）。

    为什么不用纯自相关：**它会锁到次谐波**。2026-11-14 实测，348 Hz 的片段
    被量成 157.6 Hz，于是循环长度按 157.6 Hz 的周期取整，播放出来整体低八度。
    YIN 的 CMND 阈值会先挑「第一个足够小的谷」，次谐波那个谷在它后面，选不到。
    """
    x = np.asarray(seg, dtype=np.float64)
    n = len(x)
    if n < 16:
        return 0.0
    x = x - x.mean()
    tau_min = max(2, int(sr / fmax))
    tau_max = min(n // 2, int(sr / fmin))
    if tau_max <= tau_min + 2:
        return 0.0
    nfft = 1 << int(np.ceil(np.log2(2 * n)))
    spec = np.fft.rfft(x, nfft)
    ac = np.fft.irfft(spec * np.conj(spec), nfft)[: n]
    energy = np.concatenate(([0.0], np.cumsum(x * x)))
    taus = np.arange(1, tau_max + 1)
    # d(τ) = Σ_{j=0}^{n-τ-1}(x_j - x_{j+τ})² = E[0:n-τ] + E[τ:n] - 2·ACF(τ)
    d = np.empty(tau_max + 1)
    d[0] = 0.0
    d[1:] = (energy[n - taus] - energy[0]) + (energy[n] - energy[taus]) - 2.0 * ac[taus]
    d = np.maximum(d, 0.0)
    cum = np.cumsum(d[1:])
    cmnd = np.ones(tau_max + 1)
    safe = cum > 1e-12
    cmnd[1:][safe] = d[1:][safe] * taus[safe] / cum[safe]
    cand = None
    for tau in range(tau_min, tau_max):
        if cmnd[tau] < threshold and cmnd[tau] <= cmnd[tau - 1] and cmnd[tau] <= cmnd[tau + 1]:
            cand = tau
            break
    if cand is None:
        cand = tau_min + int(np.argmin(cmnd[tau_min:tau_max]))
    a, b, c = cmnd[cand - 1], cmnd[cand], cmnd[cand + 1]
    den = a - 2 * b + c
    shift = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
    lag = cand + shift
    return sr / lag if lag > 0 else 0.0


def f0_of(seg: np.ndarray, sr: int) -> float:
    """单帧基频别名（保留旧名，内部走 YIN）。"""
    return yin_f0(seg, sr)


def f0_frames(seg: np.ndarray, sr: int, frame: float = 0.03, hop: float = 0.01) -> np.ndarray:
    """逐帧基频（YIN），60–1000 Hz。

    为什么要逐帧：判断一个窗「稳不稳」不能只看首尾。一个完整的颤音周期首尾
    几乎相等（差 <0.4%），中间却能摆 ±50 音分——旧版的漂移判据就是这么漏过去的
    （2026-11-14 实测 `harmony.wav` 窗内 215→226 Hz，而 `drift` 只有 0.0023）。
    """
    n = int(frame * sr)
    h = max(1, int(hop * sr))
    if len(seg) < n:
        return np.zeros(0)
    out = []
    for s in range(0, len(seg) - n + 1, h):
        f = yin_f0(seg[s : s + n], sr)
        if f > 0:
            out.append(f)
    return np.array(out)


def cents_spread(arr: np.ndarray) -> tuple[float, float]:
    """(p10–p90 跨度, 全跨度) 音分"""
    if len(arr) < 2:
        return 0.0, 0.0
    p10, p90 = np.percentile(arr, 10), np.percentile(arr, 90)
    spread = 1200.0 * np.log2(p90 / p10) if p10 > 0 else 0.0
    swing = 1200.0 * np.log2(arr.max() / arr.min()) if arr.min() > 0 else 0.0
    return float(spread), float(swing)


def third_octave(x: np.ndarray, sr: int, fmin: float = 125.0, fmax: float = 8000.0,
                 per_oct: int = 3):
    """倍频程长时谱（默认 1/3，`per_oct=1` 是整八度）。

    为什么要能切成整八度：1/3 倍频程的带宽（~26%）比谐波间距还窄，
    谱形会被**谐波位置**主导（267 Hz 的循环在 250 Hz 带最强，516 Hz 的在 1 kHz 带最强），
    拿它当匹配目标等于去对齐谐波，越对齐越怪。整八度一带有 2–8 根谐波，
    剩下的才是共振峰/倾斜（音色）。
    """
    n = 1 << int(np.floor(np.log2(max(2048, len(x)))))
    n = min(n, 1 << 15)
    hop = n // 2
    win = np.hanning(n)
    acc = np.zeros(n // 2 + 1)
    cnt = 0
    for s in range(0, max(1, len(x) - n), hop):
        seg = x[s:s + n]
        if len(seg) < n:
            break
        acc += np.abs(np.fft.rfft(seg * win, n)) ** 2
        cnt += 1
    psd = acc / max(1, cnt)
    fr = np.fft.rfftfreq(n, 1 / sr)
    step = 2 ** (1 / per_oct)
    half = 2 ** (1 / (2 * per_oct))
    centers = []
    f = fmin
    while f <= fmax:
        centers.append(f)
        f *= step
    centers = np.array(centers)
    bands = []
    for f0c in centers:
        m = (fr >= f0c / half) & (fr < f0c * half)
        bands.append(float(psd[m].sum()) if m.any() else 0.0)
    bands = np.array(bands)
    db = 10 * np.log10(bands + 1e-20)
    return centers, db - db.max()


def load_curve(path: str):
    doc = json.loads(Path(path).read_text(encoding="utf-8"))
    return np.array(doc["centers"], float), np.array(doc["db"], float)


def match_curve(seg: np.ndarray, sr: int, centers: np.ndarray, target_db: np.ndarray,
                limit_up: float = 3.0, limit_down: float = 12.0,
                hf_cut: float = 0.0) -> np.ndarray:
    """把循环的 1/3 倍频程包络拉到目标曲线上（零相位、**循环卷积**）。

    为什么必须循环卷积：这段是**整数个基音周期**的循环采样，接缝靠相位连续。
    线性滤波会把尾巴的余响甩到外面，接缝就断了；FFT 域直接乘增益等于
    循环卷积，接缝保持连续。

    为什么要做：2026-11-14 量出来六段的「2–4 kHz / 0.3–1 kHz」从 −20.8 dB 到
    −6.2 dB，差 14 dB——同一句里换两段循环，音色会明显跳一下，参数怎么调都救不回来。
    """
    c, db = third_octave(seg, sr, per_oct=1)
    # **只减不增**（`limit_up` 默认 +3 dB）：把暗的段往上抬会把它的本底噪声一起抬起来，
    # 听感就是「颗粒感」。2026-11-15 实测：258 Hz 那段对齐后 4–8 kHz 抬了 4.7 dB，
    # 2–8 kHz 谱平坦度从 −9.9 掉到 −10.5，整段变沙。现在最多 +3 dB，其余靠削亮的段收敛。
    gain = np.clip(target_db - db, -limit_down, limit_up)
    # 不额外平滑：整八度带本身就是平滑的，再和邻居平均一次会把需要 +12 dB 的带
    # 拉回 +6 dB（2026-11-15 实测：258 Hz 那段 2 kHz 只补到目标的 40%）。
    n = len(seg)
    fr = np.fft.rfftfreq(n, 1 / sr)
    g = np.interp(np.log2(np.maximum(fr, 1.0)), np.log2(c), gain, left=gain[0], right=0.0)
    if hf_cut > 0:
        # 高频缓降：4 kHz 起、8 kHz 到 −hf_cut，斜坡用余弦过渡（不产生新的边带）
        lo, hi = np.log2(4000.0), np.log2(8000.0)
        k = np.clip((np.log2(np.maximum(fr, 1.0)) - lo) / (hi - lo), 0.0, 1.0)
        g = g - hf_cut * (0.5 - 0.5 * np.cos(np.pi * k))
    spec = np.fft.rfft(seg) * (10 ** (g / 20))
    return np.fft.irfft(spec, n)


def f1_track(seg: np.ndarray, sr: int, frame: float = 0.04, hop: float = 0.02,
             order: int = 18) -> np.ndarray:
    """逐帧 LPC 最低共振峰（≈F1）轨迹。

    用户 2026-11-14：「长音里面存在不是a的部分」——音高稳、音量平的长音里，
    元音本身还在滑动。实测 loop_315 在 320 ms 内 F1 从 1176 漂到 1683 Hz，
    那就是「a 正在变成别的元音」，循环起来每个字都在换元音。
    """
    n = int(frame * sr)
    h = max(1, int(hop * sr))
    if len(seg) < n:
        return np.zeros(0)
    out = []
    for s in range(0, len(seg) - n + 1, h):
        x = np.asarray(seg[s:s + n], dtype=np.float64)
        x = np.append(x[0], x[1:] - 0.97 * x[:-1])
        x = x * np.hamming(len(x))
        r = np.correlate(x, x, "full")[len(x) - 1: len(x) + order]
        a = np.zeros(order + 1)
        a[0] = 1.0
        e = r[0]
        if e <= 1e-12:
            continue
        for i in range(1, order + 1):
            acc = r[i] + (np.dot(a[1:i], r[i - 1:0:-1]) if i > 1 else 0.0)
            k = -acc / e
            if i > 1:
                a[1:i] = a[1:i] + k * a[i - 1:0:-1]
            a[i] = k
            e *= (1 - k * k)
            if e <= 1e-12:
                break
        roots = np.roots(a)
        roots = roots[np.imag(roots) > 0]
        cands = []
        for z in roots:
            f = np.angle(z) / (2 * np.pi) * sr
            bw = -np.log(abs(z) + 1e-12) * sr / np.pi
            if 200 < f < 2000 and bw < 700:
                cands.append(f)
        if cands:
            out.append(min(cands))
    return np.array(out)


def vowel_tilt(seg: np.ndarray, sr: int, nsl: int = 3, dur: float = 0.06):
    """三个时间片的「中/高频相对低频」比值（dB），用来看元音有没有在变。

    为什么不用 LPC 的 F1：F1 和 F2 靠得近时会互相顶替，轨迹会跳（实测 loop_315
    的 F1 从 1176 跳到 1683，但谐波包络相关 0.97、频带比只差 1.7 dB —— 那是假象）。
    频带比只看**能量分布**，不受极点归属影响，和耳朵听到的「元音变没变」一致。
    """
    n = min(len(seg), int(dur * sr))
    if n < 512:
        return None
    out = []
    for i in range(nsl):
        start = int(i * (len(seg) - n) / max(1, nsl - 1)) if nsl > 1 else 0
        x = seg[start:start + n]
        nfft = 1 << 15
        spec = np.abs(np.fft.rfft(x * np.hanning(len(x)), nfft)) ** 2
        fr = np.fft.rfftfreq(nfft, 1 / sr)

        def e(lo, hi):
            m = (fr >= lo) & (fr < hi)
            return float(spec[m].sum())

        lo = e(500, 1200)
        out.append((10 * np.log10(e(1200, 2500) / max(lo, 1e-20)),
                    10 * np.log10(e(2500, 4000) / max(lo, 1e-20))))
    return np.array(out)


def flatten_env(seg: np.ndarray, sr: int, win_ms: float = 25.0, depth: float = 0.0) -> np.ndarray:
    """压掉 25 ms 尺度以下的音量抖动（「颗粒感」）。

    2026-11-15 实测：把循环按播放的方式连起来，量包络调制谱，
    新录音那几段在 **20–100 Hz** 的能量比白花里的 419 段高 6–12 dB——
    就是那股「沙/颗粒」的来源（SVC 逐帧增益抖动 + 录音本底）。
    这里用**循环**滑动平均（首尾环绕，不破坏接缝）算 25 ms 包络，
    再用它把快抖压强 `depth` 倍；慢的音量形状（>100 ms）保留。
    """
    if depth <= 0:
        return seg
    w = max(3, int(win_ms * 1e-3 * sr))
    k = np.ones(w) / w
    x2 = seg * seg
    pad = np.concatenate([x2[-w:], x2, x2[:w]])
    short = np.sqrt(np.convolve(pad, k, mode="same")[w:w + len(x2)] + 1e-12)
    w2 = min(len(x2), w * 5)
    k2 = np.ones(w2) / w2
    pad2 = np.concatenate([x2[-w2:], x2, x2[:w2]])
    long = np.sqrt(np.convolve(pad2, k2, mode="same")[w2:w2 + len(x2)] + 1e-12)
    gain = np.clip((short / long) ** (-depth), 0.4, 2.5)
    return seg * gain


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out", default="public/voices/harmony.wav")
    ap.add_argument("--length", type=float, default=0.32, help="循环长度（秒）")
    ap.add_argument("--min-hz", type=float, default=0.0, help="只找不低于这个基频的片段")
    ap.add_argument("--max-hz", type=float, default=1e9, help="只找不高于这个基频的片段")
    ap.add_argument("--units", default="", help="lyrics.units.json：按元音筛窗口")
    ap.add_argument("--offset", type=float, default=0.0, help="这个 wav 对应原曲的第几秒")
    ap.add_argument("--vowels", default="", help="允许的元音，逗号分隔（如 a；空 = 不筛）")
    ap.add_argument("--kana", default="", help="只挑这个假名开头的 mora（如 ら）")
    ap.add_argument(
        "--attack",
        action="store_true",
        help="不抠循环，改抠「起音」：从 mora 起点开始截一小段（含辅音），给和声每个字用",
    )
    ap.add_argument("--attack-ms", type=float, default=160.0, help="起音片段长度（毫秒）")
    ap.add_argument(
        "--max-spread",
        type=float,
        default=15.0,
        help="窗内基频 p10–p90 跨度上限（音分）。颤音会撑大这个数，默认 15",
    )
    ap.add_argument(
        "--max-swing",
        type=float,
        default=35.0,
        help="窗内基频极差上限（音分）",
    )
    ap.add_argument("--scan", type=int, default=0, help="只挑不写：打印前 N 个候选")
    ap.add_argument(
        "--max-level",
        type=float,
        default=0.3,
        help="窗内音量起伏上限（0.3 = 允许 0.7–1.3 倍中位数）。带衰减/渐强的窗不要",
    )
    ap.add_argument(
        "--match-curve",
        default="",
        help="谱线目标 JSON（{\"centers\":[...],\"db\":[...]}）：把循环的 1/3 倍频程包络拉平到它",
    )
    ap.add_argument(
        "--max-f1-drift",
        type=float,
        default=1e9,
        help="窗内第一共振峰的 p10–p90 漂移上限（Hz）。默认关闭：LPC 会在 F1/F2 之间跳，",
    )
    ap.add_argument(
        "--max-tilt",
        type=float,
        default=3.0,
        help="元音稳定性：三个时间片的「1.2–2.5k/0.5–1.2k」与「2.5–4k/0.5–1.2k」"
             "比值的最大变化（dB）。超了说明这个音里元音在滑",
    )
    ap.add_argument("--match-up", type=float, default=3.0,
                    help="谱线对齐最多往上抬多少 dB（默认 3，抬多了会把噪声一起抬起来）")
    ap.add_argument("--match-down", type=float, default=12.0,
                    help="谱线对齐最多往下削多少 dB")
    ap.add_argument("--hf-cut", type=float, default=9.0,
                    help="4–8 kHz 缓降多少 dB（压 SVC/录音的高频沙感，默认 9）")
    ap.add_argument("--flatten", type=float, default=0.0,
                    help="压掉 25 ms 尺度以下的音量抖动（0 = 不压，1 = 压满）；治「颗粒感」")
    args = ap.parse_args()

    # 元音/假名筛选：和声是「持续的咧嘴音」，两个样本的元音不一致的话，
    # 交叉淡化时元音会跟着变（一个 a 一个 o 听着像在换字）。
    #
    # 只给了 `--units` 也要读：`--scan` 时把每段候选的元音一起打出来，
    # 才能判断「这一段在唱 a 还是 o」（不给 --vowels 就只是标注，不筛）。
    want = {v.strip() for v in args.vowels.split(",") if v.strip()}
    morae: list[tuple[float, float, str, str]] = []
    if args.units:
        # 注意：这里**不能**写 `import json`——函数内任何 import 都会让 `json` 变成
        # 局部名，后面写 meta 时抛 UnboundLocalError（2026-11-14 踩过）。
        doc = json.loads(Path(args.units).read_text(encoding="utf-8"))
        for line in doc.get("lines", []):
            for u in line.get("units") or []:
                if isinstance(u.get("t"), (int, float)):
                    morae.append((u["t"], u.get("d") or 0.0, u.get("v") or "", u.get("ch") or ""))
        morae.sort()

    def mora_at(wav_seconds: float) -> tuple[str, str] | None:
        song_t = args.offset + wav_seconds
        for t, d, v, ch in morae:
            if t <= song_t <= t + d:
                return v, ch
        return None

    def vowel_at(wav_seconds: float) -> str:
        got = mora_at(wav_seconds)
        return got[0] if got else ""

    # 两种模式都要音频，先解了（起音模式不再重复解）
    data, sr = decode_mono(Path(args.audio))
    print(f"音频 {len(data) / sr:.1f}s @ {sr} Hz")

    # ---- 起音模式：从一个 mora 的**起点**截一小段（含辅音），不做循环 ----
    if args.attack:
        targets = [
            (t, d, v, ch)
            for t, d, v, ch in morae
            if (not args.kana or ch == args.kana)
            and (not want or v in want)
            and args.offset <= t <= args.offset + len(data) / sr - args.attack_ms / 1000
            and d >= args.attack_ms / 1000 * 0.8
        ]
        if not targets:
            print(f"没找到 kana={args.kana} 的 mora（窗口 {args.offset:.1f}s 起）", file=sys.stderr)
            return 1
        # 取第一个；后面的只报一下，方便挑
        print(f"候选 mora：{[round(t, 2) for t, *_ in targets][:8]}")
        song_t, dur, vowel, kana = targets[0]
        start = int((song_t - args.offset) * sr)
        n = int(args.attack_ms / 1000 * sr)
        seg = data[start : start + n].copy()
        if len(seg) < n * 0.8:
            print("素材不够长", file=sys.stderr)
            return 1
        # 尾巴 20 ms 淡出（避免切断爆音），开头不动（辅音的瞬态就靠它）
        fade = int(0.02 * sr)
        seg[-fade:] *= np.linspace(1.0, 0.0, fade)
        root = f0_of(seg[int(0.04 * sr) :], sr)
        if root <= 0:
            print("起音片段里没量到基频", file=sys.stderr)
            return 1
        peak = float(np.max(np.abs(seg))) or 1.0
        seg = seg * (0.71 / peak)

        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        pcm16 = (np.clip(seg, -1, 1) * 32767).astype(np.int16)
        import wave as wavemod

        with wavemod.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sr)
            w.writeframes(pcm16.tobytes())
        meta = {
            "kind": "attack",
            "source": Path(args.audio).name,
            "kana": kana,
            "vowel": vowel,
            "songTime": round(song_t, 2),
            "rootHz": round(root, 2),
            "lengthSec": round(len(seg) / sr, 4),
            "sampleRate": sr,
        }
        out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
        print(
            f"起音「{kana}」（{vowel}）@ {song_t:.2f}s，{len(seg) / sr * 1000:.0f} ms，"
            f"基频 {root:.1f} Hz → {out}"
        )
        return 0

    win = int(0.35 * sr)
    hop = int(0.01 * sr)
    # 整段先算一遍逐帧基频，窗内稳定性直接查表（逐窗重算慢几十倍）
    all_f0 = f0_frames(data, sr, frame=0.03, hop=0.01)
    best = None
    cands: list[dict] = []
    for start in range(0, max(1, len(data) - win), hop):
        seg = data[start : start + win]
        rms = float(np.sqrt(np.mean(seg * seg)))
        if rms <= 1e-4:
            continue
        # 窗内的帧，掐掉首尾各 50 ms，避免描边帧把跨度撑大
        pad = int(0.05 * sr)
        k0 = max(0, int((start + pad - 0.015 * sr) / hop))
        k1 = min(len(all_f0), int((start + win - pad - 0.015 * sr) / hop))
        frames = all_f0[k0:k1] if k1 > k0 else np.zeros(0)
        frames = frames[frames > 0]
        if len(frames) < 8:
            continue
        mid = float(np.median(frames))
        if mid < args.min_hz or mid > args.max_hz:
            continue
        # 稳定性用**逐帧跨度**判，不用首尾差：一个完整颤音周期首尾几乎相等，
        # 中间却能摆 ±50 音分。旧版判据（首尾差 <0.4%）就是这么漏掉颤音的。
        spread, swing = cents_spread(frames)
        if spread > args.max_spread or swing > args.max_swing:
            continue
        # **音量也要平**（2026-11-14：低音区那段 261 Hz 的循环，音量在窗内
        # 从 0.11× 摆到 3.09×，RMS 比 419 Hz 那段低 11 dB——它其实是一段
        # 「渐弱的尾音」，音高很稳但根本不是一个持续音，循环起来就是忽大忽小）。
        lvl = seg[pad : win - pad]
        lw = int(0.03 * sr)
        if len(lvl) <= lw:
            continue
        hops = np.sqrt(np.convolve(lvl * lvl, np.ones(lw) / lw, mode="valid")[:: int(0.01 * sr)])
        lmed = float(np.median(hops))
        if lmed <= 1e-4:
            continue
        lmin, lmax = float(hops.min() / lmed), float(hops.max() / lmed)
        if lmin < 1 - args.max_level or lmax > 1 + args.max_level:
            continue
        # 元音稳定性：三个时间片的频带比不能变（LPC 的 F1 不可靠，见 vowel_tilt）
        tilt = vowel_tilt(seg[pad : win - pad], sr)
        if tilt is not None:
            tilt_drift = float(np.max(tilt.max(axis=0) - tilt.min(axis=0)))
            if tilt_drift > args.max_tilt:
                continue
        else:
            tilt_drift = 0.0
        if want and vowel_at((start + win / 2) / sr) not in want:
            continue
        if args.kana and (mora_at((start + win / 2) / sr) or ("", ""))[1] != args.kana:
            continue
        drift = float(abs(frames[-1] - frames[0]) / frames[0]) if frames[0] > 0 else 0.0
        cand = {
            "start": start,
            "rms": rms,
            "f0": mid,
            "drift": drift,
            "spread": spread,
            "swing": swing,
            "frames": len(frames),
            "vowel": vowel_at(start / sr),
            "levelMin": lmin,
            "levelMax": lmax,
            "tiltDrift": round(tilt_drift, 2),
        }
        cands.append(cand)
        if best is None or rms > best["rms"]:
            best = cand

    if args.scan:
        cands.sort(key=lambda c: -c["rms"])
        print(
            f"候选 {len(cands)} 个（spread ≤ {args.max_spread} 音分，"
            f"swing ≤ {args.max_swing} 音分，{args.min_hz:.0f}–{args.max_hz:.0f} Hz）"
        )
        for c in cands[: args.scan]:
            print(
                f"  {c['start']/sr:7.2f}s  f0={c['f0']:6.1f}  "
                f"rms={20*np.log10(c['rms']):6.1f}dB  spread={c['spread']:5.1f}c  "
                f"swing={c['swing']:5.1f}c  frames={c['frames']}  vowel={c['vowel'] or '?'}"
            )
        return 0 if cands else 1

    if best is None:
        print("没找到稳定的长音；降低要求（把 drift 阈值放宽）或换一段素材", file=sys.stderr)
        return 1

    f0 = best["f0"]
    # 先按扫描估计粗取一段、量准根音，再按整数周期重取——两件事必须一致：
    # 长度按 f0 取整、根音又按长度重测的话，差几个音分接缝就错半个相位。
    #
    # 为什么不用 `f0_of`：那是**纯自相关取最大**，会锁到次谐波（2026-11-14：
    # 348 Hz 的片段量出 157.6 Hz，长度就按 157.6 的周期取了 112 个，全错）。
    # 逐帧中位数 + 抛物线插值才和播放时一致。
    seg = data[best["start"] : best["start"] + win].copy()
    loop_n = 0
    for _ in range(3):
        period = sr / f0
        loops = max(1, int(round(args.length * sr / period)))
        loop_n = int(round(loops * period))
        start = max(0, min(best["start"] + win // 2 - loop_n // 2, len(data) - loop_n - 1))
        seg = data[start : start + loop_n].copy()
        frames = f0_frames(seg, sr, 0.03, 0.01)
        frames = frames[frames > 0]
        if len(frames) < 3:
            break
        got = float(np.median(frames))
        if abs(12 * np.log2(got / f0)) > 1:
            print(f"警告：根音重测 {got:.1f} Hz 与扫描估计 {f0:.1f} Hz 差超过半音，按估计值写",
                  file=sys.stderr)
            break
        if abs(got - f0) < 0.01:
            f0 = got
            break
        f0 = got
    print(f"根音 {f0:.2f} Hz（{loops} 个周期，{len(seg)/sr*1000:.0f} ms）")

    # 最后再对齐一次：根音和循环长度必须出自**同一个** f0，否则接缝错相位
    period = sr / f0
    loops = max(1, int(round(args.length * sr / period)))
    loop_n = int(round(loops * period))
    start = max(0, min(best["start"] + win // 2 - loop_n // 2, len(data) - loop_n - 1))
    seg = data[start : start + loop_n].copy()

    # 首尾交叉淡化：拿「循环点之后真实的延续」和开头叠，**长度不变**。
    #
    # 旧版是拿尾巴叠开头、再把尾巴砍掉——一砍，长度就不再是整数个周期
    # （220 Hz 下 6 ms ≈ 1.3 个周期），接缝处相位直接跳一下。
    # 2026-11-14 实测：旧 harmony.wav 接缝跳变 0.081×RMS、harmony_hi 0.19×RMS，
    # 每圈响一次（3.2 / 4.4 Hz），听感像「同一个音高上多了个毛刺」。
    # 现在接缝处第一个样本就是真实的下一周期样本，连续。
    fade = min(int(0.006 * sr), loop_n // 8)
    if fade > 4:
        ext = data[start + loop_n : start + loop_n + fade]
        if len(ext) == fade:
            ramp = np.linspace(0.0, 1.0, fade)
            seg[:fade] = seg[:fade] * ramp + ext * (1 - ramp)
        else:
            # 循环点贴着文件尾，没有真实延续可借：退化成旧的尾巴叠开头
            ramp = np.linspace(0.0, 1.0, fade)
            seg[:fade] = seg[:fade] * ramp + seg[-fade:] * (1 - ramp)
            print("警告：循环点后面素材不够，接缝只能靠尾巴叠", file=sys.stderr)

    # **谱线对齐**：把这一段的 1/3 倍频程包络拉到目标曲线（六段音色统一）。
    # 放在 RMS 归一之前，后面的归一负责把电平拉回 −16 dBFS。
    if args.match_curve:
        centers, target_db = load_curve(args.match_curve)
        seg = match_curve(seg, sr, centers, target_db,
                          limit_up=args.match_up, limit_down=args.match_down, hf_cut=args.hf_cut)
        print(f"谱线已对齐到 {args.match_curve}（+{args.match_up}/−{args.match_down} dB，"
              f"高频再削 {args.hf_cut} dB）")

    if args.flatten > 0:
        seg = flatten_env(seg, sr, 25.0, args.flatten)
        print(f"音量抖动已压（depth {args.flatten}）")

    # **响度归一到固定 RMS**，不是峰值。
    #
    # 五段循环是交叉淡化混合的，音量不一致就等于偷偷改了混合比例：
    # 2026-11-14 实测旧的 loop_261 比 loop_419 低 **11 dB**，低音区听着
    # 「薄、虚、还有第二个声音」有一部分就是这个。峰值归一（−3 dBFS）只保证
    # 不削顶，不同元音/音区的 RMS 能差 10 dB 以上。
    target_rms = 10 ** (-16 / 20)  # −16 dBFS
    rms_now = float(np.sqrt(np.mean(seg ** 2))) or 1.0
    seg = seg * (target_rms / rms_now)
    peak = float(np.max(np.abs(seg))) or 1.0
    if peak > 0.95:  # 峰值兜底，别削顶
        seg = seg * (0.95 / peak)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(seg, -1, 1)
    pcm16 = (pcm * 32767).astype(np.int16)
    import wave as wavemod

    with wavemod.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm16.tobytes())

    meta = {
        "source": Path(args.audio).name,
        "rootHz": round(f0, 2),
        "lengthSec": round(len(seg) / sr, 4),
        "sampleRate": sr,
        "drift": round(best["drift"], 4),
        "spreadCents": round(best["spread"], 1),
        "swingCents": round(best["swing"], 1),
        "periods": loops,
        "startSec": round(best["start"] / sr, 3),
        # 这一段唱的是哪个元音：几段循环的元音不一致时，混合听起来像在换字
        "vowel": best.get("vowel") or "",
    }
    out.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    print(
        f"取 {start / sr:.2f}s 起 {len(seg) / sr * 1000:.0f} ms（{loops} 个周期），"
        f"基频 {f0:.1f} Hz，写入 {out} 和 {out.with_suffix('.json').name}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
