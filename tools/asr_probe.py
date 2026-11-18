"""用 SAPI 合成几句中文指令，再喂给 asr_server 看识别得准不准。

这一步绕开了麦克风：先证明「短句 ASR + 关键词匹配」这条路本身能用，
麦克风链和回声消除是后面单独要验的事。

用法:
  python tools/asr_probe.py --model base --out .tmp/asr_probe
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

# 桌宠要认的指令，以及识别后应该匹配到的动作
COMMANDS = [
    ("挥手", "wave"),
    ("转个圈", "spin"),
    ("唱首歌", "sing"),
    ("点点头", "nod"),
    ("摇摇头", "shake"),
    ("比个耶", "peace"),
    ("停下", "stop"),
]

# 关键词 → 动作。故意做得宽松：识别结果里只要**包含**就算命中，
# 因为 whisper 对短句常会多吐几个字（「好的挥手」「挥挥手」）。
KEYWORDS = {
    "挥手": "wave",
    "挥挥": "wave",
    "招手": "wave",
    "转圈": "spin",
    "转个圈": "spin",
    "转圈圈": "spin",
    "唱歌": "sing",
    "唱首": "sing",
    "唱歌吧": "sing",
    "点头": "nod",
    "摇头": "shake",
    "比耶": "peace",
    "比个耶": "peace",
    "停下来": "stop",
    "停下": "stop",
    "别动": "stop",
}


def synth(text: str, out: Path, voice: str = "Microsoft Huihui Desktop") -> Path:
    """用 SAPI 合成一句话到 wav。

    中文不能直接塞进 `powershell -Command` 的字符串里（会按控制台 ANSI 码页解码，
    路径和文本一起变乱码，而且不报错）。所以：文本写成 UTF-8 文件、脚本写成纯 ASCII，
    脚本自己按 UTF-8 读文本。
    """
    out.parent.mkdir(parents=True, exist_ok=True)
    txt = out.with_suffix(".txt")
    txt.write_text(text, encoding="utf-8")
    ps1 = out.with_suffix(".ps1")
    ps1.write_text(
        "Add-Type -AssemblyName System.Speech\n"
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer\n"
        f"$s.SelectVoice('{voice}')\n"
        "$s.Rate = 0\n"
        "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo("
        "16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, "
        "[System.Speech.AudioFormat.AudioChannel]::Mono)\n"
        "$s.SetOutputToWaveFile("
        f"'{out}', $fmt)\n"
        f"$text = [System.IO.File]::ReadAllText('{txt}', [System.Text.Encoding]::UTF8)\n"
        "$s.Speak($text)\n"
        "$s.Dispose()\n",
        encoding="ascii",
    )
    subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(ps1)],
        check=True,
        capture_output=True,
    )
    if not out.exists() or out.stat().st_size == 0:
        raise RuntimeError(f"合成失败，没生成 {out}")
    return out


# whisper 经常吐繁体，而我们的关键词是简体。只覆盖指令里会出现的字，
# 别为了这一件事去装 opencc（几十 MB）。
TRAD_TO_SIMP = str.maketrans(
    {
        "揮": "挥",
        "頭": "头",
        "轉": "转",
        "個": "个",
        "點": "点",
        "搖": "摇",
        "唱": "唱",
        "車": "车",
        "說": "说",
        "開": "开",
        "關": "关",
        "動": "动",
        "為": "为",
        "這": "这",
        "麼": "么",
        "來": "来",
        "過": "过",
    }
)


def normalize(text: str) -> str:
    cleaned = text.translate(TRAD_TO_SIMP)
    for ch in " ，。！？、,.!?~～":
        cleaned = cleaned.replace(ch, "")
    return cleaned


def match(text: str) -> str | None:
    cleaned = normalize(text)
    for key, action in KEYWORDS.items():
        if key in cleaned:
            return action
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description="合成指令并测试 ASR")
    ap.add_argument("--model", default="base")
    ap.add_argument("--out", default=".tmp/asr_probe")
    ap.add_argument("--server", default="tools/asr_server.py")
    args = ap.parse_args()

    out_dir = Path(args.out)
    print(f"[probe] 合成 {len(COMMANDS)} 句到 {out_dir} …", flush=True)
    wavs = []
    for index, (text, _action) in enumerate(COMMANDS):
        # 文件名用 ASCII：中文路径在 PowerShell 那一侧容易出问题
        wav = synth(text, out_dir / f"cmd{index}.wav")
        wavs.append((text, wav, index))

    env_cmd = [
        sys.executable,
        "-u",
        args.server,
        "--model",
        args.model,
        "--language",
        "zh",
        # 把可能的指令先喂给模型：短句识别率提升最明显的一招
        "--prompt",
        "、" .join(text for text, _ in COMMANDS),
    ]
    print(f"[probe] 启动 {args.model} …", flush=True)
    proc = subprocess.Popen(
        env_cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )

    assert proc.stdout and proc.stdin
    ready = proc.stdout.readline()
    print("[probe] 服务:", ready.strip(), flush=True)

    hits = 0
    for expected_text, _wav, index in wavs:
        action = COMMANDS[index][1]
        wav = out_dir / f"cmd{index}.wav"
        t0 = time.time()
        proc.stdin.write(json.dumps({"wav": str(wav)}) + "\n")
        proc.stdin.flush()
        line = proc.stdout.readline()
        try:
            res = json.loads(line)
        except json.JSONDecodeError:
            print("  响应异常:", line.strip())
            continue
        if not res.get("ok"):
            print(f"  {expected_text}: 失败 {res.get('error')}")
            continue
        got = match(res["text"])
        ok = got == action
        hits += ok
        print(
            f"  说「{expected_text}」→ 识别「{res['text']}」→ {got or '未匹配'}"
            f"  {'OK' if ok else 'x 期望 ' + action}  {res['ms']}ms",
            flush=True,
        )

    proc.stdin.close()
    proc.wait(timeout=10)
    err = proc.stderr.read() if proc.stderr else ""
    for line in err.splitlines()[-4:]:
        print("  [server]", line)

    print(f"\n[probe] 指令命中 {hits}/{len(COMMANDS)}")
    return 0 if hits == len(COMMANDS) else 1


if __name__ == "__main__":
    raise SystemExit(main())
