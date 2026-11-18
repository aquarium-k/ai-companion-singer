# 发布准备：打包与素材清理

> 2026-11-18 起。目标：把仓库做成**能分发给别人**的安装包。
> 这一页只回答三件事：哪些进包、放在哪、各有多大。

## 一、体积实况（2026-11-17 实测）

| 目录 | 体积 | 进包？ | 说明 |
|---|---|---|---|
| `dist/` | **5.2 MB** | ✅ | 渲染层产物（JS/CSS/sourcemap），构建时生成 |
| `electron/` | 0.1 MB | ✅ | 主进程 |
| `src/` | 0.7 MB | ❌ | 源码；产物已在 dist |
| `public/voices/` | 10.4 MB | ✅ 只带 `loop_*.wav` + `loops.json` + `bank.json` + `att_*` | 其中 `_orig/`、`_work/` 是烘焙中间产物，**必须排除** |
| `public/songpacks/` | **66.1 MB** | ❌ | 用户自己的歌（含版权），安装包里不带；打包后运行时目录改到 userData |
| `models/saki.vrm` | 14.2 MB | ✅ | 用户 2026-11-18 新导出，VRM meta 允许分发（见 B10） |
| `models/text.vrm` | 14.1 MB | ❌ | 授权只到「作者本人 + 非商用」，**不许进包** |
| `tools/` | 1.4 MB | ⚠️ | 只有「导入歌曲」用到（要 python）；带不带见第三节 |
| `node_modules/` | 357.5 MB | ✅ 部分 | electron-builder 会按 `dependencies` 挑，只需 three / @pixiv/three-vrm |
| `.pylibs/` | **275.6 MB** | ❌ | Python 依赖（numpy/scipy/librosa/soundfile…） |
| `.svclibs/` | **1245.6 MB** | ❌ | SVC 推理依赖（torch 等） |
| `.tmp/svcmodels/` | **1419.5 MB** | ❌ | seed-vc / whisper / bigvgan 权重 |
| `.cache/huggingface/` | 1096.9 MB | ❌ | 模型缓存 |
| `shots/` | 363.0 MB | ❌ | 实验素材（烘焙中间产物、A/B 导出） |
| `docs/` | 0.4 MB | ❌ | 文档 |

**如果要全部随包**：约 2.9 GB（Python 依赖 + 模型），安装包会到 1 GB 以上，不可接受。
所以第三节把「导入歌曲」拆成可选组件。

## 二、打包后的目录布局

| 内容 | 打包前 | 打包后 | 谁来读 |
|---|---|---|---|
| 渲染层 | `dist/` | `app.asar/dist/` | `win.loadFile` |
| 和声采样 | `public/voices/` | `app.asar/public/voices/` | `read-asset`（先 public、再 dist） |
| VRM | `models/saki.vrm` | `resources/models/saki.vrm`（extraResources，**不在 asar 里**）+ `userData/models/`（用户导入） | `list-models`（打包后自带目录 = `process.resourcesPath/models`） |
| **曲包** | `public/songpacks/` | **`%APPDATA%/<app>/songpacks/`** | `get-paths` + `read-file`；`read-asset` 里 `songpacks/*` 也改指向这里 |
| 配置 / 日志 | `data/` | `%APPDATA%/<app>/data/` | 已有逻辑（`app.isPackaged` 分支） |

曲包必须搬出去：`app.asar` 是只读的，而「导入歌曲」要往里写（`pack.json`、`stems/`、`work/`）。

## 三、「导入歌曲」= 可选组件

导入那条链需要 **Python 3.12 + `.pylibs`(276 MB) + SVC 模型(≈2.5 GB)**。
三条路：

| 方案 | 安装包 | 首次使用 | 评价 |
|---|---|---|---|
| A. 全塞进包 | ~3.2 GB | 开箱可用 | 不可接受 |
| B. **随包只带 `.pylibs`（276 MB），模型首启下载** | ~300 MB | 点「导入」→ 下 ~2.5 GB | 折中；还要用户机器上有 Python |
| C. **导入功能标记为「未安装」，弹窗说明** | ~20 MB | 装好也不可导入 | 最小包；v1 推荐 |

