#!/usr/bin/env python3
"""无歌词路径：只给音频，自动产出歌词 + 行级时间。

和 `auto_align.py` 的分工
------------------------
- `auto_align.py`：**已知歌词**，用歌词去锚定 ASR 的时间（精度高）
- `auto_lyrics.py`：**没有歌词**，直接拿 ASR 的输出当歌词（精度受 ASR 限制）

两条路径产出同一种 `lyrics.json`，下游完全一致。
没有歌词时也别指望逐字正确——ASR 会听错一部分。
实际用法是：先自动跑出初稿，再人工改错字、补时间。

用法：
    set PYTHONPATH=.pylibs
    python tools/auto_lyrics.py --audio "D:\\Music\\song.mp3" --language ja

输出到音频同目录的 `<name>.lyrics.json`，或者用 --out 指定。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

# 复用 auto_align 里的转写/精修机制（它目前兼作 ASR 公共模块）
sys.path.insert(0, str(Path(__file__).resolve().parent))
import auto_align as A  # noqa: E402

# 行切分参数
PAUSE_SPLIT = 0.55   # 词间停顿超过这个值就断行（唱歌的乐句间隙通常比说话短）
MAX_CHARS = 30       # 单行字符上限，超了就在最大的内部停顿处断开
MIN_CHARS = 2        # 太短的行（单个语气词、噪声）丢掉

# 高频幻听短语：纯音乐/间奏被编造出来的东西
HALLUCINATION_PHRASES = (
    "ご視聴ありがとうございました",
    "チャンネル登録",
    "おやすみなさい",
    "Thank you for watching",
    "Thanks for watching",
    "字幕",
)


def transcribe(audio_path: str, model_name: str, language: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    started = time.time()
    print(f"加载模型 {model_name}（首次会下载）…")
    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    print(f"模型就绪，用时 {time.time() - started:.1f}s")

    print("转写中…")
    segments, info = model.transcribe(
        audio_path,
        language=language,
        word_timestamps=True,
        vad_filter=False,  # 唱歌不能用 VAD，见 auto_align.py 的说明
        condition_on_previous_text=False,
        beam_size=5,
        temperature=0.0,
    )

    words: list[tuple[str, float, float]] = []
    seg_dump: list[dict] = []
    for seg in segments:
        text = (seg.text or "").strip()
        if text:
            seg_dump.append(
                {
                    "start": round(float(seg.start), 2),
                    "end": round(float(seg.end), 2),
                    "text": text,
                    "no_speech_prob": round(float(getattr(seg, "no_speech_prob", 0.0)), 3),
                    "avg_logprob": round(float(getattr(seg, "avg_logprob", 0.0)), 3),
                }
            )
        for word in seg.words or []:
            if word.word and word.start is not None:
                words.append((word.word, float(word.start), float(word.end)))

    print(f"转写完成：{len(seg_dump)} 段 / {len(words)} 词，用时 {time.time() - started:.1f}s")
    print(f"识别语言：{info.language}（置信 {info.language_probability:.2f}）")
    return model, words, seg_dump


def drop_hallucinations(seg_dump: list[dict], strict: bool = False) -> list[dict]:
    """丢掉常见幻听短语；严格模式才按置信度过滤。

    置信度阈值（no_speech_prob / avg_logprob）默认**不开**。
    实测它们在带伴奏的歌声上会误杀：50 段里砍掉 24 段，
    凭空造出 130 秒「空洞」，反而触发大量无用的重转写。
    这和 VAD 不能用作曲过滤是同一个原因——这些指标都是为语音训练的。
    """
    kept = []
    dropped = 0
    for seg in seg_dump:
        text = seg["text"]
        if any(p in text for p in HALLUCINATION_PHRASES):
            dropped += 1
            continue
        if strict:
            if seg.get("no_speech_prob", 0.0) > 0.6:
                dropped += 1
                continue
            if seg.get("avg_logprob", 0.0) < -1.0:
                dropped += 1
                continue
        kept.append(seg)
    if dropped:
        print(f"过滤掉 {dropped} 段（黑名单{' + 低置信' if strict else ''}）")
    return kept


def group_words(words: list[tuple[str, float, float]]) -> list[list[tuple[str, float, float]]]:
    """把词序列按停顿切成乐句。"""
    if not words:
        return []
    groups: list[list[tuple[str, float, float]]] = []
    current = [words[0]]
    for prev, word in zip(words, words[1:]):
        gap = word[1] - prev[2]
        if gap > PAUSE_SPLIT:
            groups.append(current)
            current = [word]
        else:
            current.append(word)
    groups.append(current)
    return groups


def split_long(group: list[tuple[str, float, float]]) -> list[list[tuple[str, float, float]]]:
    """一行太长时，在最长的内部停顿处断开，递归到不超过 MAX_CHARS。"""
    text = "".join(w[0] for w in group).strip()
    if len(text) <= MAX_CHARS or len(group) < 4:
        return [group]

    best, best_gap = -1, 0.0
    for i in range(1, len(group)):
        gap = group[i][1] - group[i - 1][2]
        if gap > best_gap:
            best, best_gap = i, gap
    if best <= 0:
        best = len(group) // 2

    return split_long(group[:best]) + split_long(group[best:])


def build_lines(words: list[tuple[str, float, float]]) -> list[dict]:
    lines: list[dict] = []
    for group in group_words(words):
        for piece in split_long(group):
            text = "".join(w[0] for w in piece).strip()
            text = " ".join(text.split())
            if len(A.normalize(text)) < MIN_CHARS:
                continue
            lines.append({"at": round(piece[0][1], 2), "text": text, "src": "asr"})
    return lines


def main() -> int:
    ap = argparse.ArgumentParser(description="无歌词：音频 → 歌词 + 行级时间")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="ja")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--no-refine", action="store_true", help="关闭分窗重转写精修")
    ap.add_argument(
        "--strict-filter",
        action="store_true",
        help="按 no_speech_prob/avg_logprob 过滤（默认关：会误杀歌声）",
    )
    args = ap.parse_args()

    audio_path = Path(args.audio)
    if not audio_path.exists():
        print(f"找不到音频：{audio_path}", file=sys.stderr)
        return 1

    model, words, seg_dump = transcribe(
        str(audio_path), args.model, args.language, args.device, args.compute_type
    )
    if not words:
        print("没有识别到任何词，音频可能是纯音乐", file=sys.stderr)
        return 2

    seg_dump = drop_hallucinations(seg_dump, strict=args.strict_filter)

    if not args.no_refine:
        from faster_whisper.audio import decode_audio

        audio = decode_audio(str(audio_path), sampling_rate=16000)
        duration = len(audio) / 16000.0
        regions = A.merge_regions(
            A.gap_regions(seg_dump, duration) + A.loop_regions(words, seg_dump),
            duration,
        )
        if regions:
            print(f"\n检测到 {len(regions)} 处可疑区间，分窗重转写：")
            for a, b in regions:
                print(f"  {a:7.2f}-{b:7.2f}s  ({b - a:.1f}s)")
            words, replaced = A.refine_words(model, audio, words, regions, args.language)
            print(f"实际替换 {len(replaced)} 处")

    lines = build_lines(words)

    data = {"schema": 1, "language": args.language, "source": "asr", "lines": lines}
    out_path = Path(args.out) if args.out else audio_path.with_suffix(".lyrics.json")
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    span = (lines[-1]["at"] - lines[0]["at"]) if len(lines) > 1 else 0.0
    print(f"\n共 {len(lines)} 行，覆盖 {lines[0]['at']:.1f}–{lines[-1]['at']:.1f}s（{span:.1f}s）")
    print(f"写入 {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
