"""切两段「ら」的起音瞬态，供和声咬字用（splice 式：整段替掉循环，不再叠加）。

为什么要重切
------------
现有的 `harmony_att.wav`（对白里的 ら，305 Hz）量下来是**元音在前、闭塞在后**
（0–98 ms 是上一个字的元音，98–120 ms 才是 ら 的闭塞），当头用等于先唱一个字
再闭嘴——难怪怎么调都不像。`harmony_att_sung.wav`（翻唱 65 s）方向是对的
（0–40 ms 闭塞，46 ms 之后是元音），但 150 ms 太长，尾巴会和循环叠在一起。

做法
----
- `att_ra_mid.wav`：对白版，从闭塞前 6 ms 起截 90 ms（闭塞 + burst + 40 ms 元音）。
- `att_ra_hi.wav`：翻唱版，从 64.97 s 起截 90 ms（同样含闭塞 + 元音头）。
两个都只留「瞬态 + 元音头」，后面的持续段交给循环，这样不用管变调后的
共振峰漂移，也不会两路相加。

用法: py -3 tools/cut_attack.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from extract_f0 import decode_mono  # noqa: E402

OUT = ROOT / "public" / "voices"
SR = 22050
GRID = 0.002


def envelope(sig: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    win = int(0.004 * SR)
    step = int(GRID * SR)
    n = max(0, (len(sig) - win) // step)
    rms = np.array([np.sqrt(np.mean(sig[i * step : i * step + win] ** 2) + 1e-12) for i in range(n)])
    return np.arange(n) * GRID + win / 2 / SR, rms


def print_shape(tag: str, times: np.ndarray, rms: np.ndarray, t0: float, t1: float) -> None:
    sel = (times >= t0) & (times <= t1)
    db = 20 * np.log10(rms[sel])
    peak = float(np.percentile(db, 95))
    rel = db - peak
    line = "".join(
        " " if r < -30 else "." if r < -22 else ":" if r < -15 else "-" if r < -9 else "=" if r < -4 else "#"
        for r in rel[::2]
    )
    print(f"  {tag} {t0:.3f}–{t1:.3f}s  峰值 {peak:5.1f} dB")
    print("    " + line)


def write_wav(name: str, signal: np.ndarray, meta: dict) -> None:
    import wave

    path = OUT / f"{name}.wav"
    ints = np.clip(signal, -1, 1)
    ints = (ints * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(ints.tobytes())
    (OUT / f"{name}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), "utf-8")
    print(f"  → {path.name}  {len(signal) / SR * 1000:.0f} ms  root {meta['rootHz']:.1f} Hz")


def main() -> int:
    print("== 对白里的 ら（ref3_vocals）")
    src = decode_mono(str(ROOT / "shots" / "ref3" / "sep" / "ref3_vocals.wav"))
    times, rms = envelope(src)
    print_shape("原始", times, rms, 17.0, 17.6)

    # 在 17.0–17.4 找闭塞（最小点）
    sel = (times >= 17.15) & (times <= 17.35)
    i_min = int(np.flatnonzero(sel)[np.argmin(rms[sel])])
    print(f"  最安静点 {times[i_min]:.3f}s  {20 * np.log10(rms[i_min]):.1f} dB")
    # 闭塞结束 = 之后第一次超过最小点 +18 dB 的位置
    after = np.flatnonzero(times > times[i_min])
    rise = [i for i in after if 20 * np.log10(rms[i]) > 20 * np.log10(rms[i_min]) + 18]
    burst_t = float(times[rise[0]]) if rise else float(times[i_min] + 0.03)
    print(f"  burst 起点 ≈ {burst_t:.3f}s（闭塞宽 {(burst_t - times[i_min]) * 1000:.0f} ms）")

    # 从闭塞前 6 ms 起 90 ms
    start = max(0, int((times[i_min] - 0.006) * SR))
    mid = src[start : start + int(0.09 * SR)].copy()
    # 首尾各 2 ms 淡入淡出，避免切点爆音（尾部本来就会被交叉淡化吃掉）
    fade = int(0.002 * SR)
    mid[:fade] *= np.linspace(0, 1, fade)
    mid[-fade:] *= np.linspace(1, 0, fade)
    write_wav(
        "att_ra_mid",
        mid,
        {
            "kind": "consonant",
            "source": "shots/ref3/sep/ref3_vocals.wav",
            "songTime": round(float(times[i_min]), 3),
            "rootHz": 305.64,
            "leadSec": round(float(burst_t - times[i_min] + 0.006), 3),
            "lengthSec": 0.09,
            "sampleRate": SR,
            "note": "対白の「から」の ら。持続部は切り落とし、瞬態+元音頭だけ",
        },
    )
    print_shape("切完", *envelope(mid), 0.0, len(mid) / SR)

    print("\n== 翻唱里的 ら（cover90s40 @64.97s）")
    cover = decode_mono(str(ROOT / "shots" / "cover90s40.wav"))
    start = int(64.97 * SR)
    hi = cover[start : start + int(0.09 * SR)].copy()
    hi[:fade] *= np.linspace(0, 1, fade)
    hi[-fade:] *= np.linspace(1, 0, fade)
    write_wav(
        "att_ra_hi",
        hi,
        {
            "kind": "consonant",
            "source": "shots/cover90s40.wav",
            "songTime": 64.97,
            "rootHz": 535.8,
            "leadSec": 0.040,
            "lengthSec": 0.09,
            "sampleRate": SR,
            "note": "歌の「ら」。前 40 ms が閉鎖、46 ms から元音",
        },
    )
    print_shape("切完", *envelope(hi), 0.0, len(hi) / SR)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
