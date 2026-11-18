#!/usr/bin/env python3
"""把「意图包络」搬到音色转换结果上。

## 为什么需要这个

seed-vc 的 DiT 只看 内容(whisper) + 音高 + 音色(style) + 参考提示，
**根本看不到源音频的能量包络**。所以它生成的强弱/咬字是「自己猜的」，
和我们要的那一版唱法只是碰巧有点像：实测 log 包络相关只有 0.625，
四成 200ms 片段掉到 0.3 以下——听感上就是「字头对不齐、该断的地方不断」。

这个工具做一件很窄的事：把转换结果的**逐帧能量**拉向源音频，
乘上去的是一个标量增益曲线（不改共振峰、不改音高，所以不伤音色），
增益限幅在 ±N dB 以内，避免把模型的呼吸/气声全抹平。

## 用法

    py tools/env_graft.py --source synth.wav --input vc.wav --out grafted.wav
    py tools/env_graft.py ... --strength 0.6 --limit-db 4   # 更保守

`--strength` 0=不处理，1=完全按源包络走；默认 0.8。
"""
from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

import extract_f0

SR = 44100          # 跟 seed-vc 的输出同一个采样率，避免来回重采样
HOP = 128          # 2.9ms，够细到单个辅音
WIN = 512          # 11.6ms


def frame_rms(x: np.ndarray) -> np.ndarray:
    if len(x) <= WIN:
        x = np.pad(x, (0, WIN - len(x) + 1))
    count = 1 + (len(x) - WIN) // HOP
    index = np.arange(WIN)[None, :] + HOP * np.arange(count)[:, None]
    return np.sqrt((x[index] ** 2).mean(axis=1))


def smooth(x: np.ndarray, frames: int) -> np.ndarray:
    if frames <= 1:
        return x
    kernel = np.ones(frames) / frames
    pad = frames // 2
    return np.convolve(np.pad(x, (pad, pad), mode="edge"), kernel, mode="valid")[: len(x)]


def graft(source: np.ndarray, converted: np.ndarray, strength: float, limit_db: float, smooth_ms: float):
    n = max(len(source), len(converted))
    s = np.pad(source, (0, n - len(source)))
    c = np.pad(converted, (0, n - len(converted)))

    es = frame_rms(s)
    ec = frame_rms(c)

    # 平滑到 ~15ms：只搬运「这一段响/这一段轻」，不追逐采样细节
    ms_frames = max(1, int(round(0.015 * SR / HOP)))
    es_s = smooth(es, ms_frames)
    ec_s = smooth(ec, ms_frames)

    eps = 1e-6
    ratio = (es_s + eps) / (ec_s + eps)
    gain_db = strength * 20.0 * np.log10(ratio)
    gain_db = np.clip(gain_db, -limit_db, limit_db)
    gain = 10.0 ** (gain_db / 20.0)

    # 增益曲线本身也低通一下，否则逐帧跳变会有「抽气」感
    gain = smooth(gain, max(1, int(round(smooth_ms / 1000.0 * SR / HOP))))

    # 帧中心 → 逐采样点
    centres = np.arange(len(gain)) * HOP + WIN / 2
    gain_sample = np.interp(np.arange(n), centres, gain, left=gain[0], right=gain[-1])
    return c * gain_sample


def correlation(a: np.ndarray, b: np.ndarray) -> float:
    ea, eb = frame_rms(a), frame_rms(b)
    n = min(len(ea), len(eb))
    ea, eb = ea[:n], eb[:n]
    ok = (ea > 1e-6) & (eb > 1e-6)
    if ok.sum() < 50:
        return float("nan")
    return float(np.corrcoef(np.log(ea[ok]), np.log(eb[ok]))[0, 1])


def soft_limit(x: np.ndarray, knee: float = 0.85) -> np.ndarray:
    """膝盖以下线性，以上压 tanh，避免增益把峰值推爆。"""
    a = np.abs(x)
    over = a > knee
    if not np.any(over):
        return x
    y = x.copy()
    y[over] = np.sign(x[over]) * (knee + (1.0 - knee) * np.tanh((a[over] - knee) / (1.0 - knee)))
    return y


def write_out(path: Path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() == ".mp3":
        import separate

        separate.write_mp3(path, np.stack([x, x]).astype(np.float32), SR, 192_000)
        return
    pcm = (np.clip(x, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


def main() -> int:
    ap = argparse.ArgumentParser(description="把源音频的能量包络搬到转换结果上")
    ap.add_argument("--source", required=True, help="意图（我们的合成/演唱）")
    ap.add_argument("--input", required=True, help="音色转换的输出")
    ap.add_argument("--out", required=True, help="输出路径；.mp3 走 mp3，其余按 wav")
    ap.add_argument("--strength", type=float, default=0.8, help="0=不处理，1=完全跟随源包络")
    ap.add_argument("--limit-db", type=float, default=6.0, help="增益限幅（±dB）")
    ap.add_argument("--smooth-ms", type=float, default=12.0, help="增益曲线低通时长")
    args = ap.parse_args()

    src = extract_f0.decode_mono(str(args.source), SR)
    vc = extract_f0.decode_mono(str(args.input), SR)

    before = correlation(src, vc)
    out = graft(src, vc, args.strength, args.limit_db, args.smooth_ms)
    after = correlation(src, out)

    # 保持整体响度不变，只改起伏
    rms_in = float(np.sqrt((vc**2).mean())) or 1.0
    rms_out = float(np.sqrt((out**2).mean())) or 1.0
    out *= rms_in / rms_out
    out = soft_limit(out)

    peak = float(np.max(np.abs(out))) or 1.0
    if peak > 0.99:
        out *= 0.99 / peak

    write_out(Path(args.out), out)

    print(
        f"包络相关 {before:.3f} → {after:.3f}（strength={args.strength}，"
        f"限幅 ±{args.limit_db:g}dB，{len(out)/SR:.2f}s）"
    )
    print(f"写入 {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
