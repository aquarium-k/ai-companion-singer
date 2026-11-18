import { fetchAssetBytes, fetchAssetJson } from './assets'
/**
 * 和声跟唱。
 *
 * 做什么：拿你**实测**的音高，实时算一个高音（三度 / 五度 / 八度），用合成的声音跟着哼。
 *
 * 音色来自 C2 的半成品
 * --------------------
 * 不自己搓电子琴音色，而是把 `tools/sing_synth.py`（C2 第一步的源-滤波器
 * 共振峰合成）那套谐波权重搬过来：
 *
 *   amplitude(k) = formantEnvelope(k × f0) × (1/k)^0.8
 *
 * `formantEnvelope` 是三个共振峰（F1/F2/F3）在对数频率上的高斯叠加
 * （增益 1.0/0.55/0.30，半宽 0.22/0.26/0.30 个八度，再加一层 0.35 宽裙边），
 * 这就是 C2 里被验证过「音准对、元音对」的那个包络。
 *
 * 实时化借的是 `createPeriodicWave`：一个振荡器的谐波幅度表就是它，所以
 * 一个 OscillatorNode 就能出这套谐波，不用开 48 个振荡器。f0 变了要重算表
 * （因为共振峰位置固定在 Hz 上，不跟着 f0 走），但只在音高变化超过一个半音时
 * 才算一次。
 *
 * 为什么用实测音高而不是谱面音高
 * ------------------------------
 * 和声要跟你唱。踩在谱面上，你一跑调就变成二重奏打架；跟着你的实测音高走，
 * 才是合唱。
 *
 * 音程
 * ----
 * 三度按这首歌的调性取「高一个音级」（音阶外的音退回 +4 半音），
 * 五度 +7、八度 +12 是固定音程。调性从参考音高轨用 Krumhansl 模板估。
 *
 * 延迟与反馈
 * ----------
 * 你的音高要过 32 ms 窗 + 150 ms 中位平滑，所以和声比你晚 ~100 ms。
 * 回流靠 AEC 顶（已实测有效），另外 YIN 是「围着谱面 ±2 半音」的受限搜索，
 * 和声通常高 3~12 个半音，不会被它当成人声。
 */

import type { F0Track } from '../songpack/f0'

export type HarmonyMode = 'off' | 'third' | 'thirdDown' | 'fifth' | 'octave'

/**
 * 相邻循环采样之间隔几个半音 → 混合权重的高斯宽度（半音）。
 *
 * 现在的库是 258/324/384/419/516/575 Hz（音高稳 + 音量平 + 元音不滑 + 谱线对齐），
 * 间隔 1.5–5.7 个半音。sigma = 2.0：最近的段单次变调不超过 ±2.9 个半音。
 * 旧的库只有 220/419 两段（**隔 12 个半音**），中点上两段各被拉开 6 个半音，
 * 共振峰错位近一倍、颤音率差一倍——同一音高听起来就是两个人在唱。
 */
const LOOP_SIGMA_DEFAULT = 0.6

/**
 * 一个 mora 的起音类型。
 *
 * `consonant` = 有闭塞的辅音（ら行）：必须**替换**掉循环才有位置放那 6–40 ms 的静音。
 * `vowel` = 纯元音起振（あ行等）：静音只会变成顿挫，用一个软起伏 + 上滑就够。
 */
export type ArticulationKind = 'vowel' | 'consonant' | 'aspirate'

/** 一次咬字实际用了什么参数（`status().lastAtt`，验证「按音符时长收放」） */
export type LastArticulation = {
  kind: ArticulationKind
  /** 调用方给的这个音还剩多少秒（0 = 没拿到音符表） */
  noteSec: number
  /** 循环让位的长度（毫秒） */
  holdMs: number
  /** 元音凹陷的时长（毫秒）与底部电平（0–1） */
  spanMs?: number
  bottom?: number
  /** 気声长度（毫秒） */
  durMs?: number
  /** 实际用的片段（探针用）：时长、补的静音、片段根音、播放速率 */
  sampleSec?: number
  leadMs?: number
  sampleRootHz?: number
  rate?: number
}

/** 一段起音片段（可以载入多段，按种类 + 音高挑最近的那段） */
type AttackSample = {
  buf: AudioBuffer
  rootHz: number
  /** 元音在片段里的起点：调用方要提前这么多秒触发（辅音先到） */
  leadSec: number
  kind: ArticulationKind
  /**
   * 片段自身的 RMS（后 50%）。
   *
   * 响度归一要用 `loopRms / rms`，但两段素材是**并行**载入的（谁先到不确定），
   * 所以只记原始值、到 splice 时再算——不能在载入时就除，会算到 0 上。
   */
  rms: number
  /**
   * 片段整体电平（1 = 原样）。は 的 [h] 是 −8 dB 的真气声，
   * 放进和声里仍然偏「嘶」，所以再乘 0.55 压一档。
   */
  levelScale: number
}

/**
 * 量一段循环采样**实际**的基频（Hz）。
 *
 * 为什么不能只信 json 里的 `rootHz`：两段循环是按播放速率变调的，
 * 速率 = 目标 / 根音。根音只要差 0.2%（≈4 音分），两段混在一起就会**慢拍**
 * （每秒一两次的强弱起伏）——听感正是「同一音高有两个声音」。
 * 用户 2026-11-14 反馈的就是这个：混合本身是好音色，错的是两段的音高没对齐。
 *
 * 用自相关 + 抛物线插值，取中间 0.1 秒，和人耳对「同度」的判断一致。
 */
function measureRootHz(buf: AudioBuffer): number {
  const sr = buf.sampleRate
  const data = buf.getChannelData(0)
  const win = Math.min(data.length, Math.floor(sr * 0.1))
  const start = Math.max(0, Math.floor((data.length - win) / 2))
  let mean = 0
  for (let i = 0; i < win; i++) mean += data[start + i]
  mean /= win

  const minLag = Math.max(2, Math.floor(sr / 1200))
  const maxLag = Math.min(Math.floor(sr / 60), win >> 1)
  const acf = new Float32Array(maxLag + 1)
  let best = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < win; i++) {
      sum += (data[start + i] - mean) * (data[start + i + lag] - mean)
    }
    acf[lag] = sum / (win - lag)
    if (acf[lag] > best) best = acf[lag]
  }
  if (best <= 0) return 0
  const threshold = best * 0.85
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (acf[lag] < threshold) continue
    if (acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
      const a = acf[lag - 1]
      const b = acf[lag]
      const c = acf[lag + 1]
      const denom = a - 2 * b + c
      const shift = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0
      return sr / (lag + shift)
    }
  }
  return 0
}

/** 取一段 AudioBuffer 后 50% 的 RMS（前 50% 常常是闭塞/起振，会把 RMS 拉低） */
function bufferRms(buf: AudioBuffer): number {
  const data = buf.getChannelData(0)
  const from = Math.floor(data.length * 0.5)
  let sum = 0
  for (let i = from; i < data.length; i++) sum += data[i] * data[i]
  const n = Math.max(1, data.length - from)
  return Math.sqrt(sum / n)
}

/**
 * 按 `A` 循环的模式。
 *
 * 试听结论（用户 2026-11-12）：「总的来说还是三度最好，五度容易把我也带得唱偏了，
 * 八度又太高，低三度有的怪了。」——所以循环里只留**关 ↔ 三度**，
 * 其余三种仍然实现着，用 `?harmony=thirdDown|fifth|octave` 直接进，方便以后对比。
 */
export const HARMONY_MODES: HarmonyMode[] = ['off', 'third']

/** 可用的全部模式（含不常用的三种，给 ?harmony= 用） */
export const HARMONY_ALL: HarmonyMode[] = ['off', 'third', 'thirdDown', 'fifth', 'octave']

export const HARMONY_LABEL: Record<HarmonyMode, string> = {
  off: '关',
  third: '三度',
  thirdDown: '低三度',
  fifth: '五度',
  octave: '八度',
}

export function isHarmonyMode(value: string): value is HarmonyMode {
  return (HARMONY_ALL as string[]).includes(value)
}

/** 唱和声时用哪个元音。`o` 最「融」，不会跟你的 a/i 抢频段 */
const HARMONY_VOWEL: keyof typeof FORMANTS = 'o'

/** C2 (`tools/sing_synth.py`) 的共振峰表：F1 F2 F3（Hz） */
const FORMANTS = {
  a: [800, 1200, 2600],
  i: [320, 2300, 3000],
  u: [380, 1300, 2500],
  e: [520, 1900, 2600],
  o: [520, 900, 2400],
} as const

const FORMANT_GAIN = [1.0, 0.55, 0.3]
const FORMANT_BW = [0.22, 0.26, 0.3]
/** 宽裙边：只有三个窄峰会太「哨」，真人声的共振峰之间也有能量 */
const SKIRT_GAIN = [0.5, 0.4, 0.35]
const SKIRT_BW = 0.9

/**
 * 颤音深度（音分）与频率（Hz）。
 *
 * 真人 5~7 Hz、30~100 音分，但**采样循环里本来就带着唱者的颤音**
 * （离线量：261 Hz 那段窗内摆 ±30 音分、555 Hz 那段 ±48 音分），
 * 我们再叠 22 音分 / 5.2 Hz 就是「两个颤音」——用户 2026-11-14：
 * 「颤音部分你可能频率调的略高和幅度略大了」。所以默认降到 12 音分 / 4.4 Hz，
 * 只当一层轻微的「活气」，不跟采样里的颤音抢。
 */
const VIBRATO_CENTS = 12
const VIBRATO_HZ = 4.4

/**
 * 和声的音域闸（用户 2026-11-13）：最高到小字二组 A（A5 = 880 Hz），
 * 最低到小字 A（A3 = 220 Hz）。超出这个范围就不像人声了。
 */
/**
 * 下限从 220 收到 196（G3）。
 *
 * 用户 2026-11-14：「33–35s，问题出在低于 2 的音上，能听到混着两种声音」。
 * 原因就是 220 这条线：低音区三度常常落在 200 Hz 出头，被 `while (hz < MIN_HZ) hz *= 2`
 * 直接翻上八度——听感上是「低音的人声 + 高八度的和声」两个声音叠着。
 * 用户给的下限本来就是「小字 A 或者 G」，取 G3。
 */
const MIN_HZ = 196
const MAX_HZ = 880

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
const MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export type KeyGuess = {
  tonic: number
  minor: boolean
  score: number
  name: string
}

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)
const midiToHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12)

/** 谐波幅度：三个共振峰的高斯叠加 + 宽裙边（逐字对拍 `sing_synth.py`） */
export function formantEnvelope(hz: number, vowel: keyof typeof FORMANTS = HARMONY_VOWEL): number {
  const lf = Math.log2(Math.max(hz, 1))
  const centres = FORMANTS[vowel]
  let out = 0.03
  for (let i = 0; i < 3; i++) {
    const off = lf - Math.log2(centres[i])
    out += FORMANT_GAIN[i] * Math.exp(-(off * off) / (2 * FORMANT_BW[i] ** 2))
  }
  for (let i = 0; i < 3; i++) {
    const off = lf - Math.log2(centres[i])
    out += SKIRT_GAIN[i] * 0.35 * Math.exp(-(off * off) / (2 * SKIRT_BW ** 2))
  }
  return out
}

