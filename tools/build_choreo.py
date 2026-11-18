#!/usr/bin/env python3
"""编舞生成：按节拍网格 + 实测能量曲线，把动作库拼成整首的时间轴。

为什么不用手工编舞
------------------
demo 的手工版只铺到 30 秒，后面角色就只剩基础摇摆了。人工给 204 秒排动作
不现实，而且换一首歌就要重排一遍。

做法
----
1. 从伴奏轨算出**每小节 RMS**，用 10/90 分位归一到 0..1，再平滑两小节。
   用实测能量而不是手写段落，换歌时不用重新标段落。
2. 按 BPM 切八拍（2 小节 = 1 乐句），每个乐句按能量档位选一个动作模式。
3. 循环动作（dance.bounce）没有固定时长，必须显式补 stop 指令。
4. 同一层（upper）的一次性动作不能叠，用 busy 时间挡一下。

输出的 `actions.json` 就是运行时读的那份，结构和手写版完全一致。

用法
----
python tools/build_choreo.py ^
  --pack public\\songpacks\\demo\\pack.json ^
  --audio public\\songpacks\\demo\\stems\\instrumental.mp3 ^
  --out public\\songpacks\\demo\\actions.json
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np

# 动作库的时长（秒）必须和 src/actions/index.ts 里一致，否则会叠动作
DURATION = {
    "dance.bounce": None,  # 无限循环，靠 stop 指令收尾
    "dance.wave": 1.3,
    "dance.spin": 0.92,
    "pose.peace": 2.1,
    "pose.sing": 4.3,
    "pose.cheer": 1.15,
    "pose.lean": 3.6,
    "gesture.reach": 2.4,
    "gesture.clap": 1.15,
    "gesture.nod": 0.95,
    "gesture.shake": 0.95,
    "gesture.point": 1.9,
    "gesture.hair": 1.7,
    "pose.lookBack": 2.7,
    "pose.clasp": 2.6,
    "pose.intro": 2.0,
    "pose.profile": 3.2,
}
LAYER = {
    "dance.bounce": "base",
    "dance.spin": "base",
    "dance.wave": "upper",
    "pose.peace": "upper",
    "pose.sing": "upper",
    "pose.cheer": "upper",
    "pose.lean": "upper",
    "gesture.reach": "upper",
    "gesture.clap": "upper",
    "gesture.nod": "upper",
    "gesture.shake": "upper",
    "gesture.point": "upper",
    "gesture.hair": "upper",
    "pose.lookBack": "upper",
    "pose.clasp": "upper",
    "pose.intro": "upper",
    "pose.profile": "upper",
}

# 动作的定位。**以后加新动作只要在这里标一行**，编舞就知道该把它放在哪：
#   opening —— 开场打招呼（一上来放一次）
#   closing —— 收尾 / 转圈后的收势（不当池子用）
#   pool    —— 跳段里随机挑
#   loop    —— 底层律动，会一直被 start/stop
#   beat    —— 跳段里的强拍动作
#   mode    —— 整句的模式动作（唱歌姿势）
ROLE = {
    "dance.wave": "opening",
    "pose.peace": "closing",
    "dance.bounce": "loop",
    "dance.spin": "beat",
    "pose.sing": "mode",
    # 摇头和鼓掌不进池子（用户 2026-11-11）：摇头放在跳段里像在否定什么，
    # 鼓掌更像「表演结束」，两个都应该留给特定场合，不该随机出现。
    "gesture.clap": "manual",
    "gesture.shake": "manual",
    "pose.cheer": "pool",
    "gesture.nod": "pool",
    "pose.lean": "pool",
    "gesture.reach": "pool",
    # 自我介绍进池子（用户 2026-11-12）。它是「右手往外一摊」，
    # 放在跳段里像在介绍什么，比指过去/交握这些更百搭。
    "pose.intro": "pool",
    # 第三批里其余五个一律不进编舞池：指向前方、交握、回头看、侧对镜头
    # 都是「有人在跟她说话」时才有意义的动作，在歌里随机出现会像在对空气说话。
    # 等 LLM 那层按语义点名用。
    "gesture.point": "manual",
    "gesture.hair": "manual",
    "pose.lookBack": "manual",
    "pose.clasp": "manual",
    "pose.profile": "manual",
}
UPPER_POOL = [k for k, kind in ROLE.items() if kind == "pool"]

# 能量档位 → 名称。阈值是归一化之后的
BANDS = [("calm", 0.30), ("mid", 0.60), ("high", 0.85), ("peak", 2.0)]


def band_of(energy: float) -> str:
    for name, limit in BANDS:
        if energy < limit:
            return name
    return "peak"


def bar_energy(audio: str, bpm: float, duration: float, bar_seconds: float) -> list[float]:
    """每小节 RMS，归一到 0..1。"""
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from separate import decode

    mix = decode(audio)  # (2, N) float32
    mono = mix.mean(axis=0)
    sr = 44100
    count = int(duration / bar_seconds) + 1
    raw = []
    for i in range(count):
        lo = int(i * bar_seconds * sr)
        hi = min(len(mono), int((i + 1) * bar_seconds * sr))
        if hi <= lo:
            raw.append(0.0)
            continue
        raw.append(float(np.sqrt(np.mean(mono[lo:hi] ** 2))))

    arr = np.array(raw, dtype=np.float64)
    if arr.max() <= 0:
        return [0.0] * count

    lo = float(np.percentile(arr, 10))
    hi = float(np.percentile(arr, 90))
    norm = np.clip((arr - lo) / max(hi - lo, 1e-9), 0.0, 1.0)

    # 平滑两小节，避免能量在阈值附近来回跳导致动作密度抖动
    kernel = np.ones(3) / 3.0
    padded = np.pad(norm, (1, 1), mode="edge")
    smooth = np.convolve(padded, kernel, mode="valid")
    return [float(v) for v in smooth]


def build_sections(energies: list[float], bar_seconds: float) -> list[dict]:
    """把逐小节能量合并成段落。

    这里只能看「响不响」，看不出真实的曲式（主歌/副歌要靠和声和旋律判断）。
    所以字段名按强度分档，别过度解读。为了让 HUD 上的段落名别一直闪，
    平滑窗口和最短段长都按**时间**定（约 12 秒 / 10 秒），不按小节数定——
    168 BPM 的 5 小节只有 7 秒，平滑不够，段落会碎成一片。
    """
    n = len(energies)
    if n == 0:
        return []

    width = max(3, int(round(12.0 / bar_seconds)))
    if width % 2 == 0:
        width += 1
    kernel = np.ones(width) / width
    half = width // 2
    padded = np.pad(np.array(energies), (half, half), mode="edge")
    wide = np.convolve(padded, kernel, mode="valid")

    min_run = max(2, int(round(10.0 / bar_seconds)))
    # 段落层面只分三档：high 和 peak 都是「响」，分开会把一段副歌切成好几截
    labels = ["loud" if band_of(float(v)) in ("high", "peak") else band_of(float(v)) for v in wide]

    runs: list[tuple[int, int, str]] = []
    start = 0
    for i in range(1, n + 1):
        if i == n or labels[i] != labels[start]:
            runs.append((start, i, labels[start]))
            start = i

    # 太短的段并入相邻段，避免 HUD 上段落名一直闪
    merged: list[tuple[int, int, str]] = []
    for run in runs:
        if merged and run[1] - run[0] < min_run:
            prev = merged[-1]
            merged[-1] = (prev[0], run[1], prev[2])
        elif merged and merged[-1][1] - merged[-1][0] < min_run:
            prev = merged[-1]
            merged[-1] = (prev[0], run[1], run[2])
        else:
            merged.append(run)

    sections = []
    for index, (lo, hi, label) in enumerate(merged):
        position = lo / max(n - 1, 1)
        last = index == len(merged) - 1
        if label == "calm":
            if position < 0.15:
                name = "intro"
            elif position > 0.75 or last:
                name = "outro"
            else:
                name = "break"
        elif label == "mid":
            name = "verse"
        else:
            name = "chorus"
        sections.append(
            {
                "at": round(lo * bar_seconds, 3),
                "name": name,
                "energy": round(float(np.mean(energies[lo:hi])), 2),
            }
        )

    if sections:
        sections[0]["at"] = 0.0
    return sections


def dedupe_section_names(sections: list[dict]) -> None:
    seen: dict[str, int] = {}
    for section in sections:
        base = section["name"]
        seen[base] = seen.get(base, 0) + 1
        if seen[base] > 1:
            section["name"] = f"{base}{seen[base]}"


def build_cues(
    energies: list[float],
    sections: list[dict],
    bar_seconds: float,
    beats_per_bar: int,
    duration: float,
    seed: int,
    vocals: list[float] | None = None,
    verbose: bool = False,
) -> list[dict]:
    rng = random.Random(seed)
    beat = bar_seconds / beats_per_bar

    # 乐句长度按「时间」定，不按小节数定：快歌 4 小节、慢歌 2 小节。
    # 固定 2 小节的话，168 BPM 的乐句只有 2.86 秒，动作还没做完就换了。
    target_phrase = 5.5
    phrase_bars = max(2, min(8, int(round(target_phrase / bar_seconds))))
    if phrase_bars % 2:
        phrase_bars += 1
    phrase_len = phrase_bars * bar_seconds
    phrases = int((duration + 1e-6) // phrase_len)
    print(f"  乐句 = {phrase_bars} 小节 = {phrase_len:.2f}s，共 {phrases} 句")

    cues: list[dict] = []
    bounce_start: float | None = None
    # 每层上一次动作的结束时间，防止两个一次性动作叠在一起
    busy: dict[str, float] = {}

    def add(at: float, clip: str) -> bool:
        length = DURATION[clip]
        layer = LAYER[clip]
        if length is not None:
            if busy.get(layer, -1.0) > at + 1e-6:
                return False
            busy[layer] = at + length
        cues.append({"at": round(at, 3), "clip": clip})
        return True

    def start_bounce(at: float) -> None:
        nonlocal bounce_start
        if bounce_start is not None:
            return
        # 允许和上一个 base 动作的尾巴叠一点点（blendOut 会把它们接上）
        if busy.get("base", -1.0) > at + 0.2:
            return
        cues.append({"at": round(at, 3), "clip": "dance.bounce"})
        bounce_start = at

    def stop_bounce(at: float) -> None:
        nonlocal bounce_start
        if bounce_start is None:
            return
        cues.append({"at": round(at, 3), "action": "stop", "clip": "dance.bounce"})
        busy["base"] = at
        bounce_start = None

    last_upper: str | None = None

    def pick_pool(t0: float, offset: float) -> str | None:
        """从 upper 池子里挑一个能塞得下的动作（避开上一次用完的）"""
        nonlocal last_upper
        options = [a for a in UPPER_POOL if a != last_upper]
        rng.shuffle(options)
        for act in options:
            if add(t0 + offset, act):
                last_upper = act
                return act
        return None

    section_starts = [s["at"] for s in sections]

    # 段落边界不一定落在偶小节上，所以按「乐句区间包含边界」来认，
    # 而不是要求乐句起点正好等于边界时间
    entry = {
        p
        for p in range(phrases)
        if any(s <= p * phrase_len < s + phrase_len for s in section_starts)
    }

    for p in range(phrases):
        t0 = p * phrase_len
        if t0 >= duration - 0.5:
            break

        lo = int(t0 / bar_seconds)
        hi = max(lo + 1, int((t0 + phrase_len) / bar_seconds))
        window = energies[lo:hi] or [0.0]
        energy = sum(window) / len(window)
        band = band_of(energy)

        # 前两个乐句收着点：进场直接蹦太吵
        if p < 2 and band in ("high", "peak"):
            band = "mid"

        # 只认真正的段落边界。按「档位变了」会太频繁——
        # high 和 peak 来回跳也算法，副歌里会连着转两次圈。
        new_section = p >= 2 and p in entry

        # 这一句人声在不在（只有给了人声分轨才判断）
        vocal = None
        if vocals is not None:
            vwin = vocals[lo:hi] or [0.0]
            vocal = sum(vwin) / len(vwin)

        # 三种乐句模式。`pose.sing` 是主轴：只要她在唱，就站着唱、不跳舞；
        # 只有人声在、能量又高（副歌）才放开跳；没人声就是间奏，站一会儿。
        if vocal is None:
            mode = "dance" if band in ("mid", "high", "peak") else "idle"
        elif vocal < 0.30:
            mode = "idle"
        elif band in ("high", "peak") and vocal > 0.55:
            mode = "dance"
        else:
            mode = "sing"

        if verbose:
            vtxt = f"{vocal:.2f}" if vocal is not None else "--"
            print(f"    句{p:2d} {t0:7.2f}s band={band:<5} vocal={vtxt} → {mode}")
        # 开场第一句先挥个手 —— 当打招呼。之后它就不进池子了。
        if p == 0:
            add(t0, "dance.wave")

        if mode == "idle":
            stop_bounce(t0)
            # 不是每个乐句都动，安静段动多了反而怪。
            # 摇头不进这里（用户 2026-11-11：摇头放哪儿都像在否定）
            if rng.random() < 0.45:
                add(t0, "gesture.nod")
        elif mode == "sing":
            # 唱歌时**保留**底下的摇摆（base 层），上半身换成唱歌姿势（upper 层）：
            # 站着不动地唱会像雕塑，而有律动、手臂在胸前，才像在唱。
            start_bounce(t0)
            add(t0, "pose.sing")
        else:
            # dance：转圈是 base 层、和摇摆互斥，所以只有要转圈时才先停摇摆；
            # 不转圈的乐句直接复用还在跑的摇摆，别每 5 秒停一次又起来。
            spin_here = new_section or p % 4 == 0
            if spin_here:
                stop_bounce(t0)
                add(t0, "dance.spin")
                # 转完圈比个耶 —— 比耶只做「收势」，不进池子
                add(t0 + DURATION["dance.spin"] + 0.05, "pose.peace")
                start_bounce(t0 + DURATION["dance.spin"])
            else:
                start_bounce(t0)
                first = pick_pool(t0, 0.0)
                if rng.random() < 0.55:
                    pick_pool(t0, phrase_len / 2)

    stop_bounce(duration)

    # 收尾：最后一个完整乐句上比个耶，别让画面停在半空
    tail = (phrases - 1) * phrase_len
    if tail + 2.0 < duration:
        add(tail, "pose.peace")

    cues.sort(key=lambda c: c["at"])
    return cues


def dump_actions(duration: float, sections: list[dict], cues: list[dict]) -> str:
    """一条指令一行：这个文件是要人看和手改的，别输出成每个字段一行。"""
    lines = ["{", f'  "duration": {round(duration, 3)},', '  "sections": [']
    for i, s in enumerate(sections):
        comma = "," if i < len(sections) - 1 else ""
        lines.append(f'    {{ "at": {s["at"]}, "name": "{s["name"]}", "energy": {s["energy"]} }}{comma}')
    lines.append("  ],")
    lines.append('  "cues": [')
    for i, c in enumerate(cues):
        comma = "," if i < len(cues) - 1 else ""
        if c.get("action"):
            body = f'"at": {c["at"]}, "action": "{c["action"]}", "clip": "{c["clip"]}"'
        else:
            body = f'"at": {c["at"]}, "clip": "{c["clip"]}"'
        lines.append(f"    {{ {body} }}{comma}")
    lines.append("  ]")
    lines.append("}")
    return "\n".join(lines) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description="按能量曲线生成整首编舞")
    ap.add_argument("--pack", required=True, help="pack.json，用来读 bpm / duration")
    ap.add_argument("--audio", required=True, help="伴奏轨（wav/mp3 都行）")
    ap.add_argument(
        "--vocal",
        default="",
        help="人声分轨（可选）。给了才能分出「她在唱 / 她在跳 / 她在等」三种乐句",
    )
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=7, help="固定种子，结果可复现")
    ap.add_argument("--verbose", action="store_true", help="逐句打印能量/人声/模式")
    args = ap.parse_args()

    meta = json.loads(Path(args.pack).read_text(encoding="utf-8"))
    bpm = float(meta.get("bpm") or 120)
    beats_per_bar = int(meta.get("beatsPerBar") or 4)
    duration = float(meta["duration"])
    bar_seconds = 60.0 / bpm * beats_per_bar

    print(f"{bpm:.0f} BPM，每小节 {bar_seconds:.2f}s，总长 {duration:.1f}s → {int(duration / bar_seconds)} 小节")

    energies = bar_energy(args.audio, bpm, duration, bar_seconds)
    vocals = bar_energy(args.vocal, bpm, duration, bar_seconds) if args.vocal else None
    sections = build_sections(energies, bar_seconds)
    dedupe_section_names(sections)
    cues = build_cues(
        energies, sections, bar_seconds, beats_per_bar, duration, args.seed, vocals, args.verbose
    )

    for section in sections:
        print(f"  段落 {section['at']:7.2f}s  {section['name']:<8} energy={section['energy']:.2f}")

    counts: dict[str, int] = {}
    for cue in cues:
        key = cue.get("clip", "?")
        counts[key] = counts.get(key, 0) + 1
    print(f"  共 {len(cues)} 条指令：" + "  ".join(f"{k}×{v}" for k, v in sorted(counts.items())))

    out = Path(args.out)
    out.write_text(dump_actions(duration, sections, cues), encoding="utf-8")
    print(f"写入 {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
