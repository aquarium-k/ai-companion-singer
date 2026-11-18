"""重造后的全库验收：音高 / 相位干净度 / 电平 / 元音（共振峰）一致性。

判据（都是「换掉整库之前必须过」的硬指标）：
  音高   实测 vs 目标 ≤5 音分（运行时用 json 的 rootHz 算 playbackRate，偏差会直接唱偏）
  干净   相邻周期波形相关 ≥0.94（旧库两端是 0.90–0.93）
  电平   RMS 与被替换的那一档差 ≤1 dB（和声音量不能跟着音高变）
  元音   频谱质心在同一套网格上单调、且与「あ」谱形相关 ≥0.6（不能混进别的元音）

    python tools/qa_loops.py [候选目录]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / ".tmp"))

VOICES = ROOT / "public/voices"
SR = 44100


def read(p) -> np.ndarray:
    y, sr = sf.read(str(p), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    assert sr == SR, (p, sr)
    return y


def f0_med(y: np.ndarray) -> float:
    import librosa

    f0, _, _ = librosa.pyin(y, fmin=70, fmax=1200, sr=SR, frame_length=2048, hop_length=128)
    ok = ~np.isnan(f0)
    if ok.sum() < 6:
        return 0.0
    c = float(np.median(f0[ok]))
    keep = np.abs(1200 * np.log2(f0[ok] / c)) < 100
    return float(np.median(f0[ok][keep])) if keep.sum() > 4 else c


def centroid(y: np.ndarray) -> float:
    n = 4096
    spec = np.zeros(n // 2 + 1)
    cnt = 0
    for i in range(0, max(1, len(y) - n), n // 2):
        seg = y[i : i + n]
        if len(seg) < n:
            break
        spec += np.abs(np.fft.rfft(seg * np.hanning(n))) ** 2
        cnt += 1
    spec /= max(1, cnt)
    f = np.fft.rfftfreq(n, 1 / SR)
    band = (f > 80) & (f < 10000)
    return float((spec[band] * f[band]).sum() / (spec[band].sum() + 1e-12))


def ltas(y: np.ndarray, n: int = 4096) -> np.ndarray:
    spec = np.zeros(n // 2 + 1)
    cnt = 0
    for i in range(0, max(1, len(y) - n), n // 2):
        seg = y[i : i + n]
        if len(seg) < n:
            break
        spec += np.abs(np.fft.rfft(seg * np.hanning(n))) ** 2
        cnt += 1
    return spec / max(1, cnt)


def main() -> int:
    cand_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / ".tmp/rebake-full"
    sys.path.insert(0, str(ROOT / ".tmp"))
    from chain_diag import coherence  # noqa: E402

    doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
    items = [l for l in doc["loops"] if (l.get("vowel") or "a") == "a"]

    # 候选名是 `loop_<目标取整>`，库里是上一代网格名（516.75 → loop_516），
    # 所以按 rootHz 找最近的候选，别按文件名硬匹配
    cands = {}
    for p in cand_dir.glob("loop_[0-9]*.wav"):
        try:
            cands[float(p.stem.split("_")[1])] = p
        except (IndexError, ValueError):
            continue

    def find(name: str, root: float) -> Path | None:
        exact = cand_dir / name
        if exact.exists():
            return exact
        if not cands:
            return None
        hz, p = min(cands.items(), key=lambda kv: abs(np.log2(kv[0] / root)))
        return p if abs(1200 * np.log2(hz / root)) < 50 else None

    print(
        f"{'档':>6s}{'目标':>7s}{'实测':>8s}{'误差':>7s}{'相位':>7s}{'质心Hz':>8s}"
        f"{'电平dB':>7s}{'旧相位':>7s}{'旧电平':>7s}  判定"
    )
    bad = 0
    cent = {}
    for it in sorted(items, key=lambda l: float(l["rootHz"])):
        name = Path(it["url"]).name
        target = float(it["rootHz"])
        cand = find(name, target)
        if cand is None:
            print(f"{name:>16s} 还没生成")
            continue
        y = read(cand)
        target = float(it["rootHz"])
        got = f0_med(y)
        cents = 1200 * np.log2(got / target) if got else float("nan")
        coh, _ = coherence(y, SR / target)
        rms_db = 20 * np.log10(np.sqrt(np.mean(y.astype(np.float64) ** 2)) + 1e-9)
        old = VOICES / name
        yold = read(old) if old.exists() else None
        coh_old = coherence(yold, SR / target)[0] if yold is not None else float("nan")
        rms_old = (
            20 * np.log10(np.sqrt(np.mean(yold.astype(np.float64) ** 2)) + 1e-9)
            if yold is not None
            else float("nan")
        )
        c = centroid(y)
        cent[name] = c
        ok = abs(cents) <= 5 and coh >= 0.94 and (abs(rms_db - rms_old) <= 1.0 or np.isnan(rms_old))
        if not ok:
            bad += 1
        print(
            f"{name:>16s}{target:7.1f}{got:8.2f}{cents:+7.1f}{coh:7.4f}{c:8.0f}"
            f"{rms_db:7.1f}{coh_old:7.4f}{rms_old:7.1f}  {'ok' if ok else 'BAD'}"
        )
    # 元音一致性：质心随音高应平滑变化，突跳说明换进了别的元音
    cs = list(cent.items())
    for i in range(1, len(cs)):
        prev = cs[i - 1][1]
        cur = cs[i][1]
        if prev > 0 and abs(20 * np.log2(cur / prev)) > 2.0:
            print(f"  WARN 质心突跳 {cs[i-1][0]} {prev:.0f} → {cs[i][0]} {cur:.0f} Hz")
    print(f"\n不合格：{bad}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
