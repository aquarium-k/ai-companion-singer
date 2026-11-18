/**
 * 跟着唱判定。
 *
 * 三件事：
 *   **音高**：麦克风信号 → YIN（受限搜索，只在目标音高 ±2 半音内找）
 *   **八度**：男生唱女声歌通常低一个八度，直接按谱面比会全程「检不到」。
 *             所以同时在 `ref` 和 `ref/2` 上各找一次，取偏差小的那个。
 *   **延迟**：麦克风链路（AEC + worklet 批处理 + 播放输出）有几十到几百毫秒的延迟，
 *             写死一个常量只能对某台机器有效。这里用最近几秒的数据**自动估计**
 *             最佳滞后：对每个候选滞后算「和谱面的偏差中位数」，取最小的那个。
 *
 * 为什么必须用受限搜索：麦克风里还有伴奏，全音域搜索会被音乐带跑
 * （实测混音下 27.7% 的帧跳八度、只有 17% 落在 ±100 音分内）。
 */

import { PITCH_WIN, yinFrame, yinGuided, type PitchFrame } from './pitch'
import { f0At, type F0Track } from '../songpack/f0'

/**
 * 跟唱状态。
 *
 * `idle` 和 `noref` 必须分开（用户 2026-11-12：「有的地方明明还有词，
 * 可看 UI 上却是不用唱的地方」）：
 * - `idle`：这一拍**没有词**（间奏、前奏），本来就不该唱；
 * - `noref`：**有词，但参考音高在这帧是 0**（清音、气声、换气，或者曲包根本没提
 *   f0）。这时不判，但也不能说「不用唱」——那是在骗人。
 *
 * demo 曲包原来就属于第二种的极端情况：`pack.json` 的 assets 里没写 `f0`，
 * 整首都是 noref，跟唱判定从来没跑起来过。
 */
export type SingState = 'off' | 'idle' | 'quiet' | 'noref' | 'hit' | 'miss'

export type SingReport = {
  state: SingState
  /** 最近 WINDOW 秒的命中率，0..1；没判定过为 NaN */
  hitRate: number
  /** 平滑后的偏差（音分），正 = 唱高了；没判定过为 NaN */
  cents: number
  /** 最近 WINDOW 秒里判定过多少帧 */
  judged: number
  /** 自动估计出的滞后（秒） */
  lag: number
  /** 实际用到的八度：0 = 同度，-1 = 低八度，1 = 高八度，null = 还没确定 */
  octave: number | null
  /**
   * 最近 WINDOW 秒里「没跟上」的两个原因，分开数：
   * `silent` = 根本检不到你的音高（气声/太轻/麦克风小）；`off` = 检到了但音准不对。
   * 这两个数能分开「你没唱」和「你唱错了」——排查「某一段命中特别低」全靠它。
   */
  missSilent: number
  missOff: number
  /** 这一场你实际唱到的音域（Hz）；样本不够时是 null */
  voice: { lowHz: number; highHz: number; medianHz: number; n: number } | null
}

/** 判定窗口（秒） */
const WINDOW = 4
/**
 * 命中容差（音分）。
 *
 * 2026-11-17 从 210 收紧到 **120**（≈ 一个半音多一点）：
 * 210 = 差一个全音也算「跟上」，唱跑了还显示 ✓，这个数就没有意义了。
 * 120 仍然比专业音准（±50 音分）松一倍多——麦克风、设备延迟、颤音都要留余量。
 * 想放宽/收紧用 `?tol=180` 之类。
 */
const DEFAULT_TOLERANCE = 120
/** 平滑窗（帧）：15 帧 = 150 ms */
const SMOOTH = 15
/** 连续多少帧检不到音高才算「没唱」 */
const SILENT_RUN = 5
/**
 * 麦克风原始 RMS 低于这个值就当「没在唱」，不判定。
 *
 * 0.004 ≈ −48 dBFS 是**下限**：真正该用的是「比这台机器的底噪高 6 dB」——
 * 房间里的风扇/空调一响，底噪就可能到 0.005，固定阈值会漏进去（2026-11-17 实测：
 * 底噪 0.0052 时 4 s 里判了 23 帧、命中 96%，人一声没出）。
 * 底噪是慢速跟踪的（降得快、涨得慢），所以换房间/换麦克风也能自己适应。
 */
