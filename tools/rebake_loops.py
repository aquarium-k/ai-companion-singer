#!/usr/bin/env python3
"""把循环采样重造一遍：每一档都直接走 SVC 生成，不再用 PSOLA 链派生。

为什么（2026-11-17 用户点出来的：dist/voices 里 loop 系列在低音区和高音区都不稳定）
---------------------------------------------------------------------------
现在 24 档里只有 6 档是「原始素材」（258/324/384/419/516/575），其余全是链式 TD-PSOLA
从最近的原始档推出来的。实测「相邻周期的波形相关」（相位干净度）：

    原始档      n=6   中位 0.981
    派生 1 代   n=9   中位 0.910（最低 0.814）
    派生 2–3 代 n=9   中位 0.897

而 210/225/241 和 759/803/850 正好落在派生 1–3 代 —— 这就是用户听到的「低音区和高音区都不稳」。
音高本身是准的（最大偏差 6.3 音分），所以不是「跑调」，是**相位被反复 OLA 涂抹**。

从真唱里直接截也走不通：把白花那段翻唱的 f0 轨迹扫一遍，任何音高上
能连续稳定 ≥0.45 s 的段最长只有 0.13–0.38 s（歌是逐字咬的，没有长音）。

能走的路：那条 `user_a*.wav` 是她唱的一条 3.8 s 长音。SVC（seed-vc）**保留源音高、
只换音色**，所以给一个目标音高的长音源，就能得到「她的音色 + 精确音高」的长音，
每一档都是第一代、没有 OLA 涂抹。

    python tools/rebake_loops.py --only 210,850 --out .tmp/rebake   # 先做两颗对照
    python tools/rebake_loops.py --all --apply                      # 全库重造并覆盖
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

VOICES = ROOT / "public/voices"
WORK = VOICES / "_work"
REF = ROOT / "shots/svc/refvoice3.wav"
SR = 44100
CUT_SEC = 0.60  # 裁多长（含尾部的接缝交叉淡化余量）

# 两条现成的「她唱的长音」，SVC 的源：268.9 Hz（原调）和 607.2 Hz（+8 半音那版）
SEEDS = [(".tmp/user_a.wav", 268.90), (str(WORK / "user_a_up8_svc.wav"), 607.17)]


def read_wav(path) -> np.ndarray:
    y, sr = sf.read(str(path), dtype="float32", always_2d=False)
    if y.ndim > 1:
        y = y.mean(axis=1)
    assert sr == SR, (path, sr)
    return y


def write_wav(path, x: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    peak = float(np.abs(x).max()) or 1.0
    y = x if peak <= 0.98 else x * (0.98 / peak)
    sf.write(str(path), y, SR, subtype="PCM_16")


def resample_to(y: np.ndarray, f0_from: float, f0_to: float) -> np.ndarray:
    """线性相位重采样（只为给 SVC 一个音高对的源；音色后面由 SVC 换掉）。"""
    return librosa_resample_by(y, f0_to / f0_from)


def librosa_resample_by(y: np.ndarray, rate: float) -> np.ndarray:
    """把音高乘 rate（时长除 rate）：改采样率再按 44.1k 解读。"""
    import librosa

    if abs(rate - 1.0) < 1e-4:
        return y
    return librosa.resample(y, orig_sr=SR, target_sr=int(round(SR / rate))).astype(np.float32)


def measure_f0(y: np.ndarray, lo: float = 0, hi: float = 0) -> float:
    """稳定帧的 f0 中位（pyin）。"""
    import librosa

    a = lo or 70
    b = hi or 1200
    f0, _, _ = librosa.pyin(y, fmin=a, fmax=b, sr=SR, frame_length=2048, hop_length=128)
    ok = ~np.isnan(f0)
    if ok.sum() < 6:
        return 0.0
    c = np.median(f0[ok])
    # 丢掉离中位 > 1 个半音的帧（滑音/咬字边缘）
    keep = np.abs(1200 * np.log2(f0[ok] / c)) < 100
    return float(np.median(f0[ok][keep])) if keep.sum() > 4 else float(c)


def steady_window(y: np.ndarray, seconds: float, f0_hint: float) -> tuple[int, int]:
    """找最稳的 seconds 长窗口：**先排除有停顿的**，再挑音高最平的。

    第一版只按「音高 std 最小」挑，结果挑中了她换气的位置（源素材是一条 3.8 s 的
    长音，中间有停顿）：24 档里 419/441/465 出来只有 −45 dB、89% 帧是静音，
    490 也一半是空的。所以现在把「最响的窗口」和「窗口内最轻的帧」都当硬条件。
    """
    import librosa

    hop = 256
    f0, _, _ = librosa.pyin(y, fmin=max(70, f0_hint * 0.5), fmax=min(1200, f0_hint * 2),
                            sr=SR, frame_length=2048, hop_length=hop)
    ok = ~np.isnan(f0)
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    if ok.sum() < 8:
        return 0, int(SR * seconds)
    cents = 1200 * np.log2(np.where(ok, f0, f0_hint) / f0_hint)
    n = max(2, int(seconds * SR / hop))
    ref = float(np.percentile(rms, 90)) or 1.0

    def score(i: int, need_floor: float) -> float | None:
        seg_rms = rms[i : i + n]
        if len(seg_rms) < n or not ok[i : i + n].all():
            return None
        if seg_rms.min() < need_floor * ref:  # 窗口里有停顿
            return None
        return float(np.std(cents[i : i + n]))

    for floor in (0.35, 0.2, 0.05):  # 逐级放宽，实在找不到就认了
        best, bi = None, 0
        for i in range(0, max(1, len(cents) - n)):
            s = score(i, floor)
            if s is not None and (best is None or s < best):
                best, bi = s, i
        if best is not None:
            a = bi * hop
            return a, min(len(y), a + int(seconds * SR))
    return 0, min(len(y), int(seconds * SR))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="", help="只做这几个音高，如 210,850")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--out", default=str(ROOT / ".tmp/rebake"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--steps", type=int, default=40)
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--src-sec", type=float, default=1.8, help="喂给 SVC 的源长度（秒）")
    ap.add_argument("--keep-raw", action="store_true", help="把 SVC 的完整输出也存下来（便于之后重裁）")
    args = ap.parse_args()

    doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
    targets = sorted({float(l["rootHz"]) for l in doc["loops"] if (l.get("vowel") or "a") == "a"})
    if args.only:
        want = [float(v) for v in args.only.split(",") if v.strip()]
        targets = [t for t in targets if any(abs(1200 * np.log2(t / w)) < 20 for w in want)]
    if not targets:
        print("没有目标")
        return 1

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    seeds = [(read_wav(p), f) for p, f in SEEDS]
    print(f"源：{', '.join(f'{p.split(chr(92))[-1]} {f:.1f}Hz' for p, f in [(p, f) for p, f in SEEDS])}")
    print(f"目标 {len(targets)} 档：{', '.join(f'{t:.0f}' for t in targets)}")

    from svc_engine import Engine  # 延迟导入：只在真要跑时吃 4 GB 内存

    t0 = time.time()
    engine = Engine(threads=args.threads, steps=args.steps)
    ref = read_wav(REF)
    print(f"模型 {time.time()-t0:.1f}s，参考 {len(ref)/SR:.1f}s")

    from tune_loops import tune_audio  # 复用同一套修音/接缝逻辑

    rows = []
    for target in targets:
        # 选离得近的源，少搬一点
        src, src_f0 = min(seeds, key=lambda s: abs(np.log2(target / s[1])))
        a0, b0 = steady_window(src, args.src_sec, src_f0)
        slice_ = src[a0:b0]
        # 关键：用这一小片自己的音高（整条的中位数和稳定段能差一个多半音），
        # 不然重采样完就不是目标音高（第一版 850 做出来是 796）
        f0_slice = measure_f0(slice_) or src_f0
        src_part = resample_to(slice_, f0_slice, target)
        t1 = time.time()
        conv = engine.convert(src_part, ref).astype(np.float32)
        # SVC 也会有一点偏移：量出来再定速重采样一次，最后才修音/接缝
        f0_conv = measure_f0(conv) or target
        if abs(1200 * np.log2(f0_conv / target)) > 5:
            conv = librosa_resample_by(conv, target / f0_conv)
        a, b = steady_window(conv, CUT_SEC + 0.06, target)
        if args.keep_raw:
            raw_dir = ROOT / ".tmp/svc-raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            write_wav(raw_dir / f"raw_{int(round(target))}.wav", conv)
            (raw_dir / f"raw_{int(round(target))}.json").write_text(
                json.dumps({"target": target, "cut": [a, b], "SR": SR}), encoding="utf-8"
            )
        cut = conv[a:b]
        # 迭代锁音高：SVC 出来的音高不是精确的目标，一次重采样 + 再修音，收到 ≤3 音分
        body = cut
        for _ in range(3):
            body, info = tune_audio(body, SR, target)
            got = measure_f0(body)
            if not got or abs(1200 * np.log2(got / target)) <= 3:
                break
            body = librosa_resample_by(body, target / got)
        body, info = tune_audio(body, SR, target)
        # 音高实测
        got = measure_f0(body) or 0.0
        cents = 1200 * np.log2(got / target) if got else float("nan")
        name = f"loop_{int(round(target))}.wav"
        write_wav(out_dir / name, body)
        print(
            f"{name:16s} {target:7.1f}Hz → 实测 {got:7.2f}（{cents:+5.1f}） "
            f"{len(body)/SR*1000:5.0f}ms  {time.time()-t1:5.1f}s  {'修音' if 'skipped' not in info else '原样'}"
        )
        rows.append(dict(name=name, root=got or target, target=target, cents=float(cents), len=len(body)))

    print(f"\n共 {len(rows)} 档，总耗时 {time.time()-t0:.0f}s；输出 {out_dir}")
    if args.apply:
        # 备份放到 .tmp/（public/ 会被 vite 原样拷进 dist，备份不该进发行包）
        bak = ROOT / ".tmp/voices-backup"
        bak.mkdir(parents=True, exist_ok=True)
        for r in rows:
            src = out_dir / r["name"]
            dst = VOICES / r["name"]
            old_rms = None
            if dst.exists():
                if not (bak / r["name"]).exists():
                    shutil.copy2(dst, bak / r["name"])
                old_rms = float(np.sqrt(np.mean(read_wav(dst).astype(np.float64) ** 2)))
            body = read_wav(src)
            # 电平对齐到被替换的那一档：循环之间的响度平衡是调好的，
            # SVC 出来的绝对电平不一样，不归一化的话各音高的和声会跟着音高忽大忽小
            if old_rms:
                new_rms = float(np.sqrt(np.mean(body.astype(np.float64) ** 2))) or 1.0
                body = body * (old_rms / new_rms)
            write_wav(dst, body)
            meta_path = dst.with_suffix(".json")
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
            meta.update(
                source=f"svc@{r['target']:.0f}",
                rootHz=round(r["root"], 2),
                lengthSec=round(r["len"] / SR, 4),
                sampleRate=SR,
                periods=int(round(r["len"] / (SR / r["root"]))),
                method="svc-direct",
                targetHz=round(r["target"], 2),
            )
            # familyRootHz **故意不动**：它决定运行时「哪几档同一个人、不能同时响」，
            # 也就是混音里有几个声部。现在 6 个家族混出来是调好的厚度，
            # 改成 24 个独立家族会变成 10+ 个声部同时响（更厚也更糊），那就不是这次要改的东西了。
            meta.pop("shiftSemitones", None)
            meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

        # loops.json 必须跟着改：运行时用 rootHz 算 playbackRate，
        # 样本实测 843.9 Hz 而清单写 850.3 的话，每个音都会偏低 13 音分。
        doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
        by_name = {r["name"]: r for r in rows}
        for item in doc["loops"]:
            r = by_name.get(Path(item["url"]).name)
            if not r:
                continue
            item["rootHz"] = round(r["root"], 2)
            item["from"] = f"svc-direct {r['target']:.0f}"
        doc["loops"].sort(key=lambda l: ((l.get("vowel") or "a"), l["rootHz"]))
        (VOICES / "loops.json").write_text(
            json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(f"已覆盖 public/voices + loops.json（旧文件备份到 {bak}）—— 记得再同步 dist/voices")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
