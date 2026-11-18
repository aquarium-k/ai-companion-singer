# 0.0.1 开发预览 · 发布说明

> 用来直接贴到 GitHub Releases 正文。中文为主，末尾给一段英文（方便外面的人看懂这是什么）。

## 这是什么

一个 Windows 桌面宠物：桌面上站着一个 3D 虚拟歌手，有动作、表情、口型、跟唱判定和实时和声。
**这是开发预览**——技术链路都跑通了，但还没有可以直接听的曲目。

## 能用的

- 透明置顶窗口 + 点击穿透（干活时她不会挡你点东西）、拖拽、托盘、全局快捷键
- 15 个动作：挥手 / 转圈 / 点头 / 摇头 / 鼓掌 / 比耶 / 凑近 / 伸手 / 欢呼 / 拨头发 / 走两步（真的会把窗口走开）
- 中 / 日 / 英三语（右键菜单 → 语言）
- 载入你自己的 `.vrm`、两个机位 + 镜头微调面板
- 有曲包时：跟唱判定（麦克风 YIN）、实时和声、整首翻唱、逐字口型、编舞

## 还不能用的（重要）

| | 说明 |
|---|---|
| ❌ **没有自带曲目** | 版权原因。装上之后她能站着、做动作、说话，但**唱不了** |
| ❌ **安装包里没有「导入歌曲」** | 导入要 Python 3.12 + 约 3 GB 依赖，没随包。按 `I` 会提示「这个版本不含导入组件」；导入只在源码开发版可用 |
| ⚠️ **没有代码签名** | Windows 会提示「未知发布者」→「更多信息 → 仍要运行」。这是没买签名证书（一年 $150 起）的正常现象 |
| ❌ 没有自动更新 / 崩溃上报 | 更新就重新下安装包 |

**想要能唱的版本**：自己做一个曲包（`docs/auto-lyrics-pipeline.md`），或者等之后带演示曲目的版本。

## 安装

1. 下 `伴唱桌宠 Setup 0.0.1.exe`（89.6 MB），双击安装（可改目录，会建桌面/开始菜单快捷方式）
2. SmartScreen 提示时点「更多信息 → 仍要运行」
3. 第一次打开**只有她本人**，按 `H` 打开 HUD + 混音条 + 键位提示，右键她打开菜单

校验（可选）：

```powershell
certutil -hashfile "伴唱桌宠 Setup 0.0.1.exe" SHA256
# 和 SHA256SUMS.txt 里那行对比
```

卸载：设置 → 应用 → 伴唱桌宠（`%APPDATA%\伴唱桌宠` 里的设置/曲包不会自动删，要彻底清就手动删）。

## 已知问题

- 没有曲目时的空状态：能玩动作，但「伴唱」这个核心功能用不上（见上）
- 只在 Windows 10（19045）/ 125% 缩放下验证过，Win11、150% DPI、多屏没测
- 没做长时间（数小时）稳定性测试
- 换别的 VRM 可能要重调站姿 / 嘴部偏移 / 取景
- 和声采样只做了 あ / え，遇到 i / u / o 会退回「あ」

## 版权与致谢

- **角色**：`saki.vrm`，作者 **aq**（VRoid Studio 2.16 导出）。VRM 许可允许分发 / 修改 / 商用，要求不用于过度暴力或性表现。
- **和声 / 起音采样**：用 SVC 从一首商业曲目的人声分轨做音色转换后截取的稳态长音，**仅供个人学习研究使用**，请不要商用或再分发。要公开使用请自己重烤（`docs/maintenance.md`）。
- **曲目**：不带任何曲目。你自己导入的歌、以及由它派生的分离轨 / 翻唱，版权仍归原权利人。
- 依赖：Electron、three.js、`@pixiv/three-vrm`（各自的开源许可随安装包附带）。

## 开发

源码和构建方法在仓库 README（`pnpm dev` / `pnpm run package`）。
`docs/` 里有完整的设计文档、踩坑记录和维护方案；`tools/` 里是离线流水线（造曲包、烤和声采样）。

---

## English

A Windows desktop pet featuring a 3D virtual singer: transparent always-on-top window, click-through,
15 actions, lip-sync, sing-along scoring and real-time harmony — **developer preview**.

**What works**: the pet itself (actions, menus, i18n, VRM loading, camera). **What doesn't**: there is
no bundled song and no importer in the installer (it needs Python + ~3 GB of models), so out of the box
she cannot sing. Build a song pack yourself with the tools in `tools/`, or wait for a later release.
The installer is unsigned, so SmartScreen will show "Unknown publisher" — that's expected.
