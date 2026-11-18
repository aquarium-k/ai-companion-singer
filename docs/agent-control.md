# 让 agent 操纵她（控制接口）

> 2026-11-18。这一页是**给外部程序（agent / 自动化脚本）看的接口说明**：
> 怎么连上来、能调什么、每个钩子的语义和返回值、以及三条常用配方。
> 接口本身是应用里就有的 `window.__pet.*`（48 个钩子），不需要额外装什么。

## 一、怎么连

应用需要一个**调试端口**才能被外部控制。默认不开，日常使用不受影响：

```powershell
# 打包版
"伴唱桌宠.exe" --remote-debugging-port=9340
# 开发版：先 pnpm dev，再给 electron 加同样参数
```

连上之后有三种用法：

| 用法 | 命令 |
|---|---|
| **命令行**（推荐） | `node tools/petctl.mjs --list` / `node tools/petctl.mjs action pose.wave` |
| 任意语言 / 直接 CDP | `GET http://127.0.0.1:9340/json` → 取 `webSocketDebuggerUrl` → `Runtime.evaluate` 调 `window.__pet.xxx()` |
| 自己的脚本 | 照抄 `tools/petctl.mjs` 里那 40 行（连、发、取结果） |

`petctl` 会把参数按 JSON 解析：`415` → 数字、`null` → null、`{"a":1}` → 对象、其余当字符串。

> ⚠️ **调试端口 = 完全控制权**（能读页面、能改状态）。只在本机、只在需要时开，别放进默认启动参数。

## 二、动作

| 钩子 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `action(id)` | 动作 id | `'started' \| 'restarted' \| 'blocked' \| 'missing'` | 播一个动作；`blocked` = 当前动作不让打断，`missing` = id 不存在 |
| `stopActions()` | — | `void` | 停掉所有动作，回到站姿 |
| `clips()` | — | `string[]` | 当前在跑的 clip id（检查「播了但没动」） |
| `walk()` | — | `void` | 走两步（BVH 动作，会真的把窗口走开一段） |
| `inbetween(fromId, toId, duration?)` | 姿势 id ×2，秒 | clip id | 两个姿势之间生成过门并播放 |
| `pose(id)` | 姿势 id | `'started' \| 'missing'` | 摆一个姿势（作者摆的姿势库） |
| `command(cmd)` | 命令名 | `void` | 走右键菜单那条路：`play` / `pause` / `restart` / `stop-track` / `import` / `say-song` / `mic` / `cam-front` / `cam-over` / `cam-panel` / `cam-reset` / `walk-far` / `lang:ja` … |

常用动作 id：`pose.wave` `pose.cheer` `pose.sing` `pose.lean` `pose.reach` `pose.peace` `pose.clap` `pose.hair` `pose.intro`、
`dance.bounce` `dance.spin` `walk` `turn.ccw140` `turn.cw220`。完整清单看 `src/actions/index.ts`，
运行时用 `--list` 看不到 id，用 `__pet.clips()` 反查。

## 三、和声（她唱什么）

| 钩子 | 参数 | 返回 |
|---|---|---|
| `harmony()` | — | 状态对象：`mode` / `outHz` / `gain` / `vowel` / `key` / `roots[]` / `loops[]` / `fx{vib,verb,drive,dbl}` / `sigma` / `rate` |
| `harmonyTone(hz \| null)` | Hz | `void` | 把和声钉在某个音高（`null` 松开）——不经过麦克风也能让她唱指定音 |
| `harmonyTarget(hz)` | 你唱的音高 | 她该唱的音高（Hz） | 音程换算，验证「跟唱→和声」这条链 |
| `harmonyProbe()` | — | 实测发声基频（自相关） | 核对「算的」和「响的」一致 |
| `hset(obj)` | `{mode,vib,dbl,dblLp,breath,fx,drive,verb,tilt,sigma,porta,att}` | `fx` 状态 | 运行时改和声参数（一次启动做 A/B） |
| `captureHarmony(sec)` | 秒 | `{sr, b64}` | 抓和声链的**原始输出**（Int16 base64），做频谱/毛刺分析用 |

`mode`：`off` / `third` / `thirdDown` / `fifth` / `octave`。

## 四、跟唱判定 / 麦克风

| 钩子 | 参数 | 返回 |
|---|---|---|
| `mic()` | — | `{on, sampleRate, level, gain}` |
| `latency()` | — | `{age, lag, …}`：`age` = 系统侧延迟，`lag` = 你比谱面晚多少（已补偿） |
| `activity(t?)` | 秒（省略=当前） | `{rms, ref, active}` 人声活动包络 |
| `refPitch()` | — | 参考音高轨状态（`frames` / `hz` / `score`） |
| `note(t)` / `notes(from, count)` / `noteCount()` | 秒 | 谱面音符（起点/时长/音高） |
| `attTest(noteSec, kind?)` | 秒，`vowel\|consonant\|aspirate` | `{ok, last}` | 直接触发一次咬字（不播歌也能验） |
| `attStats()` | — | 咬字统计（气声次数 / 被抑制次数 / 太短跳过次数） |
| `mouth()` | — | 口型状态（五个元音表情值 + 当前 mora 的元音） |

## 五、曲目 / 画面 / 模型

| 钩子 | 说明 |
|---|---|
| `songTime()` | 歌内时间（秒） |
| `vocalSource()` | 当前人声源：`original` / `cover`，以及分轨时长 |
| `voice()` | 和声音色来源（全局 / 曲包自带）、循环段数、起音片段数 |
| `mood()` | 当前曲子的情绪特征（valence / arousal / 调性 / 轮廓） |
| `speech()` / `saySong()` | 气泡状态 / 让她说一句「这首怎么唱」 |
| `camera()` / `orbit(deg)` | 机位状态 / 环绕角 |
| `clips()` / `restQuats()` / `bones()` / `ik()` | 动作与骨骼调试 |
| `hum()` / `humStart()` / `humStop()` / `sung()` | 待机哼歌 |
| `pageId()` / `sample()` | 页面标识 / 采样帧数据 |

## 六、三条配方

**1. 打招呼 → 挥手 → 回站姿**

```powershell
node tools/petctl.mjs action pose.intro
Start-Sleep -Milliseconds 2600
node tools/petctl.mjs action pose.wave
Start-Sleep -Milliseconds 1400
node tools/petctl.mjs stopActions
```

**2. 让她唱指定音高（不需要麦克风、不需要歌）**

```powershell
node tools/petctl.mjs hset '{"mode":"third"}'
node tools/petctl.mjs harmonyTone 415     # G#4
node tools/petctl.mjs harmonyProbe        # 应该读到 ≈415
node tools/petctl.mjs harmonyTone null
```

**3. 放一首歌 + 看跟唱情况**

```powershell
node tools/petctl.mjs command play
node tools/petctl.mjs songTime
node tools/petctl.mjs latency
node tools/petctl.mjs --json harmony
```

## 七、稳定性约定

- 这 48 个钩子是**调试/自动化接口**：名字基本稳定，但 `返回对象的字段`可能随功能增加而变（只加不改）。
- 会破坏兼容的改动会在 `docs/history.md` 里写一条「接口变更」。
- 想长期依赖某几个钩子，就在自己的脚本里包一层，别把内部字段名散落到各处。

## 八、为什么这对用户也是卖点

不用开放任何网络端口、不用装服务：**同一套 `__pet` 接口既能被 Claude/脚本驱动，也能被应用自己的验证脚本用**。
所以「能被 agent 操纵」不是新功能，而是这个项目一直以来的调试方式 —— 只是现在把它写成了契约。
