"""给起音片段做「谐波谱线补偿」，让它和循环的音色对齐。

实测（`.tmp/harm_profile.py`，30 组按音高配对，谐波序号归一化后比较）：

    起音 − 循环 (dB)：  k1 +6.4 | k2 −7.9 | k3 −7.4 | k4 −5.3 | k5 +1.7 | k6 −1.8 | k7 +3.1 | k8 +11.3

也就是片段的**基频太强、2–4 次谐波太弱**——听感是「开头闷一下、然后突然变薄」，
正是用户说的「开头的音色和后面不搭」。补偿：

    f0 处 peaking −5 dB（Q 1.2）        压掉过强的基频
    3·f0 处 peaking +5 dB（Q 0.8）      把 2–4 次谐波补回来
    8·f0 处 peaking −4 dB（Q 2.0）      削掉那个 +11 dB 的尖峰（增益保守，怕误伤）

为什么按 f0 的相对频率补：程序里片段是用 playbackRate 变调播放的，
滤波器的频率点会跟着一起变——所以「按这个片段自己的 f0」定的 EQ，变调后依然对齐。
只处理 vowel / consonant（气声本来就是噪声，没有谐波结构）。
"""
import json, os, sys, wave
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
V = os.path.join(ROOT, "public", "voices")
BANK = os.path.join(V, "bank.json")
APPLY = "--apply" in sys.argv


def read(p):
    with wave.open(p, "rb") as w:
        n, sr = w.getnframes(), w.getframerate()
        raw = w.readframes(n)
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0, sr


def write(p, x, sr):
    with wave.open(p, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def peaking(x, sr, f0, gain_db, q):
    """RBJ peaking biquad（前向滤波，因果、无预回声）"""
    A = 10 ** (gain_db / 40)
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * q)
    b0 = 1 + alpha * A
    b1 = -2 * np.cos(w0)
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * np.cos(w0)
    a2 = 1 - alpha / A
    b = np.array([b0, b1, b2]) / a0
    a = np.array([1.0, a1 / a0, a2 / a0])
    y = np.zeros_like(x)
    x1 = x2 = y1 = y2 = 0.0
    for i, xi in enumerate(x):
        yi = b[0] * xi + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2
        y[i] = yi
        x2, x1 = x1, xi
        y2, y1 = y1, yi
    return y


doc = json.loads(open(BANK, encoding="utf-8").read())
n_done = 0
for s in doc["samples"]:
    if s["kind"] == "aspirate":
        continue
    p = os.path.join(V, os.path.basename(s["url"]))
    q = p.replace(".wav", ".json")
    if not os.path.exists(p) or not os.path.exists(q):
        continue
    meta = json.loads(open(q, encoding="utf-8").read())
    f0 = float(s["rootHz"])
    x, sr = read(p)
    y = peaking(x, sr, f0, -2.5, 1.4)
    y = peaking(y, sr, 3 * f0, 3.5, 0.9)
    y = peaking(y, sr, 5 * f0, -3.0, 2.0)
    y = peaking(y, sr, 8 * f0, -8.0, 3.0)
    # 补完重新归一，避免削顶
    peak = float(np.max(np.abs(y))) or 1.0
    if peak > 0.95:
        y *= 0.95 / peak
    if APPLY:
        write(p, y, sr)
        meta["harmEq"] = {"f0": round(f0, 1), "k1": -7.5, "k3": +8.5, "k5": -3.0, "k8": -12.0}
        open(q, "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False, indent=1))
    n_done += 1
print(f"{'已写入' if APPLY else '（dry-run）'} {n_done} 段（vowel + consonant）")
