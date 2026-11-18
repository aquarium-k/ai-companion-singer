"""新旧对比试听包：旧库（PSOLA 链）/ 旧库拉长 3× / 新库（SVC 直出）。

放在 shots/loop-audition-fix/，三组：
  single/  单次循环
  repeat/  同一段连播 4.0 s（三版等长，直接数「重来几次」）
  phrase/  8 个音的一句旋律，音高走 playbackRate（和 App 同一条路）

    python tools/ab_audition.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / ".tmp"))

from chain_diag import coherence  # noqa: E402
from stretch_loops import stretch  # noqa: E402

SR = 44100
OLD = ROOT / ".tmp/voices-backup"
NEW = ROOT / "public/voices"
OUT = ROOT / "shots/loop-audition-fix"
SHOW = [210, 352, 384, 516, 850]
PHRASE = [261.6, 329.6, 392.0, 440.0, 523.3, 466.2, 392.0, 329.6]
ORDER = ["old", "old_x3", "new"]


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
    return float(np.median(f0[ok])) if ok.sum() > 4 else 0.0


def pick(dir_: Path, hz: float) -> tuple[np.ndarray, float]:
    """目录里找 rootHz 最接近 hz 的那档（旧库的 575 实际对应 571 Hz）。

    `.tmp/voices-backup` 里只备份了 wav（没 json），那就用文件名里的数字当根音近似，
    真正的根音随后用 pyin 量。
    """
    best, bd = None, 1e9
    for p in sorted(dir_.glob("loop_[0-9]*.wav")):
        jp = p.with_suffix(".json")
        if jp.exists():
            root = float(json.loads(jp.read_text(encoding="utf-8"))["rootHz"])
        else:
            root = float(p.stem.split("_")[1])
        d = abs(1200 * np.log2(root / hz))
        if d < bd:
            best, bd = p, d
    if best is None:
        raise SystemExit(f"{dir_} 里没有 loop_*.wav")
    y = read(best)
    return y, f0_med(y)


def resample(y: np.ndarray, rate: float) -> np.ndarray:
    n_out = max(1, int(round(len(y) / rate)))
    idx = np.arange(n_out) * rate
    i0 = np.floor(idx).astype(int)
    fr = idx - i0
    return (y[i0 % len(y)] * (1 - fr) + y[(i0 + 1) % len(y)] * fr).astype(np.float32)


def fade(y: np.ndarray, ms_in: float = 25, ms_out: float = 120) -> np.ndarray:
    z = y.copy()
    a = int(SR * ms_in / 1000)
    b = int(SR * ms_out / 1000)
    if a > 1:
        z[:a] *= np.linspace(0, 1, a)
    if b > 1 and len(z) > b:
        z[-b:] *= np.linspace(1, 0, b)
    return z


def variants(hz: float):
    yo, ro = pick(OLD, hz)
    out = [("old", yo, ro), ("old_x3", stretch(yo, SR, ro, 3.0)[0], ro)]
    yn, rn = pick(NEW, hz)
    out.append(("new", yn, rn))
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for sub in ("single", "repeat", "phrase"):
        (OUT / sub).mkdir(exist_ok=True)

    rows = []
    for hz in SHOW:
        for tag, y, root in variants(hz):
            coh, _ = coherence(y, SR / root)
            sf.write(OUT / "single" / f"loop_{hz}_{tag}.wav", fade(y * 0.5), SR, subtype="PCM_16")
            n = max(1, int(np.ceil(4.0 / (len(y) / SR))))
            rep = np.tile(y, n)[: int(SR * 4.0)] * 0.5
            sf.write(OUT / "repeat" / f"rep_{hz}_{tag}.wav", fade(rep, 10, 150), SR, subtype="PCM_16")
            rows.append(dict(hz=hz, tag=tag, coh=coh, ms=len(y) / SR * 1000))

    for tag in ORDER:
        segs = []
        for i, hz in enumerate(PHRASE):
            if tag == "old":
                tone, r = pick(OLD, hz)
            elif tag == "new":
                tone, r = pick(NEW, hz)
            else:
                tone, r = pick(OLD, hz)
                tone = stretch(tone, SR, r, 3.0)[0]
            tone = resample(tone, hz / r)
            want = int(SR * (0.45 if i < len(PHRASE) - 1 else 0.9))
            while len(tone) < want:
                tone = np.concatenate([tone, tone])
            segs.append(fade(tone[:want], 30, 90) * 0.5)
        sf.write(OUT / "phrase" / f"phrase_{tag}.wav", np.concatenate(segs), SR, subtype="PCM_16")

    lines = [
        "循环库新旧对比（2026-11-17）",
        "",
        "三版：",
        "  old     = 旧库：24 档里 18 档是 PSOLA 链派生（同一段反复 OLA）",
        "  old_x3  = 旧库那一段按整周期重复到 3×（0.96 s）",
        "  new     = 新库：每档都用 SVC 在目标音高上直接生成（0.62–0.66 s，第一代）",
        "",
        "目录：single/ 单次 · repeat/ 连播 4.0 s（三版等长）· phrase/ 8 音旋律（playbackRate）",
        "",
        "量化（相位相关 = 相邻周期波形归一化相关，越接近 1 越不「毛」）：",
        f"  {'档':>12s}{'相位相关':>10s}{'长度ms':>8s}",
    ]
    for r in sorted(rows, key=lambda r: (r["hz"], ORDER.index(r["tag"]))):
        lines.append(f"  {str(r['hz'])+' '+r['tag']:>12s}{r['coh']:10.4f}{r['ms']:8.0f}")
    lines += [""]
    for tag in ORDER:
        v = np.array([r["coh"] for r in rows if r["tag"] == tag])
        lines.append(f"  {tag:8s} 相位相关 中位 {np.median(v):.4f}  最差 {v.min():.4f}")
    lines += [
        "",
        "注意 old_x3 的数字也会变高，那是**复制同一个周期**造成的假象，不代表更自然。",
        "这条指标只回答「周期之间有没有被 OLA 抹乱」，听感请以 repeat/ 和 phrase/ 为准。",
    ]
    (OUT / "README.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
