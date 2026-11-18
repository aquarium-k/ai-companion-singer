#!/usr/bin/env python3
"""曲包流水线：七阶段作业 + `job.json` 状态机（B2）。

为什么要有它
------------
做一首歌现在要手工跑四条命令、自己拼路径、自己记「上次做到哪」。
B1 的一键导入要求这些步骤能被一个后台进程串起来，并且**失败能从中间重跑**——
重新分离一遍 204 秒的歌要 83 秒，不能因为第四步出错就从头再来。

设计
----
- 每个阶段自己写自己的产物文件；状态机只记「做到第几步、成功没有」。
- 产物存在且阶段标记为 done → 跳过（`--force` 强制重跑）。
- 每跑完一步就把 `job.json` 原子地重写一次（临时文件 + `os.replace`），
  前端每秒轮询也不会读到写了一半的文件。
- 子进程的 stdout 直接透传，最后 40 行留存在 `job.json` 里，失败时能在界面上看到原因。

用法
----
    python tools/pipeline.py --pack-dir public/songpacks/demo --audio "D:/Music/song.mp3"

    python tools/pipeline.py --pack-dir ... --audio ... --only choreo
    python tools/pipeline.py --pack-dir ... --force          # 全部重跑
    python tools/pipeline.py --pack-dir ... --dry-run        # 只打印命令

状态文件 `<pack-dir>/job.json`，打包分发时要排除它和 `work/`。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"

# 流水线需要的环境变量集中在这里，B1 启动子进程时不用再关心
ENV_DEFAULTS = {
    "PYTHONPATH": str(ROOT / ".pylibs"),
    "HF_HOME": str(ROOT / ".cache" / "huggingface"),
    "HF_ENDPOINT": "https://hf-mirror.com",
    "PYTHONIOENCODING": "utf-8",
    # 子进程的输出立刻落盘：默认块缓冲会把「正在跑」的日志憋在内存里，
    # 界面上看 data/pipeline-*.log 一直是 0 字节，看着像卡死
    "PYTHONUNBUFFERED": "1",
    "PET_SANDBOX_FIX": "1",
}

DEFAULT_MODEL = str(ROOT / ".cache" / "models" / "UVR_MDXNET_3_9662.onnx")


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


# ----------------------------------------------------------------- 状态文件

def write_job(pack_dir: Path, job: dict) -> None:
    """原子写：先写临时文件再替换，避免前端读到半个 JSON。"""
    job["updated"] = now()
    tmp = pack_dir / "job.json.tmp"
    tmp.write_text(json.dumps(job, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, pack_dir / "job.json")


def read_job(pack_dir: Path) -> dict | None:
    path = pack_dir / "job.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


# ----------------------------------------------------------------- 阶段

@dataclass
class Context:
    pack_dir: Path
    audio: Path
    #: 用户给的歌词文件（.lrc / .txt / .json），可能没有
    lyrics_src: Path | None
    lyrics: Path
    bpm: float | None
    title: str
    pack_id: str
    model: str
    dry_run: bool


@dataclass
class Stage:
    name: str
    title: str
    outputs: list[str]
    build: Callable[[Context], list[str]]
    skipped_reason: str = ""
    extra: dict = field(default_factory=dict)
    #: 返回非空字符串就跳过这一步（允许有副作用，比如把 lyrics.json 复制成 lyrics.auto.json）
    skip: Callable[[Context], str | None] | None = None

    def output_paths(self, ctx: Context) -> list[Path]:
        return [ctx.pack_dir / p for p in self.outputs]


def stage_pack(ctx: Context) -> list[str]:
    """写 pack.json。时长和 BPM 都从音频里来。

    BPM 用 `detect_bpm.py` 的谱通量 + 梳状自相关估计。给错了节拍网格就歪，
    编舞和节拍器会一起错——demo 曲包原来手写的 96 就是错的（实测 168），
    整首歌都在错拍上跳。所以这里必须实测，不能再默认一个值。
    """
    src = ctx.audio
    duration = 0.0
    try:
        import av  # type: ignore

        with av.open(str(src)) as container:
            if container.duration:
                duration = container.duration / 1_000_000
    except Exception as err:  # noqa: BLE001
        print(f"[pack] 读不到时长：{err}")

    bpm = ctx.bpm
    if bpm:
        print(f"[pack] BPM 用外部给的 {bpm:.1f}")
    else:
        import detect_bpm  # 同目录，脚本方式运行时 sys.path[0] 就是 tools/

        result = detect_bpm.detect(str(src))
        bpm = result["bpm"]
        ctx.bpm = bpm
        others = [c["bpm"] for c in result["candidates"][1:4]]
        print(
            f"[pack] BPM 自动检测 = {bpm:.1f}"
            f"（置信度 {result['confidence']:.2f}，备选 {others}）"
        )

    # schema 2 = 当前校验契约（见 src/songpack/schema.ts）：assets.instrumental 必填、
    # id 必须等于目录名、未知字段会被警告。字段本身和 v1 一样，v1 的包照常能读。
    meta = {
        "schema": 2,
        "id": ctx.pack_id,
        "title": ctx.title or ctx.pack_id,
        "artist": "—",
        "bpm": round(float(bpm), 2),
        "beatsPerBar": 4,
        "duration": round(duration, 2),
        "loop": False,
        "offset": 0,
        "choreography": "actions.json",
        "assets": {
            "instrumental": "stems/instrumental.mp3",
            "vocal": "stems/vocals.mp3",
            "chart": None,
            "lyrics": "lyrics.auto.json",
            "units": "lyrics.units.json",
            "viseme": None,
            # 参考音高：跟唱判定 + 和声取音程 + 待机哼歌都靠它。
            # 路径是固定的，f0 阶段负责把它造出来（放在 separate 之后）。
            "f0": "work/f0.json",
        },
    }
    out = ctx.pack_dir / "pack.json"
    out.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[pack] 写入 {out}（{duration:.1f}s，{bpm:.1f} BPM）")
    return []


def stage_separate(ctx: Context) -> list[str]:
    return [
        sys.executable,
        str(TOOLS / "separate.py"),
        "--audio", str(ctx.audio),
        "--model", ctx.model,
        "--out-dir", str(ctx.pack_dir / "stems"),
        "--format", "mp3",
    ]


def patch_pack_asset(ctx: Context, key: str, value: str) -> None:
    """往已有的 `pack.json` 里补一个 assets 字段。

    起因（2026-11-13）：f0 是后来才进流水线的。在那之前导入的曲包（斜陽、想風）
    `pack.json` 的 assets 里没有 `f0`，所以跟唱/和声在新歌上全都不生效——
    而产物路径其实一直是固定的 `work/f0.json`。

    让 f0 阶段顺手把字段补上，`--only f0` 就能把老曲包救回来，不用整条重导。
    新导入的曲包由 pack 阶段直接写，这里什么也不做。
    """
    path = ctx.pack_dir / "pack.json"
    if not path.exists():
        return
    try:
        meta = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return
    assets = meta.setdefault("assets", {})
    if assets.get(key):
        return
    assets[key] = value
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"[{key}] pack.json 补上 assets.{key} = {value}")


def stage_f0(ctx: Context) -> list[str]:
    """参考音高（`work/f0.json`）。

    这一份数据同时喂三个功能：跟唱判定（每帧比对）、和声取音程（还要靠它估调性）、
    待机哼歌（从里面挑一段旋律）。缺了它这三样在新导入的歌上全是哑的。

    输入必须是**分离后的人声**：混音里的鼓点/贝斯会让 YIN 锁到低频上。
    """
    return [
        sys.executable,
        str(TOOLS / "extract_f0.py"),
        "--audio", str(ctx.pack_dir / "stems" / "vocals.mp3"),
        "--out", str(ctx.pack_dir / "work" / "f0.json"),
    ]


def probe_duration(path: Path) -> float:
    try:
        import av  # type: ignore

        with av.open(str(path)) as container:
            if container.duration:
                return container.duration / 1_000_000
    except Exception as err:  # noqa: BLE001
        print(f"[probe] 读不到时长：{err}")
    return 0.0


def auto_lyrics(pack_dir: Path, title: str, duration: float) -> Path | None:
    """按标题 + 时长去网易云搜歌词，自动挑最像的那条。

    时长是这里最可靠的判据：同名翻唱/伴奏很多，但时长对得上的通常只有一首。
    """
    import fetch_lyrics

    try:
        candidates = fetch_lyrics.search(title, 10)
        best = fetch_lyrics.pick(candidates, title, duration)
        if not best:
            print("[lyrics] 自动搜索没有可信候选")
            return None
        lyric = fetch_lyrics.fetch(best["id"])
        count = fetch_lyrics.lyric_lines(lyric)
        if count == 0:
            print(f"[lyrics] 选中「{best['name']}」但没有歌词")
            return None
        out = pack_dir / "work" / "lyrics.fetched.lrc"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(fetch_lyrics.clean_lrc(lyric), encoding="utf-8")
        print(
            f"[lyrics] 自动抓取：{best['name']} - {best['artists']}"
            f"（{best['duration']}s，{count} 行）→ {out}"
        )
        return out
    except Exception as err:  # noqa: BLE001
        print(f"[lyrics] 自动抓取失败：{err}")
        return None


def stage_lyrics(ctx: Context) -> list[str]:
    argv = [
        sys.executable,
        str(TOOLS / "parse_lyrics.py"),
        "--input", str(ctx.lyrics_src),
        "--out", str(ctx.lyrics),
        "--language", "ja",
        "--title", ctx.title,
    ]
    return argv


def lyrics_skip(ctx: Context) -> str | None:
    """没有给歌词文件、但曲包里已经有 lyrics.json（比如上次已经导入过）就跳过。"""
    if ctx.lyrics_src is not None:
        return None
    if ctx.lyrics.exists():
        return "沿用已有的 lyrics.json"
    return None


def align_skip(ctx: Context) -> str | None:
    """歌词自带时间戳（LRC）就没必要跑 ASR。

    LRC 的时间戳是人工对出来的，精度比 ASR 好，而且能省下几分钟。
    这里直接把 lyrics.json 复制成 lyrics.auto.json，让下游的产物路径保持统一。
    """
    if not ctx.lyrics.exists():
        return None
    try:
        data = json.loads(ctx.lyrics.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    lines = data.get("lines") or []
    if not lines:
        return None
    if any(line.get("at") is None for line in lines):
        return None

    target = ctx.pack_dir / "lyrics.auto.json"
    shutil.copyfile(ctx.lyrics, target)
    words = ctx.pack_dir / "work" / "words.json"
    if not words.exists():
        words.parent.mkdir(parents=True, exist_ok=True)
        words.write_text('{"words": []}', encoding="utf-8")
    return f"歌词自带 {len(lines)} 个时间戳，跳过 ASR"


def stage_align(ctx: Context) -> list[str]:
    return [
        sys.executable,
        str(TOOLS / "auto_align.py"),
        # 对齐用**原混音**，不用分离后的轨：实测混音更好（见 tools/README.md）
        "--audio", str(ctx.audio),
        "--lyrics", str(ctx.lyrics),
        "--out", str(ctx.pack_dir / "lyrics.auto.json"),
        "--words-out", str(ctx.pack_dir / "work" / "words.json"),
        "--model", "small",
        "--language", "ja",
    ]


def stage_units(ctx: Context) -> list[str]:
    argv = [
        sys.executable,
        str(TOOLS / "build_units.py"),
        "--lyrics", str(ctx.pack_dir / "lyrics.auto.json"),
        "--out", str(ctx.pack_dir / "lyrics.units.json"),
    ]
    words = ctx.pack_dir / "work" / "words.json"
    if words.exists():
        argv += ["--words", str(words)]
    # 起音对齐：听感上比「按词均分」贴得多（人工对比样品后的结论）。
    # 没有分轨就退回文本时间，不会更差。
    vocals = ctx.pack_dir / "stems" / "vocals.mp3"
    if vocals.exists():
        argv += ["--vocals", str(vocals), "--onsets"]
    return argv


def stage_choreo(ctx: Context) -> list[str]:
    return [
        sys.executable,
        str(TOOLS / "build_choreo.py"),
        "--pack", str(ctx.pack_dir / "pack.json"),
        "--audio", str(ctx.pack_dir / "stems" / "instrumental.mp3"),
        "--out", str(ctx.pack_dir / "actions.json"),
    ]


STAGES: list[Stage] = [
    Stage("pack", "生成曲包元信息", ["pack.json"], stage_pack),
    Stage("lyrics", "解析歌词", ["lyrics.json"], stage_lyrics, skip=lyrics_skip),
    Stage(
        "separate",
        "人声分离",
        ["stems/vocals.mp3", "stems/instrumental.mp3"],
        stage_separate,
    ),
    # 放在 separate 之后：只看人声轨，不然 YIN 会被鼓和贝斯带偏。
    # 放 align 之前是为了早点失败——它对后面的阶段没有任何依赖。
    Stage("f0", "参考音高", ["work/f0.json"], stage_f0),
    Stage(
        "align",
        "歌词对齐",
        ["lyrics.auto.json"],
        stage_align,
        skip=align_skip,
    ),
    Stage("units", "逐字口型", ["lyrics.units.json"], stage_units),
    Stage("choreo", "编舞生成", ["actions.json"], stage_choreo),
]


# ----------------------------------------------------------------- 执行

def run_stage(stage: Stage, ctx: Context) -> tuple[bool, str, float]:
    started = time.time()

    # pack 阶段直接写文件，不走子进程
    if stage.name == "pack":
        if ctx.dry_run:
            return True, "dry-run", 0.0
        stage.build(ctx)
        return True, "写入 pack.json", time.time() - started

    argv = stage.build(ctx)
    print(f"\n=== [{stage.name}] {stage.title}")
    print("    " + " ".join(f'"{a}"' if " " in a else a for a in argv))
    if ctx.dry_run:
        return True, "dry-run", 0.0

    env = os.environ.copy()
    for key, value in ENV_DEFAULTS.items():
        env.setdefault(key, value)

    collected: list[str] = []
    proc = subprocess.Popen(
        argv,
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.rstrip("\r\n")
        print("    " + line)
        collected.append(line)
        if len(collected) > 40:
            collected.pop(0)
    code = proc.wait()

    seconds = time.time() - started
    if code != 0:
        return False, f"退出码 {code}\n" + "\n".join(collected[-12:]), seconds
    return True, collected[-1] if collected else "完成", seconds


def main() -> int:
    ap = argparse.ArgumentParser(description="曲包流水线（七阶段 + job.json 状态机）")
    ap.add_argument("--pack-dir", required=True, help="曲包目录，如 public/songpacks/demo")
    ap.add_argument("--audio", help="原始音频（混音）。已存在 job.json 时可省略")
    ap.add_argument("--lyrics-src", help="用户的歌词文件：.lrc / .txt / .json")
    ap.add_argument("--lyrics", help="（旧参数，等同 --lyrics-src）")
    ap.add_argument(
        "--lyrics-auto",
        action="store_true",
        help="没给歌词文件时，按标题去网易云搜并自动抓 LRC",
    )
    ap.add_argument("--bpm", type=float, default=None, help="已知 BPM 就直接给，省得猜")
    ap.add_argument("--title", default="", help="曲名")
    ap.add_argument("--model", default=DEFAULT_MODEL, help="分离模型 .onnx")
    ap.add_argument("--only", help="只跑某一步（pack/lyrics/separate/f0/align/units/choreo）")
    ap.add_argument("--from", dest="from_stage", help="从某一步开始往后跑")
    ap.add_argument("--force", action="store_true", help="忽略已完成状态，全部重跑")
    ap.add_argument("--dry-run", action="store_true", help="只打印命令不执行")
    args = ap.parse_args()

    pack_dir = Path(args.pack_dir).resolve()
    pack_dir.mkdir(parents=True, exist_ok=True)
    pack_id = pack_dir.name

    previous = read_job(pack_dir) or {}
    # 已有 pack.json 时用它的 title / bpm 当默认值，重跑不用重新指定
    existing_meta = pack_dir / "pack.json"
    if existing_meta.exists():
        try:
            meta = json.loads(existing_meta.read_text(encoding="utf-8"))
            previous.setdefault("title", meta.get("title"))
            previous.setdefault("bpm", meta.get("bpm"))
            # 显式给了 --bpm 就直接改 pack.json：前端「改 BPM」只要重跑 choreo，
            # 不应该为了一个数字重跑分离和 ASR
            if args.bpm and abs(float(meta.get("bpm") or 0) - args.bpm) > 0.01:
                meta["bpm"] = args.bpm
                existing_meta.write_text(
                    json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
                )
                previous["bpm"] = args.bpm
                print(f"[bpm] pack.json 改成 {args.bpm}")
        except (json.JSONDecodeError, OSError, ValueError):
            pass

    audio_raw = args.audio or previous.get("audio")
    if not audio_raw:
        ap.error("第一次运行必须给 --audio")
    audio = Path(audio_raw).resolve()
    if not audio.exists():
        ap.error(f"找不到音频：{audio}")

    # 用户这次给的原始歌词文件（.lrc/.txt/.json）；统一转成 <pack>/lyrics.json。
    #
    # 这里**故意不继承** job.json 里的上一次路径。以前写的是
    # `或 previous.get("lyrics_src")`，于是「重新导入一首已有的歌、面板显示沿用
    # 已有歌词」时，流水线会悄悄拿上次那个路径再解析一遍：
    #   - 上次是 .tmp/ 里的临时文件，清理后就报「找不到歌词文件」；
    #   - 没清理则把用户没有重新指定的歌词又写一遍。
    # 现在的语义很直接：这次没给歌词文件，就沿用 <pack>/lyrics.json 本身。
    lyrics_src_raw = args.lyrics_src or args.lyrics
    lyrics_src = Path(lyrics_src_raw).resolve() if lyrics_src_raw else None
    if lyrics_src is not None and not lyrics_src.exists():
        ap.error(f"找不到歌词文件：{lyrics_src}")
    # 只用于 job.json 里记录来源，不参与解析
    lyrics_src_note = str(lyrics_src) if lyrics_src else previous.get("lyrics_src")

    lyrics = pack_dir / "lyrics.json"
    auto_allowed = args.only in (None, "lyrics") and not args.from_stage
    if args.lyrics_auto and lyrics_src is None and not lyrics.exists() and auto_allowed:
        print("[lyrics] 没有给歌词文件，按标题自动搜索…")
        lyrics_src = auto_lyrics(pack_dir, args.title or previous.get("title") or pack_id, probe_duration(audio))

    if lyrics_src is None and not lyrics.exists() and args.only not in ("choreo", "units", "f0"):
        ap.error("没有歌词文件：给 --lyrics-src 传 .lrc / .txt / .json（这一步不能省）")

    # 不给就用现有的；都没有就留空，交给 pack 阶段实测
    bpm = args.bpm or previous.get("bpm")
    title = args.title or previous.get("title") or pack_id
    (pack_dir / "work").mkdir(exist_ok=True)

    job = {
        "schema": 1,
        "id": pack_id,
        "title": title,
        "audio": str(audio),
        "lyrics_src": lyrics_src_note,
        "bpm": bpm,
        "state": "running",
        "stage": None,
        "progress": 0.0,
        "error": None,
        "started": now(),
        "updated": now(),
        "stages": {},
    }
    for stage in STAGES:
        old = (previous.get("stages") or {}).get(stage.name) or {}
        done = old.get("state") == "done"
        job["stages"][stage.name] = {
            "title": stage.title,
            "state": "done" if done and not args.force else "pending",
            "seconds": old.get("seconds"),
            "message": old.get("message"),
        }

    ctx = Context(
        pack_dir=pack_dir,
        audio=audio,
        lyrics_src=lyrics_src,
        lyrics=lyrics,
        bpm=bpm,
        title=title,
        pack_id=pack_id,
        model=args.model,
        dry_run=args.dry_run,
    )

    selected = STAGES
    if args.only:
        selected = [s for s in STAGES if s.name == args.only]
        if not selected:
            ap.error(f"未知阶段：{args.only}")
    elif args.from_stage:
        names = [s.name for s in STAGES]
        if args.from_stage not in names:
            ap.error(f"未知阶段：{args.from_stage}")
        selected = STAGES[names.index(args.from_stage):]

    # --only / --from 是有意重跑，把选中阶段的状态清回 pending；
    # 否则「从 pack 重跑」会因为这步上次是 done 而被直接跳过，什么都不会发生。
    #
    # 但**没给 --only / --from 时不能清**：那是「重新导入」，语义应该是
    # 「补齐缺的」，不是「全部重做」。以前这里无条件清空全部阶段，于是
    # 重新导入一首已经做好的歌会把分离和 ASR 再跑一遍（3 分钟起步），
    # 也正是这次 align 撞上 mkl_malloc 的原因。
    if args.only or args.from_stage:
        for stage in selected:
            job["stages"][stage.name]["state"] = "pending"

    total = len(STAGES)

    # dry-run 只打印命令，不碰状态文件——否则「试跑一下」会把真实进度覆盖成已完成
    commit = (lambda: None) if args.dry_run else (lambda: write_job(pack_dir, job))
    commit()

    for stage in selected:
        entry = job["stages"][stage.name]

        # 有些阶段可以按条件整段跳过（比如 LRC 自带时间戳就不用跑 ASR）。
        # skip() 允许有副作用：align 跳过时会顺手把 lyrics.json 复制成 lyrics.auto.json，
        # 这样下游的产物路径始终统一。
        if stage.skip and entry["state"] != "done" and not args.force:
            reason = stage.skip(ctx)
            if reason:
                entry["state"] = "done"
                entry["message"] = reason
                entry["seconds"] = 0
                job["progress"] = sum(
                    1 for s in STAGES if job["stages"][s.name]["state"] == "done"
                ) / total
                commit()
                print(f"[{stage.name}] 跳过：{reason}")
                continue

        # 标记为完成但产物被删了 → 当作没做
        missing = [p for p in stage.output_paths(ctx) if not p.exists()]
        if entry["state"] == "done" and missing and not args.force:
            print(f"[{stage.name}] 产物缺失 {[p.name for p in missing]}，重跑")
            entry["state"] = "pending"

        if entry["state"] == "done":
            print(f"[{stage.name}] 已完成，跳过")
            job["stage"] = stage.name
            job["progress"] = sum(1 for s in STAGES if job["stages"][s.name]["state"] == "done") / total
            commit()
            continue

        job["stage"] = stage.name
        entry["state"] = "running"
        entry["message"] = None
        commit()

        ok, message, seconds = run_stage(stage, ctx)
        entry["state"] = "done" if ok else "failed"
        entry["message"] = message
        entry["seconds"] = round(seconds, 1)
        # f0 生成成功 → 确保 pack.json 里登记了它。
        # 老曲包（f0 进流水线之前导入的）就靠这一步补上字段，前端不用再猜。
        if ok and stage.name == "f0":
            patch_pack_asset(ctx, "f0", "work/f0.json")
        # pack 阶段可能刚刚实测出 BPM，回填到 job 里给前端显示
        if ok and stage.name == "pack" and ctx.bpm:
            job["bpm"] = ctx.bpm
        job["progress"] = sum(1 for s in STAGES if job["stages"][s.name]["state"] == "done") / total

        if not ok:
            job["state"] = "failed"
            job["error"] = f"{stage.name}: {message}"
            commit()
            print(f"\n[{stage.name}] 失败：{message}")
            return 1

        commit()
        print(f"[{stage.name}] 完成（{seconds:.1f}s）")

    all_done = all(job["stages"][s.name]["state"] == "done" for s in STAGES)
    job["state"] = "done" if all_done else "idle"
    job["stage"] = None
    commit()
    if args.dry_run:
        print(f"\ndry-run 结束（没有写 job.json）：{pack_dir / 'job.json'}")
    else:
        print(f"\n流水线 {job['state']}，job.json 已更新：{pack_dir / 'job.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
