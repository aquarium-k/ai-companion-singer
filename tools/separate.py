#!/usr/bin/env python3
"""人声分离：UVR MDX-Net ONNX，只用 numpy + onnxruntime + PyAV。

为什么不用 `audio-separator`
----------------------------
它无条件依赖 `torch>=2.3`（不是 extras），装完 .pylibs 会从 276MB 涨到 1GB 以上，
pip 解析依赖树实测 14 分钟没结束。而 MDX-Net 的推理本身只需要 onnxruntime——
这个推理链路按 UVR 的参考实现重写了一遍，依赖为零。

模型
----
`UVR-MDX-NET-Inst_HQ_3.onnx`（63MB，HF `Tha456/uvr5-models`）。
输入 `(batch, 4, 3072, 256)`：4 个通道是 [L实, L虚, R实, R虚]，
3072 个频点 × 256 帧。**它直接输出伴奏**，人声 = 原混音 - 伴奏。

参数（UVR 标准）
----------------
n_fft=6144, hop=1024, dim_f=3072, dim_t=256, 44.1kHz 立体声。
n_bins = 6144//2+1 = 3073，模型只吃前 3072 个，第 3073 个（Nyquist）在 ISTFT 前补零。
chunk = hop*(dim_t-1) = 261120 样本 ≈ 5.9 秒。
"""

from __future__ import annotations

import argparse
import os
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".pylibs"))

import numpy as np  # noqa: E402

SR = 44100
N_FFT = 6144
HOP = 1024
DIM_F = 3072
DIM_T = 256
DIM_C = 4

N_BINS = N_FFT // 2 + 1
CHUNK = HOP * (DIM_T - 1)
TRIM = N_FFT // 2
GEN = CHUNK - 2 * TRIM
MARGIN = 44100  # 分块重叠 1 秒


# ----------------------------------------------------------------- 音频读写

def decode(path: str, sr: int = SR) -> np.ndarray:
    """解码成 (2, N) float32 立体声。"""
    import av

    container = av.open(path)
    stream = container.streams.audio[0]
    resampler = av.AudioResampler(format="fltp", layout="stereo", rate=sr)
    parts = []
    for frame in container.decode(stream):
        for out in resampler.resample(frame):
            parts.append(out.to_ndarray())
    for out in resampler.resample(None):
        parts.append(out.to_ndarray())
    if not parts:
        raise RuntimeError(f"解码失败：{path}")
    return np.concatenate(parts, axis=1).astype(np.float32)


def write_wav(path: Path, data: np.ndarray, sr: int = SR) -> None:
    clipped = np.clip(data.T, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(2)
        fh.setsampwidth(2)
        fh.setframerate(sr)
        fh.writeframes(pcm.tobytes())


def write_mp3(path: Path, data: np.ndarray, sr: int = SR, bit_rate: int = 192_000) -> None:
    """分轨直接进曲包要用 mp3：204 秒的立体声 wav 是 36MB，mp3 约 5MB。

    两轨都走同一条编码路径，编码器延迟一样，所以仍然采样对齐。
    """
    import av

    container = av.open(str(path), mode="w", format="mp3")
    try:
        stream = container.add_stream("libmp3lame", rate=sr)
        stream.layout = "stereo"
        stream.bit_rate = bit_rate

        samples = np.clip(data.T, -1.0, 1.0).astype(np.float32)  # (N, 2)
        frame_size = 1152
        for start in range(0, samples.shape[0], frame_size):
            block = samples[start : start + frame_size]
            if block.shape[0] < frame_size:
                block = np.pad(block, ((0, frame_size - block.shape[0]), (0, 0)))
            frame = av.AudioFrame.from_ndarray(block.T.copy(), format="fltp", layout="stereo")
            frame.sample_rate = sr
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)
    finally:
        container.close()


def write_audio(path: Path, data: np.ndarray, sr: int = SR, bit_rate: int = 192_000) -> None:
    if path.suffix.lower() == ".mp3":
        write_mp3(path, data, sr, bit_rate)
    else:
        write_wav(path, data, sr)


# --------------------------------------------------------------- STFT / ISTFT

def hann(n: int) -> np.ndarray:
    """周期 Hann 窗，和 torch.hann_window(periodic=True) 一致。"""
    return (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / n)).astype(np.float32)


