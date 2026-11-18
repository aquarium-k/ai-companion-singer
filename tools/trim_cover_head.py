#!/usr/bin/env python3
"""修掉曲包 cover.wav 开头的孤立残片。

用户 2026-11-17 报「白花开头有些杂音」。查出来：`cover.wav` 第 0–21 ms 有一段
孤立的人声残片（峰值 0.036，−35 dB，共振峰 330–1500 Hz），之后是全数字静音，
人声要到很后面才进。残片从第 0 个样本直接开始 → 听感是一个「咔」。

来源：`tools/bake_cover.py` 的分块烘焙——第 0 段是 SVC 转换的产物，转换时的
前几帧留下了残响，拼接后就成了这个头。

做法：**只在「开头一小段有声、紧接着长时间静音」时才动手**（其余情况原样保留），
把这段残片清零，并留 5 ms 的淡出避免生成新的突变。原文件备份到 `.tmp/cover-backup/`。

    python tools/trim_cover_head.py --dry
    python tools/trim_cover_head.py
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
PACKS = ROOT / "public/songpacks"
BACKUP = ROOT / ".tmp/cover-backup"

PROBE_MS = 400  # 检查开头这么多毫秒
LOUD_DB = -70.0  # 高于这个就算「有声」
MAX_BLOB_MS = 120  # 残片最长这么多毫秒才认为是「头」
FADE_MS = 5


def head_blob(y: np.ndarray, sr: int) -> tuple[int, int] | None:
    """返回 (起点样本, 终点样本) 的孤立头部残片；没有就 None。"""
    n = min(len(y), int(PROBE_MS / 1000 * sr))
    m = int(0.001 * sr)
    fr = y[: (n // m) * m].astype(np.float64).reshape(-1, m)
    db = 20 * np.log10(np.sqrt((fr**2).mean(axis=1)) + 1e-9)
    loud = db > LOUD_DB
    if not loud[0]:
        return None  # 开头本来就是静的
    end = 0
    while end + 1 < len(loud) and loud[end + 1]:
        end += 1
    blob_ms = end + 1
    if blob_ms > MAX_BLOB_MS:
        return None  # 一开始就是音乐，别动
    # 后面必须是静音（至少 150 ms），否则说明这就是音乐开头
    tail = loud[end + 1 : min(len(loud), end + 1 + 150)]
    if len(tail) < 50 or tail.mean() > 0.05:
        return None
    return 0, int(round((blob_ms + FADE_MS) / 1000 * sr))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()
    BACKUP.mkdir(parents=True, exist_ok=True)

    fixed = 0
    for pack in sorted(PACKS.iterdir()):
        if not pack.is_dir():
            continue
        cover = pack / "cover.wav"
        if not cover.exists():
            continue
        y, sr = sf.read(cover, dtype="float32")
        if y.ndim > 1:
            y = y.mean(axis=1)
        span = head_blob(y, sr)
        if span is None:
            print(f"{pack.name[:28]:30s} 不动（开头正常）")
            continue
        a, b = span
        peak = float(np.abs(y[a:b]).max())
        print(
            f"{pack.name[:28]:30s} 清掉 {b/sr*1000:.0f} ms 的头部残片（峰值 {peak:.3f}）"
            f"{'（干跑）' if args.dry else ''}"
        )
        if args.dry:
            continue
        z = y.copy()
        fade = int(FADE_MS / 1000 * sr)
        # 残片整体压到 0；末端本来就在静音里，再补一个淡出兜底
        z[a:b] = 0.0
        if b + fade < len(z):
            z[b : b + fade] = 0.0
        if not (BACKUP / pack.name).exists():
            BACKUP.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cover, BACKUP / f"{pack.name}.cover.wav")
        sf.write(cover, z, sr, subtype="PCM_16")
        fixed += 1

    print(f"\n处理了 {fixed} 个曲包的 cover.wav" + ("" if args.dry else f"（备份在 {BACKUP}）"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
