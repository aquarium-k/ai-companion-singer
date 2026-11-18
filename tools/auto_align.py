#!/usr/bin/env python3
"""用 ASR 的 word 时间戳给已知歌词行定位。

和 align_lyrics.py 的区别
--------------------------
`align_lyrics.py` 用的是「强制对齐」（stable-ts），需要 torch。
这个脚本只用 faster-whisper（CTranslate2），不需要 torch，依赖体积小一半。

思路：ASR 负责提供「时间锚点」，已知歌词负责提供「正确文字」。
两者用字符级序列比对（LCS）对齐，再把每个歌词行的起点映射到某个 ASR 词的开始时间。
转写错几个字不影响结果，因为对齐是按整段的字符匹配做的。

用法：
    set PYTHONPATH=.pylibs
    python tools/auto_align.py \
        --audio public/songpacks/demo/stems/instrumental.mp3 \
        --lyrics public/songpacks/demo/lyrics.json \
        --model small --language ja

默认输出到 `lyrics.auto.json`，不会覆盖手工打点的文件。
"""

from __future__ import annotations

import argparse
import difflib
import gc
import json
import os
import sys
import time
from pathlib import Path

# 受限沙箱兼容：某些环境下 os.mkdir(path, 0o700) 建出的目录后续不可写，
# 而 tempfile.mkdtemp() 正好用 0o700，huggingface_hub 的下载缓存也依赖它。
# 正常环境不需要，设 PET_SANDBOX_FIX=1 才生效。
if os.environ.get("PET_SANDBOX_FIX") == "1":
    _real_mkdir = os.mkdir

    def _mkdir_777(path, mode=0o777, *args, **kwargs):  # noqa: ANN001, ANN201
        return _real_mkdir(path, 0o777, *args, **kwargs)

    os.mkdir = _mkdir_777


def _patch_pyav() -> None:
    """兼容 PyAV 19+：faster-whisper 传的 metadata_errors 参数在新版被移除了。

    老版本 av 支持这个参数，新版本直接抛 TypeError。
    这里统一吞掉，语义差异可以忽略（只是元数据解析的容错级别）。
    """
    try:
        import av
    except ImportError:
        return

    if getattr(av.open, "_pet_patched", False):
        return

    original = av.open

    def open_compat(*args, **kwargs):  # noqa: ANN001, ANN201
        kwargs.pop("metadata_errors", None)
        return original(*args, **kwargs)

    open_compat._pet_patched = True  # type: ignore[attr-defined]
    av.open = open_compat


_patch_pyav()

# 匹配时忽略的字符：空白、标点、常见装饰符号
_IGNORE = set(" \t\r\n\u3000、。，．,.!?！？…‥・:;'\"()（）[]【】<>《》-‐‑‒–—―~/\\|+*#@&%^`")


def normalize(text: str) -> str:
    return "".join(ch for ch in text if ch not in _IGNORE)


def build_char_map(words: list[tuple[str, float, float]], conv=None):
    """把 ASR 的词序列展开成字符序列，并记录每个字符属于第几个词。

    `conv` 决定每个词怎么变成字符序列，默认是去掉标点。
    传假名转换函数就得到「读音序列」——ASR 常把汉字选错，
    但读音通常是对的，只比读音能救回一大批本来锚不上的行。
    """
    if conv is None:
        conv = normalize
    chars: list[str] = []
    owner: list[int] = []
    for index, (word, _start, _end) in enumerate(words):
        for ch in conv(word):
            chars.append(ch)
            owner.append(index)
    return "".join(chars), owner


def kana_conv(text: str) -> str:
    """任意日文文本 → 只含假名的读音串（英文按日式英语转片假名）。"""
    from kana import normalize_kana, to_hiragana

    return normalize_kana(to_hiragana(text))


