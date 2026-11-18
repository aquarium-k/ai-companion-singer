# 曲包格式（schema 2）

> 校验逻辑只有一份：`src/songpack/schema.ts`。运行时（`src/songpack/loader.ts`）和离线工具
> （`tools/validate_packs.mjs`）用的都是它——改了规则两边同时生效，不会跑偏。
> 本文只讲**为什么**和**怎么填**。

## 目录结构

```
public/songpacks/
  index.json              名单（选曲面板只认这里登记的）
  <id>/                   目录名 = 曲包 id（改标题要连带改目录名）
    pack.json             元信息（本文主角）
    actions.json          编舞时间轴
    lyrics.auto.json      歌词（行级 + mora 级）
    lyrics.units.json     逐字口型用的 mora 时间轴
    stems/
      instrumental.mp3    伴奏
      vocals.mp3          原唱分轨（V 键关人声靠它）
    cover.wav             她的翻唱（Y 键切；可选）
    work/f0.json          参考音高（跟唱判定 + 和声取音程）
    voices/               曲包自带的和声音色（可选，见下）
```

`index.json`：

```json
{ "schema": 1, "packs": ["demo", "佐佐木真奈-异修罗-ed-白花-鈴木このみ"] }
```

索引和目录必须一一对应：**登记了不存在的目录 = error**，**目录没登记 = warn**
（后者会让人以为"导入没成功"，其实只是面板里看不到）。

## pack.json

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `schema` | ✔ | — | 当前 **2**；1 的包照常能读（只补默认值） |
| `id` | ✔ | — | 必须**等于目录名**。目录名就是磁盘上的身份，改名/删除都靠它 |
| `title` | ✔ | — | 面板显示名 |
| `artist` | | `—` | 只显示用 |
| `bpm` | | — | 20–300；缺了节拍器和能量曲线会退化（warn） |
| `beatsPerBar` | | `4` | 1–16 |
| `duration` | ✔ | — | 秒，正数；和 `actions.json` 的 `duration` 差 >0.5 s 会 warn（运行时以 actions 为准） |
| `loop` | | `false` | 播完循环 |
| `offset` | | `0` | 音轨相对歌曲起点的偏移（秒） |
| `choreography` | | `actions.json` | 编舞文件名 |
| `assets` | | `{}` | 见下表 |

### assets

| 键 | 必填 | 缺了会怎样 |
|---|---|---|
| `instrumental` | ✔ error | 没有伴奏，唱不了 |
| `vocal` | warn | V 关人声 / Y 换翻唱都没东西可切 |
| `cover` | — | 没有「她的翻唱」（Y 键只会切回原唱） |
| `f0` | warn | **跟唱判定和和声整首哑掉**（最容易被忽略的一条） |
| `units` | warn | 没有逐字口型和逐字换元音 |
| `lyrics` | warn | 没有字幕 |
| `chart` / `viseme` | — | 留位，现在是 `null` |
| `voices` | — | 曲包自带的循环采样数组（相对曲包目录） |
| `attackBank` | — | 曲包自带的起音片段库（`bank.json` 同格式） |
| `thumb` | — | 选曲面板缩略图；没有就显示首字色块 |

规则（都会报出来）：路径必须**相对**、用 `/`、不许 `..`；登记了但文件不在 = error。

## 手上有什么问题，看就知道

```powershell
node tools\validate_packs.mjs            # 查 public/songpacks
node tools\validate_packs.mjs --strict   # warn 也算失败（发布前用）
node tools\validate_packs.mjs --dir .tmp\某个包
```

输出是按曲包分组的 issue 列表，每条都带机器可读的 `[code]`：

| code | 级别 | 什么时候出现 |
|---|---|---|
| `schema.missing` / `schema.unsupported` | error | 没写 schema / 比程序新 |
| `id.mismatch` | error | `id` 和目录名不一致 |
| `title.missing` / `duration.invalid` | error | 必填项缺失或非法 |
| `assets.instrumental.missing` | error | 没有伴奏 |
| `assets.<key>.missing` | error | 登记了但文件不存在 |
| `key.unknown` / `assets.unknown` | warn | **字段拼错**（会给出最像的那个键名） |
| `assets.f0.missing` | warn | 跟唱/和声会静悄悄地不工作 |
| `cue.*` | error | `actions.json` 里时间越界、缺 clip、at 不是数字 |
| `track.duration` | warn | 两份时长不一致 |
| `json.bom` | warn | 文件带 UTF-8 BOM（Windows 编辑器爱加，`JSON.parse` 会报错） |

## 迁移策略

- **只向前加字段**，不改已有字段的含义；旧包不重写、不升级文件，运行时在内存里迁移。
- 读到比自己新的 schema：**拒绝加载并报错**（绝不猜测语义）。
- 这次 v1 → v2 **没有改字段**，改的是校验契约：必填项、`id` 必须等于目录名、
  未知字段要提示、默认值在这里补齐。新导入的曲包由 `tools/pipeline.py` 直接写成 `schema: 2`。

## 为什么 `id` 必须是目录名

改名那件事踩过：`id` 和目录名一旦能不一致，删除/改名/缩略图会指向不同的目录，
而且没有人能从磁盘上判断哪个才是真的。现在直接当 error 拦下来。

## 为什么 `assets.f0` 缺了只是 warn 不是 error

没有 `f0` 的包**能播**（有伴奏、有歌词、有编舞），只是跟唱判定、和声、待机哼歌全哑。
把它当 error 会把一个「半成品但能看」的包直接挡在门外；当 warn 则会在启动日志里
明明白白写一句，够定位了。
