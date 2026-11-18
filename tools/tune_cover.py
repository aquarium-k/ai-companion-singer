#!/usr/bin/env python3
"""翻唱后期修音：只修「真的跑调」的音符，不动表情。

为什么是**按音符**修，而不是整条音高曲线拉平：
原唱自己相对谱面就有 8% 的音符超过 50 音分（滑音、声门起音、颤音），那是**唱法**。
把整条曲线拉平会把这些表情一起抹掉（而且听起来像电音）。
所以只处理**偏差大到已经不像表情**的音符（默认 |偏差| >60 音分，占 11%），
每个音符内部按 TD-PSOLA 整体平移（保共振峰），两端 40 ms 交叉淡化。

用法：
    py tools/tune_cover.py --audio shots/coverfull.wav --out shots/coverfull-tuned.wav
    py tools/tune_cover.py --audio ... --threshold 80 --dry   # 只报告不写
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

import extract_f0  # noqa: E402
from make_pitch_variants import psola_shift  # noqa: E402

SR = 44100
PACK = ROOT / "public/songpacks/佐佐木真奈-异修罗-ed-白花-铃木このみ"


def read_wav(p):
    with wave.open(str(p)) as h:
        assert h.getframerate() == SR
        raw = h.readframes(h.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def write_wav(p, x):
    p.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.abs(x).max()) or 1.0
    y = x if peak <= 0.999 else x * (0.999 / peak)
    with wave.open(str(p), "wb") as h:
        h.setnchannels(1)
        h.setsampwidth(2)
        h.setframerate(SR)
        h.writeframes((np.clip(y, -1, 1) * 32767).astype("<i2").tobytes())


def f0_narrow(x, ref, win=2048):
    if len(x) < win:
        return 0.0, 0.0
    lo, hi = ref * 2 ** (-2 / 12), ref * 2 ** (2 / 12)
    lag_lo, lag_hi = int(SR / hi), min(int(SR / lo) + 1, win - 2)
    if lag_lo < 2 or lag_hi <= lag_lo:
        return 0.0, 0.0
    seg = x[:win].astype(np.float64)
    seg = seg - seg.mean()
    best, bl = 0.0, 0
    for lag in range(lag_lo, lag_hi + 1):
        a, b = seg[: win - lag], seg[lag:]
        r = float(np.dot(a, b)) / (np.sqrt(np.dot(a, a) * np.dot(b, b)) + 1e-12)
        if r > best:
            best, bl = r, lag
    return (SR / bl if bl else 0.0), best


def note_deviations(x, notes, min_dur=0.12):
    out = []
    for t, d, midi in notes:
        if d < min_dur:
            continue
        ref = 440 * 2 ** ((midi - 69) / 12)
        devs = []
        for tt in np.arange(t + d * 0.2, max(t + d * 0.21, t + d * 0.8 - 0.06), 0.05):
            i = int(tt * SR)
            f, peak = f0_narrow(x[i : i + 2048], ref)
            if f > 0 and peak > 0.6:
                devs.append(float(np.median([1200 * np.log2(f / ref)])))
        if devs:
            out.append({"t": float(t), "d": float(d), "ref": float(ref), "dev": float(np.median(devs))})
    return out


def measure_note(x, d) -> float | None:
    """在音符区间里量 x 的音高偏差（音分）。量不到返回 None。"""
    ds = []
    for tt in np.arange(d["t"] + d["d"] * 0.2, max(d["t"] + d["d"] * 0.21, d["t"] + d["d"] * 0.8 - 0.06), 0.05):
        i = int(tt * SR)
        f, peak = f0_narrow(x[i : i + 2048], d["ref"])
        if f > 0 and peak > 0.6:
            ds.append(1200 * np.log2(f / d["ref"]))
    return float(np.median(ds)) if ds else None


def summary(devs, label):
    if not devs:
        print(f"{label}：没有可量的音符")
        return
    dev = np.array([x["dev"] for x in devs])
    print(
        f"{label}：{len(dev)} 个音符，偏差中位 {np.median(dev):+.1f} 音分，"
        f"|偏差| 90 分位 {np.percentile(np.abs(dev), 90):.0f}"
    )
    for thr in (25, 50, 100):
        n = int((np.abs(dev) > thr).sum())
        print(f"  |偏差| >{thr:3d} 音分：{n} 个（{100*n/len(dev):.0f}%）")


def main() -> int:
    ap = argparse.ArgumentParser(description="翻唱后期修音（按音符、保共振峰）")
    ap.add_argument("--audio", default="shots/coverfull.wav")
    ap.add_argument("--out", default="shots/coverfull-tuned.wav")
    ap.add_argument("--threshold", type=float, default=60.0, help="|偏差| 超过这个音分才修")
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--ab", default="", help="把修前/修后拼成对比文件（给几个最偏的音符）")
    ap.add_argument(
        "--source-tolerance",
        type=float,
        default=50.0,
        help="原唱在同一音符上也偏这么多音分以内，才认为翻唱是「自己跑调」",
    )
    args = ap.parse_args()

    notes = json.loads((PACK / "work/f0.json").read_text(encoding="utf-8"))["notes"]
    x = read_wav(ROOT / args.audio)
    print(f"{args.audio} {len(x)/SR:.2f}s，音符 {len(notes)} 个")

    devs = note_deviations(x, notes)
    summary(devs, "修前")

    todo = [d for d in devs if abs(d["dev"]) > args.threshold]

    # 只修「SVC 自己跑调」的音符：原唱在同一处是准的才算。
    # 原唱也偏 → 那是唱法（滑音/声门起音/颤音），修了就是把人味抹平；
    # 原唱量不到音高 → 没有可信参照（气声/辅音），不动。
    if todo:
        src = extract_f0.decode_mono(str(PACK / "stems/vocals.mp3"), SR)
        kept, skipped_expr, skipped_unknown = [], 0, 0
        for d in todo:
            ds = measure_note(src, d)
            if ds is None:
                skipped_unknown += 1
                continue
            if abs(ds) > args.source_tolerance:
                skipped_expr += 1
                continue
            d["srcDev"] = ds
            kept.append(d)
        print(
            f"  过滤：原唱也偏（表情，不修）{skipped_expr} 个；"
            f"原唱量不到 {skipped_unknown} 个；留下 {len(kept)} 个"
        )
        todo = kept
    print(f"\n计划修 {len(todo)} 个音符（阈值 {args.threshold:.0f} 音分）")
    for d in sorted(todo, key=lambda d: -abs(d["dev"]))[:10]:
        print(f"  {d['t']:7.2f}s  参考 {d['ref']:6.1f} Hz  偏 {d['dev']:+6.0f} 音分  时长 {d['d']:.2f}s")
    if args.dry:
        return 0

    y = x.copy()
    fade = int(0.04 * SR)
    ramp = np.linspace(0, 1, fade)
    fixed = 0
    reverted = 0
    for d in todo:
        a = int(d["t"] * SR)
        b = min(len(x), int((d["t"] + d["d"]) * SR))
        if b - a < int(0.1 * SR):
            continue
        seg = x[a:b]
        # PSOLA 的「周期」必须用这一段**实际**的音高，不能用谱面音高：
        # 段子里本身就偏了 100 音分的话，用谱面周期去摆 grain 等于整段错位
        # （第一版就是这么修的，结果偏到了反方向、还丢掉周期性）。
        f0_actual = d["ref"] * 2 ** (d["dev"] / 1200)
        shifted, _ = psola_shift(seg, f0_actual, -d["dev"] / 100.0)
        if len(shifted) < len(seg):
            shifted = np.pad(shifted, (0, len(seg) - len(shifted)))
        shifted = shifted[: len(seg)]
        w = np.ones(len(seg), dtype=np.float32)
        n = min(fade, len(seg) // 2)
        if n > 4:
            w[:n] = ramp[:n]
            w[-n:] = ramp[:n][::-1]
        cand = y.copy()
        cand[a:b] = x[a:b] * (1 - w) + shifted * w
        # 安全阀：修完必须比修前更准，否则这一段回退（宁可不动，不能修坏）
        before_dev = measure_note(y, d)
        after_dev = measure_note(cand, d)
        if (
            after_dev is None
            or before_dev is None
            or abs(after_dev) > abs(before_dev) - 5
        ):
            reverted += 1
            continue
        y = cand
        fixed += 1

    # 检查有没有因为修正而削顶
    peak = float(np.abs(y).max())
    if peak > 0.999:
        y *= 0.999 / peak
        print(f"修正后峰值 {peak:.3f}，整体压了 {20*np.log10(0.999/peak):+.2f} dB")

    write_wav(ROOT / args.out, y)
    print(f"\n写入 {args.out}（修了 {fixed} 个音符，回退 {reverted} 个）")

    devs2 = note_deviations(y, notes)
    summary(devs2, "修后")

    if args.ab:
        picks = sorted(todo, key=lambda d: -abs(d["dev"]))[:3]
        parts = []
        for d in picks:
            a = int(max(0, d["t"] - 0.15) * SR)
            b = min(len(x), int((d["t"] + d["d"] + 0.2) * SR))
            parts += [x[a:b], np.zeros(int(0.35 * SR), np.float32), y[a:b], np.zeros(int(0.6 * SR), np.float32)]
        write_wav(ROOT / args.ab, np.concatenate(parts))
        print(f"对比文件 {args.ab}：每个音符「修前 → 修后」，共 {len(picks)} 处")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