v1 推荐 **C**：安装包只做「播放 + 跟唱 + 和声」，导入保留在开发版里；
以后要做 B 的话，`pipeline.cjs` 的 `findPython()` 已经支持显式配置和 `.venv`，加一个「下载组件」流程即可。

**2026-11-18 已按 C 落地并做了降级**：打包版里 `tools/pipeline.py` 不存在，所以
`import:start` 先查文件、查不到就返回一句人话（以前是把 `ENOTDIR` 直接抛给渲染层）；
`import:status` 多返回一个 `available`，渲染层据此把「按 I 导入」换成提示、把选曲面板的
空状态文案换成「这个版本不含导入组件，曲包要放到 songpacks 目录」。开发版（有 `tools/`）行为不变。

### 三之二、v0.0.2 起改成「独立的 creator pack」（实际实现）

用户提「这个版本还不能做曲包」。与其把 250 MB 塞进安装包，不如做一个**可选组件**：

| 项 | 值 |
|---|---|
| 下载 | `ai-companion-singer-creator-pack.zip`（**105 MB**，解压后 **250 MB**） |
| 内容 | `python/`（CPython 3.12，裁掉 include/libs/tcl/site-packages，35 MB）、`pylibs/`（numpy / av / onnxruntime / Pillow / pykakasi 及其依赖，187 MB）、`models/UVR_MDXNET_3_9662.onnx`（28 MB，人声分离）、`tools/`（流水线脚本 1 MB） |
| 放哪 | `<userData>/creator/`（`%APPDATA%\伴唱桌宠\creator`，右键「做曲包组件…」会打开这个目录） |
| 没有它 | 一切照旧：播放 / 跟唱 / 和声都能用，只是按 `I` 会弹说明框（原生 dialog，含下载说明 + 「打开组件目录」） |
| 有它 | `import:status.available = true`，按 `I` 走正常导入流程 |

实现要点（`electron/pipeline.cjs`）：

1. `creatorPaths()` 约定 `creator/{python,pylibs,tools,models}`；`canImport()` = creator 齐了**或**开发版有仓库自带 `tools/pipeline.py`。
2. `findPython()` 把 creator 的解释器排第一个 → 用户不用装 Python。
3. `pipelineEnv()` 的 `PYTHONPATH` 指向 `creator/pylibs`。
4. `start()` 用 creator 的 `tools/pipeline.py`、传 `--model creator/models/...`，
   **cwd 用 creator 目录**（打包后 `ctx.root` 是 `app.asar`，是个文件，拿它当 cwd 会 ENOENT）；
   日志写到 `DIR_DATA`（同样因为 asar 只读）。
5. **不含语音识别模型**：LRC 带时间戳时 `align` 阶段直接跳过（`align_skip`），所以组件里不需要
   whisper/ctranslate2；纯文本歌词那条路会失败（已知、写在说明里）。

实测（2026-11-18，打包版 + creator pack）：30 秒的歌 → `job.state = done`，
产物 `stems/`、`work/f0.json`、`lyrics.units.json`、`actions.json`、`pack.json(schema 2)` 齐全；
在 App 里点选曲面板能加载，`voice().packId` 变成新曲包。

**压缩包怎么做的**（可复现）：

```powershell
# 1) python：拷一份运行时，删掉用不到的
robocopy <python-dir> .tmp\creator\python /E /XD include libs tcl Scripts Lib\test Lib\idlelib Lib\tkinter Lib\site-packages Lib\ensurepip Lib\lib2to3
# 2) pylibs：拷依赖，排除 whisper/HF 那一套（组件里不做 ASR）
robocopy .pylibs .tmp\creator\pylibs /E /XD ctranslate2* faster_whisper* tokenizers* hf_xet* huggingface_hub* fsspec* pyarrow*
# 3) 模型 + 脚本
copy .cache\models\UVR_MDXNET_3_9662.onnx .tmp\creator\models\
copy tools\*.py .tmp\creator\tools\
# 4) 打 zip（Windows 自带 bsdtar 支持 -a 按扩展名选格式）
cd .tmp\creator; tar.exe -a -c -f ..\ai-companion-singer-creator-pack.zip python pylibs tools models
```

