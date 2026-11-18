# 0.0.4：修「放歌时嘴几乎不动」

> 直接贴进 GitHub Releases 正文。

## 修的是什么

之前放歌时她的嘴基本是闭着的——尤其是**主歌**（人声电平偏低的段落）。查下来不是渲染问题
（把嘴型钉死 `?lip=0.9` 时嘴是明显的椭圆），而是**驱动量太小**，两个原因叠在一起：

| 原因 | 现象 | 修法 |
|---|---|---|
| `level()` 的零点取整首人声的 p10 | 主歌电平低于 p10 → 算出来恒为 0，嘴一直闭着 | 零点改成 `p10 × 0.5` |
| 有 mora 时张嘴量是 `max(包络, 0.25)` | 最多张 0.22，而这张脸上 aa≈0.2 的嘴形几乎看不出来 | 改成 `0.45 + 0.55 × 包络`，底量 0.45 |

同一首 CHAINSAW 实测（`lip` 中位数）：

| 位置 | 0.0.3 | 0.0.4 |
|---|---|---|
| 10 s | 0.23 | **0.49** |
| 30 s | 0.45 | **0.66** |
| 50 s | 0.12 | **0.42** |
| 90 s | **0.01** | **0.20**（p90 0.66） |
| 120 s | 0.11 | **0.49** |

间奏仍然只跟包络（没有 mora 不加底量），所以不会出现「没在唱却一直张着嘴」。

## 怎么升级

- 装 `ai-companion-singer-0.0.4-setup.exe` 覆盖安装即可，设置和曲包都在 `%APPDATA%\伴唱桌宠`，不受影响。
- **做曲包组件没有变**：v0.0.3 那个 `ai-companion-singer-creator-pack.zip` 继续用，
  已经装过就不用再下（见 [v0.0.3](https://github.com/aquarium-k/ai-companion-singer/releases/tag/v0.0.3)）。

## 资产

| 文件 | 大小 | 说明 |
|---|---|---|
| `ai-companion-singer-0.0.4-setup.exe` | 89.6 MB | 安装包（含口型修复） |
| `SHA256SUMS.txt` | — | 安装包的 SHA256 |

## 仍然存在

- 没有代码签名：SmartScreen 提示「未知发布者」→「更多信息 → 仍要运行」。
- 安装包不带曲目、也不带做曲包组件（要另外下）。
- 和声 / 起音采样来自商业曲目的人声（SVC 转换），**仅供个人学习研究**。

---

## English

Fixes lip-sync barely moving during playback (especially verses): the envelope level was zeroed out
below the song-wide p10, and the mouth was capped at 0.22 which is visually invisible on this model.
Now the zero point is p10/2 and singing always opens to at least 0.45 + 0.55×envelope. The creator
pack is unchanged — reuse the v0.0.3 asset.
