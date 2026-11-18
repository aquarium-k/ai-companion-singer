#!/usr/bin/env python3
"""把和声循环库补成「任意目标音高离最近采样 ≤0.85 个半音」。

问题
----
现在六段是 258 / 324 / 382 / 419 / 517 / 571 Hz，间隔最大 3.96 个半音，
而白花的音域是 **206–895 Hz**——最高那个音离最近的采样有 **7.8 个半音**。
`playbackRate` 变调会把共振峰一起拉走：7.8 个半音 = 共振峰整体上移 57%，
听感就是「不是她」。

做法
----
贪心插入：始终找**最大的空隙**，在几何中点插一个新的循环，直到全音域内
任意目标离最近采样 ≤0.85 个半音。新循环用最近的已有循环跑 TD-PSOLA
（`make_pitch_variants.py`，保共振峰）生成；单次变调上限 6 个半音。
最后写清单 `public/voices/loops.json`（运行时读它，不再硬编码六段）。

为什么不是「固定间隔网格」：网格会和已有的六个根音错开，生成一堆「只差 0.4 个半音」
的重复段。按空隙插才既省段数，又不动已经调好的那六段。
"""
from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
os.chdir(ROOT)
sys.path.insert(0, str(ROOT / ".pylibs"))
sys.path.insert(0, str(ROOT / "tools"))

import numpy as np  # noqa: E402

from make_pitch_variants import (  # noqa: E402
    SR,
    envelope_db,
    f0_median,
    psola_shift,
    read_wav,
    seam_jump,
    write_wav,
)

VOICES = ROOT / "public/voices"
F_LO, F_HI = 196.0, 900.0  # 白花实际音域（略放宽）
MAX_GAP = 1.70  # 相邻采样的最大间隔（半音）→ 任意目标最多偏 0.85
MAX_SHIFT = 6.0  # 单次 PSOLA 的最大变调（再大就开始糊）


def semis(a: float, b: float) -> float:
    return 12 * np.log2(a / b)


