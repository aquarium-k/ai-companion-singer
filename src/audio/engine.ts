/**
 * 音频引擎。
 *
 * 只负责「播几段音频」和「报告当前播到哪」，不参与剧情/编舞决策。
 *
 * 关于主时钟的取舍：
 * 桌面端的动作和待机动画跑在 performance 时钟上，音频是按时间点调度过去的从属时钟。
 * 没有把全局时钟切成音频时钟，是因为暂停时 AudioContext 的时间会停，
 * 那样连呼吸眨眼都会冻住。代价是长时间播放会有极小的漂移（~50ppm），
 * P1 阶段用 HUD 上的 drift 观察，需要时再做周期性重同步。
 *
 * 分轨（C1 伴唱）
 * ---------------
 * 一首歌最多两条轨：`instrumental`（伴奏）和 `vocal`（原唱人声）。
 * 两条轨各自一个 GainNode，全部汇到 master 再出去，所以可以分别调音量，
 * 人声拉到 0 就是「伴唱」——只剩伴奏，AI 陪你唱。
 *
 * 口型有一个反直觉的点：**包络取自人声轨的「推子前」信号**（guide）。
 * 否则伴唱模式把人声静音之后，音量包络归零，角色就闭嘴了，
 * 而那正是最需要它张嘴的时候。推子前取信号，用户听不到原唱，但角色知道怎么唱。
 */

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export type StemName = 'vocal' | 'instrumental'

type Stem = {
  buffer: AudioBuffer
  gain: GainNode
  volume: number
  source: AudioBufferSourceNode | null
}

export class AudioEngine {
  private ctx: AudioContext
  private master: GainNode
  /** 口型包络：guide → guideGain → analyser → mute(0) → destination */
  private guideGain: GainNode
  private analyser: AnalyserNode
  private mute: GainNode
  private timeData: Uint8Array<ArrayBuffer>

  private stems = new Map<StemName, Stem>()
  private guideName: StemName | null = null

  private startedAtCtx = 0
  private startOffset = 0
  private segmentStart = 0
  private segmentDuration = 0
  private playing = false
  private volume = 0.85

  /**
   * 口型包络的标定区间（RMS）。
   *
   * 以前是 `min(1, rms * 4)` 加一层「整首响度 / 本轨响度」的增益补偿，
   * 两层叠起来在正常流行乐上几乎每帧都打满，等于没有起伏——
   * 长音上的颤音完全被削平，看着是一张死脸。
   * 现在改成按本曲人声轨自身的 p10/p90 定标：p10 以下闭嘴、p90 全张，
   * 中间线性映射。这样每首歌都能用满动态范围，也不依赖写死的系数。
   */
  private levelLo = 0.005
  private levelHi = 0.08

