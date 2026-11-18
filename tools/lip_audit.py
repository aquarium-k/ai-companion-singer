#!/usr/bin/env python3
"""口型审计：拿分轨人声当「真值」，量 units 驱动的口型错位有多严重。

为什么需要它
------------
口型数据（`lyrics.units.json`）的质量只能靠听/看，而看一次要开应用、找那一段、
盯几十秒，还容易「感觉好点了」。这个脚本把能测的部分都测出来：

  miss     人声有声、但没有 mora 覆盖的帧占比（会退回「啊」的嘴型）
  idle     mora 覆盖、但人声静音的帧占比（嘴在动但没唱）
  err_md   每个 mora 起点到最近「真实起音」的距离，中位数
  shift    整行平移多少毫秒能让上面的误差最小（判断是不是系统性偏早/偏晚）
  ratio    mora 数 / 检测到的起音数（≈1 说明可以逐 mora 绑时间）
  open     按 engine.level() 的公式算出来的张嘴幅度分布（1.0 = 打满）

用法
----
    py -3 tools/lip_audit.py                       # 全部曲包，新旧的都测
    py -3 tools/lip_audit.py --pack <曲包目录>

依赖：只要有分轨人声（stems/vocals.mp3）和 lyrics.units.json。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(TOOLS.parent / ".pylibs"))

import numpy as np  # noqa: E402

import extract_f0  # noqa: E402

SR = 16000
WIN = 512
HOP = 160  # 10 ms
HOP_S = HOP / SR
ONSET_GAP = 0.08
SHIFT_GRID = np.arange(-0.30, 0.301, 0.02)


def envelope(path: Path) -> np.ndarray:
    """逐帧 RMS（dB）。"""
    x = extract_f0.decode_mono(str(path), SR)
    count = 1 + max(0, (len(x) - WIN) // HOP)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(count)[:, None]
    return 20 * np.log10(np.sqrt((x[idx] ** 2).mean(axis=1)) + 1e-7)


def onsets(db: np.ndarray, lo: float, hi: float, thr_db: float) -> np.ndarray:
    """包络上升沿。5 帧中位数当基线，上升 3 dB 记一次，80 ms 内只留最高的。"""
    a = max(0, int(lo / HOP_S))
    b = min(len(db), int(hi / HOP_S))
    if b - a < 12:
        return np.zeros(0)
    seg = db[a:b]
    base = np.array([np.median(seg[max(0, i - 5):i + 1]) for i in range(len(seg))])
    rise = seg - base
    cand = [i for i in range(1, len(seg) - 1)
            if rise[i] > 3.0 and rise[i] >= rise[i - 1] and rise[i] > rise[i + 1]
            and seg[i] > thr_db]
    picked: list[int] = []
    for i in cand:
        if not picked or (i - picked[-1]) * HOP_S >= ONSET_GAP:
            picked.append(i)
        elif rise[i] > rise[picked[-1]]:
            picked[-1] = i
    return np.array([(a + i) * HOP_S for i in picked])


def units_of(payload: dict) -> list[tuple[float, float, str]]:
    out = []
    for line in payload.get("lines", []):
        for u in line.get("units") or []:
            out.append((float(u["t"]), float(u["d"]), u.get("v", "")))
    return out


def audit(pack: Path, units_name: str, label: str) -> dict:
    lyrics = json.loads((pack / units_name).read_text(encoding="utf-8"))
    units = units_of(lyrics)
    db = envelope(pack / "stems" / "vocals.mp3")

    p95 = float(np.percentile(db, 95))
    thr = p95 - 25.0
    active = db > thr

    cover = np.zeros(len(db), dtype=bool)
    for t, d, _v in units:
        a = max(0, int(t / HOP_S))
        b = min(len(db), int((t + d) / HOP_S))
        if b > a:
            cover[a:b] = True

    span_lo = int(units[0][0] / HOP_S)
    span_hi = int((units[-1][0] + units[-1][1]) / HOP_S)
    span = np.zeros(len(db), dtype=bool)
    span[span_lo:span_hi + 1] = True

    missing = float((span & active & ~cover).sum() / max(1, (active & span).sum()))
    idle = float((cover & ~active).sum() / max(1, cover.sum()))

    err0: list[float] = []
    err_shift: list[float] = []
    shifts: list[float] = []
    ratios: list[float] = []
    lines = [ln for ln in lyrics.get("lines", []) if ln.get("units")]
    for i, ln in enumerate(lines):
        us = ln["units"]
        t0 = float(us[0]["t"])
        nxt = lines[i + 1]["units"][0]["t"] if i + 1 < len(lines) else t0 + 8.0
        t1 = min(float(nxt), float(us[-1]["t"] + us[-1]["d"]) + 0.8)
        on = onsets(db, t0 - 0.35, t1 + 0.35, thr)
        starts = np.array([float(u["t"]) for u in us])
        if len(on) < 2 or len(starts) < 2:
            continue
        ratios.append(len(starts) / len(on))
        d0 = np.abs(starts[:, None] - on[None, :]).min(axis=1)
        err0.extend(d0.tolist())
        best = None
        for s in SHIFT_GRID:
            dd = np.abs((starts + s)[:, None] - on[None, :]).min(axis=1)
            v = float(dd.mean())
            if best is None or v < best[1]:
                best = (float(s), v)
        shifts.append(best[0])
        err_shift.extend(np.abs((starts + best[0])[:, None] - on[None, :]).min(axis=1).tolist())

    # 复刻 engine.level()：guideGain 补偿后的 RMS × 4，再开 0.65 次方
    rms_lin = 10 ** (db / 20.0)
    vocal_rms = float(np.sqrt(np.mean(rms_lin ** 2)))
    inst = envelope(pack / "stems" / "instrumental.mp3")
    inst_rms = float(np.sqrt(np.mean((10 ** (inst / 20.0)) ** 2)))
    ref = float(np.hypot(vocal_rms, inst_rms))
    gain = float(np.clip(ref / max(vocal_rms, 1e-6), 0.5, 8.0))
    level = np.clip(rms_lin * gain * 4.0, 0, 1)
    open_ = np.power(level, 0.65)
    sung = open_[active]

    vs = [v for _t, _d, v in units]
    switches = sum(1 for a, b in zip(vs, vs[1:]) if a != b)
    short = sum(1 for i in range(len(units) - 1) if vs[i] != vs[i + 1] and units[i][1] < 0.08)
    total = max(1e-6, sum(d for _t, d, _v in units))

    return {
        "label": label,
        "units": len(units),
        "missing": missing,
        "idle": idle,
        "err0": float(np.median(err0)) if err0 else 0,
        "err_p90": float(np.percentile(err0, 90)) if err0 else 0,
        "gt200": float(np.mean(np.array(err0) > 0.2)) if err0 else 0,
        "shift": float(np.median(shifts)) if shifts else 0,
        "err_shift": float(np.median(err_shift)) if err_shift else 0,
        "ratio": float(np.median(ratios)) if ratios else 0,
        "open_med": float(np.median(sung)) if len(sung) else 0,
        "open_p90": float(np.percentile(sung, 90)) if len(sung) else 0,
        "quiet": float(np.mean(sung < 0.15)) if len(sung) else 0,
        "rate": len(units) / total,
        "switch": switches / total,
        "short": short / max(1, switches),
    }


def render(rows: list[dict]) -> None:
    print(f"{'pack':<22}{'miss%':>7}{'idle%':>7}{'err_med':>9}{'err_p90':>9}{'>200ms%':>9}"
          f"{'shift':>8}{'err@sh':>8}{'ratio':>7}{'openMed':>9}{'openP90':>9}{'quiet%':>8}"
          f"{'mora/s':>8}{'sw/s':>6}{'<80ms%':>8}")
    for r in rows:
        print(f"{r['label']:<22}{r['missing']*100:7.1f}{r['idle']*100:7.1f}"
              f"{r['err0']*1000:8.0f}ms{r['err_p90']*1000:8.0f}ms{r['gt200']*100:9.1f}"
              f"{r['shift']*1000:+7.0f}ms{r['err_shift']*1000:7.0f}ms"
              f"{r['ratio']:7.2f}{r['open_med']:9.2f}{r['open_p90']:9.2f}{r['quiet']*100:8.1f}"
              f"{r['rate']:8.1f}{r['switch']:6.1f}{r['short']*100:8.1f}")


def main() -> int:
    ap = argparse.ArgumentParser(description="口型数据审计")
    ap.add_argument("--pack", action="append", help="曲包目录，可重复；默认扫描 public/songpacks")
    ap.add_argument("--old", action="store_true", help="同时测 lyrics.units.backup.json")
    ap.add_argument("--units", help="指定 units 文件名，默认 lyrics.units.json")
    args = ap.parse_args()

    root = TOOLS.parent / "public" / "songpacks"
    packs = [Path(p) for p in args.pack] if args.pack else [p for p in sorted(root.iterdir()) if p.is_dir()]

    rows = []
    for pack in packs:
        if not (pack / "stems" / "vocals.mp3").exists():
            print(f"跳过 {pack.name}：没有 stems/vocals.mp3")
            continue
        names = [args.units or "lyrics.units.json"]
        if args.old and (pack / "lyrics.units.backup.json").exists():
            names.insert(0, "lyrics.units.backup.json")
        for name in names:
            if not (pack / name).exists():
                continue
            tag = "" if name == "lyrics.units.json" else "(旧)"
            rows.append(audit(pack, name, f"{pack.name[:14]}{tag}"))

    if rows:
        render(rows)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