## 四、清理清单（打打包前必须做）

```powershell
# 1) 烘焙中间产物：public/voices 里只留运行时需要的
public/voices/_orig/     # 修音前的备份
public/voices/_work/     # SVC 源素材（user_a*.wav 等）
public/voices/_orig_stretch/、_orig_rebake/（如果还有）

# 2) 构建产物里的曲包副本（已修：vite 不再拷 public/）
#    确认 dist/ 只有 assets/ + index.html

# 3) 不进包但留在仓库的：shots/、.tmp/、.cache/、.pylibs/、.svclibs/、docs/
```

`electron-builder` 的 `files` 白名单会把它们都挡在外面，但白名单要写清楚，别用「全部包含再排除」。

## 五、版权 / 授权（B9、B10）

- **曲包**：用户导入的歌（mp3 与人声分离轨）不进包 —— 这条决定了第二节的布局。
- **VRM（已解决）**：随包的是用户 2026-11-18 新导出的 `models/saki.vrm`
  （VRoid Studio 2.16 / VRM 1.0）。meta 原文：

  | 字段 | 值 | 对我们意味着 |
  |---|---|---|
  | `authors` | `aq` | 署名可以不给（`creditNotation: unnecessary`），发布说明里谢一句就行 |
  | `avatarPermission` | `everyone` | 谁都能用来当头像/角色 |
  | `commercialUsage` | `corporation` | 商用（含公司）允许 |
  | `allowRedistribution` | `true` | **能随安装包分发** |
  | `modification` | `allowModificationRedistribution` | 能改、改完还能分发 |
  | `allowExcessivelyViolent/SexualUsage` | `false` | 别拿它做暴力/性表现；我们跟他唱无关 |
  | `allowPoliticalOrReligiousUsage` / `allowAntisocialOrHateUsage` | `false` | 同上 |

  旧的 `models/text.vrm`：`onlySeparatelyLicensedPerson` + `personalNonProfit` +
  `creditNotation: required` —— **不能随包**，仓库里留着仅供本地开发。
- **参考人声**：`shots/svc/refvoice3.wav` 是别人的演唱，**不进包**（也不该进仓库，收紧见 B9）。
- **和声采样**：`public/voices/loop_*.wav` 派生自同一首歌的翻唱 —— 分发给别人前要确认这层。

## 六、打包步骤（实现进度见文末）

```powershell
pnpm install                 # 只装 dependencies（electron-builder 是 devDependency，不随包）
pnpm run build               # dist/
pnpm run package             # electron-builder --dir（先出免安装目录）
pnpm run package:installer   # 出 NSIS 安装包（scripts/package_installer.mjs）
```

输出在 `release/`。`--dir` 先跑，能起来再出安装包。

`package:installer` 走的是 `scripts/package_installer.mjs`，**不是**直接 `electron-builder --win nsis`：
脚本会先把输出目录指到 `%TEMP%\pet-release`、出完再把 `伴唱桌宠 Setup *.exe` 和 `.blockmap`
拷回 `release/`（原因见第八节第 5 条），并生成 `release/SHA256SUMS.txt`（没有代码签名时的替代核对手段）。
脚本最后会打印产物大小和路径。

## 七、进度

- [x] 体积盘点（上表）
- [x] `read-asset` 先读 `public/` 再退回 `dist/`（配合 dist 不再拷 public）
- [x] 打包后曲包目录改到 `userData/songpacks`（含首启建目录 + 空 `index.json`）
- [x] `read-asset` 把 `songpacks/*` 映射到那个目录
- [x] `electron-builder` 配置与 `--dir`（产物 `release/win-unpacked/`，**264.7 MB**：exe 180 MB + `app.asar` 21 MB + `resources/models/saki.vrm` 14 MB）
- [x] 素材白名单实测：asar 里只有 `package.json` / `electron/` / `dist/` / `public/voices`（206 项）/ `node_modules`；**没有** `docs`、`shots`、`tools`、`src`、`songpacks`、`_orig`、`_work`
- [x] **VRM 授权确认**（见第五节，`saki.vrm` 允许分发）
- [x] 首次运行自检：打包版启动后从 userData 的空索引读出 0 个曲包，日志是一句「没有登记任何曲包」而不是报错；和声 48 段、起音片段 42 段都从 asar 正常载入（554 Hz 实测发声 553.6 Hz）
- [x] **图标**：`scripts/make-icon.py` → `build/icon.{ico,png}`；开发者模式打开后 rcedit 正常写进 exe
      （`ProductName=伴唱桌宠`、`FileVersion=0.0.1`、`CompanyName=ai-companion-singer contributors`、图标是粉紫圆 + 音符）