def stft(batch: np.ndarray, window: np.ndarray) -> np.ndarray:
    """(B, N) → (B, n_bins, n_frames)，center=True + reflect 填充。"""
    pad = N_FFT // 2
    padded = np.pad(batch, ((0, 0), (pad, pad)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT, axis=1)[:, ::HOP, :]
    spec = np.fft.rfft(frames * window, axis=-1)
    return np.transpose(spec, (0, 2, 1)).astype(np.complex64)


def istft(spec: np.ndarray, window: np.ndarray, length: int) -> np.ndarray:
    """(B, n_bins, n_frames) → (B, length)，重叠相加后按窗平方和归一化。"""
    frames = np.fft.irfft(np.transpose(spec, (0, 2, 1)), n=N_FFT, axis=-1) * window
    count = frames.shape[1]
    total = N_FFT + HOP * (count - 1)
    out = np.zeros((frames.shape[0], total), dtype=np.float64)
    norm = np.zeros(total, dtype=np.float64)
    for t in range(count):
        start = t * HOP
        out[:, start : start + N_FFT] += frames[:, t]
        norm[start : start + N_FFT] += window**2
    out /= np.maximum(norm, 1e-8)
    return out[:, N_FFT // 2 : N_FFT // 2 + length].astype(np.float32)


# ------------------------------------------------------------------- 模型

def band_energy_ratio(x: np.ndarray, lo: int, hi: int, sr: int = SR) -> float:
    """(2, N) 音频在 [lo, hi] Hz 的能量占比，每 5 秒取一窗平均。"""
    win = 8192
    if x.shape[-1] < win:
        return 0.0
    freqs = np.fft.rfftfreq(win, 1 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    ratios = []
    for start in range(0, x.shape[-1] - win, sr * 5):
        seg = x[:, start : start + win] * np.hanning(win)
        spec = np.abs(np.fft.rfft(seg, axis=-1)) ** 2
        total = float(spec.sum())
        if total > 0:
            ratios.append(float(spec[:, band].sum()) / total)
    return float(np.mean(ratios)) if ratios else 0.0


def guess_target(predicted: np.ndarray, sr: int = SR) -> str:
    """判断模型输出的是哪一轨。

    踩过的坑：**不能看文件名**。`UVR_MDXNET_3_9662.onnx` 这名字里没有 `Inst`，
    但它输出的是伴奏。按文件名猜会把人声和伴奏整个放反，而且编码之后
    波形长度、能量都正常，只有耳朵能听出来。

    可靠的判据是低频：伴奏有 kick 和 bass，30–120Hz 能量占比通常在 30% 以上；
    人声这一频段几乎是空的（实测 0.0%）。阈值 15% 两边都留了很大余量。
    """
    ratio = band_energy_ratio(predicted, 30, 120, sr)
    return "instrumental" if ratio > 0.15 else "vocals"


def load_session(model_path: str):
    """加载 ONNX，并从输入形状读出 dim_f / dim_t（不同模型不一样）。"""
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
    shape = session.get_inputs()[0].shape
    dim_f, dim_t = int(shape[2]), int(shape[3])
    print(f"模型输入 {shape}  → dim_f={dim_f} dim_t={dim_t}")
    if dim_f > N_BINS:
        raise SystemExit(f"模型 dim_f={dim_f} 超过 n_bins={N_BINS}，不兼容")
    return session, dim_f, dim_t


def run_chunk(session, mix: np.ndarray, window: np.ndarray) -> np.ndarray:
    """mix (2, CHUNK) → 分离结果 (2, CHUNK)。"""
    # (2, N) → (2*B, N) 的批量维度会打乱通道顺序，这里先按 RVC 的做法展开
    spec = stft(mix, window)                     # (2, n_bins, dim_t)
    spec = spec[:, :DIM_F, :]                    # 丢掉 Nyquist 那一格
    # [L实, L虚, R实, R虚]
    packed = np.stack([spec[0].real, spec[0].imag, spec[1].real, spec[1].imag], axis=0)
    packed = packed[None, ...].astype(np.float32)  # (1, 4, DIM_F, DIM_T)

    predicted = session.run(None, {session.get_inputs()[0].name: packed})[0][0]

    left = predicted[0] + 1j * predicted[1]
    right = predicted[2] + 1j * predicted[3]
    full = np.zeros((2, N_BINS, DIM_T), dtype=np.complex64)
    full[0, :DIM_F] = left
    full[1, :DIM_F] = right
    return istft(full, window, CHUNK)


def separate(mix: np.ndarray, session, progress: bool = True) -> np.ndarray:
    """整首分离，返回**模型直接预测的那一轨**（人声或伴奏，看模型）。"""
    window = hann(N_FFT)
    samples = mix.shape[1]
    step = CHUNK - 2 * MARGIN if samples > CHUNK else CHUNK

    starts = []
    pos = 0
    while pos < samples:
        starts.append(pos)
        pos += step

    out = np.zeros_like(mix)
    weight = np.zeros(samples, dtype=np.float32)
    total = len(starts)
    for index, start in enumerate(starts):
        # 每块左边多取 MARGIN 做上下文（首块没有左边），只把「本块负责」的一段累加
        pad_left = MARGIN if start > 0 else 0
        begin = start - pad_left
        take = min(CHUNK, samples - begin)
        chunk = np.zeros((2, CHUNK), dtype=np.float32)
        chunk[:, :take] = mix[:, begin : begin + take]

        result = run_chunk(session, chunk, window)

        lo = pad_left
        hi = min(take, lo + step)
        out[:, begin + lo : begin + hi] += result[:, lo:hi]
        weight[begin + lo : begin + hi] += 1.0

        if progress:
            done = (index + 1) / total
            bar = "#" * int(24 * done)
            print(f"\r  分离 {bar:<24} {done * 100:3.0f}%", end="", flush=True)

    if progress:
        print()
    weight[weight == 0] = 1.0
    return out / weight


def main() -> int:
    global DIM_F, DIM_T, CHUNK, GEN
    ap = argparse.ArgumentParser(description="UVR MDX-Net 人声分离（无 torch）")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", required=True, help="*.onnx 路径")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--prefix", default="")
    ap.add_argument(
        "--target",
        choices=["auto", "vocals", "instrumental"],
        default="auto",
        help="模型输出的是哪一轨。auto 用低频能量占比实测判断（文件名不可靠）",
    )
    ap.add_argument(
        "--format",
        choices=["wav", "mp3"],
        default="wav",
        help="输出格式。wav 用于继续跑 ASR/对齐，mp3 用于直接塞进曲包",
    )
    ap.add_argument("--bitrate", default="192k", help="mp3 码率，默认 192k")
    args = ap.parse_args()

    started = time.time()
    mix = decode(args.audio)
    print(f"解码完成：{mix.shape[1] / SR:.1f}s，{mix.shape[0]} 声道")

    session, dim_f, dim_t = load_session(args.model)
    DIM_F, DIM_T = dim_f, dim_t
    CHUNK = HOP * (DIM_T - 1)
    GEN = CHUNK - 2 * TRIM
    print(f"分块 {CHUNK / SR:.2f}s，步进 {GEN / SR:.2f}s")

    predicted = separate(mix, session)

    target = args.target
    if target == "auto":
        target = guess_target(predicted)
        print(f"模型输出实测 = {target}（30–120Hz 能量占比 {band_energy_ratio(predicted, 30, 120) * 100:.1f}%）")
    print(f"模型输出 = {target}（另一轨由 mix - 该轨得到）")

    if target == "vocals":
        vocals, instrumental = predicted, mix - predicted
    else:
        instrumental, vocals = predicted, mix - predicted

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = args.prefix
    suffix = f".{args.format}"
    bit_rate = int(args.bitrate.lower().replace("k", "")) * 1000 if args.format == "mp3" else 192_000
    write_audio(out_dir / f"{prefix}instrumental{suffix}", instrumental, bit_rate=bit_rate)
    write_audio(out_dir / f"{prefix}vocals{suffix}", vocals, bit_rate=bit_rate)

    # 能量占比可以粗判分离是否失败：人声轨不该比伴奏还响，也不该几乎为零
    e_mix = float(np.mean(mix**2))
    e_voc = float(np.mean(vocals**2))
    e_ins = float(np.mean(instrumental**2))
    print(f"人声能量占比 {e_voc / max(e_mix, 1e-9) * 100:.1f}%  伴奏 {e_ins / max(e_mix, 1e-9) * 100:.1f}%")
    print(f"耗时 {time.time() - started:.1f}s")
    print(f"写入 {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
