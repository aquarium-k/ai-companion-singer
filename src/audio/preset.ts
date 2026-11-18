/**
 * 和声参数的「预设表」——用户调好的一整套，随时可以回退。
 *
 * 为什么要有这个：这些参数是听感调出来的（2026-11-15 用户自己在参数台里调了十几轮），
 * 散落在代码常量里改起来麻烦、回退更难。现在集中成一张表：
 *
 *   - 默认用 `user-2026-11-15`（用户认可的那套，`attg` 压到 0.16）；
 *   - 想回退到上一版默认：URL 加 `?preset=default`；
 *   - 想试参数不用改代码：`?vib=8&vibhz=5&attg=0.4&verb=0.6&preset=user-2026-11-15`。
 *
 * `level` 只在参数台里有意义（试听音量），程序里由混音滑杆控制，不从这里读。
 */
export type HarmonyPreset = {
  vibHz: number
  vibCents: number
  vibDelay: number
  glideCents: number
  glideMs: number
  /** 上滑只对「音程 ≥ 这个半音数」的音生效 */
  glideMin: number
  /** 元音凹陷底部：1 = 不凹 */
  vowelDip: number
  /** 两个音之间隔多久算新乐句（秒） */
  phraseGap: number
  /** 循环混合宽度（半音） */
  sigma: number
  verb: number
  drive: number
  comp: number
  dbl: number
  attGain: number
}

export const PRESETS: Record<string, HarmonyPreset> = {
  /**
   * 2026-11-17：用户听下来「混响少一点更好听」（`?verb=0.2`），单独听和声时
   * 也确实更自然。只改混响，其它保持 11-15 那套。
   */
  'user-2026-11-17': {
    vibHz: 3,
    vibCents: 5,
    vibDelay: 0.22,
    glideCents: 30,
    glideMs: 45,
    glideMin: 1,
    vowelDip: 1,
    phraseGap: 0.35,
    /**
     * 家族混合宽度（半音）。2026-11-17 夜从 1.2 收到 **0.6**。
     *
     * 旧库的六族是**六段不同录音**，混起来是「厚」；现在每档都是 SVC 直出
     * （同一副嗓子、不同目标音高），混两族等于同一个人的两份**共振峰不同**的副本
     * 叠着唱——谐波互相错开。实测 554 Hz 时被拉高 +2.4 半音的 516.9 Hz 那一族
     * 占 31%，它的第 5 次谐波（3.18 kHz）和主副本（2.77 kHz）差了 400 Hz，
     * 听感就是那个音高「沙/空」。收到 0.6 后它只占 ~2%。
     * `?sigma=1.2` 可以回旧的宽度做 A/B。
     */
    sigma: 0.6,
    verb: 0.22,
    drive: 0.5,
    comp: 1.5,
    dbl: 0.35,
    attGain: 0.16,
  },
  /** 2026-11-15 用户调完并认可的版本 */
  'user-2026-11-15': {
    vibHz: 3,
    vibCents: 5,
    vibDelay: 0.22,
    glideCents: 30,
    glideMs: 45,
    glideMin: 1,
    vowelDip: 1,
    phraseGap: 0.35,
    sigma: 1.2,
    verb: 0.43,
    drive: 0.5,
    comp: 1.5,
    dbl: 0.35,
    attGain: 0.16,
  },
  /** 上一版默认（2026-11-15 之前）：颤音 4.4 Hz / 12 音分、混响 12%、饱和 0.12、压缩 3:1 */
  default: {
    vibHz: 4.4,
    vibCents: 12,
    vibDelay: 0.26,
    glideCents: 30,
    glideMs: 45,
    glideMin: 1,
    vowelDip: 1,
    phraseGap: 0.35,
    sigma: 2.0,
    verb: 0.12,
    drive: 0.12,
    comp: 3,
    dbl: 0.35,
    attGain: 0.7,
  },
}

export const DEFAULT_PRESET = 'user-2026-11-17'