- [x] **NSIS 安装包**：`release/伴唱桌宠 Setup 0.0.1.exe`，**89.6 MB**（+ `.blockmap`）。静默安装验证：
      `/S /D=<临时目录>` → 装出 265 MB、含 `resources/models/saki.vrm`、桌面快捷方式 + 卸载器；
      装好的程序启动后 HUD 是「角色 vrm」、banner「已载入 saki.vrm」、48 段循环 + 42 段起音。
      验完已卸掉（卸载器跑过，目录/快捷方式都清干净）
- [x] **代码签名链路验证**：用自签证书（`New-SelfSignedCertificate -Type CodeSigningCert`）实测，
      exe / 安装包 / 卸载器都被签上；`Get-AuthenticodeSignature` 只报「证书链终止于不受信任的根」，
      换成 CA 签发的证书即 `Valid`。**没有证书就还是「未知发布者」**，所以现在仍按未签名发布，
      配套给 `release/SHA256SUMS.txt` + 说明书里的说明。选型/接法/价格见 `docs/signing.md`
- [ ] **买证书**（OV ≈ ¥1000–2500/年 / EV ≈ ¥2500–4000/年 / Azure Trusted Signing ≈ $10/月）：
      拿到后设 `CSC_LINK` + `CSC_KEY_PASSWORD` 重跑 `pnpm run package:installer`，代码不用改

## 八、打包踩的五个坑（2026-11-18）

1. **winCodeSign 解包失败**：Cannot create symbolic link ... 客户端没有所需的特权。
   那个包里带 macOS 的 dylib 符号链接，普通 Windows 用户没权限创建。
   - 绕法：win.signAndEditExecutable: false（跳过 rcedit/签名 → 能出免安装目录，但 exe 是 Electron 默认图标/元数据）
   - 正解（已采用）：用户打开「开发者模式」后删掉这一行，rcedit 就能写图标和版本资源
2. **打包版起不来（0x80000003）**：这台机器的 %APPDATA% 不可写，Chromium 没有可写的 profile 就退出。
   验证时加 --user-data-dir=<可写目录> 即可；**正常用户环境不需要**这个参数。
3. **打包后模型不见了**：`list-models` 原来把「自带模型」算成 `path.join(ROOT, 'models')`，
   而打包后 `ROOT = resources/app.asar`，拼出来是 `app.asar/models`（不存在）→ 列表为空 → 界面
   掉回占位角色（HUD 显示「角色 primitive」），而且 `?model=` 在 `file://` 下 fetch 也不通，连兜底都没有。
   改法：自带模型目录用 `process.resourcesPath`（`extraResources` 就放在那）。
   **教训**：凡是「打包后换位置」的目录，都要像 `DIR_DATA` / `DIR_SONGPACKS` 一样单独算一次，
   别在别处再用 `ROOT` 拼。
4. **托盘图标解不出来**：`new Tray(icon.ico)` 失败，日志里每次都是
   `Failed to load image from path .../app.asar/electron/icon.ico`，然后退回 `icon.png` 才成功。
   原因不是 asar，是 **`nativeImage` 只保证 PNG/JPEG 能解码，不保证 ICO**。改成 png 优先
   （`icon.ico` 仍留着给 exe 图标用）。
