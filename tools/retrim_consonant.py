"""裁掉 ら 片段前面那段过长的低电平前奏。

实测（`.tmp/attack_env.py`）：`att_consonant_200` 前 120 ms 都在 −37…−23 dB，
元音从 ~130 ms 才起来。`leadSec` 是 0.09（元音起点），但那是**低电平气息**，
不是干净的闭塞——听起来像「hmm-ら」而不是一个闪音。

做法：把片段开头裁到「元音起点前 35 ms」，同时把 sidecar 的 `leadSec` 改成 0.035。
程序里 `pad = max(0, 41ms − leadReal)` 会补上剩下的一点点闭塞，于是
41 ms 静音 → burst → 元音，这才是 ら 的形状。**只动 consonant，不动 vowel/aspirate。**
"""
import json, os, wave
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
V = os.path.join(ROOT, "public", "voices")
BANK = os.path.join(V, "bank.json")
KEEP_LEAD = 0.035


def read(path):
    with wave.open(path, "rb") as w:
        n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
        raw = w.readframes(n)
    x = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def write(path, x, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


doc = json.loads(open(BANK, encoding="utf-8").read())
changed = 0
for s in doc["samples"]:
    if s["kind"] != "consonant":
        continue
    url = s["url"]
    wav = os.path.join(V, os.path.basename(url))
    meta_p = wav.replace(".wav", ".json")
    if not os.path.exists(meta_p):
        continue
    meta = json.loads(open(meta_p, encoding="utf-8").read())
    lead = float(meta.get("leadSec") or 0)
    if lead <= KEEP_LEAD + 0.01:
        continue
    x, sr = read(wav)
    cut = int((lead - KEEP_LEAD) * sr)
    if cut <= 0 or cut >= len(x) - int(0.05 * sr):
        continue
    x = x[cut:]
    # 新开头做 2 ms 淡入，避免裁切点变成咔哒
    fade = max(4, int(0.002 * sr))
    x[:fade] *= np.linspace(0.0, 1.0, fade)
    write(wav, x, sr)
    meta["leadSec"] = round(KEEP_LEAD, 3)
    meta["lengthSec"] = round(len(x) / sr, 4)
    meta["trimmedFrom"] = round(lead, 3)
    open(meta_p, "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False, indent=1))
    changed += 1
    print(f"{os.path.basename(wav):<24} lead {lead*1000:5.0f} ms → {KEEP_LEAD*1000:.0f} ms，"
          f"长度 {len(x)/sr*1000:4.0f} ms")
print(f"共裁 {changed} 段")