def map_lyric_to_asr(lyric_text: str, asr_text: str) -> tuple[list[int], list[bool]]:
    """给歌词的每个字符，找它在 ASR 字符串里的对应位置。

    返回 `(mapping, matched)`：
      mapping —— 每个字符对应的 ASR 位置，找不到的用邻近位置填
      matched —— 该字符是不是**真的匹配上了**（不是被兜底填的）

    为什么要区分：一句 ASR 完全没听出来的歌词（短句、被伴奏盖住、夹在英文里），
    兜底规则也会给它一个位置，于是它会被锚到隔壁那句上。
    有了 matched，上层就能判断「这句到底有没有证据」。
    """
    mapping = [-1] * len(lyric_text)
    matched = [False] * len(lyric_text)

    matcher = difflib.SequenceMatcher(None, lyric_text, asr_text, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for offset in range(i2 - i1):
                mapping[i1 + offset] = j1 + offset
                matched[i1 + offset] = True
        else:
            # 替换/删除：把整段映射到 ASR 该段的起点（位置是猜的，不算匹配）
            for i in range(i1, i2):
                mapping[i] = j1

    # 补上开头可能没匹配到的位置
    last = 0
    for i in range(len(mapping)):
        if mapping[i] < 0:
            mapping[i] = last
        else:
            last = mapping[i]

    return mapping, matched

    return mapping


# ---------------------------------------------------------------- 分窗重转写
#
# 整首一次性转写时，Whisper 会在某些段落陷入「重复幻觉」：同一个词连吐几十遍，
# 时间全挤在几秒里；有时干脆整段 20 多秒没有任何输出。
# 这两种情况下，那一段歌词没有可用锚点，行级时间会全部塌到同一个点。
#
# 实测：同样的音频，把那一段单独切出来（10 秒窗、5 秒步进）重转写，文字就正常了。
# 所以策略是「整首跑一遍 → 找出可疑区间 → 只重转写这些区间 → 重做对齐」。

REPEAT_RUN = 5       # 同一个词连续出现这么多次，判为重复幻觉
LOOP_NGRAM = 2       # 文本重复检测用的 n-gram 长度
LOOP_HITS = 6        # 同一个 n-gram 出现这么多次，判为重复幻觉
GAP_LIMIT = 6.0      # 相邻段之间空了这么久，判为漏转写
INTERP_RUN = 3       # 连续这么多行只能插值，判为不可信
MIN_WORD_DURATION = 0.02  # 短于这个的词没有时间信息，不能当锚点
# 一行里「真的匹配上」的字所占比例下限。低于它就不给锚点，改为按行序插值。
# 默认关（0 = 不做闸门）：实测 0.30 会误伤已经对齐好的行
# （锚定行从 73 掉到 54），而它想修的「短句被拉到隔壁」只修好两句。
# 调这个参数是在「召回」和「精度」之间换，不是白捡。
MIN_MATCH_RATIO = 0.0
WINDOW = 10.0        # 重转写窗口长度
HOP = 5.0            # 窗口步进，取窗口前半的词以免重复


def looks_like_loop(text: str) -> bool:
    """整段文字是不是「同一个片段重复很多遍」。

    词级检测会漏掉这类：Whisper 把「give lead」听成「ギリギリ」之后，
    吐出来的是「ギリギリギリギリ…」，每个词单独看都不一样，
    但两个字的片段重复了十几次。

    阈值必须跟长度挂钩：一段 100 字的正常歌词里，「でも」这种片段重复 4–6 次
    很常见，拿固定的 6 次去判会误杀。实测「ギリ」在 30 字的幻觉里出现 14 次。
    """
    body = normalize(text)
    if len(body) < 16:
        return False
    counts: dict[str, int] = {}
    for i in range(len(body) - LOOP_NGRAM + 1):
        gram = body[i : i + LOOP_NGRAM]
        counts[gram] = counts.get(gram, 0) + 1
    threshold = max(LOOP_HITS, int(len(body) * 0.18))
    return max(counts.values(), default=0) >= threshold


def has_repeat_loop(words: list[tuple[str, float, float]], start: float, end: float) -> bool:
    run, prev = 1, None
    for word, w_start, _w_end in words:
        if not (start <= w_start < end):
            continue
        if word == prev:
            run += 1
            if run >= REPEAT_RUN:
                return True
        else:
            run, prev = 1, word
    return False


def merge_regions(regions: list[tuple[float, float]], duration: float) -> list[tuple[float, float]]:
    if not regions:
        return []
    padded = sorted(
        (max(0.0, a - 0.6), min(duration, b + 0.6)) for a, b in regions if b > a
    )
    merged = [list(padded[0])]
    for a, b in padded[1:]:
        if a - merged[-1][1] <= 1.5:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged]


