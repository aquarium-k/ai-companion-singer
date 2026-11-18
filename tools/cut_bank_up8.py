#!/usr/bin/env python3
"""把「升八度录音 → SVC」切成高音区起音样本，并合并进 `public/voices/bank.json`。

背景
----
低音区样本（200–415 Hz）已经用第一轮录音切好了；这次要补的是高音区。
三条 `*_up8.m4a` 已经用 seed-vc 换成她的音色，产物在
`public/voices/_work/user_{a,ra,ha}_up8_svc.wav`。

做法
----
- `あ`：切 SVC 后的元音起振；
- `ら`：切 SVC 后的「闭塞 + burst + 元音头」；
- `は`：**`[h]` 用原始录音**（SVC 会把气声压掉约 11 dB），元音用 SVC 后的；
- 每个片段测根音写 JSON，并按 `url` 去重合并进 `bank.json`。

用法
----
    py -3 tools/cut_bank_up8.py
    py -3 tools/cut_bank_up8.py --dry-run     # 只打印会切什么，不写文件
"""
from __future__ import annotations

import argparse
import json
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

try:
    import numpy as np
except ModuleNotFoundError:
    print("找不到 numpy——它应该在 .pylibs 里。确认仓库完整（.pylibs/numpy）。")
    raise SystemExit(1)

from extract_f0 import decode_mono, yin  # noqa: E402

SR = 22050
OUT = ROOT / "public" / "voices"
WORK = OUT / "_work"
PLANS = [
    ("a", "vowel", 0.04, 0.13),
    ("ra", "consonant", 0.09, 0.13),
    ("ha", "aspirate", 0.10, 0.13),
]


def notes_of(sig: np.ndarray) -> list[dict]:
    f0, clarity, _ = yin(sig)
    times = np.arange(len(f0)) * 256 / SR
    midi = np.array([round(69 + 12 * np.log2(h)) if h > 0 else 0 for h in f0])
    voiced = (f0 > 0) & (clarity > 0.5)
    runs: list[dict] = []
    i = 0
    while i < len(midi):
        if not voiced[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(midi) and voiced[j + 1] and midi[j + 1] == midi[i]:
            j += 1
        if times[j] - times[i] >= 0.10 and midi[i] > 0:
            runs.append(
                {"t": float(times[i]), "end": float(times[j]), "hz": float(np.median(f0[i : j + 1]))}
            )
        i = j + 1
    return runs


def write_wav(path: Path, x: np.ndarray) -> None:
    x = np.clip(x, -1, 1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype(np.int16).tobytes())


def take(x: np.ndarray, t0: float, t1: float) -> np.ndarray:
    return x[max(0, int(t0 * SR)) : min(len(x), int(t1 * SR))].copy()


def fade_edges(seg: np.ndarray, ms: float = 2.0) -> np.ndarray:
    n = max(1, int(ms / 1000 * SR))
    if len(seg) > 2 * n:
        seg[:n] *= np.linspace(0, 1, n)
        seg[-n:] *= np.linspace(1, 0, n)
    return seg


def main() -> int:
    ap = argparse.ArgumentParser(description="切高音区起音样本并合并 bank.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    bank_path = OUT / "bank.json"
    bank = json.loads(bank_path.read_text(encoding="utf-8"))["samples"] if bank_path.exists() else []
    added = 0

    for name, kind, back, fwd in PLANS:
        conv_path = WORK / f"user_{name}_up8_svc.wav"
        orig_path = WORK / f"user_{name}_up8.wav"
        if not conv_path.exists() or not orig_path.exists():
            print(f"{name}_up8: 缺文件（{conv_path.name} / {orig_path.name}），跳过")
            continue
        conv = decode_mono(str(conv_path), sr=SR)
        orig = decode_mono(str(orig_path), sr=SR)
        notes = notes_of(conv)
        kept = [n for n in notes if 380 <= n["hz"] <= 950]
        print(f"{name}_up8: 检测到 {len(notes)} 个音，落在 380–950 Hz 的 {len(kept)} 个")
        for n in kept:
            hz = n["hz"]
            t = n["t"]
            if kind == "aspirate":
                seg = np.concatenate(
                    [take(orig, t - back, t - 0.005), take(conv, t - 0.005, t + fwd)]
                )
            else:
                seg = take(conv, t - back, t + fwd)
            if len(seg) < int(0.06 * SR):
                continue
            seg = fade_edges(seg)
            base = f"att_{kind}_{int(round(hz))}"
            print(f"  {base}: {hz:.0f} Hz  {len(seg) / SR * 1000:.0f} ms")
            if args.dry_run:
                continue
            write_wav(OUT / f"{base}.wav", seg)
            meta = {
                "kind": kind,
                "source": f"用户录音 {name}_up8.m4a → SVC(refvoice3)",
                "rootHz": round(hz, 1),
                "leadSec": round(back, 3),
                "lengthSec": round(len(seg) / SR, 3),
                "sampleRate": SR,
                "note": "高音区样本（升八度录音）",
            }
            (OUT / f"{base}.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8"
            )
            bank = [b for b in bank if b["url"] != f"voices/{base}.wav"]
            bank.append({"url": f"voices/{base}.wav", "kind": kind, "rootHz": round(hz, 1)})
            added += 1

    if args.dry_run:
        print("dry-run：没有写文件")
        return 0

    bank.sort(key=lambda b: (b["kind"], b["rootHz"]))
    bank_path.write_text(json.dumps({"samples": bank}, ensure_ascii=False, indent=1), encoding="utf-8")
    kinds: dict[str, int] = {}
    for b in bank:
        kinds[b["kind"]] = kinds.get(b["kind"], 0) + 1
    print(f"新增 {added} 段；bank.json 共 {len(bank)} 段 {kinds}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
