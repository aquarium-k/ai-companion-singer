#!/usr/bin/env python3
"""用提取出来的 F0 + mora 时间轴，合成一版「角色唱的人声」。

这是什么，不是什么
------------------
这是**源-滤波器**（source-filter）的共振峰合成，不是神经歌声合成：

- 声源：一串谐波（锯齿波近似），基频来自 `tools/extract_f0.py` 的 F0 曲线；
- 滤波器：每个元音给三组共振峰（F1/F2/F3），把谐波幅度塑形成那个元音的音色；
- 时长/断句：来自 `lyrics.units.json` 的 mora 时间轴。

所以它能做对**音高、节奏、元音**三件事，做不对辅音和换气——
听感接近「初代 VOCALOID」那一档。要不要走这条路，先听一版再定。

用法
----
    python tools/sing_synth.py --pack public/songpacks/xxx --out out.wav
    python tools/sing_synth.py --pack ... --vibrato 0 --gain 0.9
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path

import numpy as np

SR = 22050
HARMONICS = 28
#: 换元音时的共振峰过渡时长（秒）。0 = 瞬切（听感机械）
GLIDE_SECONDS = 0.055

# 元音共振峰（Hz）：F1 F2 F3
FORMANTS = {
    "a": (800.0, 1200.0, 2600.0),
    "i": (320.0, 2300.0, 3000.0),
    "u": (380.0, 1300.0, 2500.0),
    "e": (520.0, 1900.0, 2600.0),
    "o": (520.0, 900.0, 2400.0),
    "n": (300.0, 1200.0, 2500.0),
    "": (0.0, 0.0, 0.0),
}

# 每个共振峰的相对增益和带宽（带宽用 log2 空间里的半宽）
FORMANT_GAIN = (1.0, 0.55, 0.30)
FORMANT_BW = (0.22, 0.26, 0.30)


def envelope_tracks(freqs_k: np.ndarray, centres: list[np.ndarray]) -> np.ndarray:
    """按**逐采样点的**共振峰中心算谱包络。

    为什么不是「两个元音的包络交叉淡化」：包络是在**当前元音的谐波位置**上
    采样的，换一个元音，那批频率点正好落在别人的共振峰之间，值会掉到 0.03。
    于是每个 mora 开头都有 55ms 几乎没声音——实测 RMS 从 0.061 掉到 0.020。
    正确做法是让共振峰中心自己动，谐波增益跟着重新算。
    """
    log_f = np.log2(np.maximum(freqs_k, 1.0))
    out = np.full_like(freqs_k, 0.03)
    for centre, gain, bw in zip(centres, FORMANT_GAIN, FORMANT_BW):
        offset = log_f - np.log2(np.maximum(centre, 1.0))[None, :]
        out += gain * np.exp(-(offset**2) / (2 * bw**2))
    for centre, gain, bw in zip(centres, (0.5, 0.4, 0.35), (0.9, 0.9, 0.9)):
        offset = log_f - np.log2(np.maximum(centre, 1.0))[None, :]
        out += gain * 0.35 * np.exp(-(offset**2) / (2 * bw**2))
    return out


def formant_tracks(vowel: str, prev_vowel: str, n: int, span: int) -> list[np.ndarray]:
    """这一 mora 里每个采样点的 F1/F2/F3。

    和上一个元音不同时，前 `span` 个点在对数频率上从上一个滑过来
    （共振峰按比例移动，直接线性插值会在高频偏得厉害）。
    """
    current = FORMANTS.get(vowel) or FORMANTS["a"]
    previous = FORMANTS.get(prev_vowel)

    if previous and prev_vowel != vowel and span > 2 and all(f > 0 for f in previous):
        weight = np.ones(n)
        weight[:span] = 0.5 - 0.5 * np.cos(np.linspace(0.0, np.pi, span))
        return [
            np.exp2(np.log2(p) * (1.0 - weight) + np.log2(c) * weight)
            for p, c in zip(previous, current)
        ]
    return [np.full(n, c) for c in current]


def envelope(freq: np.ndarray, vowel: str) -> np.ndarray:
    """单点包络（画图/调试用）。"""
    formants = FORMANTS.get(vowel)
    if formants is None:
        formants = FORMANTS["a"]
    if vowel == "" or formants[0] <= 0:
        return np.zeros_like(freq)
    n = len(freq)
    return envelope_tracks(
        np.asarray(freq, dtype=np.float64).reshape(1, -1),
        [np.full(n, c) for c in formants],
    ).reshape(-1)


def load_pack(pack: Path) -> tuple[list[dict], dict]:
    units_path = pack / "lyrics.units.json"
    f0_path = pack / "work" / "f0.json"
    if not units_path.exists():
        raise SystemExit(f"缺少 {units_path}（先跑 build_units）")
    if not f0_path.exists():
        raise SystemExit(f"缺少 {f0_path}（先跑 tools/extract_f0.py）")

    units = json.loads(units_path.read_text(encoding="utf-8"))
    f0 = json.loads(f0_path.read_text(encoding="utf-8"))
    return units.get("lines", []), f0


def f0_track(f0_data: dict, total_samples: int) -> np.ndarray:
    """把帧级 F0 上采样成逐采样点，清音处沿用上一个浊音值。"""
    frames = f0_data["frames"]
    hop_s = f0_data["hop"] / f0_data["sr"]
    times = np.array([f[0] for f in frames], dtype=np.float64)
    values = np.array([f[1] for f in frames], dtype=np.float64)

    voiced = values > 0
    if not voiced.any():
        return np.full(total_samples, 220.0)

    # 用「上一个浊音值」填充空洞，再线性插值到采样点
    idx = np.where(voiced, np.arange(len(values)), -1)
    np.maximum.accumulate(idx, out=idx)
    idx[0] = max(idx[0], 0)
    filled = values[np.maximum(idx, 0)]
    filled[~voiced & (idx < 0)] = 220.0

    # 采样点 -> 时间 -> 帧位置
    sample_times = np.arange(total_samples) / SR
    return np.interp(sample_times, times, filled)


def morae_of(lines: list[dict]) -> list[tuple[float, float, str, str]]:
    """把歌词里所有 mora 摊平成按时间排序的 (起, 时长, 元音, 假名)。

    逐行嵌套遍历拿不到「跨行」的上下文，而连唱/换气恰恰跨行——
    「这一行最后一句」和「下一行第一句」之间是不是连着，决定要不要断开。
    """
    units: list[tuple[float, float, str, str]] = []
    for line in lines:
        for unit in line.get("units") or []:
            start = float(unit["t"])
            dur = float(unit["d"])
            vowel = str(unit.get("v") or "a")
            kana = str(unit.get("ch") or "")
            if dur <= 0.02:
                continue
            units.append((start, dur, vowel, kana))
    units.sort(key=lambda item: item[0])
    return units


# ---------------------------------------------------------------------------
# 辅音
# ---------------------------------------------------------------------------

# 假名 → (类型, 能量中心 Hz)。类型决定用哪种噪声/浊音模型。
# 只按**行**分：日语里同一行的辅音发音位置接近，够用了。
_STOP_K = ("stop", 2400.0)
_STOP_T = ("stop", 3600.0)
_STOP_P = ("stop", 1300.0)
_FRIC_S = ("fric", 6200.0)
_FRIC_SH = ("fric", 4200.0)
_FRIC_H = ("fric", 2200.0)
_FRIC_F = ("fric", 1700.0)     # ふ [ɸ]：双唇擦音，能量低、偏低频
_FRIC_C = ("fric", 3000.0)     # ひ [ç]：硬腭擦音
_FRIC_Z = ("fric", 5000.0)     # ざ行：齿龈擦音，靠 5k 附近
_AFF_T = ("affricate", 4200.0)   # ち [tɕ]
_AFF_TS = ("affricate", 5200.0)  # つ [ts]
_AFF_J = ("affricate", 3800.0)   # じ [dʑ]
_AFF_DZ = ("affricate", 5000.0)  # づ [dz]
_STOP_G = ("stop_voiced", 2200.0)  # が行：浊塞音，有前浊
_STOP_D = ("stop_voiced", 3200.0)  # だ行
_STOP_B = ("stop_voiced", 1000.0)  # ば行
_NASAL = ("nasal", 300.0)
_TAP = ("tap", 320.0)
_MORAIC_N = ("moraic_nasal", 0.0)  # ん：整个 mora 都是鼻音

_KANA_CONS: dict[str, tuple[str, float]] = {}
for _chars, _kind in (
    ("かきくけこ", _STOP_K),
    ("がぎぐげご", _STOP_G),
    ("さすせそ", _FRIC_S),
    ("ざずぜぞ", _FRIC_Z),
    ("し", _FRIC_SH),
    ("じ", _AFF_J),
    ("たちてと", _STOP_T),
    ("だぢでど", _STOP_D),
    ("つ", _AFF_TS),
    ("ち", _AFF_T),
    ("づ", _AFF_DZ),
    ("はへほ", _FRIC_H),
    ("ひ", _FRIC_C),
    ("ふ", _FRIC_F),
    ("ばびぶべぼ", _STOP_B),
    ("ぱぴぷぺぽ", _STOP_P),
    ("なにぬねの", _NASAL),
    ("まみむめも", _NASAL),
    ("らりるれろ", _TAP),
    ("ん", _MORAIC_N),
    ("やゆよ", ("glide", 0.0)),
    ("わを", ("glide", 0.0)),
):
    for _ch in _chars:
        _KANA_CONS[_ch] = _kind

#: 各类型的持续时长（秒）。塞音包含闭塞段 + 爆破点，所以比单看「爆破」要长。
#: 塞音闭塞从 32ms 提到 50ms：真人唱的时候闭塞段更接近这个量级，太短会让
#: 能量包络几乎没有凹陷（seed-vc 那边反馈的「包络太平」有一部分来自这里）。
_CONS_DUR = {
    "stop": 0.050,
    "stop_voiced": 0.055,
    "fric": 0.080,
    "affricate": 0.075,
    "nasal": 0.050,
    "tap": 0.035,
    "moraic_nasal": 0.0,   # 占满整个 mora，不单独切一段
    "glide": 0.0,
}


def consonant_of(kana: str) -> tuple[str, float, float] | None:
    """假名 → (类型, 中心频率, 时长)。元音开头的 mora 返回 None。"""
    if not kana:
        return None
    head = kana[0]
    kind = _KANA_CONS.get(head)
    if kind is None or kind[0] == "glide":
        return None
    return kind[0], kind[1], _CONS_DUR[kind[0]]


def noise_band(n: int, centre: float, width_oct: float, rng: np.random.Generator) -> np.ndarray:
    """带通白噪声：在 log2 频率上做一个高斯包络。"""
    if n <= 1:
        return np.zeros(max(n, 0))
    white = rng.normal(0.0, 1.0, n)
    spectrum = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    shape = np.exp(-((np.log2(np.maximum(freqs, 1.0) / centre)) ** 2) / (2 * width_oct**2))
    shape[freqs < 120.0] = 0.0
    out = np.fft.irfft(spectrum * shape, n)
    peak = float(np.max(np.abs(out))) or 1.0
    return out / peak


def voiced_hum(freqs: np.ndarray, formants: tuple[float, float, float], harmonics: int = 7) -> np.ndarray:
    """浊辅音（鼻音、闪音）用低次谐波凑一个「闷」的声源。"""
    n = len(freqs)
    k = np.arange(1, harmonics + 1)
    freqs_k = k[:, None] * freqs[None, :]
    centres = [np.full(n, c) for c in formants]
    gains = envelope_tracks(freqs_k, centres) * (1.0 / k)[:, None] ** 0.8
    phases = np.cumsum(2 * np.pi * freqs_k / SR, axis=1)
    return (gains * np.sin(phases)).sum(axis=0)


def make_consonant(
    kind: str,
    centre: float,
    n: int,
    freqs: np.ndarray,
    rng: np.random.Generator,
) -> np.ndarray:
    """生成一段辅音。n = 采样点数，freqs = 这段的音高轨迹。"""
    out = np.zeros(n)
    if n <= 4:
        return out

    if kind == "stop":
        # 闭塞（静音）占前 60%，然后一个 8ms 的爆破。
        # 闭塞太短的话，一段唱下来能量包络几乎是直线（缺凹陷）。
        close = int(n * 0.60)
        burst_len = min(n - close, int(0.008 * SR))
        if burst_len > 2:
            burst = noise_band(burst_len, centre, 0.55, rng)
            decay = np.exp(-np.linspace(0.0, 5.0, burst_len))
            out[close : close + burst_len] = burst * decay * 0.7

    elif kind == "stop_voiced":
        # 浊塞音（が/だ/ば）：闭塞段不是真静音，而是**低电平的浊音**（前浊），
        # 然后爆破也比清塞音软。以前按清塞音做，听起来就成了 か/た/ぱ。
        close = int(n * 0.60)
        if close > 4:
            out[:close] = voiced_hum(freqs[:close], (250.0, 900.0, 2200.0)) * 0.12
        burst_len = min(n - close, int(0.010 * SR))
        if burst_len > 2:
            burst = noise_band(burst_len, centre, 0.55, rng)
            decay = np.exp(-np.linspace(0.0, 4.0, burst_len))
            out[close : close + burst_len] = burst * decay * 0.35

    elif kind == "affricate":
        # 破擦音（ち/つ/じ/づ）：闭塞 + 一段**摩擦**（不是 8ms 的爆破）。
        # 以前 ち/つ 按塞音做，听感是「咔」一下而不是「嗤」。
        close = int(n * 0.45)
        fric_len = n - close
        if fric_len > 4:
            noise = noise_band(fric_len, centre, 0.75, rng)
            env = np.minimum(1.0, np.linspace(0.0, 1.0, fric_len) * 8.0)
            env *= np.exp(-np.linspace(0.0, 1.6, fric_len))
            out[close:] = noise * env * 0.30

    elif kind == "moraic_nasal":
        # 拨音 ん：整个 mora 都是鼻音（浊音 + 鼻共振峰），不能当元音处理
        out = voiced_hum(freqs, (250.0, 1100.0, 2400.0)) * 0.55
        out *= np.minimum(1.0, np.linspace(0.0, 1.0, n) * 6.0)

    elif kind == "fric":
        noise = noise_band(n, centre, 0.9, rng)
        # 摩擦音本身有起伏，加一点慢速调制避免像白噪声
        t = np.arange(n) / SR
        mod = 0.75 + 0.25 * np.sin(2 * np.pi * 23.0 * t)
        ramp = np.minimum(1.0, np.linspace(0.0, 1.0, n) * 6.0)
        out = noise * mod * ramp * 0.22

    elif kind == "nasal":
        out = voiced_hum(freqs, (300.0, 1200.0, 2500.0)) * 0.75
        # 鼻音没有爆破，起音要软
        out *= np.minimum(1.0, np.linspace(0.0, 1.0, n) * 4.0)

    elif kind == "tap":
        out = voiced_hum(freqs, (400.0, 1400.0, 2600.0)) * 1.0
        out *= np.exp(-np.linspace(0.0, 3.5, n))

    return out


def mora_env(length: int, attack: bool, release: bool) -> np.ndarray:
    """一个 mora 的起落包络（只在非连唱时做 20ms 起 / 40ms 落）。"""
    env = np.ones(length)
    if attack:
        a = min(length, max(1, int(0.02 * SR)))
        env[:a] = np.linspace(0.0, 1.0, a)
    if release:
        r = max(1, int(0.04 * SR))
        if r < length:
            env[-r:] = np.linspace(1.0, 0.0, r)
    return env


def synthesize(
    lines: list[dict],
    f0_data: dict,
    vibrato: float,
    total_seconds: float,
    vowel_offset: float | None = None,
) -> np.ndarray:
    total = int(total_seconds * SR) + SR
    track = f0_track(f0_data, total)
    out = np.zeros(total, dtype=np.float64)

    units = morae_of(lines)
    # 相位累积：跨 mora 连续，避免每个音都从 0 相位重新起振（会有咔哒声）
    phase = 0.0

    # 共振峰过渡的时长：真实演唱里换元音大约要 40-70ms
    glide = int(GLIDE_SECONDS * SR)

    for index, (start, dur, vowel, kana) in enumerate(units):
        i0 = int(start * SR)
        n = int(dur * SR)
        if n <= 8 or i0 >= total:
            continue
        i1 = min(total, i0 + n)
        n = i1 - i0

        prev_start, prev_dur, prev_vowel = (
            (units[index - 1][0], units[index - 1][1], units[index - 1][2])
            if index > 0
            else (None, 0.0, "")
        )
        next_start = units[index + 1][0] if index + 1 < len(units) else None

        # 连唱还是不连唱：间隔在 20ms 内就当同一条气。
        # 以前每个 mora 都独立做 20ms 起 + 40ms 落，连续音节之间会出现
        # 一次骤降再抬起——这是「机器念字」而不是「唱」的主要原因。
        legato_in = prev_start is not None and (start - (prev_start + prev_dur)) < 0.02
        legato_out = next_start is not None and (next_start - (start + dur)) < 0.02

        freqs = track[i0:i1].copy()

        # 颤音：真实演唱本来就有，但我们的 F0 分辨率只有 11.6ms，
        # 补一点点 5.5Hz 的调制会更像「唱」而不是「电子音」
        if vibrato > 0 and dur > 0.18:
            t = np.arange(n) / SR
            rate = 5.5
            depth = vibrato * np.minimum(1.0, (dur - 0.18) / 0.2)
            freqs *= 1.0 + depth * np.sin(2 * np.pi * rate * t)

        env_note = mora_env(n, not legato_in, not legato_out)

        f1 = float(np.median(freqs))
        harmonics = min(HARMONICS, max(1, int((SR * 0.45) / max(f1, 1.0))))
        if vowel == "" or f1 <= 0:
            # 促音 っ：真静音（以前留了一点气声，等于没停）
            continue

        # ---- 辅音：在元音之前 ----
        # 让音节「有起音的边界」，这是能不能听出唱什么词的关键。
        consonant = consonant_of(kana)

        # ん：整个 mora 是鼻音，没有「元音 + 辅音」的结构，单独处理
        if consonant and consonant[0] == "moraic_nasal":
            v_start = i0 if vowel_offset is None else i0 + int(round(vowel_offset * SR))
            v_start = max(0, min(v_start, i1 - 16))
            vn = i1 - v_start
            if vn > 8:
                hum = make_consonant(
                    "moraic_nasal", 0.0, vn, track[v_start:i1], np.random.default_rng(23 + index)
                )
                out[v_start:i1] += hum * mora_env(vn, not legato_in, not legato_out)
            continue

        cons_n = 0
        if consonant and dur > 0.12:
            kind, centre, length = consonant
            cons_n = min(int(length * SR), int(n * 0.55))

        # 元音起点：默认 = mora 起点 + 辅音时长（辅音「吃」掉 mora 开头）。
        # 给了 --vowel-offset 就按那个位移放（负值 = 元音提前），辅音整体跟着
        # 提前，并且仍然紧贴元音——日文演唱里辅音常常落在拍点之前。
        if vowel_offset is None:
            v_start = i0 + cons_n
        else:
            v_start = i0 + int(round(vowel_offset * SR))
        v_start = max(0, min(v_start, i1 - 16))

        if cons_n > 4:
            c_len = min(cons_n, v_start)
            c0 = v_start - c_len
            if c_len > 4:
                out[c0:v_start] += make_consonant(
                    kind, centre, c_len, track[c0:v_start], np.random.default_rng(11 + index)
                )

        # 元音终点：下一个 mora 的辅音一旦提前到拍前，就会盖住这个 mora 的尾巴。
        # 塞音的「闭塞」必须是真的静音，所以这里把前一个元音截到下一个辅音的起点。
        v_end = i1
        if index + 1 < len(units):
            n_start, n_dur, _n_vowel, n_kana = units[index + 1]
            n_cons = consonant_of(n_kana)
            n_cons_n = 0
            if n_cons and n_dur > 0.12:
                n_cons_n = min(int(n_cons[2] * SR), int(n_dur * SR * 0.55))
            n_i0 = int(n_start * SR)
            n_v_start = n_i0 + (n_cons_n if vowel_offset is None else int(round(vowel_offset * SR)))
            v_end = max(v_start + 16, min(i1, n_v_start - n_cons_n))

        vn = v_end - v_start
        if vn <= 8:
            continue
        freqs = track[v_start:v_end].copy()
        env = mora_env(vn, not legato_in, not legato_out)
        if cons_n > 0:
            # 元音起音：辅音之后的起音要快（5ms），不能像从零开始那样软
            fade = min(vn, int(0.005 * SR))
            env[:fade] *= np.linspace(0.2, 1.0, fade)

        # ---- 力度与音内衰减 ----
        # 之前每个 mora 的电平都是 1.0，整段唱下来包络是一条直线，动态只剩
        # 辅音那几十毫秒。真人唱长音时声门压更大（更响），而且音内会松开。
        loud = 1.0
        if dur > 0.28:
            loud += min(0.30, (dur - 0.28) * 0.8)
        loud *= 1.0 + 0.06 * float(np.sin(2.2 * index))  # 逐音轻微起伏，避免完全一样
        env *= loud
        if dur > 0.30:
            env *= np.linspace(1.0, 0.80, vn)
        elif dur > 0.18:
            env *= np.linspace(1.0, 0.93, vn)

        k = np.arange(1, harmonics + 1)
        freqs_k = k[:, None] * freqs[None, :]           # (K, vn)

        # 共振峰逐采样点移动：从上一个元音滑到这个元音。
        # 不做的话元音是**瞬切**的，听感非常机械。
        span = glide if (legato_in and prev_vowel and prev_vowel != vowel) else 0
        centres = formant_tracks(vowel, prev_vowel if legato_in else "", vn, min(span, vn // 2))
        gains = envelope_tracks(freqs_k, centres)
        gains *= (1.0 / k)[:, None] ** 0.8              # 谐波衰减

        phase_step = 2 * np.pi * freqs_k / SR
        phases = phase + np.cumsum(phase_step, axis=1)
        signal = (gains * np.sin(phases)).sum(axis=0)
        phase = phases[-1, -1] % (2 * np.pi)

        # 元音只铺在元音起点之后的那一段
        out[v_start : v_start + vn] += signal * env

    # 归一化到 -6dBFS 附近
    peak = float(np.max(np.abs(out))) or 1.0
    out *= 0.5 / peak
    return out


def write_wav(path: Path, signal: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(signal, -1.0, 1.0)
    data = (pcm * 32767).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(data)


def write_mp3(path: Path, signal: np.ndarray, bit_rate: int = 160_000) -> None:
    """复用分轨那条编码路径（它要的是 (声道, 采样点)）。"""
    import separate

    path.parent.mkdir(parents=True, exist_ok=True)
    stereo = np.stack([signal, signal], axis=0).astype(np.float32)
    separate.write_mp3(path, stereo, SR, bit_rate)


def decode_backing(path: Path) -> np.ndarray:
    """伴奏解码成单声道，和合成信号同一个采样率。"""
    import extract_f0

    return extract_f0.decode_mono(str(path), SR)


def soft_limit(x: np.ndarray, knee: float = 0.6) -> np.ndarray:
    """膝盖以下线性，以上用 tanh 压。

    合成音的峰值/有效值比很高（每个 mora 起头都是硬边），
    按 RMS 定增益之后峰值会顶穿。整段缩放会把整体电平压得太低——
    那正是「混音比伴奏还小声」的原因——所以只压越界的部分。
    """
    magnitude = np.abs(x)
    over = magnitude > knee
    if not over.any():
        return x
    compressed = knee + (1.0 - knee) * np.tanh((magnitude - knee) / (1.0 - knee))
    y = np.where(over, compressed * np.sign(x), x)
    return np.clip(y, -1.0, 1.0)


def mix_with_backing(
    vocal: np.ndarray,
    backing: np.ndarray,
    vocal_db: float = -3.0,
) -> tuple[np.ndarray, float, float]:
    """把人声混到伴奏上，返回 (mix, vocal 增益, 伴奏缩放)。

    先把伴奏峰值收到 0.7（混音工程里的常规做法：给要加进来的东西留余量），
    再按 RMS 定人声增益，最后只压人声的峰。这样**不会**因为整段缩放
    把人声段和空白段一起拉低——那样听起来就像「混音比伴奏还小声」。
    """
    length = max(len(vocal), len(backing))
    v = np.zeros(length)
    b = np.zeros(length)
    v[: len(vocal)] = vocal
    b[: len(backing)] = backing

    b_peak = float(np.max(np.abs(b))) or 1e-6
    b_scale = min(1.0, 0.7 / b_peak)
    b *= b_scale

    b_rms = float(np.sqrt((b**2).mean())) or 1e-6
    v_rms = float(np.sqrt((v**2).mean())) or 1e-6
    gain = (b_rms * (10 ** (vocal_db / 20.0))) / v_rms

    mix = b + soft_limit(v * gain, knee=0.8)
    mix = mix[: len(backing)]  # 合成多留的 1 秒尾巴不要

    # mp3 在硬边上过冲 2-3dB，收到 0.62 编出来大约 0.85
    peak = float(np.max(np.abs(mix)))
    if peak > 0.62:
        mix *= 0.62 / peak
    return mix, gain, b_scale


def main() -> int:
    ap = argparse.ArgumentParser(description="源-滤波器歌声合成（预览用）")
    ap.add_argument("--pack", required=True, help="曲包目录")
    ap.add_argument("--out", required=True, help="输出；.mp3 走 mp3 编码，其余按 wav")
    ap.add_argument("--vibrato", type=float, default=0.012, help="颤音深度（比例，0 关掉）")
    ap.add_argument(
        "--vowel-offset",
        type=float,
        default=None,
        help="元音相对 mora 起点的位移（秒）。默认 None＝辅音吃掉 mora 开头（旧行为）；"
        "0＝元音落在拍点、辅音提前——实测没有更好听，留作实验开关",
    )
    ap.add_argument("--from", dest="t_from", type=float, default=None, help="只导出 [t_from,t_to] 这段（秒）")
    ap.add_argument("--to", dest="t_to", type=float, default=None, help="同 --from")
    ap.add_argument(
        "--backing",
        help="伴奏（stems/instrumental.mp3）。给了就再出一版混音，方便判断贴不贴",
    )
    ap.add_argument(
        "--vocal-db",
        type=float,
        default=-3.0,
        help="人声相对伴奏的 RMS（dB），默认 -3",
    )
    ap.add_argument("--vocals-out", help="顺带把纯人声也存一份")
    args = ap.parse_args()

    pack = Path(args.pack)
    lines, f0_data = load_pack(pack)

    duration = float(f0_data.get("duration") or 0.0)
    if duration <= 0:
        raise SystemExit("f0.json 里没有 duration")

    total_units = sum(len(l.get("units") or []) for l in lines)
    print(f"歌词 {len(lines)} 行 / {total_units} 个 mora，音频 {duration:.1f}s")

    signal = synthesize(lines, f0_data, args.vibrato, duration, args.vowel_offset)

    if args.t_from is not None or args.t_to is not None:
        a = int((args.t_from or 0.0) * SR)
        b = int((args.t_to if args.t_to is not None else len(signal) / SR) * SR)
        signal = signal[max(0, a) : max(0, b)]
        print(f"导出片段 {a/SR:.2f}–{b/SR:.2f}s")

    rms = float(np.sqrt((signal**2).mean()))
    print(f"合成完成：{len(signal) / SR:.1f}s，RMS {rms:.3f}，峰值 {np.abs(signal).max():.3f}")

    out_path = Path(args.out)
    if args.vocals_out:
        write_any(Path(args.vocals_out), signal)
        print(f"纯人声 {args.vocals_out}")

    if args.backing:
        backing_path = Path(args.backing)
        if not backing_path.is_absolute():
            backing_path = pack / backing_path
        if not backing_path.exists():
            raise SystemExit(f"找不到伴奏：{backing_path}")
        backing = decode_backing(backing_path)
        mix, gain, b_scale = mix_with_backing(signal, backing, args.vocal_db)
        print(
            f"伴奏 {len(backing) / SR:.1f}s，峰值收到 ×{b_scale:.2f}，"
            f"人声增益 ×{gain:.2f}（目标 {args.vocal_db:+.1f}dB / 伴奏 RMS）"
        )
        write_any(out_path, mix)
    else:
        write_any(out_path, signal)

    size = out_path.stat().st_size / 1024 / 1024
    print(f"写入 {out_path}（{size:.1f}MB）")
    return 0


def write_any(path: Path, signal: np.ndarray) -> None:
    if path.suffix.lower() == ".mp3":
        write_mp3(path, signal)
    else:
        write_wav(path, signal)


if __name__ == "__main__":
    raise SystemExit(main())