def gap_regions(segments: list[dict], duration: float) -> list[tuple[float, float]]:
    regions: list[tuple[float, float]] = []
    prev_end = 0.0
    for seg in segments:
        if seg["start"] - prev_end > GAP_LIMIT:
            regions.append((prev_end, seg["start"]))
        prev_end = max(prev_end, seg["end"])
    if duration - prev_end > GAP_LIMIT:
        regions.append((prev_end, duration))
    return regions


def loop_regions(words: list[tuple[str, float, float]], segments: list[dict]) -> list[tuple[float, float]]:
    return [
        (seg["start"], seg["end"])
        for seg in segments
        if has_repeat_loop(words, seg["start"], seg["end"]) or looks_like_loop(seg.get("text", ""))
    ]


def interp_regions(lines: list[dict], min_run: int = INTERP_RUN) -> list[tuple[float, float]]:
    """连续多行只能插值的地方，时间不可信，值得重转写。"""
    regions: list[tuple[float, float]] = []
    i = 0
    while i < len(lines):
        if lines[i].get("src") != "interp":
            i += 1
            continue
        j = i
        while j + 1 < len(lines) and lines[j + 1].get("src") == "interp":
            j += 1
        if j - i + 1 >= min_run:
            before = lines[i - 1].get("at") if i > 0 else 0.0
            after = lines[j + 1].get("at") if j + 1 < len(lines) else None
            if before is not None and after is not None:
                regions.append((float(before), float(after)))
        i = j + 1
    return regions


def build_prompt(lines: list[dict], a: float, b: float, pad_lines: int = 1) -> str | None:
    """用落在区间里的歌词行拼一段提示词，喂给 Whisper 当 initial_prompt。

    歌词本来就是已知的，这正是比通用 ASR 强的地方：直接告诉它该听什么。
    提示词过长会拖慢解码，截断到 220 字足够覆盖一个乐句。
    """
    idx = [i for i, line in enumerate(lines) if line.get("at") is not None and a <= line["at"] <= b]
    if not idx:
        return None
    lo = max(0, idx[0] - pad_lines)
    hi = min(len(lines) - 1, idx[-1] + pad_lines)
    text = " ".join(lines[i]["text"].strip() for i in range(lo, hi + 1)).strip()
    return text[:220] or None


def refine_words(
    model,
    audio,
    words: list[tuple[str, float, float]],
    regions: list[tuple[float, float]],
    language: str,
    lines: list[dict] | None = None,
) -> tuple[list[tuple[str, float, float]], list[tuple[float, float]]]:
    """对可疑区间做小窗重转写，用新词替换该区间原有的词。

    传了 `lines` 就会用该区间的歌词文本当 `initial_prompt`。
    实测这一步很关键：「give me give love」整段被听成「元気だ 君の不変のカルマ」，
    加上歌词提示后才正确落到 169.98–171.8。
    """
    total = len(audio) / 16000.0
    replaced: list[tuple[float, float]] = []

    for a, b in regions:
        prompt = build_prompt(lines, a, b) if lines else None
        fresh: list[tuple[str, float, float]] = []
        t = a
        while t < b:
            w_end = min(t + WINDOW, b)
            if w_end - t < 1.5:
                break
            chunk = audio[int(t * 16000) : int(w_end * 16000)]
            try:
                segs, _info = model.transcribe(
                    chunk,
                    language=language,
                    word_timestamps=True,
                    vad_filter=False,
                    condition_on_previous_text=False,
                    beam_size=5,
                    temperature=0.0,
                    initial_prompt=prompt,
                )
            except Exception as err:  # noqa: BLE001  单个窗口失败不该中断整首
                print(f"  窗口 {t:.1f}-{w_end:.1f}s 转写失败：{err}", file=sys.stderr)
                t += HOP
                continue
            for seg in segs:
                for word in seg.words or []:
                    if not word.word or word.start is None:
                        continue
                    abs_start = t + float(word.start)
                    if abs_start >= t + HOP:  # 只取窗口前半，避免与下一窗重复
                        continue
                    fresh.append(
                        (word.word, round(abs_start, 3), round(min(total, t + float(word.end)), 3))
                    )
            t += HOP

        if not fresh:
            print(f"  区间 {a:.1f}-{b:.1f}s 重转写没有捞到词，保留原结果")
            continue
        if has_repeat_loop(fresh, 0.0, total) or looks_like_loop("".join(w[0] for w in fresh)):
            print(f"  区间 {a:.1f}-{b:.1f}s 重转写仍然重复，保留原结果")
            continue

        words = [w for w in words if not (a <= w[1] < b)] + fresh
        words.sort(key=lambda w: w[1])
        replaced.append((a, b))

    return words, replaced