export function estimateKey(track: F0Track | null): KeyGuess | null {
  if (!track) return null
  const hist = new Array<number>(12).fill(0)
  let voiced = 0
  for (let i = 0; i < track.f0.length; i += 2) {
    const hz = track.f0[i]
    if (!(hz > 0)) continue
    const midi = hzToMidi(hz)
    if (midi < 30 || midi > 96) continue
    const pc = ((Math.round(midi) % 12) + 12) % 12
    hist[pc] += 1
    voiced++
  }
  if (voiced < 200) return null

  const norm = (arr: number[]): number[] => {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length) || 1
    return arr.map((v) => (v - mean) / sd)
  }
  const h = norm(hist)

  let best: KeyGuess | null = null
  let bestSum = -Infinity
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE
      let sum = 0
      for (let k = 0; k < 12; k++) sum += h[(tonic + k) % 12] * profile[k]
      // 注意比的是**同一个量**：以前这里拿「原始 sum」和「sum/12」比，
      // 后面每一个候选都能过，结果永远是最后一个（B 小调）——
      // demo 实际最高的是 D 大调（0.93 vs 0.73）。虽然 D 大调和 B 小调是
      // 关系大小调、音阶相同（三度换算不受影响），但标签是错的。
      if (sum > bestSum) {
        bestSum = sum
        best = { tonic, minor, score: sum / 12, name: `${NOTE_NAMES[tonic]} ${minor ? '小调' : '大调'}` }
      }
    }
  }
  return best
}

/** 按调性取「高一个音级」的三度；音阶外的音退回 +4 半音（大三度） */
export function diatonicThird(midi: number, key: KeyGuess | null): number {
  const m = Math.round(midi)
  if (!key) return m + 4
  const scale = key.minor ? MINOR_SCALE : MAJOR_SCALE
  const rel = (((m - key.tonic) % 12) + 12) % 12
  const degree = scale.indexOf(rel)
  if (degree < 0) return m + 4
  const nextDegree = degree + 2
  const octave = Math.floor(nextDegree / 7) * 12
  return m + (scale[nextDegree % 7] + octave - rel)
}

/**
 * 「低一个音级」的三度（往下数两级）。
 *
 * 和上面的三度对称：主音的下三度要跨到**低八度**的第六级，
 * 所以 `octave` 用 floor 而不是 ceil——用 ceil 会变成「往上大六度」。
 */
export function diatonicThirdBelow(midi: number, key: KeyGuess | null): number {
  const m = Math.round(midi)
  if (!key) return m - 4
  const scale = key.minor ? MINOR_SCALE : MAJOR_SCALE
  const rel = (((m - key.tonic) % 12) + 12) % 12
  const degree = scale.indexOf(rel)
  if (degree < 0) return m - 4
  const prev = degree - 2
  const octave = Math.floor(prev / 7) * 12
  const index = ((prev % 7) + 7) % 7
  return m + (scale[index] + octave - rel)
}

/**
 * 一段音色 / 起音素材的来源。
 *
 * 为什么不是纯 URL 字符串：全局那套采样在 `dist/voices/*.wav`，走
 * `fetchAssetBytes`；**曲包自带**的采样在 `songpacks/<id>/voices/`，
 * 生产环境由主进程从 `public/songpacks` 读（不是 `dist`），必须走曲包加载器。
 * 所以这里让调用方直接给「怎么取字节」，序列化路径只拿来做日志和 sidecar 推导。
 */
export type VoiceAsset =
  | string
  | {
      /** 日志/去重用，如 `songpacks/demo/voices/loop_258.wav` */
      key: string
      open: () => Promise<ArrayBuffer>
      /** 读同名 sidecar（`.json`）：rootHz / leadSec / kind / levelScale */
      openJson?: () => Promise<unknown>
    }

type ResolvedVoice = {
  key: string
  open: () => Promise<ArrayBuffer>
  openJson: () => Promise<unknown>
}

function resolveVoice(asset: VoiceAsset): ResolvedVoice {
  if (typeof asset === 'string') {
    return {
      key: asset,
      open: () => fetchAssetBytes(asset),
      openJson: () => fetchAssetJson<unknown>(asset.replace(/\.wav$/i, '.json')),
    }
  }
  return {
    key: asset.key,
    open: asset.open,
    openJson: asset.openJson ?? (() => fetchAssetJson<unknown>(asset.key.replace(/\.wav$/i, '.json'))),
  }
}

export class HarmonyVoice {
  private ctx: AudioContext
  private osc: OscillatorNode
  private env: GainNode
  /**
   * 起音片段走这条独立的包络，只跟音量、**不跟咬字的凹陷**。
   *
   * 凹陷是为了「让循环采样听起来在换字」：`env` 每咬一下先塌到 0.55 再起来。
   * 但片段本身（`attack → env`）也会被这个凹陷按下去——「ら」的闪音在片段第
   * 21 ms，正好落在凹陷最深的 28 ms 里，等于把辅音自己掐掉（−5 dB）。
   * 所以片段改走 `attackOut`：只有循环挨压，片段全音量出声。
   */
  private attackOut: GainNode
  private lfo: OscillatorNode
  private lfoGain: GainNode
  private analyser: AnalyserNode
  private probeBuf: Float32Array<ArrayBuffer>
  private mute: GainNode
  /** 采样音色（SVC 换声后的持续元音循环）；空 = 退回振荡器 */
  private samples: {
    src: AudioBufferSourceNode
    gain: GainNode
    rootHz: number
    familyRoot: number
    /** 这段循环是哪个元音（a/i/u/e/o）。2026-11-15 起多了一套「え」 */
    vowel: string
  }[] = []

  private mode: HarmonyMode = 'off'
  private keyGuess: KeyGuess | null = null
  private level = 0.16
  /** 上一次起音的时刻（秒）；这段时间内不再让 update 覆盖包络/音高 */
  private articulateUntil = 0
  /** 闭口（循环被开的那个洞）结束的时刻；这之前 update() 不许碰包络 */
  private holeUntil = 0
  /** 累计起音次数（量测用：应该跟 mora 速率一致） */
  private articulations = 0
  /** 真正播出去的「ら」起音次数（应该≈articulations） */
  private attacks = 0
  /**
   * 起音片段库（v2）：可以同时载入多段，按「种类 + 音高最近」挑。
   *
   * 为什么要多段：片段是**原速播放**改音高（playbackRate），一跳就是共振峰跟着走。
   * 低于 ~405 Hz 用对白那个 ら（305 Hz），高于它用唱的 ら（536 Hz），
   * 变调不超过 ±4.5 个半音。
   */
  private attackBank: AttackSample[] = []
  /** 「ら」的起音片段：每个 mora 播一次，只出声几十毫秒（status()/HUD 读它） */
  private attackBuf: AudioBuffer | null = null
  /** 合成気声用的白噪声缓冲（は行） */
  private noiseBuf: AudioBuffer | null = null
  /** 参考音高断了之后，最多还沿用上一帧音高多久（秒），见 update() */
  private holdUntil = 0
  /** 上一次咬字用的目标音高（Hz）：音高没变就不重新起振颤音、也不上滑 */
  private lastArticulatedHz = 0
  /** 循环采样的 RMS（起音片段要按它归一，否则辅音会比循环小 8 dB） */
  private loopRms = 0
  /** 上一次咬字实际用的参数（`status().lastAtt`，用来核对音长判定有没有生效） */
  private lastAtt: LastArticulation | null = null
  /** 两段循环怎么混：`mix`（默认，高斯加权）/ `low` / `high`（只留一段，A/B 用） */
  private loopMode: 'mix' | 'low' | 'high' = 'mix'
  /**
   * 当前要唱哪个元音（a/i/u/e/o），由歌词的 mora 逐字驱动。
   *
   * 为什么重要（2026-11-15）：库里原本只有「あ」的循环，所以嘴上是 い/う/え/お、
   * 声音永远是「あ」——她其实没法「唱字」。现在 `loop_e_*` 那一套是从白花里
   * 真唱的一段「え」切出来、再用 PSOLA 铺到全音域的（元音在共振峰上，
   * PSOLA 不改包络，所以挪到别的音高还是「え」）。
   */
  private vowelWant = 'a'
  private attackRoot = 232
  /**
   * 起音片段里「辅音 → 元音」的位置（秒）。
   *
   * 片段是整字截的（前面有 100 ms 辅音），所以它不能踩在 mora 边界上播，
   * 否则元音迟到 100 ms——快句子里一个字才 200 ms，等于整拍错位。
   * 由 `.tmp/cut_attack.py` 量出来写进 json：提前这么多调 `articulate()`，
   * 元音正好落在字上，辅音提前一点起来（真唱也是辅音先到）。
   */
  private attackLead = 0
  /**
   * 片段类型：`consonant`（有辅音，循环上开方波形的洞）/
   * `vowel`（纯元音起振，只做一个平滑的软起伏）。
   *
   * 元音起振不需要「洞」——没有辅音要腾位置，开口子只会变成每 200 ms 一次
   * 的顿挫（用户：「有些不连续感」）。但完全不动也不行：循环一直在响，
   * 起振会被掩蔽。所以元音版做一条 70 ms 的**余弦凹槽**（平滑，没有方角）。
   */
  private attackKind: ArticulationKind = 'consonant'
  /** 咬字总开关（`?att=off`） */
  private attackEnabled = true
  /** 哼歌模式：唱同音，不叠音程（待机哼歌用） */
  private humming = false
  /** 咬字时循环保留下多少（0 = 完全让位，默认）。`?duck=0.3` 可以复现 v1 的掩蔽问题做 A/B */
  private duckLevel = 0
  /** 用户用 `?duck=` 指定过就不再按片段类型改默认值 */
  private duckTouched = false
  /**
   * 元音咬字的凹陷底部（1 = 不凹，默认）。`?dip=0.3` 放回旧版的软凹槽做 A/B。
   *
   * 2026-11-14 用户：「现在的あ为什么这么奇怪，あ本来该是一个平滑的音」——
   * 凹槽是每个 mora 挖一次，341 ms 的音上就是每秒 2.9 次 −10.5 dB 的小洞。
   */
  private vowelDip = 1
  /** 颤音：深度（音分）和起振延迟（秒），可以用 URL 参数临时 A/B */
  private vibCents = VIBRATO_CENTS
  private vibDelay = 0.26
  /** 循环混合宽度（半音），预设可改 */
  private loopSigma = LOOP_SIGMA_DEFAULT
  /** 上滑参数（预设可改） */
  private glideCents = 30
  private glideMs = 45
  private glideMin = 1
  /**
   * 换音时每个半音给多少秒的滑行时间（0 = 直接跳）。
   * 2026-11-17：用户说「换音生硬」，把它从一个固定 30 ms 改成按音程算。
   * `?porta=0.012` 可以调大（更「连」），`?porta=0` 回到硬切。
   */
  private portaSec = 0.008
  /** 上一次真正下发的音高（算音程用，和 `lastOutHz` 分开：后者会被别处覆盖） */
  private lastOutHzBefore = 0
  /** 颤音频率（Hz），预设可改 */
  private vibHz = VIBRATO_HZ
  /** 上一次喂进来的谱面音高（Hz） */
  private lastInHz = 0
  private lastOutHz = 0
  /** 当前 PeriodicWave 是按哪个 f0 算的；0 = 还没算 */
  private waveHz = 0
  /** 量测时钉死的频率（null = 正常跟麦） */
  private pinned: number | null = null
  /** 高音区是否已经切到「下方三度」（音域闸的迟滞状态，见 targetFor） */
  private highBelow = false
  /** targetFor 的上一次推演（探针用） */
  private lastTargetDebug: { refHz: number; outMidi: number; beforeGuard: number; over: number; highBelow: boolean; after: number } | null = null

