# 0.0.3 开发预览：做曲包组件补上语音识别

> 直接贴进 GitHub Releases 正文。

## 这一版改了什么

0.0.2 的做曲包组件只支持**带时间戳的 LRC**——歌词是纯文本（.txt）的话，对齐那一步没有
可用的模型，会失败。这一版把 **Whisper（faster-whisper / CTranslate2，small 模型）** 打进组件里，
两种歌词都能导入：

| 歌词 | 走哪条路 | 时间 |
|---|---|---|
| LRC（带时间戳） | 直接用时间戳，不跑 ASR | 30 秒的歌 ≈ 10–60 秒 |
| 纯文本（无时间戳） | Whisper 对齐（small，CPU int8） | 约 **3–6 倍音频时长**：3 分钟的歌 10–20 分钟 |

组件从 105 MB 涨到 **561 MB**（解压后约 800 MB），多出来的就是语音识别运行时和 small 模型
（`ctranslate2` + `faster_whisper` + 461 MB 模型）。安装包本身大小不变。

## 怎么用

1. 装 `ai-companion-singer-0.0.3-setup.exe`
2. 右键她 → **「做曲包组件…」** → 「打开组件目录」
3. 下 `ai-companion-singer-creator-pack.zip`，把里面的 `python/`、`pylibs/`、`tools/`、`models/`
   四个文件夹解压到那个目录（覆盖旧组件即可）
4. 按 `I` 选歌 + 歌词（LRC 或 .txt 都行）

> 已经装过 0.0.2 的组件？直接下载新 zip 覆盖解压就行，目录结构没变。

## 资产

| 文件 | 大小 | 说明 |
|---|---|---|
| `ai-companion-singer-0.0.3-setup.exe` | 89.6 MB | 安装包 |
| `ai-companion-singer-creator-pack.zip` | 561 MB | 可选组件：Python 3.12 + numpy/av/onnxruntime/Pillow/pykakasi + ctranslate2/faster-whisper + UVR MDX-Net 分离模型 + whisper-small |
| `SHA256SUMS.txt` | — | 上面两个文件的 SHA256 |

## 已知问题

- **ASR 很吃时间**（CPU 上 3–6 倍音频时长），导长歌的时候窗口别关。
- 插值补出来的行在歌词面板里带 `≈`，时间不准，可以用 `K` 逐行打点修正。
- 没有代码签名：SmartScreen 提示「未知发布者」→「更多信息 → 仍要运行」。
- 和声 / 起音采样来自商业曲目的人声（SVC 转换），**仅供个人学习研究**。
- 只在 Windows 10（19045）/ 125% 缩放下验证过。

---

## English

0.0.3 adds speech recognition to the optional creator pack, so **plain-text lyrics** (no timestamps)
can be aligned too. The pack grows to 561 MB (Python + numpy/av/onnxruntime + CTranslate2 +
faster-whisper + UVR separation model + whisper-small). Alignment via ASR takes roughly 3–6× the
audio duration on CPU; an LRC with timestamps skips it entirely.
