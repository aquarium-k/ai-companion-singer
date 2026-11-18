"""把重造出来的候选样本装进库里：锁音高（谐波梳）、整周期裁剪、电平对齐、写 json/清单。

为什么单独一步（而不是 `rebake_loops.py --apply` 里顺手做）：
SVC 跑一次 24 档要 40 分钟，装库可能要重来好几次。生成和装库分开，改判据就不用重烤。

音高为什么不信 pyin：实测这批样本上 pyin 会偏 −5…−6 音分（`loop_289` pyin 288.20 /
谐波梳 289.16 / 目标 289.15）。运行时是拿 json 的 rootHz 算 playbackRate 的，
写偏几音分就唱偏几音分，所以这里用谐波梳（`.tmp/comb.py`）定 rootHz，并顺手把它锁到目标上。

    python tools/apply_loops.py --from .tmp/rebake-full --dry   # 只看会怎么改
    python tools/apply_loops.py --from .tmp/rebake-full         # 真装
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
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / ".tmp"))

from comb import comb_f0  # noqa: E402

VOICES = ROOT / "public/voices"
SR = 44100


def read(p) -> np.ndarray:
    y, sr = sf.read(str(p), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    assert sr == SR, (p, sr)
    return y


def write(p: Path, y: np.ndarray) -> None:
    peak = float(np.abs(y).max()) or 1.0
    z = y if peak <= 0.98 else y * (0.98 / peak)
    sf.write(str(p), z, SR, subtype="PCM_16")


def resample_by(y: np.ndarray, rate: float) -> np.ndarray:
    import librosa

    if abs(rate - 1.0) < 1e-5:
        return y
    return librosa.resample(y, orig_sr=SR, target_sr=int(round(SR / rate))).astype(np.float32)


def trim_periods(y: np.ndarray, f0: float) -> np.ndarray:
    """裁成整数个周期，并用接缝后一个周期交叉淡化（循环才无缝）。"""
    period = SR / f0
    n_per = max(2, int(round(len(y) / period)))
    length = int(round(n_per * period))
    if length > len(y):
        length -= int(round(period))
    if length <= 0:
        return y
    body = y[:length].astype(np.float64).copy()
    fade = int(round(period))
    if 1 < fade and len(y) >= length + fade:
        w = np.linspace(0, 1, fade)
        body[:fade] = body[:fade] * w + y[length : length + fade] * (1 - w)
    return body.astype(np.float32)


def relock(y: np.ndarray, target: float, iters: int = 4) -> tuple[np.ndarray, float]:
    """锁到 target：量 → 定速重采样 → 整周期裁剪，直到 ≤1 音分。"""
    f = comb_f0(y, SR, target, span_cents=60)
    for _ in range(iters):
        d = 1200 * np.log2(f / target)
        if abs(d) <= 1.0:
            break
        # rate = 目标/实测：rate>1 就是把音高抬高（resample_by 的语义是「播出来的音高 ×rate」）
        y = trim_periods(resample_by(y, target / f), target)
        f = comb_f0(y, SR, target, span_cents=30)
    return trim_periods(y, f), f


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="src_dir", default=str(ROOT / ".tmp/rebake-full"))
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--no-rms", action="store_true", help="不对齐电平（A/B 时用）")
    args = ap.parse_args()

    src_dir = Path(args.src_dir)
    doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
    bak = ROOT / ".tmp/voices-backup"

    # 候选文件名是 `loop_<四舍五入的目标 Hz>`（`rebake_loops.py` 按目标取整命名），
    # 而库里的名字来自上一代网格（516.75 → loop_516、571.25 → loop_575）。
    # 直接同名匹配会漏掉这几档，所以按 rootHz 找最近的那个候选。
    cands = {}
    for p in src_dir.glob("loop_[0-9]*.wav"):
        try:
            cands[float(p.stem.split("_")[1])] = p
        except (IndexError, ValueError):
            continue

    def find(name: str, root: float) -> Path | None:
        exact = src_dir / name
        if exact.exists():
            return exact
        if not cands:
            return None
        hz, p = min(cands.items(), key=lambda kv: abs(np.log2(kv[0] / root)))
        return p if abs(1200 * np.log2(hz / root)) < 50 else None

    rows = []
    for item in doc["loops"]:
        if (item.get("vowel") or "a") != "a":
            continue
        name = Path(item["url"]).name
        target = float(item["rootHz"])
        cand = find(name, target)
        if cand is None:
            print(f"{name:16s} 缺候选，跳过")
            continue
        y = read(cand)
        y, f = relock(y, target)
        rms_db = 20 * np.log10(np.sqrt(np.mean(y.astype(np.float64) ** 2)) + 1e-9)
        old_path = VOICES / name
        old_rms = None
        if old_path.exists() and not args.no_rms:
            yo = read(old_path)
            old_rms = float(np.sqrt(np.mean(yo.astype(np.float64) ** 2)))
            cur = float(np.sqrt(np.mean(y.astype(np.float64) ** 2))) or 1.0
            y = (y * (old_rms / cur)).astype(np.float32)
        rows.append(dict(name=name, target=target, f=f, y=y, len=len(y)))
        delta = 1200 * np.log2(f / target)
        print(
            f"{name:16s} 目标 {target:7.2f} → {f:7.2f}（{delta:+5.1f}） "
            f"{len(y)/SR*1000:5.0f}ms  {rms_db:6.1f} dB  {'(干跑)' if args.dry else ''}"
        )

    if not rows:
        print("没有可装的候选")
        return 1
    if args.dry:
        print(f"\n干跑：{len(rows)} 档；加（去掉 --dry）才写文件")
        return 0

    bak.mkdir(parents=True, exist_ok=True)
    by_name = {r["name"]: r for r in rows}
    for item in doc["loops"]:
        name = Path(item["url"]).name
        r = by_name.get(name)
        if not r:
            continue
        dst = VOICES / name
        if dst.exists() and not (bak / name).exists():
            shutil.copy2(dst, bak / name)
        write(dst, r["y"])
        # familyRootHz **不动**：它决定运行时「哪几档同一个人、不能同时响」，
        # 也就是混音里有几个声部。6 个家族混出来的厚度是调好的，改成 24 个独立家族
        # 会变成 10 多个声部同时响（更厚也更糊），那不是这次要改的东西。
        meta_path = dst.with_suffix(".json")
        meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
        meta.update(
            source=f"svc@{r['target']:.0f}",
            rootHz=round(r["f"], 2),
            lengthSec=round(r["len"] / SR, 4),
            sampleRate=SR,
            periods=int(round(r["len"] / (SR / r["f"]))),
            method="svc-direct",
        )
        meta.pop("shiftSemitones", None)
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        # 清单里的 rootHz 必须和样本实测一致，否则 playbackRate 一算就偏
        item["rootHz"] = round(r["f"], 2)
        item["from"] = f"svc-direct {r['target']:.0f}"

    doc["loops"].sort(key=lambda l: ((l.get("vowel") or "a"), l["rootHz"]))
    (VOICES / "loops.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\n装了 {len(rows)} 档 → {VOICES}（旧文件备份在 {bak}）")
    print("记得重新构建，让 dist/voices 跟上：node scripts/ensure-dist.mjs --force")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