  // ---- 后期链路（见构造函数里的说明）----
  private fxIn: GainNode
  private hpf: BiquadFilterNode
  private mudCut: BiquadFilterNode
  private deEss: BiquadFilterNode
  /** 亮度（高架）。`?tilt=` 调，默认 0 dB 不改现有音色 */
  private tilt: BiquadFilterNode
  private deAnalyser: AnalyserNode
  private deBuf: Uint8Array<ArrayBuffer>
  private deCutDb = -3
  private deNextAt = 0
  private shaper: WaveShaperNode
  private driveGain: GainNode
  private comp: DynamicsCompressorNode
  private dryOut: GainNode
  private wetOut: GainNode
  private preDelay: DelayNode
  private verb: ConvolverNode
  private out: GainNode
  private dblDelay: DelayNode
  private dblLfo: OscillatorNode
  private dblLfoGain: GainNode
  private dblPan: StereoPannerNode
  private dblGain: GainNode
  /**
   * 双声部副本的低通。
   *
   * 18 ms 的延迟副本和干声叠加，高频会在 1/(2×18 ms) ≈ 28 Hz 的梳状上反复抵消/加强——
   * 听感是「毛边/不干净」，这就是「doubler 加厚」的副作用。把副本的 6 kHz 以上削掉，
   * 加厚还在，但不再和干声在高频打架。`?dblLp=2500` 更狠一点做 A/B。
   */
  private dblLp: BiquadFilterNode
  /**
   * 「气声」层（`?breath=` 调，默认 0.05）。
   *
   * 用户 2026-11-17：单听和声「不够自然」。循环采样是**纯元音**——没有真人在长音上
   * 那层一直存在的呼吸噪声。补一层带通噪声（2–5 kHz），跟着同一个包络开关，
   * 听感上会从「电子风琴」变回「人在唱」。给多了就是「沙」，0.05 大约 −26 dB。
   */
  private breathSrc: AudioBufferSourceNode
  private breathBp: BiquadFilterNode
  private breathGain: GainNode
  private fxOn = true
  private driveAmount = 0.12
  private verbAmount = 0.12
  private compAmount = 3
  private dblAmount = 0.35
  /** 起音片段相对循环的电平（1 = 一样响。默认 0.7，见 splice 里的说明） */
  private attackGain = 0.7

  constructor(ctx: AudioContext, destination: AudioNode) {
    this.ctx = ctx

    /**
     * 后期链路（`?fx=off` 可整条旁路）。
     *
     * 按业界标准人声链的**后段**补的（借鉴 [Amped Studio 的 vocal chain 指南]
     * (https://ampedstudio.com/blog/vocal-chain/) 和 [Sonarworks 的插件顺序]
     * (https://www.sonarworks.com/blog/learn/how-to-chain-multiple-vocal-effects-plugins-effectively)：
     * 清理 EQ → 压缩 → 去齿音 → 塑形 EQ → 饱和 → 混响 → 限制器）：
     *
     *   高通 100 Hz（去掉 100 Hz 以下的隆隆声，否则压缩器会被它带跑）
     *   → 300 Hz 挖 −2 dB（去「闷」）
     *   → 4.5 kHz 挖 −3 dB（降齿音/沙）
     *   → 软饱和（tanh，给薄采样补谐波）
     *   → 压缩 3:1（把忽大忽小压平，和声才「贴」在歌里）
     *   → 干湿 + 短混响（0.7 s，12%）：循环采样是**完全干**的，
     *     放进和伴奏同一个空间里，这是「自然感」最大的一块
     *
     * 为什么要做：用户 2026-11-15「声音的质感还是存在问题」。
     * 前面几轮都在修采样本身（音高/音量/元音/谱线），但干声再干净，
     * 贴到一条有混响的伴奏上还是「像贴纸」——缺的是空间和动态。
     */
    this.fxIn = ctx.createGain()
    this.hpf = ctx.createBiquadFilter()
    this.hpf.type = 'highpass'
    this.hpf.frequency.value = 100
    this.hpf.Q.value = 0.7
    this.mudCut = ctx.createBiquadFilter()
    this.mudCut.type = 'peaking'
    this.mudCut.frequency.value = 300
    this.mudCut.Q.value = 1.0
    this.mudCut.gain.value = -2
    this.deEss = ctx.createBiquadFilter()
    this.deEss.type = 'peaking'
    this.deEss.frequency.value = 4500
    this.deEss.Q.value = 1.2
    this.deEss.gain.value = -3
    // 亮度：3 kHz 高架。默认 0 dB（等于不存在），`?tilt=2` 才动
    this.tilt = ctx.createBiquadFilter()
    this.tilt.type = 'highshelf'
    this.tilt.frequency.value = 3000
    this.tilt.gain.value = 0
    /**
     * 动态去齿音：固定挖 −3 dB 会把干净的段也挖暗；这里每 120 ms 量一次
     * 「4–8 kHz 相对 0.5–2 kHz」的能量差，沙的时候多挖（最多 −6 dB），
     * 干净的时候几乎不挖（−1 dB）。Web Audio 没有侧链压缩，所以用分析器 + 参数控制。
     */
    this.deAnalyser = ctx.createAnalyser()
    this.deAnalyser.fftSize = 1024
    this.deAnalyser.smoothingTimeConstant = 0.5
    this.deBuf = new Uint8Array(new ArrayBuffer(this.deAnalyser.frequencyBinCount))
    this.shaper = ctx.createWaveShaper()
    this.shaper.oversample = '2x'
    this.driveGain = ctx.createGain()
    this.driveGain.gain.value = 1
    this.comp = ctx.createDynamicsCompressor()
    this.comp.threshold.value = -18
    this.comp.knee.value = 12
    this.comp.ratio.value = 3
    this.comp.attack.value = 0.008
    this.comp.release.value = 0.14
    this.dryOut = ctx.createGain()
    this.wetOut = ctx.createGain()
    this.wetOut.gain.value = 0.12
    this.preDelay = ctx.createDelay(0.1)
    this.preDelay.delayTime.value = 0.018
    this.verb = ctx.createConvolver()
    this.verb.normalize = true
    this.verb.buffer = this.buildImpulse(0.7, 2.8)
    this.out = ctx.createGain()

    /**
     * 双声部（doubler）：业界给单薄人声「加厚」最常用的一招——
     * 一条 18 ms 延迟、慢速微调的副本，左右各偏一点，听起来像**同一个人唱了两遍**。
     * 不是合唱（chorus）那种明显抖动：LFO 只有 0.32 Hz / ±2.2 ms，慢到听不出调制，
     * 只留下两只耳朵的轻微差异。
     */
    this.dblDelay = ctx.createDelay(0.1)
    this.dblDelay.delayTime.value = 0.018
    this.dblLfo = ctx.createOscillator()
    this.dblLfo.frequency.value = 0.32
    this.dblLfoGain = ctx.createGain()
    /**
     * 双声部副本的延迟抖动深度（±秒）。
     *
     * 2026-11-17 夜量出来：0.0022（旧值）让包络的 1–6 Hz 起伏达到 **8.9 dB 峰峰**
     * （18 ms 延迟 = 55 Hz 间距的梳状滤波，抖动让梳齿扫过谐波 → 2–5 Hz 的“哇音”）。
     * 降到 0.0002 后是 **2–3 dB**（和不抖时一样，量测本底就有 2 dB），但保留了一点
     * 双声部的色差。`?dblLfo=0.0022` 可以回旧行为做 A/B。
     */
    this.dblLfoGain.gain.value = 0.0002
    this.dblLfo.connect(this.dblLfoGain)
    this.dblLfoGain.connect(this.dblDelay.delayTime)
    this.dblLfo.start()
    this.dblPan = ctx.createStereoPanner()
    this.dblPan.pan.value = 0.35
    this.dblGain = ctx.createGain()
    this.dblGain.gain.value = 0.35

    this.fxIn.connect(this.hpf)
    this.hpf.connect(this.mudCut)
    this.mudCut.connect(this.deAnalyser)
    this.deAnalyser.connect(this.deEss)
    this.deEss.connect(this.tilt)
    this.tilt.connect(this.shaper)
    this.shaper.connect(this.driveGain)
    this.driveGain.connect(this.comp)
    this.comp.connect(this.dryOut)
    this.comp.connect(this.preDelay)
    this.preDelay.connect(this.verb)
    this.verb.connect(this.wetOut)
    this.comp.connect(this.dblDelay)
    this.dblLp = ctx.createBiquadFilter()
    this.dblLp.type = 'lowpass'
    this.dblLp.frequency.value = 6000
    this.dblLp.Q.value = 0.7
    this.dblDelay.connect(this.dblLp)
    this.dblLp.connect(this.dblPan)
    this.dblPan.connect(this.dblGain)
    this.dblGain.connect(this.out)
    this.dryOut.connect(this.out)
    this.wetOut.connect(this.out)
    this.out.connect(destination)
    this.setDrive(0.12)
    this.setDoubler(0.35)

    this.env = ctx.createGain()
    this.env.gain.value = 0
    this.env.connect(this.fxIn)

    // 气声层：一段固定噪声 → 2.5 kHz 带通 → 小增益 → 同一个包络
    // （跟着包络走，所以只在她唱的时候有「呼吸」，不会一直嘶嘶响）
    this.breathSrc = ctx.createBufferSource()
    this.breathSrc.buffer = this.ensureNoise()
    this.breathSrc.loop = true
    this.breathBp = ctx.createBiquadFilter()
    this.breathBp.type = 'bandpass'
    this.breathBp.frequency.value = 2500
    this.breathBp.Q.value = 0.7
    this.breathGain = ctx.createGain()
    // 0.03（用户 2026-11-17 听下来 0.05 稍微大了），`?breath=` 可调
    this.breathGain.gain.value = 0.03
    this.breathSrc.connect(this.breathBp)
    this.breathBp.connect(this.breathGain)
    this.breathGain.connect(this.env)
    this.breathSrc.start()

    this.attackOut = ctx.createGain()
    this.attackOut.gain.value = 0
    this.attackOut.connect(this.fxIn)

    // 量测抽头：接在包络后面，再乘 0 接地（和 AudioEngine 里的 analyser 一个套路：
    // 不接到 destination 上的节点在某些实现里不会被拉取，拿不到波形）。
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.env.connect(this.analyser)
    this.mute = ctx.createGain()
    this.mute.gain.value = 0
    this.analyser.connect(this.mute)
    this.mute.connect(ctx.destination)
    this.probeBuf = new Float32Array(new ArrayBuffer(this.analyser.fftSize * 4))

    this.osc = ctx.createOscillator()
    this.osc.type = 'sine' // 真正决定音色的是 PeriodicWave
    this.osc.frequency.value = 220
    this.osc.connect(this.env)
    this.osc.start()

    // 轻微颤音：完全没有的话长音听着像风琴
    this.lfo = ctx.createOscillator()
    this.lfo.frequency.value = VIBRATO_HZ
    this.lfoGain = ctx.createGain()
    this.lfoGain.gain.value = 0
    this.lfo.connect(this.lfoGain)
    this.lfoGain.connect(this.osc.detune)
    this.lfo.start()
  }