def repair_unmapped(lines: list[dict]) -> int:
    """把「没匹配到」和「坍塌到同一时间」的行，按行序在锚点之间插值。

    ASR 漏掉整段时，那几行会全部映射到同一个词，表现为时间完全相同。
    这种情况没有真实锚点可用，只能插值——但要标出来，让上层知道这段不可信。
    """
    if not lines:
        return 0

    bad = [False] * len(lines)
    if lines[0].get("at") is None:
        bad[0] = True
    for i in range(1, len(lines)):
        prev = lines[i - 1].get("at")
        curr = lines[i].get("at")
        if curr is None or (prev is not None and abs(curr - prev) < 0.02):
            bad[i] = True

    if not any(bad):
        return 0

    anchors = [(i, lines[i]["at"]) for i in range(len(lines)) if not bad[i]]
    if not anchors:
        return 0

    fixed = 0
    for i in range(len(lines)):
        if not bad[i]:
            continue
        prev = next(((k, t) for k, t in reversed(anchors) if k < i), None)
        nxt = next(((k, t) for k, t in anchors if k > i), None)

        if prev and nxt:
            span = nxt[0] - prev[0]
            step = (nxt[1] - prev[1]) / span if span else 0.0
            lines[i]["at"] = round(prev[1] + step * (i - prev[0]), 2)
        elif prev:
            lines[i]["at"] = round(prev[1] + 3.0 * (i - prev[0]), 2)
        elif nxt:
            lines[i]["at"] = round(max(0.0, nxt[1] - 3.0 * (nxt[0] - i)), 2)
        else:
            continue
        lines[i]["src"] = "interp"
        fixed += 1

    return fixed