const SILENT_RMS = 0.004
/** 要判定，原始电平至少得比底噪高这么多倍（≈ +6 dB） */
const LOUD_OVER_NOISE = 2
/** 帧移（样本） = 10 ms */
const HOP = 160
const SR = 16000

/** 自动滞后估计：候选范围与步长 */
const LAG_MAX = 0.4
const LAG_STEP = 0.02
/** 估计用的样本窗口（秒） */
const LAG_WINDOW = 6
/** 多少帧估一次 */
const LAG_EVERY = 150
/** 估计结果低于这个偏差中位数才采信（否则说明用户根本没在唱） */
const LAG_MAX_ACCEPT = 150

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export class SingAlong {
  /** 命中容差（音分），可在 URL 上用 ?tol=150 放宽 */
  readonly tolerance: number
  track: F0Track | null = null
  /** 当前播放位置（秒），主循环每帧更新 */
  position = 0

  private buf = new Float32Array(SR)
  private base = 0
  private total = 0
  private nextFrame = 0

  private out: PitchFrame = { f0: 0, clarity: 0, rms: 0 }
  private history: { t: number; hit: boolean; cents: number }[] = []
  private recent: number[] = []
  private silentRun = 0
  private lastCents = Number.NaN
  private lastState: SingState = 'idle'

  /** 自动估计出来的链路滞后（秒） */
  private lag = 0.04
  /**
   * 判定时扣掉的「这一帧采完到现在过了多久」（秒）。
   *
   * 这才是**系统自己的延迟**：分析窗 32 ms + 帧移 10 ms + 采样块 8 ms 左右。
   * HUD 上那个「滞后」是**你比谱面晚了多少**（歌手的滞后，由 `estimateLag` 估），
   * 两个数完全不是一回事——2026-11-16 用户把后者当成了系统延迟。
   */
  private lastAge = 0
  private lagSamples: { t0: number; f0: number }[] = []
  private lagFrames = 0
  private octave: number | null = null
  /** 显示用八度的滞回计数（连续多少帧想改成新八度） */
  private octPending = 0
  /** 用户实际唱出来的音高（Hz），滑动窗口 ≈ 40 秒；用来估「你的音域」 */
  private voice: number[] = []
  /** 最近一次实测到的音高和时刻：和声跟唱要的是「你现在唱在哪个音」 */
  private lastHz = 0
  private lastHzAt = 0
  /** 「没跟上」的两个原因（时间戳，报告时按窗口裁） */
  private missSilent: number[] = []
  private missOff: number[] = []
  /**
   * 整场的统计（开麦 → 关麦 / 换歌）：每 4 秒一个桶。
   *
   * 只报「4 秒命中率」的话，用户只能看到眼前这一下；唱完一首想知道「哪段没唱好」
   * 就得靠这个。桶只记帧数和命中数，不占内存（一首 230 s 也就 58 个桶）。
   */
  private session = {
    judged: 0,
    hits: 0,
    buckets: new Map<number, { j: number; h: number }>(),
  }
  /** 上一帧的参考音高（换音时清空平滑窗用） */
  private lastRef = 0
  /**
   * 「这一拍该不该唱」的门。没给就退回 `ref > 0`。
   * 参考音高在间奏里有分离残留，白花 27% 的「有声帧」其实没有 mora，
   * 不设门就会把「你没唱」记成「没跟上」。
   */
  gate: ((t: number) => boolean) | null = null

  constructor(tolerance = DEFAULT_TOLERANCE) {
    this.tolerance = Math.max(20, Math.min(300, tolerance))
  }

  /**
   * 最近一次实测到的音高（Hz）；0 = 这 300 ms 内没检到。
   *
   * 和判定状态无关：`noref`（有词但没参考音高）时不出判定，但如果麦克风那边
   * 检到了音高，和声照样能跟。这是「和声」和「打分」两件事的分界。
   */
  get currentHz(): number {
    if (this.lastHz <= 0) return 0
    return performance.now() - this.lastHzAt > 300 ? 0 : this.lastHz
  }

  get report(): SingReport {
    const now = this.position
    while (this.history.length && now - this.history[0].t > WINDOW) this.history.shift()
    const judged = this.history.length
    let hits = 0
    const cents: number[] = []
    for (const h of this.history) {
      if (h.hit) hits++
      if (!Number.isNaN(h.cents)) cents.push(h.cents)
    }
    // 把窗口外的「没跟上原因」时间戳扔掉
    while (this.missSilent.length && now - this.missSilent[0] > WINDOW) this.missSilent.shift()
    while (this.missOff.length && now - this.missOff[0] > WINDOW) this.missOff.shift()
    return {
      state: this.lastState,
      hitRate: judged > 0 ? hits / judged : Number.NaN,
      // 报窗口内偏差的中位数，而不是瞬时值——瞬时值会随颤音来回跳，
      // 看着像「偏差 128 音分」其实只是某一帧
      cents: cents.length >= 5 ? median(cents) : Number.NaN,
      judged,
      lag: this.lag,
      octave: this.octave,
      missSilent: this.missSilent.length,
      missOff: this.missOff.length,
      voice: this.voiceReport(),
    }
  }

  /** 最近一块麦克风的原始电平（0..1，经验标定），HUD 用来看收音大小 */
  private level = 0
  /**
   * 增益**之前**的 RMS（平滑过）。
   *
   * 2026-11-17 用户报「什么都没做也显示跟上」：自适应增益在安静的房间里会拉到 8 倍，
   * 噪声底被放大后 YIN 也能找到“周期”，于是每帧都判成命中。
   * 判定之前必须先看这个值——它是麦克风真实电平，和增益无关。
   */
  private rawRms = 0
  /** 这台机器/这个房间的底噪（慢速跟踪，判定门槛用它） */
  private noiseFloor = 0.002
  /** 自适应增益：笔记本内置麦经常只有 10% 电平，不放大 YIN 检不到 */
  private gain = 1
  private env = 0

  get inputLevel(): number {
    return this.level
  }

  get inputGain(): number {
    return this.gain
  }

  /** 增益之前的原始 RMS（判断「有没有人在唱」用的就是这个） */
  get inputRms(): number {
    return this.rawRms
  }

  /** 当前估计的底噪（HUD/调试用：判定门槛 = max(0.004, 底噪×2)） */
  get noise(): number {
    return this.noiseFloor
  }

  /** 记一帧到整场统计（按 4 s 分桶） */
  private noteSession(t: number, hit: boolean): void {
    if (!Number.isFinite(t) || t < 0) return
    const key = Math.floor(t / 4)
    const b = this.session.buckets.get(key) ?? { j: 0, h: 0 }
    b.j += 1
    if (hit) b.h += 1
    this.session.buckets.set(key, b)
    this.session.judged += 1
    if (hit) this.session.hits += 1
  }

  /**
   * 整场汇总：总命中率 + 最差的一个 4 s 桶（至少判过 40 帧 = 0.4 s 才算数，
   * 不然一个只有两三帧的桶会把「最差」抢走）。
   */
  sessionReport(): {
    judged: number
    hitRate: number
    worst: { from: number; to: number; rate: number } | null
  } {
    const judged = this.session.judged
    const hitRate = judged > 0 ? this.session.hits / judged : Number.NaN
    let worst: { from: number; to: number; rate: number } | null = null
    for (const [k, b] of this.session.buckets) {
      if (b.j < 40) continue
      const rate = b.h / b.j
      if (!worst || rate < worst.rate) worst = { from: k * 4, to: k * 4 + 4, rate }
    }
    return { judged, hitRate, worst }
  }

  /** 判定扣掉的「分析延迟」（秒）与歌手滞后（秒）——验证补偿用 */
  get timing(): { age: number; lag: number } {
    return { age: this.lastAge, lag: this.lag }
  }

  reset(): void {
    this.history.length = 0
    this.recent.length = 0
    this.silentRun = 0
    this.missSilent.length = 0
    this.missOff.length = 0
    this.session = { judged: 0, hits: 0, buckets: new Map() }
    this.lagSamples.length = 0
    this.lagFrames = 0
    this.lastCents = Number.NaN
    this.lastState = 'idle'
    this.rawRms = 0
    this.octave = null
    this.octPending = 0
    this.base = 0
    this.total = 0
    this.nextFrame = 0
    this.buf = new Float32Array(SR)
  }

  /** 喂一块麦克风样本，返回这次判定了几帧 */
  push(block: Float32Array): number {
    // 收音电平：先算这一块的 RMS，再按经验系数映射到 0..1。
    // 注意 `rms` 是**增益之前**的（麦克风真实电平），自适应增益会把噪声底也放大 8 倍，
    // 所以「有没有人在唱」只能用这个原始值判断，不能用放大之后的样本。
    let energy = 0
    for (let i = 0; i < block.length; i++) energy += block[i] * block[i]
    const rms = Math.sqrt(energy / Math.max(1, block.length))
    this.rawRms = this.rawRms * 0.7 + rms * 0.3
    // 底噪跟踪：比当前估计低就跟得很快（适应安静），高就慢慢涨（别把一句歌词当成新底噪）
    const k = rms < this.noiseFloor ? 0.1 : 0.002
    this.noiseFloor += (rms - this.noiseFloor) * k
    this.level = Math.max(0, Math.min(1, rms * 8))

    // 自适应增益：峰值的慢衰减包络 → 目标电平。上限 8 倍，避免把噪声底也放大到炸。
    this.env = Math.max(rms, this.env * 0.97)
    const want = Math.max(1, Math.min(8, 0.08 / Math.max(1e-4, this.env)))
    this.gain += (want - this.gain) * 0.05

    const scaled = new Float32Array(block.length)
    for (let i = 0; i < block.length; i++) scaled[i] = block[i] * this.gain

    const merged = new Float32Array(this.buf.length + scaled.length)
    merged.set(this.buf)
    merged.set(scaled, this.buf.length)
    this.buf = merged
    this.total += scaled.length

    let judged = 0
    while ((this.nextFrame * HOP) + PITCH_WIN - this.base <= this.buf.length) {
      this.judge(this.nextFrame * HOP - this.base, this.nextFrame * HOP)
      this.nextFrame++
      judged++
      this.lagFrames++
    }
    if (this.lagFrames >= LAG_EVERY) {
      this.lagFrames = 0
      this.estimateLag()
    }

    const keepFrom = Math.max(0, (this.nextFrame - 2) * HOP - this.base)
    if (keepFrom > 0) {
      this.buf = this.buf.slice(keepFrom)
      this.base += keepFrom
    }
    return judged
  }

  /**
   * 量这一帧你唱在哪儿，再和参考音高比。
   *
   * 做法：**全音域** YIN 先测一次真实音高（`yinFrame`），然后把差值按八度**折叠**——
   * `cents = 1200·log2(实测/参考)`，减去最近的 1200 整数倍，剩下的才是「音准偏差」。
   *
   * 为什么不在 ref / ref/2 / ref×2 上各探一次（2026-11-16 第一版）：
   * 人声的二次谐波很强，`yinGuided` 在 2×ref 附近**也能找到周期**，于是同度唱的帧
   * 会时不时被判成「高八度」（用户当天就发现了：同调被判高八度）。折叠没有这个歧义：
   * 检到基频还是二次谐波，折完都是同一个音级。
   *
   * 全音域 YIN 完全测不到（气声、太轻）时，退回「以参考为中心 ±2 半音」的受限搜索，
   * 宁可只在同度附近找，也不要乱跳。
   */
  private detect(frameOffset: number, target: number): { cents: number; octave: number } | null {
    yinFrame(this.buf, frameOffset, this.out)
    let hz = this.out.f0
    if (!(hz > 0)) {
      yinGuided(this.buf, frameOffset, target, this.out)
      hz = this.out.f0
      if (!(hz > 0)) return null
    }

    const raw = 1200 * Math.log2(hz / target)
    const octave = Math.round(raw / 1200)
    const cents = raw - octave * 1200
    if (Math.abs(octave) > 2) return null
    if (Math.abs(cents) > 200) return null

    // 显示用的八度：连续 6 帧（60 ms）一致才改，免得 HUD 在「同度/高八度」之间跳。
    // 注意这只影响显示，判定已经和八度无关了。
    if (this.octave === null) this.octave = octave
    else if (octave === this.octave) this.octPending = 0
    else if (++this.octPending >= 6) {
      this.octave = octave
      this.octPending = 0
    }
    return { cents, octave }
  }

  /** 音域的 5%/50%/95% 分位——直接给 min/max 会被一两个毛刺带跑 */
  private voiceReport(): SingReport['voice'] {
    const v = this.voice.filter((hz) => hz >= 60 && hz <= 1200).sort((a, b) => a - b)
    if (v.length < 30) return null
    const at = (q: number): number => v[Math.min(v.length - 1, Math.max(0, Math.round(q * (v.length - 1))))]
    return { lowHz: at(0.05), medianHz: at(0.5), highHz: at(0.95), n: v.length }
  }

  private judge(frameOffset: number, frameAbs: number): void {
    // 先看有没有人在唱：麦克风原始电平（增益之前）必须**明显高于底噪**。
    // 不做这一步的话，安静的房间里底噪被放大 8 倍，YIN 也能找到“周期” → 每帧命中。
    if (this.rawRms < Math.max(SILENT_RMS, this.noiseFloor * LOUD_OVER_NOISE)) {
      this.lastState = 'quiet'
      this.recent.length = 0
      this.silentRun = 0
      return
    }
    // 这一帧采完到现在过了多久（秒）
    const age = Math.max(0, (this.total - (frameAbs + PITCH_WIN)) / SR)
    this.lastAge = age
    // 拉回滞后之后的播放时刻
    const refT = this.position - age - this.lag

    const ref = f0At(this.track, refT)
    // 参考音高换音（> 1 个半音）时清空平滑窗。
    // `SMOOTH` 是 150 ms 的中位窗，而白花 12–16 s 那一句的音符中位只有 **116 ms**——
    // 窗里会混进前一个音和后一个音的偏差，算出来的中位对谁都不准，整段被判成「音不准」。
    // 用户 2026-11-16 报的「12~20 s 命中特别低」就是这一段（全曲最快的一句）。
    if (ref > 0 && this.lastRef > 0 && Math.abs(1200 * Math.log2(ref / this.lastRef)) > 100) {
      this.recent.length = 0
    }
    if (ref > 0) this.lastRef = ref
    if (!(ref > 0)) {
      // 这一帧没有参考音高：可能是清音/气声/换气，也可能整个曲包没带 f0。
      // 有词就不能说「不用唱」，单列一个 noref。
      this.lastState = this.gate && this.gate(refT) ? 'noref' : 'idle'
      this.recent.length = 0
      this.silentRun = 0
      // 判定不做了，但**和声**还想要「你现在唱在哪个音」。用上一个音当搜索中心
      // （受限搜索本来就只找 ±2 半音，持续音不会跳超过这个范围），
      // 只更新 lastHz，不影响判定和历史。
      if (this.lastState === 'noref' && this.lastHz > 0) {
        const f = this.detect(frameOffset, this.lastHz)
        // 折回原来的八度：不折的话 `lastHz` 会一路被二次谐波带上去
        if (f && this.out.f0 > 0) {
          this.lastHz = this.out.f0 / Math.pow(2, f.octave)
          this.lastHzAt = performance.now()
        }
      }
      return
    }
    if (this.gate && !this.gate(refT)) {
      this.lastState = 'idle'
      this.recent.length = 0
      this.silentRun = 0
      return
    }

    const found = this.detect(frameOffset, ref)
    if (!found) {
      this.silentRun++
      this.recent.length = 0
      if (this.silentRun >= SILENT_RUN) {
        this.lastState = 'miss'
        this.lastCents = Number.NaN
        this.history.push({ t: refT, hit: false, cents: Number.NaN })
        this.missSilent.push(refT)
        this.noteSession(refT, false)
      }
      return
    }

    this.silentRun = 0
    // 八度（显示用）在 detect 里已经带滞回更新过了，这里不再覆盖
    // 记下你实际唱到的音高（`out.f0` 是刚才拿来比对的实测值）。
    // 存**折回参考八度**的那个值：lag 估计和音域统计都假设「和谱面同一个八度」，
    // 存原始值的话，高/低八度唱的人会被自己的八度带偏。
    const folded = this.out.f0 / Math.pow(2, found.octave)
    if (folded > 0) {
      this.voice.push(folded)
      if (this.voice.length > 4000) this.voice.shift()
      // 和声跟唱读这个（见 `currentHz`）
      this.lastHz = folded
      this.lastHzAt = performance.now()
    }
    this.recent.push(found.cents)
    if (this.recent.length > SMOOTH) this.recent.shift()
    const smoothed = this.recent.length >= 5 ? median(this.recent) : found.cents
    this.lastCents = smoothed
    this.lastState = Math.abs(smoothed) <= this.tolerance ? 'hit' : 'miss'
    if (this.lastState === 'miss') this.missOff.push(refT)
    this.history.push({ t: refT, hit: this.lastState === 'hit', cents: smoothed })
    this.noteSession(refT, this.lastState === 'hit')

    // 记录 (t0, f0)，t0 是「假设滞后为 0 时的播放时刻」，估计滞后时再回退
    this.lagSamples.push({ t0: refT + this.lag, f0: folded })
    if (this.lagSamples.length > LAG_WINDOW * 100) this.lagSamples.shift()
  }

  /**
   * 自动估计滞后：对每个候选滞后，算「用户音高 vs 谱面」的偏差中位数，取最小。
   * 只有样本够多、且最佳结果确实像在唱（< LAG_MAX_ACCEPT 音分）才更新，
   * 否则保留上一次的值——避免用户没唱时把滞后估成随机数。
   */
  private estimateLag(): void {
    if (this.lagSamples.length < 200) return
    let bestLag = this.lag
    let bestMed = Number.POSITIVE_INFINITY
    for (let lag = 0; lag <= LAG_MAX + 1e-9; lag += LAG_STEP) {
      const devs: number[] = []
      for (const s of this.lagSamples) {
        const ref = f0At(this.track, s.t0 - lag)
        if (!(ref > 0) || s.f0 <= 0) continue
        let c = 1200 * Math.log2(s.f0 / ref)
        if (Math.abs(c) > 200 && ref / 2 >= 65) {
          const c2 = 1200 * Math.log2(s.f0 / (ref / 2))
          if (Math.abs(c2) < Math.abs(c)) c = c2
        }
        if (Math.abs(c) <= 300) devs.push(Math.abs(c))
      }
      if (devs.length < 100) continue
      const med = median(devs)
      if (med < bestMed) {
        bestMed = med
        bestLag = lag
      }
    }
    if (bestMed <= LAG_MAX_ACCEPT) this.lag = bestLag
  }
}
