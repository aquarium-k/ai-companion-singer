"""试听包：0.65 s 短样本 vs ×3 拉长后的 1.9 s 长样本（同一批素材）。

    python tools/length_ab.py        # → shots/loop-mul/

short 用 `.tmp/voices-065`（拉长前的备份），long 用 `public/voices`（现在的库）。
两版都是同一批 SVC 素材，区别只在「循环多长」——所以听的就是「重复感」。
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

from chain_diag import coherence  # noqa: E402

SR = 44100
SHORT = ROOT / ".tmp/voices-065"
LONG = ROOT / "public/voices"
OUT = ROOT / "shots/loop-mul"
SHOW = [210, 352, 516, 850]
PHRASE = [261.6, 329.6, 392.0, 440.0, 523.3, 466.2, 392.0, 329.6]


def read(p) -> np.ndarray:
    y, sr = sf.read(str(p), dtype="float32")
    if y.ndim > 1:
        y = y.mean(axis=1)
    assert sr == SR, (p, sr)
    return y


def pick(dir_: Path, hz: float) -> tuple[np.ndarray, float]:
    best, bd = None, 1e9
    for p in sorted(dir_.glob("loop_[0-9]*.wav")):
        jp = p.with_suffix(".json")
        root = (
            float(json.loads(jp.read_text(encoding="utf-8"))["rootHz"])
            if jp.exists()
            else float(p.stem.split("_")[1])
        )
        d = abs(1200 * np.log2(root / hz))
        if d < bd:
            best, bd = p, d
    y = read(best)
    import librosa

    f0, _, _ = librosa.pyin(y, fmin=70, fmax=1200, sr=SR, frame_length=2048, hop_length=128)
    ok = ~np.isnan(f0)
    return y, float(np.median(f0[ok])) if ok.sum() > 4 else hz


def resample(y: np.ndarray, rate: float) -> np.ndarray:
    n_out = max(1, int(round(len(y) / rate)))
    idx = np.arange(n_out) * rate
    i0 = np.floor(idx).astype(int)
    fr = idx - i0
    return (y[i0 % len(y)] * (1 - fr) + y[(i0 + 1) % len(y)] * fr).astype(np.float32)


def fade(y: np.ndarray, ms_in: float = 20, ms_out: float = 120) -> np.ndarray:
    z = y.copy()
    a = int(SR * ms_in / 1000)
    b = int(SR * ms_out / 1000)
    if a > 1:
        z[:a] *= np.linspace(0, 1, a)
    if b > 1 and len(z) > b:
        z[-b:] *= np.linspace(1, 0, b)
    return z


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "repeat").mkdir(exist_ok=True)
    (OUT / "phrase").mkdir(exist_ok=True)

    lines = ["循环长度对比：0.65 s（short）vs ×3 拉长 1.9 s（long）", ""]
    for hz in SHOW:
        for tag, d in (("short", SHORT), ("long", LONG)):
            y, root = pick(d, hz)
            n = max(1, int(np.ceil(4.0 / (len(y) / SR))))
            rep = np.tile(y, n)[: int(SR * 4.0)] * 0.5
            sf.write(OUT / "repeat" / f"rep_{hz}_{tag}.wav", fade(rep, 10, 150), SR, subtype="PCM_16")
            coh, _ = coherence(y, SR / root)
            lines.append(f"  {hz} {tag:6s} {len(y)/SR*1000:6.0f} ms  相位相关 {coh:.4f}")

    for tag, d in (("short", SHORT), ("long", LONG)):
        segs = []
        for i, hz in enumerate(PHRASE):
            tone, r = pick(d, hz)
            tone = resample(tone, hz / r)
            want = int(SR * (0.45 if i < len(PHRASE) - 1 else 0.9))
            while len(tone) < want:
                tone = np.concatenate([tone, tone])
            segs.append(fade(tone[:want], 30, 90) * 0.5)
        sf.write(OUT / "phrase" / f"phrase_{tag}.wav", np.concatenate(segs), SR, subtype="PCM_16")

    lines += [
        "",
        "同一批 SVC 素材，只有长度不同：short 每 0.65 s 原样重来一次，long 每 1.9 s 一次。",
        "拉长不生成新细节（音色差中位 0.24 dB），所以差别只在「重复感 / 起伏被放慢」。",
        "重点听 repeat/：长音上 short 会有一次明显的「重来」，long 没有。",
    ]
    (OUT / "README.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
