#!/usr/bin/env python3
"""歌词 → mora 级 units（逐字口型的数据源）。

输入：带时间戳的 lyrics.json（P1 的产物）
输出：同上结构，但每行多一个 `kana` 和 `units[]`

一条 unit 是什么
----------------
    { "t": 12.34, "d": 0.16, "ch": "しょ", "v": "i" }

- `ch` 是一个 mora（不是汉字，也不是一个字符——「しょ」算一个 mora）
- `v` 是元音，口型直接用：a→aa / i→ih / u→ou / e→ee / o→oh
  特殊值：`n` 拨音（闭口）、空串 促音（停顿）、`?` 不会出现

时长怎么分
----------
日文是 mora-timed 语言，同一句里每个 mora 时长几乎相等，所以行内**均分**。
但行首到下一行行首的时间差里可能包含间奏，直接均分会把口型拉长到间奏上。

所以优先用 ASR 词时间找出这一行**实际唱完的时刻**（--words 指定的转写缓存），
找不到再退回「下一行行首」。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / ".pylibs"))

import numpy as np  # noqa: E402

import auto_align as A  # noqa: E402
from kana import line_morae_offsets, normalize_kana, to_hiragana  # noqa: E402

MIN_UNIT = 0.05        # mora 最短时长，太短口型会抖
KANA_MIN_RATIO = 0.35  # 假名字符占比低于这个值，说明这行主要是英文，生成不了 mora
WORD_PAD = 0.45        # 找候选 ASR 词时前后放宽的时间窗

# ---- 分轨能量（A7 的第二刀） -------------------------------------------------
# LRC 只给行首时间，行内节奏靠 ASR 词比例估算。但「哪里真的在唱」是可以量出来的：
# 人声轨的能量。把 mora 的相对位置重新映射到**有声段**上，就能消掉
# 「停顿里还在动嘴」，也让长音分到更多时间。
ENERGY_SR = 22050
ENERGY_WIN = 1024
ENERGY_HOP = 441         # 20ms
VOICED_DB = -18.0        # 相对本行峰值
MIN_RUN = 0.07           # 短于这个的有声段丢掉（多半是分离残留）
MERGE_GAP = 0.09         # 短于这个的间隙并回有声段（句内换气）


def load_energy(path: str) -> tuple[np.ndarray, float]:
    """返回 (逐帧 RMS, 帧移秒)。"""
    import extract_f0

    x = extract_f0.decode_mono(path, ENERGY_SR)
    count = 1 + max(0, (len(x) - ENERGY_WIN) // ENERGY_HOP)
    if count <= 0:
        return np.zeros(0), ENERGY_HOP / ENERGY_SR
    idx = np.arange(ENERGY_WIN)[None, :] + ENERGY_HOP * np.arange(count)[:, None]
    e = np.sqrt((x[idx] ** 2).mean(axis=1))
    return e, ENERGY_HOP / ENERGY_SR


def load_voicing(path: str) -> tuple[np.ndarray, float]:
    """逐帧「有没有明确的音高」。比能量可靠：分离残留的能量抬高了噪声底，
    但残留通常没有稳定基频。"""
    import extract_f0

    x = extract_f0.decode_mono(path, ENERGY_SR)
    f0, clarity, _rms = extract_f0.yin(x)
    mask = (f0 > 0) & (clarity > 0.55)
    return mask.astype(bool), 256 / ENERGY_SR


def sung_runs(
    flag: np.ndarray, hop_s: float, t0: float, t1: float
) -> list[tuple[float, float]]:
    """在 [t0,t1) 里找有声段（绝对时间）。flag 可以是布尔掩码或能量。"""
    if len(flag) == 0 or t1 <= t0:
        return []
    a = max(0, int(t0 / hop_s))
    b = min(len(flag), int(t1 / hop_s) + 1)
    if b - a < 3:
        return []
    seg = flag[a:b]
    if seg.dtype != bool:
        peak = float(seg.max())
        if peak <= 0:
            return []
        voiced = seg > peak * (10 ** (VOICED_DB / 20.0))
    else:
        voiced = seg

    runs: list[list[float]] = []
    start = None
    for i, v in enumerate(voiced):
        if v and start is None:
            start = i
        elif not v and start is not None:
            runs.append([(a + start) * hop_s, (a + i) * hop_s])
            start = None
    if start is not None:
        runs.append([(a + start) * hop_s, (a + len(voiced)) * hop_s])

    # 合并小间隙
    merged: list[list[float]] = []
    for run in runs:
        if merged and run[0] - merged[-1][1] < MERGE_GAP:
            merged[-1][1] = run[1]
        else:
            merged.append(run)
    merged = [r for r in merged if r[1] - r[0] >= MIN_RUN]
    return [(r[0], r[1]) for r in merged]


def map_to_runs(positions: list[float], runs: list[tuple[float, float]]) -> list[float]:
    """把 0..1 的相对位置映射到「只落在有声段」的绝对时间上。"""
    if not runs:
        return []
    lengths = [b - a for a, b in runs]
    total = sum(lengths)
    if total <= 0:
        return []

    def to_abs(p: float) -> float:
        p = min(1.0, max(0.0, p))
        target = p * total
        acc = 0.0
        for (a, b), length in zip(runs, lengths):
            if target <= acc + length or (a, b) == runs[-1]:
                return a + (target - acc)
            acc += length
        return runs[-1][1]

    return [to_abs(p) for p in positions]


def mora_positions(text: str, at: float, end: float, words: list[tuple[str, float, float]]):
    """算出每个 mora 在这一行里的**相对位置** 0..1，以及这一行**实际唱完**的时刻。

    为什么用相对位置而不是绝对时间
    ------------------------------
    行内 mora 的疏密应该由 ASR 词时间决定——长音那个词拖得久，
    它下面的 mora 就该占更多位置。所以这里只取 ASR 的**比例**，
    再映射回 [at, 真实唱完]。

    第三个返回值是「这一行真正开唱/唱完的时刻」(ref_start, ref_end)。
    以前这里只返回比例，外面一律按「下一行行首」当结尾，于是
    **ASR 明明听出这一句在 4 秒前就唱完了，mora 还是铺满 8 秒的间隙**。

    注意份额和跨度是两件事：
      份额（shares）按**词的时长**算，不含词间空隙 —— 否则一个 2 秒的空隙
      会全摊给前一个 mora，造出 2 秒一个的 mora（白花第 10/20 行）。
      跨度（span）是**第一个词开头到最后一个词结尾**，必须含空隙 ——
      否则 mora 只铺满「词长之和」，中间的空隙和行尾就没人覆盖，
      唱到那里嘴是闭着的（审计里 26%~33% 的漏唱就是这么来的）。
    """
    morae = line_morae_offsets(text)
    count = len(morae)
    if count == 0:
        return [], 0.0, None

    uniform = [i / count for i in range(count)]
    if not words:
        return uniform, 0.0, None

    cand = [(w) for w in words if w[2] >= at - WORD_PAD and w[1] <= end + WORD_PAD]
    if not cand:
        return uniform, 0.0, None

    # 候选词的假名串 + 每个字符属于第几个候选词
    asr_kana = ""
    owner: list[int] = []
    for index, (word, _start, _stop) in enumerate(cand):
        kana = normalize_kana(to_hiragana(word))
        asr_kana += kana
        owner.extend([index] * len(kana))
    if not asr_kana:
        return uniform, 0.0, None

    line_kana = normalize_kana(to_hiragana(text))
    mapping, _matched = A.map_lyric_to_asr(line_kana, asr_kana)

    word_of: list[int] = []
    for _mora, _vowel, offset in morae:
        pos = mapping[offset] if offset < len(mapping) else -1
        word_of.append(owner[pos] if 0 <= pos < len(owner) else -1)

    mapped = [ci for ci in word_of if ci >= 0]
    if not mapped:
        return uniform, 0.0, None

    ref_start = cand[mapped[0]][1]
    ref_end = cand[mapped[-1]][2]
    span = ref_end - ref_start
    if span <= 0.05:
        return uniform, 0.0, None

    # 只用「词的时长」累加：词与词之间的空隙（间奏、长换气）不计入。
    # 以前的写法把空隙也摊进了前一个 mora，于是出现 2 秒一个的 mora——
    # 白花第 10/20 行就是这样（1.33 / 1.98 s/mora）。
    plan: list[tuple[int, int, int]] = []
    index = 0
    while index < count:
        ci = word_of[index]
        stop = index
        while stop + 1 < count and word_of[stop + 1] == ci:
            stop += 1
        plan.append((ci, index, stop))
        index = stop + 1

    total_dur = sum(cand[ci][2] - cand[ci][1] for ci, _a, _b in plan if ci >= 0)
    if total_dur <= 0.05:
        return uniform, 0.0, None

    positions = [0.0] * count
    acc = 0.0
    for ci, first, last in plan:
        if ci < 0:
            continue
        share = last - first + 1
        each = (cand[ci][2] - cand[ci][1]) / share
        for k in range(share):
            positions[first + k] = acc / total_dur
            acc += each

    # 没映射到的 mora 沿用前一个位置（通常是同一个词）
    prev = 0.0
    for i in range(count):
        prev = max(prev, min(1.0, max(0.0, positions[i])))
        positions[i] = prev

    # 覆盖率决定「信 ASR 多少」：词映射稀疏时（常见于重复幻觉段）
    # 强行按它分配会造出几秒钟的单个 mora，比均分还糟。
    coverage = len(mapped) / count
    return positions, coverage, (ref_start, ref_end)


# 单个 mora 份额的压缩指数：1 = 完全信 ASR，越小越接近均分
SHARE_EXPONENT = 0.7
# 单个 mora 最多占整行的比例，超过就重新分配
MAX_SHARE = 0.35

# ---- 起音对齐（--onsets） ---------------------------------------------------
# 用户听样品的判断：能量起音落点基本都对，问题只在「一个起音要覆盖两个 mora」。
# 所以这里不再按比例摊，而是把 mora 序列和起音序列做一次对齐：
#   1:1 正常；2:1 漏检（一个起音两个 mora，平分）；1:2 多判（一个 mora 两个起音，忽略后者）
ONSET_GAP = 0.10      # 两个起音的最短间隔（太密会造出 <80ms 的 mora）
ONSET_RISE = 2.0      # 比 5 帧中位基线上涨多少 dB 算一次起音
ONSET_LEAD = 0.25     # 找起音时前后放宽的时间窗
COST_MISS = 0.6       # 漏检一个起音的代价
SNAP_MAX = 0.12       # 局部吸附的最大移动量（超出就认为不是同一个字头）
MAX_MISS_RATIO = 2.5  # mora 数 / 起音数 超过这个就不信起音，退回老路径
MAX_EXTRA_RATIO = 2.0  # 起音数 / mora 数 超过这个同样退回


def load_db(path: str) -> tuple[np.ndarray, float]:
    """人声轨逐帧 RMS（dB），10ms 帧移。

    帧长/帧移要和 `tools/lip_audit.py` 用的一致（16k / 512 / 160），
    否则起音数会差一倍——20ms 帧下 5 帧基线跨 100ms，上升沿被抹平。
    """
    import extract_f0

    x = extract_f0.decode_mono(path, 16000)
    win, hop = 512, 160
    count = 1 + max(0, (len(x) - win) // hop)
    if count <= 0:
        return np.zeros(0), hop / 16000
    idx = np.arange(win)[None, :] + hop * np.arange(count)[:, None]
    rms = np.sqrt((x[idx] ** 2).mean(axis=1))
    return 20 * np.log10(rms + 1e-7), hop / 16000


def detect_onsets(db: np.ndarray, hop_s: float, lo: float, hi: float, thr: float) -> list[tuple[float, float]]:
    """包络上升沿，返回 [(时刻, 强度dB)]。5 帧中位数当基线，上升 3dB 记一次，80ms 内只留最高的。"""
    a = max(0, int(lo / hop_s))
    b = min(len(db), int(hi / hop_s))
    if b - a < 12:
        return []
    seg = db[a:b]
    base = np.array([np.median(seg[max(0, i - 5):i + 1]) for i in range(len(seg))])
    rise = seg - base
    cand = [i for i in range(1, len(seg) - 1)
            if rise[i] > ONSET_RISE and rise[i] >= rise[i - 1] and rise[i] > rise[i + 1]
            and seg[i] > thr]
    picked: list[int] = []
    for i in cand:
        if not picked or (i - picked[-1]) * hop_s >= ONSET_GAP:
            picked.append(i)
        elif rise[i] > rise[picked[-1]]:
            picked[-1] = i
    return [((a + i) * hop_s, float(rise[i])) for i in picked]


def phonation_end(db: np.ndarray, hop_s: float, lo: float, hi: float, thr: float) -> float:
    """这一段里最后一次「还在唱」的时刻（用于最后一个 mora 的终点）。"""
    a = max(0, int(lo / hop_s))
    b = min(len(db), int(hi / hop_s))
    if b - a < 3:
        return hi
    idx = np.flatnonzero(db[a:b] > thr)
    if len(idx) == 0:
        return hi
    return min(hi, (a + idx[-1]) * hop_s + 0.06)


def align_groups(m: int, n: int) -> list[tuple[int, int, int, int]] | None:
    """mora（m）与起音（n）的对齐，返回 [(i0,i1,j0,j1)]。

    只有两种步子：1:1 正常、2:1 一个起音覆盖两个 mora（漏检）。
    **不设 1:2**——用户听下来 1-4 后半段并不是多判，而是旧版挤在一起造成的错觉；
    多出来的起音在进来之前就按强度丢掉了，丢在 DP 里会把后面的 mora 整体提前。
    """
    INF = 1e9
    D = [[INF] * (n + 1) for _ in range(m + 1)]
    B: list[list[tuple[int, int] | None]] = [[None] * (n + 1) for _ in range(m + 1)]
    D[0][0] = 0.0
    for i in range(m + 1):
        for j in range(n + 1):
            cur = D[i][j]
            if cur >= INF:
                continue
            if i + 1 <= m and j + 1 <= n and cur < D[i + 1][j + 1]:
                D[i + 1][j + 1] = cur
                B[i + 1][j + 1] = (i, j)
            if i + 2 <= m and j + 1 <= n and cur + COST_MISS < D[i + 2][j + 1]:
                D[i + 2][j + 1] = cur + COST_MISS
                B[i + 2][j + 1] = (i, j)
    if D[m][n] >= INF:
        return None
    groups: list[tuple[int, int, int, int]] = []
    i, j = m, n
    while i > 0 or j > 0:
        prev = B[i][j]
        if prev is None:
            return None
        pi, pj = prev
        groups.append((pi, i, pj, j))
        i, j = pi, pj
    groups.reverse()
    return groups


def snap_units(
    units: list[dict],
    db: np.ndarray,
    hop_s: float,
    thr: float,
    lo: float,
    hi: float,
) -> list[dict]:
    """把现有 mora 的起点挪到 ±SNAP_MAX 内最近的起音上。

    和 DTW 重排的区别：**数量不变、移动有上限**。所以最坏情况是「没吸附上」，
    不会像 DTW 那样一整行错位（实测 1-4 行 しょ 被挪了 540ms）。
    """
    raw = detect_onsets(db, hop_s, lo - ONSET_LEAD, hi + 0.1, thr)
    onsets = [t for t, _s in raw]
    if not onsets:
        return units

    starts = [float(u["t"]) for u in units]
    snapped = starts[:]
    for i, t in enumerate(starts):
        best = min(onsets, key=lambda o: abs(o - t))
        if abs(best - t) > SNAP_MAX:
            continue
        prev_t = snapped[i - 1] if i > 0 else -1e9
        next_t = starts[i + 1] if i + 1 < len(starts) else 1e9
        if best - prev_t < MIN_UNIT or next_t - best < MIN_UNIT:
            continue
        snapped[i] = best

    end = min(phonation_end(db, hop_s, lo, hi + ONSET_LEAD, thr), max(hi, starts[-1] + 0.6))
    out = []
    for i, u in enumerate(units):
        t = snapped[i]
        nxt = snapped[i + 1] if i + 1 < len(snapped) else end
        out.append({"t": round(t, 3), "d": round(max(MIN_UNIT, nxt - t), 3),
                    "ch": u["ch"], "v": u["v"]})
    return out


def build_from_onsets(
    morae: list[tuple[str, str, int]],
    shares: list[float],
    db: np.ndarray,
    hop_s: float,
    thr: float,
    lo: float,
    hi: float,
    limit: float,
) -> list[dict] | None:
    """用能量起音重排这一行的 mora 时间。失败返回 None（外面退回老路径）。

    `shares` 是文本/ASR 估出来的相对时长，只在「一个起音覆盖多个 mora」时用来分配，
    这样漏检的位置仍然按文字节奏走，而不是一刀对半。
    """
    is_hold = lambda ch: ch[:1] in ("ー", "ｰ")
    is_gem = lambda ch: ch[:1] in ("っ", "ッ")

    raw = detect_onsets(db, hop_s, lo - ONSET_LEAD, min(hi, limit) + 0.1, thr)
    raw = [item for item in raw if item[0] < limit]
    idx_on = [k for k, (ch, _v, _o) in enumerate(morae) if not (is_hold(ch) or is_gem(ch))]
    m = len(idx_on)
    # 起音比 mora 多时只丢「最弱」的那几个：最强的几乎一定是字头，弱的才可能是颤音/气口
    if len(raw) > m:
        raw = sorted(sorted(raw, key=lambda kv: -kv[1])[:m], key=lambda kv: kv[0])
    onsets = [t for t, _s in raw]
    n = len(onsets)
    if m < 3 or n < 2:
        return None
    if m / n > MAX_MISS_RATIO or n / m > MAX_EXTRA_RATIO:
        return None

    groups = align_groups(m, n)
    if not groups:
        return None

    end = min(phonation_end(db, hop_s, lo, min(hi, limit) + ONSET_LEAD, thr), limit)
    starts: dict[int, float] = {}
    for gi, (i0, i1, j0, j1) in enumerate(groups):
        t0 = onsets[j0]
        t1 = onsets[groups[gi + 1][2]] if gi + 1 < len(groups) else end
        span = max(MIN_UNIT * (i1 - i0), t1 - t0)
        weights = [max(1e-3, shares[idx_on[k]]) for k in range(i0, i1)]
        total = sum(weights)
        acc = t0
        for k in range(i0, i1):
            starts[idx_on[k]] = acc
            acc += span * weights[k - i0] / total

    # 按原始顺序铺。ー 和 っ 不占独立起音：
    #   ー：复制前一个 mora 的时间轴（同样长、同样元音），视觉上就是「保持」；
    #   っ：放在下一个起音之前的 60ms 里，闭口。
    units: list[dict] = []
    prev_vowel = ""
    for k, (ch, vowel, _off) in enumerate(morae):
        if k in starts:
            prev_vowel = vowel
        if is_hold(ch):
            vowel = prev_vowel or vowel

        if k in starts:
            t = starts[k]
            nxt = next((starts[j] for j in range(k + 1, len(morae)) if j in starts), end)
            d = max(MIN_UNIT, nxt - t)
        elif is_hold(ch):
            if not units:
                return None
            t = units[-1]["t"]
            d = units[-1]["d"]
        else:  # っ：下一个起音之前的 60ms 闭口
            nxt = next((starts[j] for j in range(k + 1, len(morae)) if j in starts), end)
            t = max(nxt - 0.06, (units[-1]["t"] + 0.01) if units else lo)
            d = 0.06
            vowel = ""
        units.append({"t": round(max(lo - 0.1, t), 3), "d": round(max(0.01, d), 3), "ch": ch, "v": vowel})

    span_used = units[-1]["t"] + units[-1]["d"] - units[0]["t"]
    if span_used > (limit - lo) * 1.25 + 0.3:
        return None
    return units


def build(
    lines: list[dict],
    words: list[tuple[str, float, float]],
    energy: np.ndarray | None = None,
    hop_s: float = ENERGY_HOP / ENERGY_SR,
    vocal: tuple[np.ndarray, float, float] | None = None,
    snap: bool = False,
) -> int:
    total_units = 0

    for index, line in enumerate(lines):
        at = line.get("at")
        if at is None:
            line["units"] = []
            continue

        morae = line_morae_offsets(line["text"])
        line["kana"] = to_hiragana(line["text"])
        if not morae:
            line["units"] = []
            continue

        # 整行几乎没有假名（纯英文且未收录）——铺满会让口型变慢动作
        plain = A.normalize(line["text"])
        kana_chars = normalize_kana(line["kana"])
        if plain and len(kana_chars) / len(plain) < KANA_MIN_RATIO:
            line["units"] = []
            continue

        nxt = lines[index + 1].get("at") if index + 1 < len(lines) else None
        end = float(nxt) if nxt is not None and float(nxt) > at else at + 3.0

        positions, coverage, span_hint = mora_positions(line["text"], float(at), end, words)
        if not positions:
            line["units"] = []
            continue

        # 真正该铺的区间：ASR 说这一句什么时候开唱、唱完，就用它，
        # 而不是一味铺到下一行行首（中间可能隔着一整段间奏）。
        # 起点也要挪：LRC 的行首时间常常比人声实际开唱早 100~300ms，
        # 固定从 at 开始铺会让整行 mora 一致偏早。
        sung_start = float(at)
        sung_end = end
        if span_hint and coverage >= 0.5:
            sung_end = min(end, max(float(at) + 0.4, span_hint[1]))
            sung_start = min(sung_end - 0.2, max(float(at) - 0.12, min(float(at) + 0.6, span_hint[0])))
        # 太短就退回整段：ASR 偶尔会把整行词压在一个点上，那种终点不可信
        if sung_end - sung_start < 0.6 * len(positions) * MIN_UNIT:
            sung_start = float(at)
            sung_end = end
        span = max(0.2, sung_end - sung_start)

        # 把「ASR 推出来的相对位置」和「均分」按覆盖率混合，再限制单个 mora 的占比。
        # 覆盖率 1 时完全按 ASR，0 时完全均分。
        count = len(positions)
        uniform_share = 1.0 / count
        alpha = min(1.0, max(0.0, coverage))

        weights = []
        for k in range(count):
            stop = positions[k + 1] if k + 1 < count else 1.0
            asr_share = max(0.0, stop - positions[k])
            blended = alpha * asr_share + (1 - alpha) * uniform_share
            # 压缩极端值：ASR 的个别词时间很脏，直接信会造出 2 秒的单个 mora。
            # 指数 <1 会把「比均分长很多」的份额往下拉，但不改变大小关系。
            weights.append(blended**SHARE_EXPONENT)

        # 再兜一道硬上限：单个 mora 不超过整行的 35%。
        # 超过通常意味着 ASR 把这一行的词都堆在了一个点上，那种分布没有信息量。
        total = sum(weights) or 1.0
        shares = [w / total for w in weights]
        capped = [min(s, MAX_SHARE) for s in shares]
        fixed = sum(capped)
        if fixed < 1.0 - 1e-6:
            free = sum(s for s in capped if s < MAX_SHARE)
            if free > 1e-6:
                shares = [
                    s if s >= MAX_SHARE else s + (1.0 - fixed) * s / free
                    for s in capped
                ]
            else:
                shares = [uniform_share] * count
        else:
            shares = capped

        units = []
        cursor = sung_start

        # 起音对齐优先：能量起音比「按词均分」准得多（实测同一行只有 1/3 的边界能对上）。
        # 失败就退回下面的老路径，不会更差。
        if vocal is not None and not snap:
            db, vhop, thr = vocal
            aligned = build_from_onsets(
                morae, shares, db, vhop, thr, sung_start, sung_end, end - 0.05
            )
            if aligned is not None:
                line["units"] = aligned
                total_units += len(aligned)
                continue

        # 有分轨能量就把 mora 的相对位置重映射到「真的在唱」的段上；
        # 没有就保持原来的均分/ASR 混合结果。
        run_starts = None
        if energy is not None:
            runs = sung_runs(energy, hop_s, sung_start, sung_end)
            if runs:
                starts = [0.0]
                acc = 0.0
                for k in range(count):
                    acc += shares[k]
                    starts.append(min(1.0, acc))
                run_starts = map_to_runs(starts, runs)

        for k, (mora, vowel, _offset) in enumerate(morae):
            if run_starts is not None:
                t_start = run_starts[k]
                t_end = run_starts[k + 1]
                duration = max(MIN_UNIT, t_end - t_start)
                cursor = t_start
            else:
                duration = span * shares[k]
            units.append(
                {
                    "t": round(cursor, 3),
                    "d": round(duration, 3),
                    "ch": mora,
                    "v": vowel,
                }
            )
            cursor += duration

        if vocal is not None and snap and units:
            db, vhop, thr = vocal
            units = snap_units(units, db, vhop, thr, sung_start, sung_end)
        line["units"] = units
        total_units += len(units)

    return total_units


def load_words(path: str | None) -> list[tuple[str, float, float]]:
    if not path:
        return []
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    return [tuple(word) for word in payload["words"]]


def main() -> int:
    ap = argparse.ArgumentParser(description="歌词 → mora units")
    ap.add_argument("--lyrics", required=True, help="带时间戳的 lyrics.json")
    ap.add_argument("--words", help="ASR 转写缓存（auto_align.py --words-out 的产物），可选")
    ap.add_argument(
        "--vocals",
        help="分轨人声（stems/vocals.*）。给了就按它的能量把 mora 铺在有声段上",
    )
    ap.add_argument(
        "--onsets",
        action="store_true",
        help="用 --vocals 的能量起音定位每个 mora 的起点（实验性，听感更贴）",
    )
    ap.add_argument(
        "--snap",
        action="store_true",
        help="保留现有 mora 时间，只把起点吸附到 ±120ms 内最近的起音（不会漂）",
    )
    ap.add_argument("--out", help="默认写到输入文件旁边的 lyrics.units.json")
    args = ap.parse_args()

    path = Path(args.lyrics)
    data = json.loads(path.read_text(encoding="utf-8"))
    lines = data.get("lines", [])
    if not lines:
        print("歌词文件里没有 lines", file=sys.stderr)
        return 1

    words = load_words(args.words)
    energy = None
    hop_s = ENERGY_HOP / ENERGY_SR
    vocal = None
    if args.onsets or args.snap:
        if not args.vocals:
            print("--onsets / --snap 需要同时给 --vocals", file=sys.stderr)
            return 1
        if not Path(args.vocals).exists():
            print(f"找不到人声轨：{args.vocals}", file=sys.stderr)
            return 1
        db, vhop = load_db(args.vocals)
        # 门限：整首人声的 p95 往下 25 dB。固定门限比按行更稳
        thr = float(np.percentile(db, 95)) - 25.0 if len(db) else -40.0
        vocal = (db, vhop, thr)
        n_on = len(detect_onsets(db, vhop, 0.0, len(db) * vhop, thr))
        print(f"人声能量：{len(db)} 帧（{vhop*1000:.0f}ms/帧），门限 {thr:.1f} dB，全曲起音 {n_on} 个")
    elif args.vocals:
        energy, hop_s = load_voicing(args.vocals)
        print(f"人声浊音掩码：{len(energy)} 帧（{hop_s*1000:.0f}ms/帧），"
              f"浊音占比 {100*energy.mean():.0f}%")
    total = build(lines, words, energy, hop_s, vocal, snap=args.snap)

    data["schema"] = 2
    data["source"] = "kana+mora"
    out_path = Path(args.out) if args.out else path.with_name("lyrics.units.json")
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    with_units = sum(1 for line in lines if line.get("units"))
    print(f"{with_units}/{len(lines)} 行生成了 units，共 {total} 个 mora")
    if not words:
        print("（没有 --words，行内按均分估算，长音分不到更多时长）")
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