def build_vowel(seed_path: str, vowel: str, apply: bool) -> int:
    """用一个真元音种子，按现有「a」网格的音高整族生成（`loop_<vowel>_<hz>`）。

    为什么这样也能得到正确的元音：元音的身份在**共振峰**（绝对 Hz），
    而 TD-PSOLA 变调只改基频、不动频谱包络。所以把 467 Hz 的「え」搬到 300 或 800 Hz，
    读起来还是「え」。这也意味着**不必为每个元音每个音高都录一遍**——
    每元音一段真音 + PSOLA 就够。
    """
    seed = Path(seed_path)
    meta = json.loads(seed.with_suffix(".json").read_text(encoding="utf-8"))
    seed_root = float(meta["rootHz"])
    src = read_wav(seed)
    print(f"种子 {seed.name}  {seed_root:.2f} Hz（元音 {vowel}）")

    # 目标网格 = 现有「a」库的音高（这样两个元音的库一一对应，切换时音高不用换算）
    doc = json.loads((VOICES / "loops.json").read_text(encoding="utf-8"))
    targets = sorted(
        {round(float(l["rootHz"]), 2) for l in doc["loops"] if (l.get("vowel") or "a") == "a"}
    )
    print(f"目标 {len(targets)} 个音高：{targets[0]:.0f} … {targets[-1]:.0f} Hz")

    # 从种子出发，每次生成「离已生成节点 ≤6 半音」的目标（链式，避免一次变调太多）
    done = {round(seed_root, 2): {"root": seed_root, "audio": src, "from": "seed"}}
    pending = [t for t in targets if abs(semis(t, seed_root)) > 0.5]
    made = []
    while pending:
        progress = False
        for t in list(pending):
            near = min(done.values(), key=lambda n: abs(semis(t, n["root"])))
            shift = semis(t, near["root"])
            if abs(shift) > MAX_SHIFT:
                continue
            y, f0_out = psola_shift(near["audio"], near["root"], shift)
            done[round(f0_out, 2)] = {"root": f0_out, "audio": y, "from": f"{near['root']:.0f} {shift:+.2f}"}
            made.append((f0_out, y, shift, near["root"]))
            pending.remove(t)
            progress = True
        if not progress:
            print(f"⚠ 剩下 {len(pending)} 个音高变调跨不过 6 个半音，跳过：{pending}")
            break

    print(f"生成 {len(made)} 段「{vowel}」")
    if not apply:
        print("（只规划不写；加 --apply 才生成文件并更新 loops.json）")
        return 0

    items = doc["loops"]
    for f0_out, y, shift, parent_root in made:
        name = f"loop_{vowel}_{int(round(f0_out))}"
        path = VOICES / f"{name}.wav"
        write_wav(path, y)
        path.with_suffix(".json").write_text(
            json.dumps(
                {
                    "source": seed.name,
                    "rootHz": round(f0_out, 2),
                    "lengthSec": round(len(y) / SR, 4),
                    "sampleRate": SR,
                    "periods": int(round(len(y) / (SR / f0_out))),
                    "shiftSemitones": round(float(shift), 3),
                    "method": "psola",
                    "vowel": vowel,
                    # 整个元音只有一段真素材 → 全部同族（同族只让一档发声）
                    "familyRootHz": round(seed_root, 2),
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )
        items.append(
            {
                "url": f"voices/{name}.wav",
                "rootHz": round(f0_out, 2),
                "familyRootHz": round(seed_root, 2),
                "vowel": vowel,
                "from": f"{seed.stem} {shift:+.2f}",
            }
        )

    # 种子本身也进清单
    items.append(
        {
            "url": f"voices/{seed.name}",
            "rootHz": round(seed_root, 2),
            "familyRootHz": round(seed_root, 2),
            "vowel": vowel,
            "from": "seed",
        }
    )
    for it in items:
        it.setdefault("vowel", "a")
    items.sort(key=lambda l: ((l.get("vowel") or "a"), l["rootHz"]))
    (VOICES / "loops.json").write_text(
        json.dumps({"schema": 1, "maxGap": MAX_GAP, "loops": items}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"更新 loops.json：共 {len(items)} 段")

    print("\n校验（新生成的段）：")
    for f0_out, y, shift, _ in made:
        got = f0_median(y)
        cents = 1200 * np.log2(got / f0_out) if got > 0 else 0
        print(
            f"  {f0_out:7.2f} Hz 实测 {got:7.2f}（{cents:+5.1f} 音分）"
            f"  接缝 {seam_jump(y):.4f}  {shift:+.2f} 半音"
        )
    return 0


def main() -> int:
    apply = "--apply" in sys.argv

    # ---- 模式二：换元音。给一段真元音种子，按现有库的音高网格整族生成 ----
    seed_arg = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--seed"), "")
    vowel_arg = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--vowel"), "")
    if seed_arg:
        if not vowel_arg:
            raise SystemExit("--seed 要配 --vowel（例如 --vowel e）")
        return build_vowel(seed_arg, vowel_arg, apply)

    nodes = []
    for wav in sorted(VOICES.glob("loop_*.wav")):
        if re.match(r"loop_[aiueo]_", wav.stem):
            continue  # 带元音前缀的（loop_e_465）不属于「a」网格
        meta = json.loads(wav.with_suffix(".json").read_text(encoding="utf-8"))
        root = float(meta["rootHz"])
        nodes.append(
            {
                "root": root,
                "path": wav,
                "from": "existing",
                # 「家族」= 同一段原始采样。同一个家族的两档**不能同时响**，
                # 否则等于把同一个人的同一条音高叠两遍（会打架/拍频）。
                "family": root,
            }
        )
    nodes.sort(key=lambda n: n["root"])
    print("已有：", "  ".join(f"{n['root']:.1f}" for n in nodes))

    made = []

    def audio_of(node) -> np.ndarray:
        """节点的音频。新插的节点还没落盘，所以必须缓存内存里的那份。"""
        if "audio" not in node:
            node["audio"] = read_wav(node["path"])
        return node["audio"]

    while True:
        bounds = [F_LO] + [n["root"] for n in nodes] + [F_HI]
        gaps = [(bounds[i + 1] - bounds[i], bounds[i], bounds[i + 1]) for i in range(len(bounds) - 1)]
        gaps = [(semis(b, a), a, b) for _, a, b in gaps]
        gap, a, b = max(gaps)
        if gap <= MAX_GAP:
            break
        target = float(np.sqrt(a * b))  # 几何中点
        parent = min(nodes, key=lambda n: abs(semis(target, n["root"])))
        shift = semis(target, parent["root"])
        if abs(shift) > MAX_SHIFT:
            print(f"⚠ {a:.0f}–{b:.0f} Hz 这个空隙插不进（要变调 {shift:+.1f}），先按最近的来")
            shift = np.sign(shift) * MAX_SHIFT
            target = parent["root"] * 2 ** (shift / 12)
        y, f0_out = psola_shift(audio_of(parent), parent["root"], shift)
        name = f"loop_{int(round(f0_out))}"
        node = {
            "root": f0_out,
            "path": VOICES / f"{name}.wav",
            "from": f"{parent['path'].stem} {shift:+.2f}",
            "audio": y,
            # 链式派生（717→803）也要挂在**原始**那段上，否则一族会被劈成两族
            "family": parent.get("family", parent["root"]),
        }
        nodes.append(node)
        nodes.sort(key=lambda n: n["root"])
        made.append((node, y, shift))
        print(
            f"  插 {target:7.2f} Hz：{parent['path'].stem} {shift:+.2f} 半音 → {f0_out:7.2f} Hz（{name}）"
        )

    roots = sorted(n["root"] for n in nodes)
    worst, worst_at = 0.0, 0.0
    for t in np.arange(F_LO, F_HI + 0.1, 0.5):
        d = min(abs(semis(t, r)) for r in roots)
        if d > worst:
            worst, worst_at = d, t
    print(f"\n库共 {len(roots)} 段：{' '.join(f'{r:.0f}' for r in roots)}")
    print(f"覆盖率：{F_LO:.0f}–{F_HI:.0f} Hz 内任意目标离最近采样最多 **{worst:.2f} 半音**（最差点 {worst_at:.0f} Hz）")

    if not apply:
        print("\n（只规划不写；加 --apply 才生成文件和 loops.json）")
        return 0

    for node, y, shift in made:
        write_wav(node["path"], y)
        (node["path"].with_suffix(".json")).write_text(
            json.dumps(
                {
                    "source": node["from"].split(" ")[0] + ".wav",
                    "rootHz": round(node["root"], 2),
                    "lengthSec": round(len(y) / SR, 4),
                    "sampleRate": SR,
                    "periods": int(round(len(y) / (SR / node["root"]))),
                    "shiftSemitones": round(float(node["from"].split(" ")[1]), 3),
                    "method": "psola",
                    # 运行时靠它判断「哪几档是同一个人、不能同时响」
                    "familyRootHz": round(node["family"], 2),
                },
                ensure_ascii=False,
                indent=1,
            ),
            encoding="utf-8",
        )

    items = []
    for n in sorted(nodes, key=lambda n: n["root"]):
        items.append(
            {
                "url": f"voices/{n['path'].name}",
                "rootHz": round(n["root"], 2),
                "familyRootHz": round(n["family"], 2),
                "from": n["from"],
            }
        )
    (VOICES / "loops.json").write_text(
        json.dumps({"schema": 1, "maxGap": MAX_GAP, "loops": items}, ensure_ascii=False, indent=1),
        encoding="utf-8",
    )
    print(f"\n写入 {VOICES / 'loops.json'}：{len(items)} 段")

    print("\n校验（新生成的段：音高 / 接缝 / 与父段的包络位移）：")
    bad = 0
    for node, y, shift in made:
        got = f0_median(y)
        cents = 1200 * np.log2(got / node["root"]) if got > 0 else 0
        seam = seam_jump(y)
        parent_src = VOICES / (node["from"].split(" ")[0] + ".wav")
        freqs, env_p = envelope_db(read_wav(parent_src))
        _, env_y = envelope_db(y)
        band = (freqs >= 150) & (freqs <= 8000)
        ea, eb = env_p[band] - env_p[band].mean(), env_y[band] - env_y[band].mean()
        corr = float(np.corrcoef(ea, eb)[0, 1])
        ok = abs(cents) < 8 and seam < 0.25 and corr > 0.6
        if not ok:
            bad += 1
        print(
            f"  {node['path'].name:16s} {node['root']:7.2f} Hz 实测 {got:7.2f}（{cents:+5.1f} 音分）"
            f"  接缝 {seam:.4f}  包络相关 {corr:.3f}  {'' if ok else '⚠'}"
        )
    print("\n不合格：", bad)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