  /** 合成一段短混响的冲激响应（指数衰减的噪声；0.7 s 够把「贴纸感」抹掉） */
  private buildImpulse(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate
    const n = Math.max(64, Math.floor(rate * seconds))
    const buf = this.ctx.createBuffer(2, n, rate)
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch)
      for (let i = 0; i < n; i++) {
        const t = i / n
        // 前 8 ms 淡入，避免混响自己变成一个咔哒
        const fade = Math.min(1, i / (rate * 0.008))
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * fade
      }
    }
    return buf
  }

  /**
   * 亮度：3 kHz 高架增益（dB）。
   *
   * 循环采样是从「她的翻唱」里截的持续元音，本身比原唱暗一截（SVC 的固有特性），
   * 接到和声链上又过了 4.5 kHz 的齿音挖除，听起来容易「糊在伴奏后面」。
   * 这个旋钮就是给这种时候用的：+2 dB 左右会明显「站出来」，别超过 +4（会变刺）。
   * 默认 0 dB（完全等价于没有这个滤波器），用 `?tilt=2` 试。
   */
  setTilt(db: number): void {
    this.tilt.gain.value = Math.max(-6, Math.min(6, db))
  }

  /** 软饱和量（0 = 旁路）。给薄采样补一点谐波，别过头变成失真 */
  setDrive(amount: number): void {
    this.driveAmount = Math.max(0, Math.min(0.6, amount))
    const k = 1 + this.driveAmount * 8
    if (this.driveAmount <= 0.001) {
      this.shaper.curve = null
      this.driveGain.gain.value = 1
      return
    }
    const n = 1024
    const curve = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1
      curve[i] = Math.tanh(k * x) / Math.tanh(k)
    }
    this.shaper.curve = curve
    // 饱和会把 RMS 抬高一点，补回来
    this.driveGain.gain.value = 1 / (1 + this.driveAmount * 0.5)
  }

  /** 混响湿量（0 = 全干）。干声是循环采样，空间感全靠这一档 */
  setReverb(amount: number): void {
    this.verbAmount = Math.max(0, Math.min(0.6, amount))
    const now = this.ctx.currentTime
    this.wetOut.gain.setTargetAtTime(this.verbAmount, now, 0.05)
    // 湿大了就把干降一点，听感响度别飙
    this.dryOut.gain.setTargetAtTime(1 - this.verbAmount * 0.35, now, 0.05)
  }

  /** 动态去齿音的判决（每 120 ms 一次，避免抽气感） */
  private adaptDeEss(now: number): void {
    if (!this.fxOn || now < this.deNextAt) return
    this.deNextAt = now + 0.12
    this.deAnalyser.getByteFrequencyData(this.deBuf)
    const binHz = this.ctx.sampleRate / this.deAnalyser.fftSize
    const band = (lo: number, hi: number): number => {
      const a = Math.max(1, Math.floor(lo / binHz))
      const b = Math.min(this.deBuf.length - 1, Math.ceil(hi / binHz))
      let s = 0
      for (let i = a; i <= b; i++) s += this.deBuf[i]
      return s / Math.max(1, b - a + 1)
    }
    // 字节频谱：0..255 映射到 minDecibels..maxDecibels，差值足够用
    const diff = band(4000, 8000) - band(500, 2000)
    const target = Math.max(-6, Math.min(-1, -1 - Math.max(0, diff - 8) * 0.18))
    if (Math.abs(target - this.deCutDb) > 0.3) {
      this.deCutDb = target
      this.deEss.gain.setTargetAtTime(target, now, 0.08)
    }
  }

  /** 混响尾巴长度（秒）。长音多的段落想要更长一点，`?rt=1.2` */
  setReverbTime(seconds: number): void {
    const sec = Math.max(0.25, Math.min(2.0, seconds))
    this.verb.buffer = this.buildImpulse(sec, 2.8)
    console.info(`[harmony] 混响尾巴 ${sec.toFixed(2)} s`)
  }

  /** 双声部量（0 = 关）。0.3–0.5 是「同一个人唱两遍」的区间，再大就成合唱了 */  setDoubler(amount: number): void {
    this.dblAmount = Math.max(0, Math.min(1, amount))
    const now = this.ctx.currentTime
    this.dblGain.gain.setTargetAtTime(this.dblAmount, now, 0.05)
    // 加了副本会变响，干声按比例让一点
    this.dryOut.gain.setTargetAtTime(1 - this.dblAmount * 0.2 - this.verbAmount * 0.35, now, 0.05)
  }

  /** 起音片段相对循环的电平（0.3–1.2）。默认 0.7 */
  setAttackGain(gain: number): void {
    this.attackGain = Math.max(0.05, Math.min(1.5, gain))
  }

  /** 压缩比（1 = 不压）。和声要贴在歌里，动态别比人声还大 */
  setComp(ratio: number): void {
    this.compAmount = Math.max(1, Math.min(6, ratio))
    this.comp.ratio.setTargetAtTime(this.compAmount, this.ctx.currentTime, 0.05)
    this.comp.threshold.value = this.compAmount <= 1.01 ? 0 : -18
  }

  /** 整条后期链的开/关（`?fx=off`）：关掉时所有节点改成直通参数 */
  setFx(on: boolean): void {
    this.fxOn = on
    const now = this.ctx.currentTime
    this.hpf.frequency.setTargetAtTime(on ? 100 : 5, now, 0.02)
    this.mudCut.gain.setTargetAtTime(on ? -2 : 0, now, 0.02)
    this.deEss.gain.setTargetAtTime(on ? -3 : 0, now, 0.02)
    this.setDrive(on ? this.driveAmount : 0)
    this.setComp(on ? this.compAmount : 1)
    this.setReverb(on ? this.verbAmount : 0)
    this.setDoubler(on ? this.dblAmount : 0)
    if (!on) this.deEss.gain.setTargetAtTime(0, now, 0.02)
    else this.deEss.gain.setTargetAtTime(this.deCutDb, now, 0.05)
  }

  setReference(track: F0Track | null): void {    this.keyGuess = estimateKey(track)
    if (this.keyGuess) {
      console.info(`[harmony] 调性估计 ${this.keyGuess.name}（相关 ${this.keyGuess.score.toFixed(2)}）`)
    }
  }

  /**
   * 换音色：载入几段「可循环的持续元音」，之后用播放速率改音高。
   *
   * 素材是 C2 那条「原唱 → seed-vc 换音色」路线的成品：
   * `tools/make_harmony_voice.py` 从 `shots/svc/out_real30_refvoice2.wav` 里
   * 抠出稳定长音（对齐到整数个周期、首尾交叉淡化）。
   *
   * **为什么要好几段**：采样器靠播放速率改音高，连带把共振峰和颤音率一起拉走——
   * 一个 260 Hz 的样本去唱 587 Hz 就是 +14 个半音的「花栗鼠」。
   * 所以按 2–5 个半音一段摆一个**采样库**（现在是六段 233–524 Hz），
   * 目标音高落在哪两段之间就按对数距离加权交叉淡化，单段最多变调 ±2.5 个半音。
   * 旧版只有 220 / 419 两段（隔 12 个半音），中间那段两段都错了半个八度，
   * 听感就是「同一个音高有两个声音」。
   *
   * 全部载入失败就继续用振荡器合成，不会哑。
   */
  async loadSamples(assets: VoiceAsset[]): Promise<number> {
    const loaded = await Promise.all(
      assets.map(async (asset) => {
        const voice = resolveVoice(asset)
        const url = voice.key
        try {
          // 走 fetchAssetBytes：Electron 的 file:// 页面里 fetch 读不到本地文件
          const buf = await this.ctx.decodeAudioData(await voice.open())
          let rootHz = 260
          // json 里的根音优先：那是烤制时用 **YIN 逐帧中位数**量的，误差 ≤3 音分。
          // 浏览器里的 `measureRootHz` 只有 0.1 s 窗、且被循环自带的颤音带偏
          // （实测 harmony.wav 量出 216.6，实际 219.6，差 −24 音分），只能当兜底。
          const measured = measureRootHz(buf)
          if (measured > 40 && measured < 1200) rootHz = measured
          let familyRoot = 0
          let vowel = 'a'
          try {
            const meta = (await voice.openJson()) as {
              rootHz?: number
              familyRootHz?: number
              vowel?: string
            } | null
            if (meta?.rootHz && meta.rootHz > 0) {
              if (measured > 0 && Math.abs(12 * Math.log2(meta.rootHz / measured)) > 0.5) {
                console.info(
                  `[harmony] ${url} 浏览器粗测 ${measured.toFixed(1)} Hz，用 json 的 ${meta.rootHz.toFixed(1)} Hz`,
                )
              }
              rootHz = meta.rootHz
            }
            // 「家族」：这一档是从哪段原始采样派生的（PSOLA 扩音域）。
            // 同一家族的两档是同一个人的同一条音高，**不能同时响**，所以运行时
            // 每家只让离目标最近的那一档发声。没写就是自己一家。
            if (meta?.familyRootHz && meta.familyRootHz > 0) familyRoot = meta.familyRootHz
            if (meta?.vowel) vowel = meta.vowel
          } catch {
            /* 没 meta 就用粗测值 */
          }
          return { buf, rootHz, familyRoot: familyRoot || rootHz, vowel, url }
        } catch (err) {
          console.warn(`[harmony] 音色 ${url} 载入失败`, err)
          return null
        }
      }),
    )

    for (const item of loaded) {
      if (!item) continue
      const src = this.ctx.createBufferSource()
      src.buffer = item.buf
      src.loop = true
      // 颤音必须也接到采样上：采样是靠 playbackRate 改音高的，振荡器那条
      // `lfoGain → osc.detune` 对它不起作用（以前就是漏了这一条，所以听不到颤音）
      this.lfoGain.connect(src.detune)
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      src.connect(gain)
      gain.connect(this.env)
      src.start()
      this.samples.push({
        src,
        gain,
        rootHz: item.rootHz,
        familyRoot: item.familyRoot,
        vowel: item.vowel,
      })
      // 循环的响度基准（起音片段归一用）：各段取平均。取 max 会让电平高的那段
      // 把基准抬起来，低音区的辅音就会比循环响——听起来像「鼓包」。
      const rms = bufferRms(item.buf)
      this.loopRms = this.loopRms > 0 ? (this.loopRms + rms) / 2 : rms
      console.info(
        `[harmony] 音色 ${item.buf.duration.toFixed(2)}s 循环（根音 ${item.rootHz.toFixed(0)} Hz，${item.url}）`,
      )
    }
    if (this.samples.length) this.osc.disconnect()
    return this.samples.length
  }

  /**
   * 换音色前清空：停掉并断开所有循环采样。
   *
   * 曲包切换时用。不清空的话新旧两套采样会**同时**挂在 `env` 上，
   * 按音高各自加权——同一个音高会变成两个人的声音（正是之前那个 bug 的形状）。
   */
  clearSamples(): void {
    for (const s of this.samples) {
      try {
        s.src.stop()
      } catch {
        /* 已经停过了 */
      }
      try {
        s.src.disconnect()
      } catch {
        /* 没连过 */
      }
      try {
        s.gain.disconnect()
      } catch {
        /* 没连过 */
      }
    }
    this.samples = []
    this.loopRms = 0
    // 退回振荡器兜底（loadSamples 载入成功后会再断开它）
    try {
      this.osc.disconnect()
    } catch {
      /* 没连过 */
    }
    this.osc.connect(this.env)
  }

  /** 清空起音片段库（换曲包时跟着换） */
  clearAttacks(): void {
    this.attackBank = []
    this.attackBuf = null
    this.attackRoot = 232
    this.attackLead = 0
    this.attackKind = 'consonant'
  }

  /** 库里有没有这个元音（没有就退回「あ」） */
  private hasVowel(v: string): boolean {
    return this.samples.some((s) => s.vowel === v)
  }

  /**
   * 换元音（由歌词的 mora 驱动）。同一元音重复调用是空操作。
   * 换的时候不重建音频，只让增益在 60 ms 内交叉淡化到新元音那一套。
   */
  setVowel(v: string | null | undefined): void {
    const next = v === 'i' || v === 'u' || v === 'e' || v === 'o' ? v : 'a'
    if (next === this.vowelWant) return
    this.vowelWant = next
    if (this.samples.length && this.lastOutHz > 0) this.setPitch(this.lastOutHz, 0.04)
  }

  /** 当前想让和声唱哪个元音（`status()` 和 A/B 用） */
  get vowel(): string {
    return this.hasVowel(this.vowelWant) ? this.vowelWant : 'a'
  }

  private setPitch(hz: number, tau: number): void {    const now = this.ctx.currentTime
    if (this.samples.length) {
      // 每个采样都按自己的根音算速率，所以发出来的**音高相同**，只是音色不同。
      //
      // 默认：按高斯权重**混合**多个「家族」（这是她音色「厚」的那一半，2026-11-14
      // 用户明确说砍掉之后音色变差了）。`?loop=low|high` 只留最低/最高一族做 A/B。
      //
      // **家族**：2026-11-15 起循环库同一段采样有好几档（PSOLA 扩音域，
      // 210–850 Hz，见 `tools/build_loop_library.py`）。同一家族的几档是
      // 「同一个人、同一条音高」，同时响就会拍频（正是用户反复报的
      // 「一个音高两个声音」），所以每家只让离目标最近的那一档出声，
      // 混合只发生在**不同家族**之间——和以前六个家族的做法完全一致。
      // **元音**：2026-11-15 起库里有「あ」和「え」两套（`loop_a_*` / `loop_e_*`），
      // 运行时会按歌词的 mora 逐字切换（`setVowel`）。没有的元音（i/u/o）先退回「あ」。
      // 切换靠增益淡化（60 ms），音频本体不重建——所有档位一直是转着的。
      const want = this.hasVowel(this.vowelWant) ? this.vowelWant : 'a'
      const pool = this.samples.filter((s) => s.vowel === want)
      const families = [...new Set(pool.map((s) => s.familyRoot))].sort((a, b) => a - b)
      const famDist = new Map<number, number>()
      // 2026-11-17 夜：**sigma 真正生效**（以前算了 d² 却没除 sigma²，等于写死 1 半音）。
      // 为什么要收窄：库里现在每档都是 SVC 直出（同一副嗓子、不同目标音高），
      // 混两个家族 = 同一个人的两个**共振峰不同的副本**叠在一起，谐波互相错开。
      // 实测 554 Hz 时 516.75 那一族（被拉高 +2.4 半音）还占 24%，它的第 5 次谐波
      // 和主副本差 ~200 Hz——听感就是那个音高「沙」。收窄到 0.8 半音后它只占 ~5%。
      // `?sigma=1.2` 可以回旧的宽度做 A/B。
      for (const f of families) {
        const d = 12 * Math.log2(hz / f)
        famDist.set(f, (d * d) / (this.loopSigma * this.loopSigma))
      }

      // 权重先减去最小值再取指数：目标音高远离所有家族时（白花最高 895 Hz，
      // 而最低家族才 258 Hz），直接 exp(-(d/sigma)²) 会下溢成 0，求和变成
      // 「比 1e-6 还小」→ 所有增益判成 0 → **高音区和声直接哑掉**。
      let famW: Map<number, number>
      if (this.loopMode === 'low' || this.loopMode === 'high') {
        const pick = this.loopMode === 'low' ? families[0] : families[families.length - 1]
        famW = new Map(families.map((f) => [f, f === pick ? 1 : 0]))
      } else {
        const minD = Math.min(...families.map((f) => famDist.get(f)!))
        famW = new Map(families.map((f) => [f, Math.exp(-(famDist.get(f)! - minD))]))
      }
      const sum = families.reduce((a, f) => a + (famW.get(f) ?? 0), 0) || 1

      // 每家挑最近的一档（只在目标元音的档位里挑）
      const chosen = new Map<number, number>()
      this.samples.forEach((s, i) => {
        if (s.vowel !== want) return
        const d = Math.abs(12 * Math.log2(hz / s.rootHz))
        const cur = chosen.get(s.familyRoot)
        if (cur === undefined || d < Math.abs(12 * Math.log2(hz / this.samples[cur].rootHz))) {
          chosen.set(s.familyRoot, i)
        }
      })

      this.samples.forEach((s, i) => {
        const on = s.vowel === want && chosen.get(s.familyRoot) === i
        s.src.playbackRate.setTargetAtTime(hz / s.rootHz, now, tau)
        const w = on ? (famW.get(s.familyRoot) ?? 0) / sum : 0
        s.gain.gain.setTargetAtTime(w, now, 0.06)
      })
      return
    }
    if (this.waveHz <= 0 || Math.abs(12 * Math.log2(hz / this.waveHz)) > 1) {
      this.waveHz = hz
      this.osc.setPeriodicWave(this.buildWave(hz))
    }
    this.osc.frequency.setTargetAtTime(hz, now, tau)
  }

  get key(): string {
    return this.keyGuess?.name ?? '未定（按大三度）'
  }

  get currentMode(): HarmonyMode {
    return this.mode
  }

  setMode(mode: HarmonyMode): void {
    this.mode = mode
    if (mode === 'off') this.gate(0.001)
  }

  cycle(): HarmonyMode {
    const i = HARMONY_MODES.indexOf(this.mode)
    this.setMode(HARMONY_MODES[(i + 1) % HARMONY_MODES.length])
    return this.mode
  }

  /** 颤音参数（?vib=22&vibdelay=0.26）：0 音分或 0 延迟都合法，用来 A/B */
  setVibrato(cents: number, delaySec: number): void {
    this.vibCents = Math.max(0, Math.min(120, cents))
    this.vibDelay = Math.max(0, Math.min(2, delaySec))
  }

  /** 颤音频率（`?vibhz=`；预设里 3 Hz） */
  setVibratoHz(hz: number): void {
    this.vibHz = Math.max(0.5, Math.min(9, hz))
    this.lfo.frequency.setTargetAtTime(this.vibHz, this.ctx.currentTime, 0.05)
  }

  /** 循环混合宽度（`?sigma=`；预设里 1.2 半音） */
  setLoopSigma(sigma: number): void {
    this.loopSigma = Math.max(0.3, Math.min(6, sigma))
  }

  /** 上滑：深度（音分）、时长（秒）、触发的最小音程（半音） */
  setGlide(cents: number, seconds: number, minSemis: number): void {
    this.glideCents = Math.max(0, Math.min(120, cents))
    this.glideMs = Math.max(0, Math.min(200, seconds * 1000))
    this.glideMin = Math.max(0, Math.min(6, minSemis))
  }

  /** 换音滑行：每半音多少秒（0 = 硬切，0.008 ≈ 默认） */
  setPortamento(secPerSemitone: number): void {
    this.portaSec = Math.max(0, Math.min(0.05, secPerSemitone))
  }

  /** 双声部副本的低通截止（Hz）。默认 6000，`?dblLp=2500` 更暗 */
  setDoublerLowpass(hz: number): void {
    this.dblLp.frequency.value = Math.max(800, Math.min(16000, hz))
  }

  /**
   * 双声部延迟的抖动深度（秒）。默认 0.0022（±2.2 ms，在 18 ms 延迟上是很深的
   * 慢速镶边）；`?dblLfo=0.0002` 几乎不抖、只留固定的合唱色差。
   *
   * 为什么要能关：18 ms 延迟 + 颤音会变成「梳状滤波被 3 Hz 扫过」，
   * 实测包络有 3 Hz、5 dB 的电平抖动（`?dbl=0` 时消失）——听感就是「不够干净」。
   */
  setDoublerLfo(depth: number): void {
    this.dblLfoGain.gain.value = Math.max(0, Math.min(0.02, depth))
  }

  /** 气声层电平（0 = 关，0.05 ≈ 默认，0.12 明显「有气」） */
  setBreath(amount: number): void {
    this.breathGain.gain.value = Math.max(0, Math.min(0.3, amount))
  }

  /** `?loop=low|high`：只播其中一段循环，用来判断「第二个声音」来自哪一段 */
  setLoopMode(mode: 'mix' | 'low' | 'high'): void {
    this.loopMode = mode
  }

  /** 咬字时循环保留下多少（0 = 完全让位）。`?duck=0.3` 可以复现 v1 的掩蔽做 A/B */
  setDuck(level: number): void {
    this.duckTouched = true
    this.duckLevel = Math.max(0, Math.min(1, level))
  }

  /** 元音咬字的凹陷底部（1 = 不凹，默认）。`?dip=0.3` 放回旧版凹槽做 A/B */
  setVowelDip(bottom: number): void {
    this.vowelDip = Math.max(0.02, Math.min(1, bottom))
  }

  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level))
  }

  /** 给你唱的某个音（Hz）算和声音高（Hz）。0 = 不出声 */
  targetFor(refHz: number): number {
    if (this.mode === 'off' && !this.humming) return 0
    if (!(refHz > 0)) return 0
    // 哼歌：唱同音，不做音程换算
    if (this.humming) return refHz > 40 && refHz < 2000 ? refHz : 0
    const midi = hzToMidi(refHz)
    let outMidi: number
    if (this.mode === 'octave') outMidi = Math.round(midi) + 12
    else if (this.mode === 'fifth') outMidi = Math.round(midi) + 7
    else if (this.mode === 'thirdDown') outMidi = diatonicThirdBelow(midi, this.keyGuess)
    else outMidi = diatonicThird(midi, this.keyGuess)
    let hz = midiToHz(outMidi)
    /**
     * 高音区的音域闸，要**带迟滞 + 先夹住**（2026-11-15 复核出来的）。
     *
     * 旧写法是「只要超过 MAX_HZ 就直接换成下方三度」。白花里 2% 的帧在 740 Hz 以上，
     * 而 740 Hz 的上方三度是 880.9 Hz——比 880 只超 **0.02 个半音**，却让和声
     * 从 831 Hz 一把掉到 622 Hz（**跳了 6 个半音**），听感就是高音区「和声忽然塌一下」。
     * 现在：
     *   - 超出不到 1 个半音 → **夹在 MAX_HZ**（几乎听不出差别）；
     *   - 真超了才换下方三度，并且**迟滞 1 个半音**：下来之后要回到 MAX−1 以下才切回上方，
     *     避免旋律在阈值附近抖动时和声来回跳（那比跳一次更难听）。
     */
    const over = 12 * Math.log2(Math.max(hz, 1e-6) / MAX_HZ)
    /**
     * 高音区：**能夹住就夹住，真超了才落下去**（顺序很重要）。
     *
     * 2026-11-15 实测（`__pet.harmonyTarget` + `targetDebug`）：
     * 旋律 710 Hz（F5）→ 和声 830 Hz（+3），720 Hz（F#5）→ 上方三度是 A#5 = 932 Hz，
     * 比 880 只超 **1.0 个半音**，旧代码却直接换下方三度 → **622 Hz**（掉 6 个半音）。`n     * 夹住的容差取 **2 个半音**：932（A#5）夹成 880（A5），和 F#5 仍是小三度，`n     * 比掉下去变成 D#5 的自然得多。
     * 原因是我上一版先按 `over > 1` 把 `highBelow` 置位、再进闸——置位之后
     * 夹住那条分支就永远进不去了。现在先判断夹住，只有真落下去才置位。
     */
    if (hz > MAX_HZ) {
      if (!this.highBelow && over <= 3) {
        hz = MAX_HZ
      } else {
        this.highBelow = true
        hz = midiToHz(diatonicThirdBelow(midi, this.keyGuess))
        while (hz > MAX_HZ) hz /= 2
      }
    } else if (over < -0.5) {
      this.highBelow = false
    }
    // 太低：升八度（低音区的和声翻上去才像人）
    while (hz < MIN_HZ) hz *= 2
    this.lastTargetDebug = {
      refHz: +refHz.toFixed(2),
      outMidi: +outMidi.toFixed(3),
      beforeGuard: +midiToHz(outMidi).toFixed(2),
      over: +(12 * Math.log2(midiToHz(outMidi) / MAX_HZ)).toFixed(3),
      highBelow: this.highBelow,
      after: +hz.toFixed(2),
    }
    return hz > 40 && hz < 2000 ? hz : 0
  }

  /**
   * 按当前 f0 造一张谐波表（`createPeriodicWave`）。
   *
   * 谐波幅度 = 共振峰包络 × (1/k)^0.8，然后按能量归一——
   * 不归一的话不同音高响度会差一大截（共振峰扫过高次谐波时尤其明显）。
   */
  private buildWave(f0: number): PeriodicWave {
    const count = Math.max(8, Math.min(48, Math.floor(5200 / f0)))
    const real = new Float32Array(count + 1)
    const imag = new Float32Array(count + 1)
    let peak = 0
    for (let k = 1; k <= count; k++) {
      const a = formantEnvelope(k * f0) / Math.pow(k, 0.8)
      imag[k] = a
      if (a > peak) peak = a
    }
    // 基频垫底：C2 的共振峰包络在 f0 远低于 F1 时会把基频压掉 18 dB 以上
    // （110 Hz 的 `o` 元音，k=1 只有 k=5 的 1/8）。谐波间隔还在，纸面上能听出音高，
    // 但笔记本小喇叭上会听成高一个八度——用户 2026-11-12 报「音高不太对」。
    // 补到峰值的 45% 就不歧义了，音色基本不变（共振峰仍是主导）。
    const floor = peak * 0.45
    if (imag[1] < floor) imag[1] = floor

    let power = 0
    for (let k = 1; k <= count; k++) power += imag[k] * imag[k]
    const norm = power > 1e-9 ? 1 / Math.sqrt(power) : 0
    for (let k = 1; k <= count; k++) imag[k] *= norm
    return this.ctx.createPeriodicWave(real, imag, { disableNormalization: true })
  }

  /** 量测用：把和声钉在某个频率上（跳过麦克风和音程计算），持续发声 */
  tone(hz: number | null): void {
    this.pinned = hz && hz > 0 ? hz : null
    if (this.pinned) this.applyTone(this.pinned)
    else this.gate(0.001)
  }

  private applyTone(hz: number): void {
    this.lastOutHz = hz
    this.setPitch(hz, 0.01)
    this.gate(this.level)
  }

  private gate(level: number): void {
    const now = this.ctx.currentTime
    // 下降必须快：以前 0.25 s，从 0.16 掉到 0.0016 要 ~1.2 s——唱完一句换口气，
    // 和声还拖着一条尾巴（用户 2026-11-12：「原唱没在唱，和声却没停」）。
    const tau = level > this.env.gain.value ? 0.08 : 0.05
    this.env.gain.setTargetAtTime(level, now, tau)
    // 起音片段跟同一个「开/关」电平，但不跟 articulate() 的凹陷
    this.attackOut.gain.setTargetAtTime(level, now, tau)
    // 颤音不在这里管：它由 articulate() 起振、由 update() 在停唱时归零。
    // （以前这里每帧写一次，会把 articulate() 排的「延迟起振」冲掉。）
  }

  /**
   * 每帧调用，`refHz` 是**谱面**在这一刻的音高（`work/f0.json`），0 = 没人唱。
   *
   * 早期版本跟的是麦克风里你的实测音高，结果是：
   * ① 你的音高要过 32 ms 窗 + 150 ms 中位平滑，和声比你晚 100 ms——用户实测
   *    「延迟有些不能接受」；② 只在你唱的时候才有和声。
   * 改成跟谱面之后延迟只剩「一帧 + 30 ms 滑音」≈ 20 ms，而且不用麦克风，
   * 也没有回声风险。代价是它不跟你跑调——但和声本来就该在调上。
   */
  /**
   * 载入一段起音片段（可以调多次，组成片段库）。
   *
   * **切法很重要**（2026-11-13 量出来的）：
   * - `att_ra_mid`：对白「から」的 ら，从闭塞前 6 ms 起 90 ms。闭塞只有 ~6 ms，
   *   紧接 burst + 元音头。
   * - `att_ra_hi`：翻唱 64.97 s 那个**唱的** ら，90 ms，前 40 ms 是闭塞。
   * - 旧的 `harmony_att.wav`（124 ms）**切反了**：0–98 ms 是上一个字的元音，
   *   98 ms 才是闭塞——当头用等于先唱一个字再闭嘴，怎么调都不可能像 ら。
   */
  async loadAttack(asset: VoiceAsset): Promise<void> {
    const voice = resolveVoice(asset)
    const url = voice.key
    try {
      const buf = await this.ctx.decodeAudioData(await voice.open())
      let rootHz = 260
      let leadSec = 0
      let levelScale = 1
      let kind: ArticulationKind = 'vowel'
      try {
        const meta = (await voice.openJson()) as {
          rootHz?: number
          leadSec?: number
          kind?: 'vowel' | 'consonant' | 'aspirate'
          levelScale?: number
        } | null
        if (meta?.rootHz && meta.rootHz > 0) rootHz = meta.rootHz
        if (meta?.leadSec && meta.leadSec > 0) leadSec = Math.min(0.3, meta.leadSec)
        if (meta?.kind === 'vowel' || meta?.kind === 'consonant' || meta?.kind === 'aspirate') {
          kind = meta.kind
        }
        if (typeof meta?.levelScale === 'number' && meta.levelScale > 0) {
          levelScale = Math.min(2, meta.levelScale)
        }
      } catch {
        /* 没有 json：当成元音起振、根音 260 Hz */
      }
      this.attackBank.push({ buf, rootHz, leadSec, kind, rms: bufferRms(buf), levelScale })
      // 兼容旧字段：status() 和 HUD 还在读它们（取最近载入的那段）
      this.attackBuf = buf
      this.attackRoot = rootHz
      this.attackLead = leadSec
      this.attackKind = kind
      console.info(
        `[harmony] 起音「${url}」${buf.duration.toFixed(3)}s，根音 ${rootHz.toFixed(0)} Hz，` +
          `${kind}，提前 ${(leadSec * 1000).toFixed(0)} ms（库 ${this.attackBank.length} 段）`,
      )
    } catch (err) {
      console.warn('[harmony] 起音片段载入失败，退回「音量凹陷」模拟咬字', err)
    }
  }

  /** 起音片段要提前多少秒播（0 = 片段本身就是元音，踩边界播） */
  get leadSec(): number {
    return this.attackLead
  }

  /** `?att=off`：整段咬字关掉（只保留音高跟随；用户认为「音高变就够了」） */
  setAttackEnabled(on: boolean): void {
    this.attackEnabled = on
  }

  /**
   * 哼歌模式：唱**同音**（不叠三度），也不做咬字。
   * 待机时她哼的是「谱面上的那条旋律」，和伴奏里的自己错开就不好听了。
   */
  setHumming(on: boolean): void {
    this.humming = on
  }

  /**
   * 「咬字」：每个 mora 开头来一次。
   *
   * v2（2026-11-13 重做）。v1 的做法是**叠加**：循环照常响，起音片段同时播，
   * 再把循环挖一个 24 ms 的洞。三个后果，都是实测/听感确认过的：
   *   ① 循环把闪音那 6–20 ms 的闭塞掩蔽掉（片段里 −38 dB 的洞，混进来只剩 −9 dB），
   *      用户：「`duck=0.3` 时听不到 `r`」；
   *   ② 挖深了就变成每 200 ms 一次的门夹（用户：「有些不连续感」）；
   *   ③ 片段和循环同时出声、同音不同相 → 音量翻倍 + 梳状滤波，咬字像「鼓包」。
   *
   * v2 改成**替换**：mora 开头把循环压到底，起音片段独占这一段，末尾用等功率
   * 曲线把循环淡回来（片段同时淡出）。字是片段给的（真闭塞 + 真 burst），
   * 循环和它一点都不重叠，也就不需要「猜洞有多深」。
   *
   * 两种起音分开处理：
   *   - `consonant`（ら行）：片段里有真闭塞。循环必须**完全**静音，
   *     否则 6 ms 的闭塞会被持续元音盖掉——这是全部问题的根源。
   *   - `vowel`（あ行等）：没有辅音要腾位置，静音只会变成顿挫。只要一个
   *     短而深的软起伏（−24 dB / 36 ms）+ 45 音分的上滑（真唱起音也从低处滑上来）。
   *
   * `aheadHz` = **下一个字**的音高（调用方提前 leadSec 秒查谱面得到的）。
   * 返回 false = 这次没咬（谱面还没出音 / 防抖窗口内），调用方不要把 mora
   * 记成「已处理」，否则这个字就永远没咬到。
   */
  articulate(aheadHz = 0, kind: ArticulationKind = 'vowel', noteSec = 0): boolean {
    if (!this.attackEnabled) return false
    const now = this.ctx.currentTime
    if (now < this.articulateUntil) return false
    const attackHz = aheadHz > 0 ? aheadHz : this.lastOutHz
    // 谱面在这一刻还是换气/间奏：等 mora 边界再来（那时 f0 已经出来了）
    if (!(attackHz > 0)) return false

    const sample = kind === 'consonant' ? this.pickAttack('consonant', attackHz) : null
    if (kind === 'aspirate') return this.aspirate(now, attackHz, noteSec)
    return sample ? this.splice(now, attackHz, sample, noteSec) : this.notch(now, attackHz, noteSec)
  }

  /**
   * は行：气声（[h]）+ 元音起振。
   *
   * 比 ら 好做，也更好验证：`[h]` 的声学本质就是**一段带通的噪声**，
   * 不需要从人声里切（切也切不出干净的），直接合成更可控。
   * 和 ら 共用同一套「循环让位 + 末尾交叉淡化」，所以结论能互相迁移：
   * 噪声段该多长、交叉淡化多长、循环让位多深，都能直接搬到 ら 上。
   *
   * 噪声用固定种子的伪随机（不用 Math.random：每次刷新音色一样，便于 A/B）。
   */
  private aspirate(now: number, hz: number, noteSec = 0): boolean {
    // 优先用**真唱的**は起音（cover 里切的，[h] 是 −8 dB 的真气声）；
    // 合成噪声只在没有素材时兜底——用户 2026-11-13：「切到关就听不到嘶声了」，
    // 说明那层嘶声就是我们合成的噪声。
    const sample = this.pickAttack('aspirate', hz)
    if (sample) return this.splice(now, hz, sample, noteSec, 'aspirate')
    const level = Math.max(0.001, this.level)
    // 气声长度跟着**音符还剩多少时间**走：90 ms 的音上吹 60 ms 的气，音就没了
    const dur = noteSec > 0 ? Math.min(0.06, Math.max(0.022, noteSec * 0.35)) : 0.06
    const hold = Math.max(0.014, dur * 0.6)
    const xf = 0.028
    this.lastAtt = { kind: 'aspirate', noteSec, holdMs: Math.round(hold * 1000), durMs: Math.round(dur * 1000) }
    const src = this.ctx.createBufferSource()
    src.buffer = this.ensureNoise()
    src.loop = true
    /**
     * 气声的滤波链（v2：用户 2026-11-13 说「像机器摩擦」）。
     *
     * 原因不是语气，是**窄带噪声**：原来一个 `bandpass 1800 / Q 0.7`，
     * 能量挤在 1.8 kHz 附近，听上去是有音高的「嘶」，连着几个字就是摩擦声。
     * 真实的 [h] 是被**后面元音的共振峰**塑形的宽噪声：/ha/ 的能量从 700 Hz
     * 一直铺到 3 kHz 以上，1.2 kHz 有个鼓包（F2）。改成
     * 「高通 700 + 1.2 kHz 抬 4 dB + 低通 3.2 kHz」，三段斜率都很缓。
     */
    const hp = this.ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 400
    hp.Q.value = 0.6
    const peek = this.ctx.createBiquadFilter()
    peek.type = 'peaking'
    peek.frequency.value = 1200
    peek.Q.value = 1.0
    peek.gain.value = 3
    const lp = this.ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3000
    lp.Q.value = 0.5
    const gain = this.ctx.createGain()
    // 用户 2026-11-13 第二次听：「还是没把那噪音去掉」——气声本身被当成噪声了。
    // 降到 0.28，只留「一口气」的线索，不再是「嘶」。
    const amp = level * 0.28
    // 气声起音比元音快：8 ms 上来，尾巴交给交叉淡化
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.linearRampToValueAtTime(amp, now + Math.min(0.008, dur * 0.25))
    gain.gain.setValueAtTime(amp, now + hold)
    gain.gain.linearRampToValueAtTime(0.0001, now + dur)
    src.connect(hp)
    hp.connect(peek)
    peek.connect(lp)
    lp.connect(gain)
    gain.connect(this.attackOut)
    src.start(now)
    src.stop(now + dur + 0.01)
    this.articulations++
    this.attacks++

    // 循环让位（长度跟着音符时长走），再用 28 ms 淡回（和 ら 的 splice 同一个形状）
    const env = this.env.gain
    env.cancelScheduledValues(now)
    const from = Math.max(0.001, env.value)
    env.setValueAtTime(from, now)
    env.linearRampToValueAtTime(0.0008, now + 0.004)
    env.setValueAtTime(0.0008, now + hold)
    env.linearRampToValueAtTime(level, now + hold + xf)
    this.holeUntil = now + hold + xf
    this.articulateUntil = now + hold + xf + 0.02

    this.maybeResetVibrato(now, this.lastOutHz > 0 ? this.lastOutHz : hz)
    return true
  }

  /** 合成用的 0.5 s 白噪声（固定种子，重复播放音色一致） */
  private ensureNoise(): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf
    const len = Math.floor(this.ctx.sampleRate * 0.5)
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    let seed = 0x2f6e2b1
    for (let i = 0; i < len; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      data[i] = seed / 0x3fffffff - 1
    }
    this.noiseBuf = buf
    return buf
  }

  /** 按「种类 + 音高最近」挑起音片段：变调越少，共振峰/闭塞时长越接近原样 */
  private pickAttack(kind: ArticulationKind, hz: number): AttackSample | null {
    let best: AttackSample | null = null
    let bestDist = Number.POSITIVE_INFINITY
    for (const item of this.attackBank) {
      if (item.kind !== kind) continue
      const dist = Math.abs(Math.log2(hz / item.rootHz))
      if (dist < bestDist) {
        bestDist = dist
        best = item
      }
    }
    return best
  }

  /**
   * 替换式咬字（consonant）。片段独占 [now, now+hold]，循环在底下静音，
   * 之后 `xf` 秒等功率交叉淡化回循环。
   *
   * `xf` 取 28 ms：比一个基音周期长一个数量级，容得下两边的相位差；
   * 再长就会把「同音高、不同相位」的两段叠出拍音。`hold` 上限 170 ms——
   * 快句子里一个 mora 可能只有 150 ms，替太久会把节奏吃掉。
   */
  private splice(now: number, hz: number, sample: AttackSample, noteSec = 0,
                 kind: ArticulationKind = 'consonant'): boolean {
    // 0.5–2 倍：再往外变调，共振峰会明显不对（这里只放 40 ms 元音头，
    // 所以比循环采样能容忍的范围宽一点）
    const rate = Math.max(0.5, Math.min(2, hz / sample.rootHz))
    const xf = 0.028
    /**
     * 闭塞的最小长度。
     *
     * 用户 2026-11-13 第二次听：「ら 还是听不出来」。量下来对白那段的闭塞只有 **6 ms**，
     * 在 16% 音量的和声里基本不可闻（真唱里闪音闭塞 15–30 ms）。
     * 所以片段前面补一段**真静音**：不伪造声音，只是把「闭嘴」的时间补够。
     *
     * 但**不能超过这个音本身的长度**（2026-11-14）：90 ms 的音上补 41 ms 静音，
     * 等于把这个音吃掉一半——快句子里听起来就是「顿挫、不稳」。
     * 所以取 `min(41 ms, 音符时长 × 0.3)`。
     */
    const MIN_CLOSURE = noteSec > 0 ? Math.min(0.041, noteSec * 0.3) : 0.041
    const leadReal = sample.leadSec / rate
    const pad = Math.max(0, MIN_CLOSURE - leadReal)
    const sampled = pad + sample.buf.duration / rate
    // 替换段最多占这个音的 40%（下限 50 ms、上限 170 ms）。
    //
    // 原来固定上限 190 ms：白花的八分音符是 341 ms，于是**每个音有一多半时间
    // 播的是起音片段**（另一段录音、另一个音高），剩下的才是循环——
    // 每换一个音音色就翻一次，这就是用户说的「不够稳定」（2026-11-14）。
    const cap = noteSec > 0 ? Math.max(0.05, Math.min(0.17, noteSec * 0.4)) : 0.19
    /**
     * **片段淡入的长度 = 片段自己的前奏**（用户 2026-11-15：「ra 开头听起来完全就是别的声音」）。
     *
     * 上一版是「循环 3 ms 落到底 + 片段立刻满电平」，等于把一个别的音的尾巴
     * 硬插进来——那一下的瞬态就是「别的声音」。改成：
     *   循环照常响到 `d`（片段起播点）→ 两边一起在 `fadeIn` 里交叉过去 →
     *   burst 落点时片段已经是满电平。
     * 这样片段开头那点「上一个音的尾巴」是从 0 淡进来的，不再是硬切。
     */
    const fadeIn = Math.min(0.05, Math.max(0.008, leadReal))
    const hold = Math.max(0.012, Math.min(cap, sampled) - xf - fadeIn)
    const level = Math.max(0.001, this.level)
    const d = now + pad
    this.lastAtt = {
      kind,
      noteSec,
      holdMs: Math.round(hold * 1000),
      // 探针：证明「用的是哪一段、多长、提前多少、变调多少」——用户 2026-11-14
      // 问过「ら 到底接进程序没有」，光看代码不够，得能读出实际用的片段
      sampleSec: +sample.buf.duration.toFixed(3),
      leadMs: Math.round(pad * 1000),
      sampleRootHz: +sample.rootHz.toFixed(1),
      rate: +rate.toFixed(3),
    }

    this.articulations++
    this.articulateUntil = d + fadeIn + hold + xf + 0.02
    this.holeUntil = d + fadeIn + hold + xf

    // 片段：整段响，末尾 `xf` 秒淡出，把位置让给循环
    //
    // 响度归一：片段（−17 dB）比循环（−9 dB）小 8 dB，不归一的话辅音那一下
    // 听起来是「声音变闷」而不是「咬了个字」——这是 2026-11-13「ら 听不出来」的另一半原因。
    const norm =
      this.loopRms > 0 && sample.rms > 1e-6
        ? Math.min(6, Math.max(0.3, this.loopRms / sample.rms))
        : 1
    /**
     * 起音片段的额外衰减（用户 2026-11-15：「是不是可以把开头这个特征的音量减少一些」）。
     *
     * 之前 `norm = loopRms/sampleRms` 是把片段**拉到和循环一样响**——那对辅音是必要的
     * （不然听不出字），但整段都按循环电平播，开头的「特征」就顶出来了。
     * 默认压到 **0.7（−3 dB）**：辅音还是听得见，但不再比后面亮一截。`?attg=` 可调。
     */
    const amp = level * norm * sample.levelScale * this.attackGain
    const src = this.ctx.createBufferSource()
    src.buffer = sample.buf
    src.playbackRate.value = rate
    const gain = this.ctx.createGain()
    gain.gain.setValueAtTime(0.0001, d)
    gain.gain.linearRampToValueAtTime(amp, d + fadeIn)
    gain.gain.setValueAtTime(amp, d + fadeIn + hold)
    gain.gain.linearRampToValueAtTime(0.0001, d + fadeIn + hold + xf)
    src.connect(gain)
    gain.connect(this.attackOut)
    // 补的那段静音在片段前面，所以起播时间往后挪 pad
    src.start(d)
    src.stop(d + fadeIn + hold + xf + 0.02)
    this.attacks++

    // 循环：3 ms 落到底 → 停住 → 淡回
    //
    // **只用线性 ramp，不用 setValueCurveAtTime**：规范里曲线不能和同一个 param 上
    // 的其它事件重叠，而 `gate()` 每帧都可能来一次 setTargetAtTime——两者一撞就抛
    // NotSupportedError 并且把整个 tick 打断（2026-11-13 实测，每帧一片红）。
    // 28 ms 的段落用折线听不出差别。
    const env = this.env.gain
    env.cancelScheduledValues(now)
    const from = Math.max(0.001, env.value)
    // 默认完全让位（floor=0.0008），`?duck=` 可以把循环留一点回来做对比
    const floor = Math.max(0.0008, level * this.duckLevel)
    // 循环一直响到片段起播点 `d`，然后和片段**同一个 fadeIn** 交叉过去
    const duckIn = Math.max(0.008, fadeIn * 0.7)
    env.setValueAtTime(from, d)
    env.linearRampToValueAtTime(floor, d + duckIn)
    env.setValueAtTime(floor, d + duckIn + hold)
    env.linearRampToValueAtTime(level, d + duckIn + hold + xf)
    this.holeUntil = d + duckIn + hold + xf

    this.maybeResetVibrato(now, hz)
    return true
  }

  /**
   * 元音起振（vowel / 没有片段时的兜底）。
   *
   * **不给元音挖洞**（用户 2026-11-14：「现在的あ为什么这么奇怪，あ本来该是一个
   * 平滑的音吧」）。以前这里是「底 30%、宽 28 ms」的软凹槽，每个 mora 挖一次，
   * 白花的八分音符是 341 ms → 每秒 2.9 次 −10.5 dB 的小洞，连着听就是「颤」。
   * 真唱的 a 换音时音量是**平的**（只有辅音才让位），所以元音只做两件事：
   *   - 换音时的**上滑**（30 音分，45 ms 内滑到位）；
   *   - 一个音之内**不再动颤音**。
   * `?dip=0.3` 可以把旧版凹槽放回来做 A/B（`vowelDip`）。
   */
  private notch(now: number, hz: number, noteSec = 0): boolean {
    const level = Math.max(0.001, this.level)
    const span = noteSec > 0 ? Math.max(0.012, Math.min(0.03, noteSec * 0.08)) : 0.024
    const bottom = this.vowelDip
    this.lastAtt = {
      kind: 'vowel',
      noteSec,
      holdMs: bottom < 0.99 ? Math.round(span * 1000) : 0,
      spanMs: Math.round(span * 1000),
      bottom: +bottom.toFixed(2),
    }
    this.articulations++
    this.articulateUntil = now + span + 0.03

    if (bottom < 0.99) {
      // A/B 用：旧版的软凹槽
      const env = this.env.gain
      env.cancelScheduledValues(now)
      const from = Math.max(0.001, env.value)
      const down = Math.min(0.008, span * 0.4)
      env.setValueAtTime(from, now)
      env.linearRampToValueAtTime(Math.max(0.0008, level * bottom), now + down)
      env.linearRampToValueAtTime(level, now + span)
      this.holeUntil = now + span
    } else {
      // 不碰包络：`update()` 每帧的 `gate(level)` 会把它稳在 level 上
      this.holeUntil = 0
    }

    const target = this.lastOutHz > 0 ? this.lastOutHz : hz
    const prev = this.lastArticulatedHz
    const interval = prev > 0 ? 12 * Math.log2(target / prev) : 0
    const sameNote = prev > 0 && Math.abs(interval) < 0.5
    const tooShort = noteSec > 0 && noteSec < 0.11
    const leap = Math.abs(interval) >= this.glideMin
    const scoop = sameNote || tooShort || !leap ? 1 : Math.pow(2, -this.glideCents / 1200)
    if (this.samples.length) {
      for (const s of this.samples) {
        const rate = target / s.rootHz
        if (scoop === 1) {
          s.src.playbackRate.setTargetAtTime(rate, now, 0.02)
        } else {
          s.src.playbackRate.setValueAtTime(rate * scoop, now)
          s.src.playbackRate.setTargetAtTime(rate, now + 0.02, Math.max(0.005, this.glideMs / 1000 / 2.5))
        }
      }
    } else if (scoop === 1) {
      this.osc.frequency.setTargetAtTime(target, now, 0.02)
    } else {
      this.osc.frequency.setValueAtTime(target * scoop, now)
      this.osc.frequency.setTargetAtTime(target, now + 0.02, Math.max(0.005, this.glideMs / 1000 / 2.5))
    }

    this.maybeResetVibrato(now, target)
    return true
  }

  /**
   * 颤音何时重新起振。
   *
   * 以前每个 mora 都 `lfoGain → 0` 再爬回来：5 字/秒就是每秒 5 次把颤音掐死再放，
   * 听感正是「音高不稳」（用户 2026-11-13）。后来改成「换音就重起」，
   * 但白花的音只有 341 ms、颤音延迟 260 ms + 爬升 100 ms，等于每个音都掐一次，
   * 颤音永远长不起来。现在的判据是**音程**：级进（<150 音分）连续跑，
   * 只有大跳或从静音里起来才重新起振。
   */
  private maybeResetVibrato(now: number, hz: number): void {
    const prev = this.lastArticulatedHz
    this.lastArticulatedHz = hz
    if (prev <= 0) return
    /**
     * **只在「重新出声」时起振**，一个乐句之内颤音一直跑。
     *
     * 用户 2026-11-14：「あ这边其实不超出整个乐句的话是不必重新发音的
     * （正常唱歌时就是如此）」——颤音同理：真唱里乐句内部哪怕大跳，颤音也是连续的，
     * 只有换气/断句之后才重新起振。所以判据从「音高变了」改成「刚才是不是静音」。
     */
    const quiet = this.env.gain.value < this.level * 0.25
    if (!quiet) return
    this.lfoGain.gain.cancelScheduledValues(now)
    this.lfoGain.gain.setValueAtTime(0, now)
    this.lfoGain.gain.setTargetAtTime(this.vibCents, now + this.vibDelay, 0.1)
  }

  update(refHz: number): void {
    if (this.pinned) {
      this.applyTone(this.pinned)
      return
    }
    // 字头（辅音）那几十毫秒，参考轨经常没有基频（YIN 只认周期信号）。
    // 直接跟着 0 走就是「和声断一下再回来」——用户 2026-11-13 听到的「音高不稳」
    // 有一部分就是这个。断掉时保持上一帧音高最多 150 ms，等元音出来再跟上。
    const nowSec = this.ctx.currentTime
    if (refHz > 0) this.holdUntil = nowSec + 0.15
    else if (nowSec < this.holdUntil) refHz = this.lastInHz

    const target = this.targetFor(refHz)
    this.lastInHz = refHz

    if (target <= 0) {
      this.lastOutHz = 0
      this.gate(0.001)
      this.lfoGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05)
      return
    }

    this.lastOutHz = target
    // 音高**每帧都跟**，不再被咬字冻住。以前 `articulateUntil` 有 140 ms，
    // 200 ms 一个字的时候和声的音高有 70% 时间停在上一个音上（音高打嗝）。
    //
    // 2026-11-17 用户：「换音生硬」。原因是这里一直用固定的 30 ms 时间常数——
    // 同音的微调没问题，但 3 个半音以上的跳进听起来就是「啪」地跳过去。
    // 改成**按音程给时间**：每半音 8 ms（可调），同音 12 ms、5 个半音 ~52 ms，
    // 听感上像真人「带过去」，而不是电音阶跃。
    const now = this.ctx.currentTime
    const prevOut = this.lastOutHzBefore
    const semis = prevOut > 0 ? Math.abs(12 * Math.log2(target / prevOut)) : 0
    const tau = Math.min(0.05, 0.012 + this.portaSec * semis)
    this.lastOutHzBefore = target
    this.setPitch(target, tau)
    // 包络只在「洞」的外面碰：洞里是 articulate() 排的方波，插一手会把洞填平
    if (now >= this.holeUntil) this.gate(this.level)
    this.adaptDeEss(now)
  }

  /**
   * 量测：从输出波形自相关估「实际发出来的基频」。
   *
   * 只比对 `outHz`（意图）不够——采样音色靠播放速率改音高，万一速率算错、
   * 或者循环接缝把周期改了，都会「算对了但听着不对」。
   *
   * 取峰值的规则要小心：人声样本的共振峰会造出**更短的周期**（F1 的倒数），
   * 直接取全局最大会锁到共振峰上（实测能差 100 音分）。所以按 YIN 的做法，
   * 从最短的快照开始找**第一个**超过最大值 85% 的峰。
   */
  probeF0(): number {
    if (!this.ctx || this.env.gain.value < 0.005) return 0
    this.analyser.getFloatTimeDomainData(this.probeBuf)
    const sr = this.ctx.sampleRate
    const buf = this.probeBuf
    let mean = 0
    for (let i = 0; i < buf.length; i++) mean += buf[i]
    mean /= buf.length

    const minLag = Math.max(2, Math.floor(sr / 1600))
    const maxLag = Math.min(Math.floor(sr / 70), Math.floor(buf.length / 2))
    const acf = new Float32Array(maxLag + 1)
    let maxVal = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      let n = 0
      for (let i = 0; i + lag < buf.length; i++) {
        sum += (buf[i] - mean) * (buf[i + lag] - mean)
        n++
      }
      acf[lag] = n > 0 ? sum / n : 0
      if (acf[lag] > maxVal) maxVal = acf[lag]
    }
    if (maxVal <= 0) return 0

    const threshold = maxVal * 0.85
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (acf[lag] < threshold) continue
      // 局部极大才算峰
      if (acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1]) {
        const a = acf[lag - 1]
        const b = acf[lag]
        const c = acf[lag + 1]
        const denom = a - 2 * b + c
        const shift = Math.abs(denom) > 1e-12 ? (0.5 * (a - c)) / denom : 0
        return sr / (lag + shift)
      }
    }
    return 0
  }

  /** 调试用：和声链的输出采样率（`captureSamples` 要它来算时间） */
  get sampleRate(): number {
    return this.ctx.sampleRate
  }

  /**
   * 调试用：从最终输出节点抓一段**原始样本**。
   *
   * 为什么不能只听：判断「接续时不够干净」是素材的问题还是和声链的问题，得拿到链的输出做频谱。
   * 用 `ScriptProcessorNode` 直接抄 float —— 不用 `MediaRecorder`，后者是 opus 有损，
   * 正好会把要查的细小毛刺压掉。
   */
  captureSamples(sec: number): Promise<Float32Array> {
    const sr = this.ctx.sampleRate
    const need = Math.max(1, Math.ceil(sec * sr))
    const tap = this.ctx.createScriptProcessor(4096, 1, 1)
    const sink = this.ctx.createGain()
    sink.gain.value = 0 // 只为了让节点被拉取，不要把声音再叠一遍
    const chunks: Float32Array[] = []
    let got = 0
    return new Promise((resolve) => {
      tap.onaudioprocess = (e) => {
        const buf = e.inputBuffer.getChannelData(0)
        chunks.push(new Float32Array(buf))
        got += buf.length
        if (got < need) return
        tap.onaudioprocess = null
        try {
          this.out.disconnect(tap)
        } catch {
          /* 已经断开 */
        }
        try {
          tap.disconnect()
          sink.disconnect()
        } catch {
          /* 同上 */
        }
        const out = new Float32Array(got)
        let o = 0
        for (const c of chunks) {
          out.set(c, o)
          o += c.length
        }
        resolve(out)
      }
      this.out.connect(tap)
      tap.connect(sink)
      sink.connect(this.ctx.destination)
    })
  }

  status(): {
    mode: HarmonyMode
    key: string
    userHz: number
    outHz: number
    /** 配置的音量（滑杆给的目标值） */
    level: number
    /** 当前实际包络（0 = 没在响） */
    gain: number
    /** 累计起音次数 */
    articulations: number
    /** 其中真播了「ら」片段的次数 */
    attacks: number
    /** 有没有载入起音片段 */
    hasAttack: boolean
    /** 起音片段库里有几段（0 = 只能用软凹槽） */
    bank: number
    /** 起音片段要提前多少秒播（0 = 没载入） */
    leadSec: number
    /** 起音片段本身多长（秒，0 = 没载入） */
    attackSec: number
    /** 起音片段的根音（Hz） */
    attackRootHz: number
    /** 咬字时循环被压到多少 */
    duck: number
    /** 咬字总开关（`?att=off` 时为 false） */
    attackOn: boolean
    /** 元音咬字的凹陷底部（1 = 不凹，默认） */
    vowelDip: number
    /** 两段循环采样当前各自的增益 */
    loops: number[]
    /** 两段循环**实测**的根音（Hz），用来核对有没有音高错位/慢拍 */
    roots: number[]
    /** 当前唱哪个元音（没有该元音时会退回 a） */
    vowel: string
    /** 上一次咬字的实际参数（验证「按音符时长收放」用） */
    lastAtt: LastArticulation | null
    /** 估计出来的调性（探针用） */
    keyInfo: { tonic: number; minor: boolean; name: string; score: number } | null
    targetDebug: { refHz: number; outMidi: number; beforeGuard: number; over: number; highBelow: boolean; after: number } | null
    /** 后期链的状态（?fx=off 时为 false） */
    fx: { on: boolean; drive: number; verb: number; comp: number; dbl: number; attGain: number }
    /** 颤音与混合宽度（预设会改，探针用） */
    vib: { hz: number; cents: number; delay: number }
    sigma: number
    /**
     * 当前实际下发给采样的播放速率（第一段循环）。
     *
     * 音高是靠 playbackRate 改的，所以它的**时间轨迹**就是「换音滑多久」的实测：
     * 换音瞬间跳一大格 = 硬切；几帧爬过去 = 有 portamento。验证「换音生硬」用。
     */
    rate: number
  } {
    return {
      mode: this.mode,
      key: this.key,
      userHz: Math.round(this.lastInHz),
      outHz: Math.round(this.lastOutHz),
      level: this.level,
      gain: this.env.gain.value,
      articulations: this.articulations,
      attacks: this.attacks,
      hasAttack: this.attackBank.length > 0,
      bank: this.attackBank.length,
      leadSec: this.attackLead,
      attackSec: this.attackBuf?.duration ?? 0,
      attackRootHz: this.attackRoot,
      duck: this.duckLevel,
      attackOn: this.attackEnabled,
      vowelDip: this.vowelDip,
      loops: this.samples.map((s) => +s.gain.gain.value.toFixed(2)),
      roots: this.samples.map((s) => +s.rootHz.toFixed(2)),
      vowel: this.vowel,
      /** 上一次咬字用的参数（音长判定的证据：hold/span 是否跟着音符时长走） */
      lastAtt: this.lastAtt,
      /** 估计出来的调性（探针用：tonic 是 MIDI 音级，major 表示大小调） */
      keyInfo: this.keyGuess,
      /** 上一次 targetFor 的推演 */
      targetDebug: this.lastTargetDebug,
      fx: { on: this.fxOn, drive: this.driveAmount, verb: this.verbAmount, comp: this.compAmount, dbl: this.dblAmount, attGain: this.attackGain },
      vib: { hz: this.vibHz, cents: this.vibCents, delay: this.vibDelay },
      sigma: this.loopSigma,
      rate: this.samples.length ? +this.samples[0].src.playbackRate.value.toFixed(5) : 0,
    }
  }
}