def load_model_with_fallback(factory, args, threads: int | None = None):
    """加载 Whisper 模型；内存不够就降线程重试。

    CTranslate2 + MKL 在 Windows 上会用 `mkl_malloc` 申请每个线程的 workspace，
    8 线程时可能直接 `RuntimeError: mkl_malloc: failed to allocate memory`——
    机器总内存还有富余也会失败（桌面端开着 Electron 和两条解码后的音轨时尤其容易）。
    线程数减半通常就能过，代价只是转写慢一点。
    """
    threads = max(1, threads if threads is not None else args.cpu_threads)
    while True:
        try:
            return factory(
                args.model,
                device=args.device,
                compute_type=args.compute_type,
                cpu_threads=threads,
            )
        except RuntimeError as err:
            message = str(err).lower()
            if threads <= 1 or "allocate" not in message:
                raise
            threads = max(1, threads // 2)
            print(f"内存不足，降到 {threads} 线程重试…", file=sys.stderr)


def transcribe_all(model, audio: str, args) -> tuple[list, list[dict], object]:
    """整段转写，返回 (words, segments_dump, info)。

    单独抽出来是为了让调用方能把「转写期间 OOM」也纳进降级重试——
    `model.transcribe()` 本身只是建了个生成器，真正的算力是在**遍历**时才跑的，
    所以 try 必须包住这个循环，否则 `mkl_malloc` 会直接把进程带走。
    """
    # 注意：默认关闭 VAD。Silero VAD 是为「语音」训练的，
    # 唱歌 + 伴奏会被判成非语音直接丢掉，导致大段歌词没有锚点。
    segments, info = model.transcribe(
        audio,
        language=args.language,
        word_timestamps=True,
        vad_filter=args.vad,
        condition_on_previous_text=False,
        beam_size=5,
        temperature=0.0,
    )

    words: list[tuple[str, float, float]] = []
    seg_dump: list[dict] = []
    for segment in segments:
        seg_text = (segment.text or "").strip()
        if seg_text:
            seg_dump.append(
                {
                    "start": round(float(segment.start), 2),
                    "end": round(float(segment.end), 2),
                    "text": seg_text,
                }
            )
        for word in segment.words or []:
            if word.word and word.start is not None:
                words.append((word.word, float(word.start), float(word.end)))
    return words, seg_dump, info


def main() -> int:
    ap = argparse.ArgumentParser(description="ASR 锚点 + 已知歌词 → 行级时间戳")
    ap.add_argument("--audio", required=True)
    ap.add_argument("--lyrics", required=True)
    ap.add_argument("--out")
    ap.add_argument("--model", default="small")
    ap.add_argument("--language", default="ja")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument(
        "--cpu-threads",
        type=int,
        default=4,
        help="CTranslate2 线程数。内存紧张时调小（会自动降级重试）",
    )
    ap.add_argument(
        "--vad",
        action="store_true",
        help="开启 VAD 过滤（默认关闭：会把唱歌当非语音丢掉）",
    )
    ap.add_argument("--words-out", help="把转写结果（词 + 段）缓存成 JSON")
    ap.add_argument("--words-in", help="直接读缓存的转写结果，跳过转写")
    ap.add_argument(
        "--no-refine",
        action="store_true",
        help="不对可疑区间做分窗重转写（默认会做，用来打破 Whisper 的重复幻觉）",
    )
    ap.add_argument(
        "--text-align",
        action="store_true",
        help="按原文本比对而不是读音（默认按读音：ASR 把「衝動的」听成「昭和の敵」时读音仍然接近）",
    )
    args = ap.parse_args()

    lyrics_path = Path(args.lyrics)
    data = json.loads(lyrics_path.read_text(encoding="utf-8"))
    lines = data.get("lines", [])
    if not lines:
        print("歌词文件里没有 lines", file=sys.stderr)
        return 1

    started = time.time()
    model = None
    seg_dump: list[dict] = []
    # 线程数在整条流程里共享：主转写降级过，后面精修那轮也用降级后的值
    threads = max(1, args.cpu_threads)

    if args.words_in:
        cached = json.loads(Path(args.words_in).read_text(encoding="utf-8"))
        words = [tuple(w) for w in cached["words"]]
        seg_dump = cached.get("segments", [])
        seg_count = len(seg_dump)
        print(f"读缓存转写：{seg_count} 段 / {len(words)} 词（跳过转写）")
    else:
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            print("缺少 faster-whisper。先执行：", file=sys.stderr)
            print("  pip install --target .pylibs faster-whisper", file=sys.stderr)
            print("  然后 set PYTHONPATH=.pylibs", file=sys.stderr)
            return 1

        print(f"加载模型 {args.model}（首次会下载）…")

        # 转写期间的 OOM 也要能降级：先按配置的线程数跑，撞上 mkl_malloc 就
        # 减半、重新加载、重跑。慢一点总比整首歌的歌词没轴强。
        while True:
            model = load_model_with_fallback(WhisperModel, args, threads)
            print(f"模型就绪，用时 {time.time() - started:.1f}s（{threads} 线程）")
            print("转写中…")
            try:
                words, seg_dump, info = transcribe_all(model, args.audio, args)
                break
            except RuntimeError as err:
                message = str(err).lower()
                if threads <= 1 or "allocate" not in message:
                    raise
                threads = max(1, threads // 2)
                print(
                    f"转写时内存不足（{err.__class__.__name__}），降到 {threads} 线程重试…",
                    file=sys.stderr,
                )
                del model
                gc.collect()

        seg_count = len(seg_dump)
        elapsed = time.time() - started
        print(f"转写完成：{seg_count} 段 / {len(words)} 词，用时 {elapsed:.1f}s")
        print(f"识别语言：{info.language}（置信 {info.language_probability:.2f}）")

        if args.words_out:
            payload = {"words": words, "segments": seg_dump}
            Path(args.words_out).write_text(
                json.dumps(payload, ensure_ascii=False), encoding="utf-8"
            )
            print(f"转写缓存写入 {args.words_out}")

    if not words:
        print("没有识别到任何词，音频可能是纯音乐", file=sys.stderr)
        return 2

    # 把每行歌词拼接起来，同时记录每行在整段文本里的字符区间
    conv = normalize if args.text_align else kana_conv
    lyric_text = ""
    spans: list[tuple[int, int]] = []
    for line in lines:
        normalized = conv(line["text"])
        spans.append((len(lyric_text), len(lyric_text) + len(normalized)))
        lyric_text += normalized

    # 幻觉区里的词不能用：Whisper 在那里吐的是重复同一个片段，
    # 词时间是编出来的，拿它当锚点会让整段歌词行首全错。
    active_words = list(words)

    # 高度重复区里的行不能用逐词锚点（哪一遍对应哪一行无从确定），
    # 但也不能把那些词从序列里删掉——全局比对会因为前半段失去对应
    # 而把整段歌词塞到剩下的文本开头。正确做法是保留对齐，只把落进
    # 这些区间的行锚点作废，交给 repair_unmapped 按行序铺开。
    dead_zones: list[tuple[float, float]] = []

    def align_once() -> int:
        # 零时长（或极短）的词没有时间信息，不能当锚点。
        # Whisper 在重复段会吐出一串 start == end 的词，
        # 拿它们定位会让整行锚到一个点上。
        usable = [w for w in active_words if w[2] - w[1] >= MIN_WORD_DURATION]
        asr_text, owner = build_char_map(usable, conv)
        if not asr_text:
            return 0
        mapping, matched = map_lyric_to_asr(lyric_text, asr_text)
        hit = 0
        pending: dict[int, list[int]] = {}

        for index, (line, (start, end)) in enumerate(zip(lines, spans)):
            line.pop("src", None)
            if start >= end:
                # 整行没有假名（纯英文且没收录）——退回按原文本比对的位置
                line["at"] = None
                continue

            # 匹配质量闸门：真的匹配上的字太少，就说明 ASR 没听到这句，
            # 此时兜底位置是编的，锚上去只会把它拉到隔壁那句上。
            quality = sum(1 for i in range(start, end) if matched[i]) / (end - start)
            if quality < MIN_MATCH_RATIO:
                line["at"] = None
                continue

            asr_pos = mapping[start]
            if asr_pos < 0 or asr_pos >= len(owner):
                line["at"] = None
                continue
            when = usable[owner[asr_pos]][1]

            zone = next((z for z, (a, b) in enumerate(dead_zones) if a <= when < b), -1)
            if zone >= 0:
                pending.setdefault(zone, []).append(index)
                line["at"] = None
                continue

            line["at"] = round(when, 2)
            line["src"] = "asr"
            hit += 1

        # 重复区内的连续行：在这一段里按行数均匀铺开。
        # 逐词锚点在重复区里只会随机落到某一遍上，均分的期望误差反而更小。
        for zone, indices in pending.items():
            a, b = dead_zones[zone]
            step = (b - a) / len(indices)
            for k, index in enumerate(indices):
                lines[index]["at"] = round(a + step * (k + 0.5), 2)
                lines[index]["src"] = "interp"
            hit += len(indices)

        return hit

    matched = align_once()
    if matched == 0:
        print("ASR 文本为空", file=sys.stderr)
        return 2

    fixed = repair_unmapped(lines)
    print(f"锚定成功 {matched}/{len(lines)} 行")
    if fixed:
        print(f"插值补齐 {fixed} 行（这些行没有真实时间锚点，精度不可信）")

    # 可疑区间：大段没转写、重复幻觉、连续多行只能插值
    if not args.no_refine:
        duration = max((seg["end"] for seg in seg_dump), default=0.0)
        if args.words_in:
            try:
                from faster_whisper.audio import decode_audio

                duration = len(decode_audio(args.audio, sampling_rate=16000)) / 16000.0
            except Exception:  # noqa: BLE001
                pass
        regions = merge_regions(
            gap_regions(seg_dump, duration)
            + loop_regions(words, seg_dump)
            + interp_regions(lines),
            duration,
        )
        if regions:
            print(f"\n检测到 {len(regions)} 处可疑区间，分窗重转写：")
            for a, b in regions:
                print(f"  {a:7.2f}-{b:7.2f}s  ({b - a:.1f}s)")
            if model is None:
                from faster_whisper import WhisperModel

                model = load_model_with_fallback(WhisperModel, args, threads)
            from faster_whisper.audio import decode_audio

            audio = decode_audio(args.audio, sampling_rate=16000)
            words, replaced = refine_words(model, audio, words, regions, args.language)
            active_words = list(words)

            # 重转写没救回来、且整段高度重复的区间 → 不逐行找锚点。
            #
            # 注意这不是「幻觉」判断。压缩比判据只会说「文本高度重复」，
            # 而歌词本来就可能重复（这首歌就是这样）。真正的理由是：
            # 同一句在音频里出现了 N 遍、歌词只写了 4 行时，
            # 「哪一遍对应哪一行」无从确定，逐行找锚点只会随机落在某一遍上。
            # 均匀铺开反而稳定。
            #
            # 边界必须用**原始段的起止**，不能用外扩合并后的 region——
            # 否则会连区间外侧的正确锚点（比如紧接着的第一句）一起吞掉。
            rejected = [(a, b) for a, b in regions if (a, b) not in replaced]
            dead = [
                (seg["start"], seg["end"])
                for seg in seg_dump
                if any(a <= seg["start"] < b for a, b in rejected)
                and (
                    has_repeat_loop(words, seg["start"], seg["end"])
                    or looks_like_loop(seg.get("text", ""))
                )
            ]
            if dead:
                print(
                    f"{len(dead)} 段高度重复，逐行锚点不可靠，改为按行序铺开："
                    + " ".join(f"{a:.1f}-{b:.1f}" for a, b in dead)
                )
                dead_zones = list(dead)

            if replaced or dead:
                matched = align_once()
                fixed = repair_unmapped(lines)
                print(f"重转写后锚定成功 {matched}/{len(lines)} 行，插值 {fixed} 行")

            # 第二轮：仍然只能插值的地方，用歌词原文当提示词再转一次
            hard = merge_regions(interp_regions(lines, min_run=2), duration)
            if hard:
                print(f"\n{len(hard)} 处仍有连续插值，加歌词提示词重转：")
                for a, b in hard:
                    print(f"  {a:7.2f}-{b:7.2f}s  提示词={build_prompt(lines, a, b)!r}")
                words, replaced2 = refine_words(
                    model, audio, words, hard, args.language, lines=lines
                )
                if replaced2:
                    active_words = list(words)
                    matched = align_once()
                    fixed = repair_unmapped(lines)
                    print(f"提示词重转后锚定成功 {matched}/{len(lines)} 行，插值 {fixed} 行")

    # 精修后的词要写回缓存，否则下游（build_units）拿到的还是精修前的转写，
    # 在重复幻觉区间会退化成均分。
    if args.words_out and not args.words_in:
        payload = {"words": words, "segments": seg_dump}
        Path(args.words_out).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        print(f"精修后的转写缓存已更新 {args.words_out}")

    # 时间倒序检查
    inversions = 0
    for i in range(1, len(lines)):
        prev, curr = lines[i - 1].get("at"), lines[i].get("at")
        if prev is not None and curr is not None and curr < prev:
            inversions += 1
    if inversions:
        print(f"警告：{inversions} 处时间倒序", file=sys.stderr)

    out_path = Path(args.out) if args.out else lyrics_path.with_name("lyrics.auto.json")

    # 保留手工打点：输出文件里 src=user 的行不覆盖，方便「自动跑一遍 → 手修几行 → 再跑」
    if out_path.exists():
        try:
            previous = json.loads(out_path.read_text(encoding="utf-8")).get("lines", [])
        except Exception:  # noqa: BLE001
            previous = []
        kept = 0
        for old, new in zip(previous, lines):
            if old.get("src") == "user" and old.get("at") is not None:
                new["at"] = old["at"]
                new["src"] = "user"
                kept += 1
        if kept:
            print(f"保留手工打点的 {kept} 行（src=user，不会被自动结果覆盖）")

    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"写入 {out_path}")

    # 和手工打点对比
    manual_path = lyrics_path
    if manual_path.exists():
        manual = json.loads(manual_path.read_text(encoding="utf-8")).get("lines", [])
        print("\n行号   自动      手工      偏差")
        print("-" * 42)
        for i, (auto, man) in enumerate(zip(lines, manual)):
            if i >= 15:
                print("…")
                break
            a, m = auto.get("at"), man.get("at")
            if a is None or m is None:
                print(f"{i + 1:>3}   {'-':>8}  {'-':>8}")
                continue
            print(f"{i + 1:>3}   {a:>8.2f}  {m:>8.2f}  {a - m:>+8.2f}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
