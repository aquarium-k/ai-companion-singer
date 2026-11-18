# 维护方案（提案）

> 2026-11-18。目标：**以后加东西、修东西都有固定路径**，不靠“记得上次怎么弄的”。
> 分四块：数据流水线、和声/音色、动作、代码与新功能。末尾是每次改完的回归清单。

## 一、总原则

1. **离线重活、运行时只回放**。造数据（分离 / 对齐 / 音高 / 和声采样 / 编舞）都在 `tools/` 里离线做，产物进 `public/` 或曲包；渲染层不做重计算。
2. **一份逻辑，两处使用**。能共用的校验/规则就做成模块让两边 import：`src/songpack/schema.ts`（运行时 + `tools/validate_packs.mjs`）。
3. **每个“自动做出来的东西”都要有量化判据 + 一条命令**。没有判据的手工判断会随记忆丢失（和声那几轮就是这么走的）。
4. **不靠截图判断方向**。相机在 +Z、走路朝 +Z 这类事都从测量推（这条已经救过好几次）。
5. **调试钩子走 `__pet.*`**，不塞进 UI。现有：`harmony()` / `harmonyProbe()` / `harmonyTone()` / `hset()` / `captureHarmony()` / `attTest()` / `mic()` / `latency()` / `clips()` / `poseTest()`。

## 二、数据流水线（造曲包）

`tools/pipeline.py` 是一条**幂等**的阶段链，状态记在 `<pack>/job.json`（每阶段 `state`），断了能续。

```
separate → f0 → lyrics/align → units(口型) → choreo → pack(写 pack.json) → cover(可选)
```

**加一个新阶段**（例如“情绪分析”“可视化”）共四步：

1. `pipeline.py` 里加 `def stage_xxx(ctx)`，返回 `(ok, 说明, 秒)`；
2. 注册 `Stage("xxx", "一句话说明", ["产物文件名"], stage_xxx)`，插在依赖它的人之前；
3. 产物写进 `<pack>/` 或 `<pack>/work/`，并在 `pack.json` 的 `assets` 里登记（新键要同时加到
   `src/songpack/schema.ts` 的 `ASSET_KEYS` 和 `docs/pack-schema.md`）；
4. `node tools/validate_packs.mjs` 通过（新键要有对应的 warn/error 规则）。

**改已有阶段**：先跑 `--only` 单阶段跑一遍看 job.json 的 `stages`，确认旧产物会被覆盖/跳过。

## 三、和声 / 音色（最容易出错的一块）

现在的库是「SVC 直出 → 落库 → ×3 拉长 → 包络展平」，四步各有工具。**按顺序跑**：

```powershell
# 1) 生成（每条 100 s 左右，24 档约 40 分钟）
python tools\rebake_loops.py --all --out .tmp\rebake-full --keep-raw
# 2) 验收（音高 / 相位 / 电平 / 元音一致性）
python tools\qa_loops.py .tmp\rebake-full
# 3) 落库（谐波梳锁音高 + 整周期裁剪 + 电平对齐 + 改 loops.json）
python tools\apply_loops.py --from .tmp\rebake-full -dry   # 先干跑
python tools\apply_loops.py --from .tmp\rebake-full
# 4) ×3 拉长 → 展平慢起伏（顺序不能反：先拉长再展平，1 Hz 的晃才会被算进趋势）
python tools\stretch_loops.py --factor 3 --apply
python tools\flatten_loops.py
# 5) 构建 + 实跑核对
node scripts\ensure-dist.mjs --force
node .tmp\loops_smoke2.mjs        # 48 段、端到端音高偏差
```

**判据（缺一不可）**：音高（谐波梳）≤1 音分；相位相关 ≥0.94；静音断口 0%；接缝 ≤0.5×99.9 分位；
电平对齐到被替换那一档（±1 dB）；`loops.json` 的 `rootHz` = 实测值。

**排查树**（用户说“和声不对”时按顺序问）：

| 现象 | 先量什么 | 命令 / 钩子 |
|---|---|---|
| 音不准 / 跑调 | 端到端音高偏差 | `loops_smoke2.mjs`（`harmonyProbe()`） |
| “毛/沙” | 相邻周期相关、1–6 Hz 包络抖动 | `captureHarmony()` + `.tmp/cap_analyze2.py` / `am_depth.py` |
| 某个音高特别怪 | 该音高在响几档、各占多少 | `hset()` 前后读 `status().loops` / `roots` |
| 咬字处“咔” | 咬字后的瞬态 | `attTest()` + `.tmp/art_analyze.py` |
| 长音“晃” | 慢速幅度起伏（拉长后 ~1 Hz） | `flatten_loops.py --dry` 看 AM 前后 |

**已知未解**：合成样本在个别音高仍会被听出“不稳”，而我们现有的指标（幅度/谐波/相位）**看不到它**。
下次再遇到：先让用户给**时间和音高**（这次给了 G#4 / 10 s 的 C#5，才定位到反复回到的两档），
再决定换什么指标——不要拿“数变好了”当修好。

## 四、动作

| 要加的东西 | 路径 |
|---|---|
| **一个姿势**（作者手摆） | 姿势编辑器导出 JSON → `src/actions/poses/` → 注册到姿势库（P7） |
| **一段关键帧剪辑** | `src/actions/clips/`（P8 格式，`duration` + 每骨骼关键帧） |
| **BVH 动作** | `node tools/bvh_to_clip.mjs` → `src/actions/gen/`；注意 `--owns-exclude head,neck` 与 `--trim 1` 这两个坑 |
| **右键菜单入口** | `electron/main.cjs` 的 `menuActionItems()` + `src/main.ts` 的 `handleCommand` |
| **验证** | `node .tmp/audit_actions.mjs`（穿模/交叉）；脚部问题看 `src/rig/footLock.ts` 的双脚支撑门 |

规则：**单腿支撑的动作不要依赖“锚点碾转”**（`dance.spin` 就是这么坏的），双脚着地才累加枢轴角。

## 五、代码 / 新功能

- **分层**：base（站姿/走路/转圈）/ upper（手臂手势）/ face（表情）/ additive（呼吸）。新动作先想清楚占哪一层，别整段覆盖 base。
- **设置持久化**：新字段加到 `src/state/settings.ts` 的默认值里，旧存档缺字段自动补默认（现有写法就是这样，不用迁移函数）。
- **音色/参数预设**：`src/audio/preset.ts` 加一个具名预设，旧的保持可回退（`?preset=`）。
- **本地资源读取**：一律走 `read-asset` / `read-file`（`file://` 页面 fetch 不到本地文件）；新增目录要先想清楚打包后在 asar 还是 userData（见 `docs/release.md` 二）。
- **新调试钩子**：`__pet.xxx()` 一个函数返回一个对象，字段命名和 HUD 一致。

## 六、每次改完的回归清单（5 分钟）

```powershell
npx tsc --noEmit                       # 类型
node scripts\validate_packs.mjs        # 曲包格式（0 error）
node scripts\ensure-dist.mjs --force   # 构建
node .tmp\loops_smoke2.mjs             # 48 段 + 音高偏差 + 夹带的 harmony 日志
node .tmp\audit_actions.mjs            # 动作穿模（改过动作时）
npx electron-builder --dir             # 改过主进程/打包配置时
```

只看两件事：**exit code 0**、**关键数字没有退化**（音高偏差、46/48 段、0 error）。数字存进 `docs/history.md`，
下次对比着看。
