# 0.0.2 开发预览：现在可以做曲包了

> 直接贴进 GitHub Releases 正文。

## 这一版改了什么

**以前**：安装包只带播放 / 跟唱 / 和声，按 `I` 会说「这个版本不含导入组件」——
等于新装上之后她能站着、能挥手，但**唱不了**。

**现在**：做曲包需要的 Python 工具链（人声分离 / 参考音高 / 逐字口型 / 编舞）
单独打成了一个可选组件。装一次，之后所有歌都能自己导入。

### 怎么用

1. 装 `ai-companion-singer-0.0.2-setup.exe`
2. 右键她 → **「做曲包组件…」** → 点「打开组件目录」
3. 下 `ai-companion-singer-creator-pack.zip`（105 MB，解压后约 250 MB），
   把里面的 `python/`、`pylibs/`、`tools/`、`models/` 四个文件夹解压到那个目录
4. 按 `I` 选歌 + 歌词（**建议用 LRC**，带时间戳就不用跑语音识别，快很多）
5. 导入面板会显示每一步进度；完成后按 `S` 就能在选曲面板里看到新曲目

## 资产

| 文件 | 大小 | 说明 |
|---|---|---|
| `ai-companion-singer-0.0.2-setup.exe` | 89.6 MB | 安装包（不带做曲包组件） |
| `ai-companion-singer-creator-pack.zip` | 105 MB | 可选组件：Python 3.12 + numpy/av/onnxruntime + 人声分离模型（UVR MDX-Net） |
| `SHA256SUMS.txt` | — | 上面两个文件的 SHA256 |

## 说明 / 已知问题

- **没有代码签名**：SmartScreen 会提示「未知发布者」→「更多信息 → 仍要运行」，正常现象。
- **组件里没有语音识别模型**：歌词请用带时间戳的 LRC（「自动找歌词」抓到的就是 LRC）。
  没有时间戳的纯文本歌词会走另一条更慢的路径，当前组件里没带对应的模型，会失败。
- 30 秒的歌导入约 10–60 秒；整首 3–5 分钟的歌要几分钟，属正常。
- 和声 / 起音采样仍然来自商业曲目的人声（SVC 转换），**仅供个人学习研究**，别商用或再分发。
- 只在 Windows 10（19045）/ 125% 缩放下验证过；Win11、150% DPI、多屏没测。

## 升级注意

- 0.0.1 的曲包目录在 `%APPDATA%\伴唱桌宠\songpacks`，这一版不变，直接沿用。
- 组件只需装一次，之后升级安装包不用重装。

---

## English

Developer preview. New in 0.0.2: song packs can now be created from the released build via an
optional **creator pack** (Python 3.12 + numpy/av/onnxruntime + a UVR MDX-Net separation model,
105 MB download / ~250 MB extracted). Right-click the character → "Creator pack…" tells you where
to extract it; then press `I`, pick a song and an **LRC with timestamps**. No code signing yet —
SmartScreen will warn about an unknown publisher.
