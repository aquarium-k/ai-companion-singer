"""把 ら/は 的起音片段重新对齐到**它自己的音节起点**，并丢掉切完太短的。

两类用不同的起音判据：

- **ら（consonant）**：找能量跳变（burst）。实测 `att_consonant_230` 前面 100 ms
  是 −21…−16 dB 的浊音尾巴，burst 在 105 ms —— 切到 burst 前 8 ms。
- **は（aspirate）**：找**噪声起点**（周期性第一次掉到 0.45 以下而且不是静音）。
  不能用能量跳变——[h] 之后接元音时能量也是往上的，按能量切会把 [h] 整段切掉。
  实测 `att_aspirate_537` 前面 160 ms 都是浊音（周期 0.6–0.9），那就是「混入的其它声音」。

切完长度 < 60 ms 的片段**从库里删掉**（太短撑不起一个起音，剩下的样本靠变调顶上）。
默认 dry-run，`--apply` 才写。
"""
import json, os, sys, wave
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
V = os.path.join(ROOT, "public", "voices")
BANK = os.path.join(V, "bank.json")
PRE = 0.008
MIN_KEEP = 0.060


def read(path):
    with wave.open(path, "rb") as w:
        n, sr = w.getnframes(), w.getframerate()
        raw = w.readframes(n)
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0, sr


def write(path, x, sr):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


def frames(x, sr):
    hop = max(1, int(0.005 * sr))
    k = max(2, int(0.010 * sr))
    lvl, per = [], []
    for s in range(0, len(x) - k, hop):
        seg = x[s:s + k]
        lvl.append(20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-9))
        c = seg - seg.mean()
        ac = np.correlate(c, c, "full")[len(c) - 1:]
        ac = ac / (ac[0] + 1e-12)
        lo, hi = int(sr / 700), min(int(sr / 60), len(ac) - 1)
        per.append(float(ac[lo:hi].max()) if hi > lo else 0.0)
    return np.array(lvl), np.array(per), hop / sr


def onset_of(x, sr, kind):
    """返回 (切点秒, 元音起点秒)。

    两类都用**元音起点**（能量最大跳变）做基准，再往前留固定的「辅音量」：
    - ら：burst 前 8 ms（burst 就是元音前的那一下，闭锁由程序补的 41 ms 静音负责）
    - は：[h] 是**气声**，本身没有能量跳变，所以用「元音起点前 50 ms」当它的起点。
      上一版用「周期性掉到 0.45」判 [h]，在 −30 dB 的静音段上周期性本来就不稳，
      结果把 130 ms 的浊音尾巴留了下来（`att_aspirate_537` 实测）。
    """
    lvl, per, dt = frames(x, sr)
    # 最大能量跳变（跨 20 ms）
    span = max(1, int(0.02 / dt))
    dif = lvl[span:] - lvl[:-span] if len(lvl) > span else np.zeros(1)
    vowel = int(np.argmax(dif)) + span if len(dif) and dif.max() >= 4 else 0
    vowel_t = vowel * dt
    if kind == "aspirate":
        cut = max(0.0, vowel_t - 0.050)
        return cut, vowel_t
    cut = max(0.0, vowel_t - PRE)
    return cut, vowel_t


apply = "--apply" in sys.argv
doc = json.loads(open(BANK, encoding="utf-8").read())
keep, drop = [], []
print(f"{'片段':<24} {'总长':>6} {'起点':>6} {'元音':>6} → {'新长':>6} {'新lead':>7}  结果")
for s in doc["samples"]:
    if s["kind"] == "vowel":
        keep.append(s)
        continue
    wav = os.path.join(V, os.path.basename(s["url"]))
    meta_p = wav.replace(".wav", ".json")
    x, sr = read(wav)
    onset, vowel = onset_of(x, sr, s["kind"])
    cut = max(0.0, onset - PRE)
    new = x[int(cut * sr):]
    new_lead = max(0.004, vowel - cut)
    short = len(new) / sr < MIN_KEEP
    print(f"{os.path.basename(wav):<24} {len(x)/sr*1000:5.0f}ms {onset*1000:6.0f} {vowel*1000:6.0f} → "
          f"{len(new)/sr*1000:5.0f}ms {new_lead*1000:6.0f}ms  {'删（太短）' if short else ('切 ' + str(int(cut*1000)) + 'ms')}")
    if short:
        drop.append(s)
        continue
    keep.append(s)
    if apply and cut >= 0.004:
        fade = max(4, int(0.002 * sr))
        new[:fade] *= np.linspace(0.0, 1.0, fade)
        write(wav, new, sr)
        meta = json.loads(open(meta_p, encoding="utf-8").read()) if os.path.exists(meta_p) else {}
        meta["leadSec"] = round(new_lead, 3)
        meta["lengthSec"] = round(len(new) / sr, 4)
        meta["onsetTrimmed"] = round(cut, 3)
        open(meta_p, "w", encoding="utf-8").write(json.dumps(meta, ensure_ascii=False, indent=1))

print(f"{'已写入' if apply else '（dry-run）'}：保留 {len(keep)} 段，删 {len(drop)} 段")
if apply:
    doc["samples"] = keep
    open(BANK, "w", encoding="utf-8").write(json.dumps(doc, ensure_ascii=False, indent=1))
    for s in drop:
        for ext in (".wav", ".json"):
            p = os.path.join(V, os.path.basename(s["url"]).replace(".wav", ext))
            if os.path.exists(p):
                os.remove(p)
    print("bank.json 已更新，短片段文件已删")
