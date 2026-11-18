"""常驻的语音识别小服务：一次加载模型，之后每句只做推理。

为什么不「每句话启动一次 python」：faster-whisper 加载模型要 3~6 秒，
用户说四个字要等六秒，没人会用。

协议（stdin/stdout 各一行 JSON）：
  请求  {"wav": "C:/path/to.wav"}   或  {"ping": true}
  响应  {"ok": true, "text": "挥手", "ms": 123, "audio": 1.8}
        {"ok": false, "error": "..."}

用法:
  python tools/asr_server.py --model base
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")


def log(*args: object) -> None:
    print(*args, file=sys.stderr, flush=True)


def read_wav(path: str) -> tuple["object", int]:
    """自己读 wav，不经过 PyAV。

    faster-whisper 默认用 av 解码，而这套 .pylibs 里的 av 版本和它的调用对不上
    （`open() got an unexpected keyword argument 'metadata_errors'`）。
    我们喂进去的永远是 16 kHz / 16-bit / 单声道 PCM，用标准库 wave + numpy 解足够，
    顺带省掉一次重采样。
    """
    import numpy as np
    import wave

    with wave.open(path, "rb") as f:
        channels = f.getnchannels()
        width = f.getsampwidth()
        rate = f.getframerate()
        raw = f.readframes(f.getnframes())

    if width != 2:
        raise ValueError(f"只支持 16-bit PCM，这个是 {width * 8}-bit")
    data = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    return data, rate


def main() -> int:
    ap = argparse.ArgumentParser(description="常驻 ASR 服务（JSON lines over stdio）")
    ap.add_argument("--model", default="base", help="faster-whisper 模型名或本地路径")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--language", default="zh", help="固定语言能省掉检测，短句更准")
    ap.add_argument(
        "--prompt",
        default="",
        help="initial_prompt：把可能的指令先告诉模型，短句识别率会明显提高",
    )
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    threads = args.threads or max(1, (os.cpu_count() or 4) // 2)
    t0 = time.time()
    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type=args.compute_type,
        cpu_threads=threads,
    )
    log(f"[asr] 模型 {args.model} 载入 {time.time() - t0:.1f}s, {threads} 线程")

    # 告诉上层「我准备好了」，避免它盲等
    print(json.dumps({"ready": True, "model": args.model}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            print(json.dumps({"ok": False, "error": "bad json"}), flush=True)
            continue

        if req.get("ping"):
            print(json.dumps({"ok": True, "pong": True}), flush=True)
            continue

        wav = req.get("wav")
        if not wav or not os.path.exists(wav):
            print(json.dumps({"ok": False, "error": f"没有这个文件: {wav}"}), flush=True)
            continue

        t1 = time.time()
        try:
            audio, rate = read_wav(wav)
            if rate != 16000:
                log(f"[asr] 警告：采样率 {rate}，不是 16000，识别会偏")
            segments, info = model.transcribe(
                audio,
                language=args.language or None,
                beam_size=3,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 300},
                condition_on_previous_text=False,
                initial_prompt=args.prompt or None,
            )
            text = "".join(seg.text for seg in segments).strip()
            print(
                json.dumps(
                    {
                        "ok": True,
                        "text": text,
                        "ms": int((time.time() - t1) * 1000),
                        "audio": round(len(audio) / max(1, rate), 2),
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
        except Exception as exc:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