  constructor(ctx: AudioContext) {
    this.ctx = ctx

    this.master = ctx.createGain()
    this.master.gain.value = this.volume
    this.master.connect(ctx.destination)

    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.55

    // analyser 的输出乘 0 再接地：它本身是个直通节点，不接到 destination 上
    // 在部分实现里不会被拉取，拿不到波形。乘 0 既保证被渲染又不发声。
    this.mute = ctx.createGain()
    this.mute.gain.value = 0
    this.analyser.connect(this.mute)
    this.mute.connect(ctx.destination)

    this.guideGain = ctx.createGain()
    this.guideGain.gain.value = 1
    this.guideGain.connect(this.analyser)

    this.timeData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))
  }

  /**
   * 和声跟唱（`HarmonyVoice`）接在这两条线上：
   * 用同一个 AudioContext 才能一起被渲染，接到 master 上才能跟着音量滑杆走。
   */
  get context(): AudioContext {
    return this.ctx
  }

  get output(): AudioNode {
    return this.master
  }

  /** 当前音量包络，0..1，用于驱动口型。取自 guide 轨的推子前信号 */
  level(): number {
    if (!this.playing || this.guideName === null) return 0

    this.analyser.getByteTimeDomainData(this.timeData)
    let sum = 0
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i] - 128) / 128
      sum += v * v
    }
    const rms = Math.sqrt(sum / this.timeData.length)
    /*
     * 映射：把「声段 p10」再往下压一半当零点。
     *
     * 原来零点就是 p10，于是**副歌以外的段落**（人声在中低电平）算出来几乎恒为 0，
     * 嘴一直闭着——用户 2026-11-18 报的「放歌没有嘴型」就是这个。实测同一首里
     * 30 s 处 p50=0.45，90 s 处 p50=0.01，而两处的 vocal 包络 RMS 只差一半。
     * 零点收到 p10/2 之后，安静段也能落在 0.3–0.8，嘴至少跟着字在动。
     */
    const lo = this.levelLo * 0.5
    const span = Math.max(1e-4, this.levelHi - lo)
    return clamp((rms - lo) / span, 0, 1)
  }

  /**
   * 用本轨自己的包络分位数定标。
   *
   * 关键点：**先分出声段，再在声段内部取分位数**。人声分轨的静音段接近 0，
   * 直接对全帧取 p10/p90 会得到「p10≈0、p90≈峰值」，而在唱的帧本来就集中在高位，
   * 映射完还是常年打满（实测 open 中位仍是 0.88~0.91、34% 的帧贴顶）。
   * 改成先按 p60 切出声段、再取声段内的 p10/p90，在唱的帧才铺得开。
   *
   * 每 4 帧采一次就够稳；230 秒的歌扫描在 50 ms 量级，相对解码可以忽略。
   */
  private calibrate(stem: Stem): void {
    const data = stem.buffer.getChannelData(0)
    const win = 1024
    const hop = win * 4
    const vals: number[] = []
    for (let i = 0; i + win < data.length; i += hop) {
      let sum = 0
      for (let j = 0; j < win; j++) {
        const v = data[i + j]
        sum += v * v
      }
      vals.push(Math.sqrt(sum / win))
    }
    if (vals.length < 20) return
    vals.sort((a, b) => a - b)
    const q = (arr: number[], p: number): number =>
      arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]

    const gate = q(vals, 0.6)
    const active = vals.filter((v) => v > gate)
    if (active.length < 10) return
    this.levelLo = q(active, 0.1)
    this.levelHi = Math.max(this.levelLo * 1.3, q(active, 0.9))
    console.info(
      `[lip] 包络标定 声段 ${active.length}/${vals.length} 帧，p10=${this.levelLo.toFixed(4)} p90=${this.levelHi.toFixed(4)}`,
    )
  }

  get hasTrack(): boolean {
    return this.stems.size > 0
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get trackDuration(): number {
    let max = 0
    for (const stem of this.stems.values()) max = Math.max(max, stem.buffer.duration)
    return max
  }

  /** 当前实际用于口型的那条轨（null = 一轨都没有） */
  get guide(): StemName | null {
    return this.guideName
  }

  get segmentLength(): number {
    return this.segmentDuration
  }

  get currentVolume(): number {
    return this.volume
  }

  hasStem(name: StemName): boolean {
    return this.stems.has(name)
  }

  /** 分轨的解码结果（做人声活动包络用，不要再解码一遍） */
  stemBuffer(name: StemName): AudioBuffer | null {
    return this.stems.get(name)?.buffer ?? null
  }

  /**
   * 换曲前把「新曲没有的分轨」丢掉。
   *
   * `loadStem` 只会覆盖同名 buffer：如果新曲没有人声轨，旧曲的人声会留在
   * `stems` 里继续播——软切换（不重开页面）时这是最危险的一处。
   */
  unloadStems(keep: StemName[]): void {
    for (const [name, stem] of [...this.stems]) {
      if (keep.includes(name)) continue
      try {
        stem.source?.stop()
      } catch {
        /* 已经停了 */
      }
      this.stems.delete(name)
    }
    if (this.guideName && !this.stems.has(this.guideName)) this.guideName = null
  }

  stemVolume(name: StemName): number | null {
    const stem = this.stems.get(name)
    return stem ? stem.volume : null
  }

  /** 载入（或替换）一条分轨，返回时长 */
  async loadStem(name: StemName, data: ArrayBuffer): Promise<number> {
    const buffer = await this.ctx.decodeAudioData(data)

    const existing = this.stems.get(name)
    if (existing) {
      existing.buffer = buffer
    } else {
      const gain = this.ctx.createGain()
      gain.gain.value = 1
      gain.connect(this.master)
      this.stems.set(name, { buffer, gain, volume: 1, source: null })
    }

    this.pickGuide()
    return buffer.duration
  }

  /**
   * 选口型参考轨：优先人声，没有就用伴奏。
   * 响度补偿交给 `calibrate()` 的分位数标定，这里只把 guide 增益归 1。
   */
  private pickGuide(): void {
    const vocal = this.stems.get('vocal')
    const inst = this.stems.get('instrumental')
    const guide = vocal ?? inst
    this.guideName = vocal ? 'vocal' : inst ? 'instrumental' : null
    this.guideGain.gain.value = 1
    if (guide) this.calibrate(guide)
  }

  /** 指定要播放的片段（用于从长曲里截一段做 demo） */
  setSegment(start: number, duration: number): void {
    this.segmentStart = Math.max(0, start)
    const available = Math.max(0, this.trackDuration - this.segmentStart)
    this.segmentDuration = duration > 0 ? Math.min(duration, available) : available
  }

  play(offset = 0): void {
    if (!this.hasTrack) return
    this.stopSources()

    const length = this.segmentDuration > 0 ? this.segmentDuration : this.trackDuration
    const from = Math.min(length, Math.max(0, offset))
    const remain = Math.max(0.01, length - from)
    const startAt = this.ctx.currentTime + 0.015

    for (const [name, stem] of this.stems) {
      const src = this.ctx.createBufferSource()
      src.buffer = stem.buffer
      src.connect(stem.gain)
      // 两条从同一个源分出：一条给耳朵，一条推子前给口型
      if (name === this.guideName) src.connect(this.guideGain)
      src.start(startAt, this.segmentStart + from, remain)
      stem.source = src
    }

    this.startedAtCtx = startAt
    this.startOffset = from
    this.playing = true
  }

  pause(): void {
    if (!this.playing) return
    this.startOffset = this.position()
    this.playing = false
    this.stopSources()
  }

  stop(): void {
    this.playing = false
    this.startOffset = 0
    this.stopSources()
  }

  /** 当前音频播放位置（秒，相对片段起点） */
  position(): number {
    if (!this.playing) return this.startOffset
    const elapsed = this.ctx.currentTime - this.startedAtCtx
    return this.startOffset + Math.max(0, elapsed)
  }

  /** 总音量（M / [ ]），分轨音量乘在它前面 */
  setVolume(v: number): void {
    this.volume = clamp(v, 0, 1)
    this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.04)
  }

  /** 单轨音量 0..1。人声拉到 0 = 伴唱模式 */
  setStemVolume(name: StemName, v: number): void {
    const stem = this.stems.get(name)
    if (!stem) return
    stem.volume = clamp(v, 0, 1)
    // 短斜坡而不是直接赋值，避免拖动滑杆时出现咔哒声
    stem.gain.gain.setTargetAtTime(stem.volume, this.ctx.currentTime, 0.03)
  }

  private stopSources(): void {
    for (const stem of this.stems.values()) {
      const src = stem.source
      stem.source = null
      if (!src) continue
      try {
        src.stop()
      } catch {
        /* 已经停了 */
      }
      try {
        src.disconnect()
      } catch {
        /* ignore */
      }
    }
  }
}
