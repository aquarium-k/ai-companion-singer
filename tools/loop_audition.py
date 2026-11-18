"""生成试听包：现在的循环 / 拉长 2× / 拉长 3× / SVC 直出，放到 shots/loop-audition/。

四种样本，对应四种「让和声不机械」的思路：
  now = 现在库里的（修过音，0.32 s，多数是 PSOLA 链派生）
  x2  = 现在这段按周期重复到 2×（0.64 s）
  x3  = 同上到 3×（0.96 s）        ← 用户提的「慢放再截」的有效版本
  svc = 不走 PSOLA，直接用 SVC 在目标音高上生成 0.6 s 长音（第一代，没有 OLA 涂抹）

三种听法：
  single/  单次循环（音色本身）
  repeat/  同一段连播 6 次（听「循环多久重来一次」）  ← 重点
  phrase/  8 个音的一句旋律，音高走 playbackRate（和 App 同一条路）

    python tools/loop_audition.py
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

from stretch_loops import stretch  # noqa: E402

VOICES = ROOT / "public/voices"
OUT = ROOT / "shots/loop-audition"
SR = 44100

SVC_DIRS = [ROOT / ".tmp/rebake-full", ROOT / ".tmp/rebake6", ROOT / ".tmp/rebake"]

SHOW = [210, 241, 516, 850]

PHRASE = [261.6, 329.6, 392.0, 440.0, 523.3, 466.2, 392.0, 329.6]


def load_current(root_hz: float) -> tuple[np.ndarray, float]:
    doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
    best = min(
        (l for l in doc["loops"] if (l.get("vowel") or "a") == "a"),
        key=lambda l: abs(1200 * np.log2(root_hz / float(l["rootHz"]))),
    )
    y, sr = sf.read(VOICES / Path(best["url"]).name, dtype="float32")
    assert sr == SR, sr
    return y, float(best["rootHz"])


def load_svc(hz: float) -> tuple[np.ndarray, float] | None:
    import librosa

    for d in SVC_DIRS:
        p = d / f"loop_{hz}.wav"
        if p.exists():
            y, sr = sf.read(p, dtype="float32")
            if y.ndim > 1:
                y = y.mean(axis=1)
            f0, _, _ = librosa.pyin(y, fmin=70, fmax=1200, sr=SR, frame_length=2048, hop_length=128)
            ok = ~np.isnan(f0)
            return y, float(np.median(f0[ok])) if ok.sum() > 4 else hz
    return None


def resample(y: np.ndarray, rate: float) -> np.ndarray:
    """和 Web Audio 的 playbackRate 同一种做法（线性插值重采样，循环）。"""
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


def measure(x: np.ndarray, root: float) -> dict:
    """音高抖动 + 相位干净度（相邻周期波形相关，越接近 1 越不像「毛」）。"""
    import librosa

    sys.path.insert(0, str(ROOT / ".tmp"))
    from chain_diag import coherence

    f0, _, _ = librosa.pyin(x, fmin=70, fmax=1000, sr=SR, frame_length=2048, hop_length=128)
    ok = ~np.isnan(f0)
    std = float(np.std(1200 * np.log2(f0[ok] / root))) if ok.sum() > 8 else float("nan")
    try:
        coh, _ = coherence(x, SR / root)
    except Exception:
        coh = float("nan")
    return dict(std=std, coh=coh)


def variants_for(hz: float):
    cur, root = load_current(hz)
    out = [("now", cur, root)]
    for tag, f in (("x2", 2.0), ("x3", 3.0)):
        out.append((tag, stretch(cur, SR, root, f)[0], root))
    s = load_svc(hz)
    if s:
        out.append(("svc", s[0], s[1]))
    return out


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for sub in ("single", "repeat", "phrase"):
        (OUT / sub).mkdir(exist_ok=True)

    rows = []
    for hz in SHOW:
        vs = variants_for(hz)
        for tag, y, root in vs:
            m = measure(y, root)
            sf.write(OUT / "single" / f"loop_{hz}_{tag}.wav", fade(y * 0.5), SR, subtype="PCM_16")
            # 统一 4.0 s：四种样本在同一段时长里「重来几次」可以直接对比
            n = max(1, int(np.ceil(4.0 / (len(y) / SR))))
            rep = np.tile(y, n)[: int(SR * 4.0)] * 0.5
            sf.write(OUT / "repeat" / f"rep_{hz}_{tag}.wav", fade(rep, 10, 150), SR, subtype="PCM_16")
            rows.append(dict(hz=hz, tag=tag, ms=len(y) / SR * 1000, **m))

        for tag, y, root in vs:
            segs = []
            for i, hz2 in enumerate(PHRASE):
                if tag == "svc":
                    s = load_svc(int(round(hz2)))
                    if s is None:
                        continue
                    tone, r2 = s
                else:
                    tone, r2 = load_current(hz2)
                    if tag == "x2":
                        tone = stretch(tone, SR, r2, 2.0)[0]
                    elif tag == "x3":
                        tone = stretch(tone, SR, r2, 3.0)[0]
                tone = resample(tone, hz2 / r2)
                want = int(SR * (0.45 if i < len(PHRASE) - 1 else 0.9))
                while len(tone) < want:
                    tone = np.concatenate([tone, tone])
                segs.append(fade(tone[:want], 30, 90) * 0.5)
            if len(segs) == len(PHRASE):
                sf.write(OUT / "phrase" / f"phrase_{tag}.wav", np.concatenate(segs), SR, subtype="PCM_16")

    lines = [
        "循环采样试听包（2026-11-17）",
        "",
        "四种样本：",
        "  now = 现在库里的（修过音，0.32 s；多数档是 PSOLA 链派生）",
        "  x2  = 现在这段按整周期重复到 2×（0.64 s，音高/共振峰不变）",
        "  x3  = 同上 3×（0.96 s）",
        "  svc = 不走 PSOLA 链，直接用 SVC 在目标音高上生成 0.6 s 长音（第一代）",
        "",
        "目录：",
        "  single/  单次循环（听音色本身）",
        "  repeat/  同一段连播 4.0 s（四版等长，直接对比「重来几次」）  ← 重点",
        "  phrase/  8 个音的一句旋律，音高走 playbackRate（和 App 同一条路）",
        "",
        "量化（相位相关 = 相邻周期波形的归一化相关，越接近 1 越干净；这是「毛/抖」的直接量）：",
        f"  {'样本':>10s} {'音高std(音分)':>13s} {'相位相关':>9s} {'长度ms':>8s}",
    ]
    for r in sorted(rows, key=lambda r: (r["hz"], ["now", "x2", "x3", "svc"].index(r["tag"]))):
        lines.append(
            f"  {str(r['hz'])+' '+r['tag']:>10s} {r['std']:13.1f} {r['coh']:9.4f} {r['ms']:8.0f}"
        )
    lines += [
        "",
        "拉长（x2/x3）不改变波形内容：每个 grain 都是原波形的拷贝，实测音色差中位 0.34 dB、",
        "接缝 0.06× 分位。所以它只把「本来就有的周期级起伏」放慢，重复间隔从 0.32 s 变长。",
        "svc 则是换素材：同样是她的音色，但在目标音高上是第一代（没有反复 OLA 的相位涂抹）。",
        "",
        "判断建议：repeat/ 里比较 now 和 svc；phrase/ 里听整句谁更像人。",
    ]
    (OUT / "README.txt").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