5. **NSIS 在工作区内必定失败（exit 2）**：electron-builder 出 NSIS 包时会先编一个「只生成卸载器」的
   小安装器，然后**原地把它跑一遍**（`WriteUninstaller`）。这一步在 `release/` 里跑一律 exit 2
   （拷到 `%TEMP%`、或 `release/` 之外的任何目录都 exit 0），所以不是安装脚本写错了。
   绕法（已自动化）：`scripts/package_installer.mjs` 里用 `--config.directories.output=%TEMP%\pet-release`
   出包，再把 `伴唱桌宠 Setup *.exe` 拷回 `release/`。手动等价：
   `npx electron-builder --win nsis --config.directories.output=C:/Users/<你>/AppData/Local/Temp/pet-release`。

---

## 九、推到 GitHub（开发预览用）

这台机器上**没装 git**（`git` 不在 PATH），先装 [Git for Windows](https://git-scm.com/download/win)。

```powershell
cd <项目目录>
git init -b main
git add -A
git status --short | Measure-Object -Line    # 约 370 个文件（≈21.6 MB，含 saki.vrm 14 MB）
git commit -m "0.0.1 开发预览"
git remote add origin https://github.com/<你的账号>/ai-companion-singer.git
git push -u origin main
```

**提交前必看**——`git status --short` 里**不能**出现下面这些（`.gitignore` 已经挡住，
如果出现了，先查是哪条规则没匹配上，**别用 `git add -f`**）：

| 不能进仓库 | 为什么 |
|---|---|
| `data/` | 本机音乐路径、导入日志（个人数据） |
| `public/songpacks/` | 别人的歌 + 分离轨（版权） |
| `shots/`、`.tmp*/`、`checkpoints/`、`.pylibs/`、`.svclibs/`、`.cache/` | 合计约 5 GB |
| `models/text.vrm` | VRM 许可不允许再分发 |
| `release/`、`dist/` | 构建产物，走 Releases |

**发 Release**：GitHub → Releases → Draft a new release → tag `v0.0.1` →
上传 `release/伴唱桌宠 Setup 0.0.1.exe` 和 `release/SHA256SUMS.txt` →
正文直接贴 `docs/release-notes-0.0.1.md`。安装包不进 git，只放 Releases。

⚠️ **GitHub 会把中文文件名改掉**：`伴唱桌宠 Setup 0.0.1.exe` 上传后变成
`Setup.0.0.1.exe`（空格变点、中文没了）。所以发布资产用 ASCII 名
**`ai-companion-singer-0.0.1-setup.exe`**，`SHA256SUMS.txt` 里也写这个名字
（2026-11-18 第一次发布时踩到，已改名重传）。

> 想把安装包里的和声采样也一起公开的话，先在 `README.md` 的版权段里说清楚
> 「仅供个人学习研究」；要正式发布还是得按 `docs/maintenance.md` 用自己录的元音重烤。

## 十、中国大陆的网络问题（2026-11-18 实测）

这台机器到 **`github.com` 的 DNS 被污染**：解析结果是 `20.6.7.17` / `192.5.6.30` 这类
根 DNS 服务器地址；换成真实 IP（`140.82.112.3` 等）能连上，但 TLS 吞吐只有 **~0.1 KB/s**，
`git push` 必然超时。`api.github.com` / `uploads.github.com` / `codeload.github.com`
解析正常、速度也可以，所以 `gh` 的命令都能用，只有「推代码/拉大文件」不行。

**现在的做法**（已经配好，不用重做）：

| 项 | 值 |
|---|---|
| remote | `ssh://git@ssh.github.com:443/aquarium-k/ai-companion-singer.git`（GitHub 的 SSH-over-443 入口，域名解析正常，握手 1–2 秒） |
| 私钥 | `.tmp/ssh/id_ed25519`（在 `.gitignore` 里，不会进仓库）；公钥已用 `gh ssh-key add` 注册 |
| 推送 | `node scripts/push.mjs`（内部设好 `GIT_SSH_COMMAND`，用 Windows 自带的 OpenSSH） |
| 撤销密钥 | `gh ssh-key list` → `gh ssh-key delete <id>` |

想换回 HTTPS：先开代理（Clash 之类，默认 `127.0.0.1:7890`），再
`git remote set-url origin https://github.com/<你>/ai-companion-singer.git`，
推的时候加 `-c http.proxy=http://127.0.0.1:7890`。
