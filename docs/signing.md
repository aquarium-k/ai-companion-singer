# 代码签名（调研 + 现状 + 怎么接）

> 2026-11-18。先给结论：**链路已经通了，缺的只是一张证书**；而按微软 2025–2026 的最新规则，
> 「有没有证书」只影响「第一次下载会不会被拦」，**不影响能不能装、能不能用**。
> 所以它不是一个发布阻塞项，是一个「信任/转化」项。

---

## 1. 现在是什么状态

| 项 | 状态 |
|---|---|
| 打包产物是否签名 | ❌ 没有（`Get-AuthenticodeSignature` → `NotSigned`） |
| 用户第一次运行 | SmartScreen「未知发布者」→「更多信息 → 仍要运行」（两次点击） |
| 签名链路是否可用 | ✅ 用自签证书实测通了：exe + 安装包 + 卸载器都签上（第 5 节） |
| 有证书后要改代码吗 | 不用。两个环境变量：`CSC_LINK` / `CSC_KEY_PASSWORD` |
| 没有证书期间 | `release/SHA256SUMS.txt` + 说明书里写清楚（第 6 节） |

## 2. 官方现在怎么规定（2026 值）

数字和结论来自微软官方页
[Code signing options for Windows app developers](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
（页面最后更新 2026-11-10）：

| 方式 | 价格 | 谁能用 | SmartScreen | 备注 |
|---|---|---|---|---|
| **Microsoft Store（MSIX）** | 免费 | 全球 | ✅ **完全不弹** | 商店替你重签；要提交审核、做 MSIX 包 |
| Microsoft Store（MSI/EXE） | 要有证书 | 全球 | ✅ 安装时不弹 | 你自己签，CA 必须在微软受信任根里 |
| **Azure Artifact Signing**（原 Trusted Signing） | ≈ $9.99/月 | 组织：美/加/欧/英；**个人：仅美、加** | ⚠️ 声誉靠时间攒，前期会弹 | **中国大陆用不了**（个人不行、组织也不行） |
| **OV 证书** | $150–300/年 | 全球 | ⚠️ 同上，靠时间攒 | 2023-06 起私钥必须在 HSM/硬件 token 或云 HSM |
| **EV 证书** | $400+/年 | 全球 | ⚠️ **2024 起和 OV 一样，不再秒过** | 多花的钱只买到更严的身份审核，买不到免弹窗 |
| 自签 | 免费 | — | ❌ 对普通用户是**强拦截** | 只适合本机测试 / 企业内部分发（组策略装根证书） |
| 不签 | 免费 | — | ❌ 强提示，企业可能直接拦 | 微软不推荐用于公开分发 |

几条关键事实，和以前的直觉不一样：

1. **EV 不再是「秒过」**。2024 年微软移除了 EV 的自动信誉授予，EV 签的包同样从零攒声誉。
   所以「多花 200 美金买 EV 换免弹窗」这条路已经没有了。
2. **Azure Trusted Signing 个人只开美加**，组织只开美/加/欧/英 —— 中国大陆主体用不了。
3. **声誉是按「发布者 + 文件」累积的**，不是按证书指纹：连续版本用同一个发布者签名，
   后来的版本能继承信任；换证书可能清零（有 ISV 在 2026-10 反馈过换签后 SmartScreen 提交
   十几天还在审核）。
4. **开源项目有一条免费通道**：[SignPath Foundation](https://signpath.io) 给符合条件的开源项目
   提供 OV 级签名（走他们的托管流水线）。如果这个项目打算开源，这是最划算的一条。
5. 微软文档里有一句也适用于我们：**不要让 agent 生成/导出/提交发布证书**。
   我这次用的是本机生成、用完即删的**测试**证书，符合这条。

## 3. 三条现实路线（中国主体）

| 路线 | 成本 | 时间 | 用户看到的 | 建议 |
|---|---|---|---|---|
| **A. 先不签**（现在） | 0 | 0 | 「未知发布者」+ 说明 | v0.1 就用这个。文字写清楚 + 给 SHA256，B 站视频里演示一次怎么点过去 |
| **B. 买 OV 证书** | ≈ ¥1000–2500/年（国内 CA 代理，需实名或营业执照，送硬件 token 或云签名） | 1–2 周 | 前期仍会弹，攒量后消失 | 有几百个真实下载、开始收赞助时再买 |
| **C. 上 Microsoft Store（MSIX）** | 免费签名，可能要开发者账号费 + 审核 | 1–3 周（做 MSIX、填资料、审核） | **完全没有弹窗** | 如果愿意做 MSIX 包，这是唯一「零成本零弹窗」的路；代价是审核和商店规则 |

> 顺带一句：Electron 打 MSIX 是可行的（electron-builder 有 `appx` target，微软也有
> Electron→MSIX 的文档），但桌宠这种「透明置顶 + 点击穿透」的窗口在 MSIX 的
> 应用容器里能不能保持行为，需要实测——这是路线 C 的前置风险。

## 4. 有证书了怎么签（不用改代码）

electron-builder 会自动读这两个环境变量：

```powershell
$env:CSC_LINK = 'D:\certs\aicompanion.pfx'      # 也可以是 base64 字符串
$env:CSC_KEY_PASSWORD = '<证书密码>'
pnpm run package            # 免安装目录
pnpm run package:installer  # NSIS 安装包
```

签完自查（`Status` 应该是 `Valid`）：

```powershell
Get-AuthenticodeSignature 'release\伴唱桌宠 Setup 0.0.1.exe' |
  Format-List Status, StatusMessage, SignerCertificate
```

云 HSM（SSL.com eSigner、Azure Artifact Signing 等）不用 `.pfx`，改用厂商的签名命令：
electron-builder 走 `win.azureSignOptions` 或自定义 `sign` 钩子，具体看
[electron-builder 的 Windows 签名文档](https://www.electron.build/docs/features/code-signing/code-signing-win/)
（它支持证书文件、证书库、`osslsigncode`、自定义钩子几种模式）。

## 5. 自签实测记录（2026-11-18，仅证明链路）

```powershell
# 1) 生成一张「代码签名」用途的自签证书（只进当前用户证书库）
powershell.exe -Command "New-SelfSignedCertificate -Type CodeSigningCert \
  -Subject 'CN=AI Companion Singer Test' -CertStoreLocation Cert:\CurrentUser\My \
  -KeyExportPolicy Exportable"

# 2) 导出 pfx
Export-PfxCertificate -Cert Cert:\CurrentUser\My\<thumbprint> -FilePath .tmp\signing\test.pfx `
  -Password (ConvertTo-SecureString 'pw' -AsPlainText -Force)

# 3) 打包（输出到工作区外，原因见 docs/release.md 八之 5）
$env:CSC_LINK = '<abs path>\test.pfx'; $env:CSC_KEY_PASSWORD = 'pw'
npx electron-builder --win nsis --config.directories.output=<工作区外的目录>
```

结果：

| 文件 | `Get-AuthenticodeSignature` |
|---|---|
| `resources/伴唱桌宠.exe` | `UnknownError` — 证书链终止于不受信任的根（`CN=AI Companion Singer Test`） |
| `伴唱桌宠 Setup 0.0.1.exe` | 同上 |

也就是说：**签名本身成功**（合法 Authenticode，篡改会被发现），只是根证书没进受信任区。
换成 CA 签发的证书，这个状态就变 `Valid`。验完证书已从 `Cert:\CurrentUser\My` 移除，
pfx 和临时产物都删了；**自签的包不能发**（对用户是强拦截，比不签还糟）。

> 顺带一个观察：打包时 rcedit（写 exe 图标/版本）偶发
> `Unable to commit changes` —— 刚生成的 180 MB exe 正被杀软扫描、文件被占用。
> electron-builder 自己重试 3 次通常就过；如果发现 exe 图标变成 Electron 默认的，重跑一次打包。

## 6. 不签也能让用户放心的做法（v0.1 就用这个）

1. 发布页给 **SHA256**：`scripts/package_installer.mjs` 自动生成 `release/SHA256SUMS.txt`，
   视频/图文里教一句 `certutil -hashfile 伴唱桌宠 Setup 0.0.1.exe SHA256`。
2. 说明书里写明「没有代码签名，Windows 会提示未知发布者，这是正常的」——
   `docs/manual.md` 第 2 节已经写了。
3. 从 **GitHub Releases** 下载（HTTPS + 平台信任），比网盘转发好解释。
4. 如果哪天开源了，优先试 **SignPath Foundation**（免费 OV 级签名）。
