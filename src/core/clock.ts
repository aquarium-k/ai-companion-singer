import type { BeatState } from './types'

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * 主时钟。
 *
 * 平时走 performance.now()，一旦有音频播放就切到 AudioContext.currentTime，
 * 切换时记录偏移保证时间连续 —— 这是「音频为主时钟」的最小实现：
 * 长曲下 rAF 抖动的累积误差不会传导到节拍和歌词上。
 */
export class MasterClock {
  private audioCtx: AudioContext | null = null
  private base = 0
  private perfAtBase = performance.now()
  private audioAtBase = 0
  private mode: 'perf' | 'audio' = 'perf'

  constructor() {
    try {
      this.audioCtx = new AudioContext({ latencyHint: 'interactive' })
    } catch (err) {
      console.warn('[clock] AudioContext 不可用，退化为纯 performance 时钟', err)
      this.audioCtx = null
    }
  }

  get audio(): AudioContext | null {
    return this.audioCtx
  }

  get usingAudio(): boolean {
    return this.mode === 'audio'
  }

  async resumeAudio(): Promise<void> {
    if (this.audioCtx && this.audioCtx.state !== 'running') {
      try {
        await this.audioCtx.resume()
      } catch {
        /* 无声卡等场景，忽略 */
      }
    }
  }

  now(): number {
    if (this.mode === 'audio' && this.audioCtx && this.audioCtx.state === 'running') {
      return this.base + (this.audioCtx.currentTime - this.audioAtBase)
    }
    return this.base + (performance.now() - this.perfAtBase) / 1000
  }

  useAudio(on: boolean): void {
    const t = this.now()
    this.base = t
    this.perfAtBase = performance.now()

    if (on && this.audioCtx && this.audioCtx.state === 'running') {
      this.audioAtBase = this.audioCtx.currentTime
      this.mode = 'audio'
    } else {
      this.mode = 'perf'
    }
  }
}

/**
 * 节拍网格。改 BPM 时保留当前拍位，避免舞蹈动作跳变。
 */
export class BeatClock {
  bpm: number
  beatsPerBar: number
  private offset = 0

  constructor(bpm = 96, beatsPerBar = 4) {
    this.bpm = clamp(bpm, 30, 240)
    this.beatsPerBar = beatsPerBar
  }

  /** 秒 → 浮点拍号 */
  beatFloat(t: number): number {
    return ((t - this.offset) * this.bpm) / 60
  }

  /** 浮点拍号 → 秒 */
  beatTime(beat: number): number {
    return this.offset + (beat * 60) / this.bpm
  }

  setBpm(bpm: number, t: number): void {
    const b = this.beatFloat(t)
    this.bpm = clamp(bpm, 30, 240)
    this.offset = t - (b * 60) / this.bpm
  }

  /** 重新对齐：让当前时刻落在整拍上 */
  align(t: number): void {
    this.offset = t
  }

  state(t: number): BeatState {
    const bf = this.beatFloat(t)
    const beat = Math.floor(bf)
    const phase = bf - beat
    const bar = Math.floor(beat / this.beatsPerBar)
    const beatInBar = beat - bar * this.beatsPerBar
    return { bpm: this.bpm, beatsPerBar: this.beatsPerBar, beat: bf, bar, beatInBar, phase }
  }
}

/**
 * 节拍器。只用来验证「音频时钟 + 节拍网格 + 动作同步」这条链路，
 * 后续换成真实伴奏时接口不变。
 */
export class Metronome {
  private nextBeat = 0
  private running = false
  private lookahead = 0.12

  constructor(private clock: MasterClock, private beat: BeatClock) {}

  get enabled(): boolean {
    return this.running
  }

  async start(): Promise<void> {
    await this.clock.resumeAudio()
    this.clock.useAudio(true)
    this.beat.align(this.clock.now())
    this.nextBeat = 1
    this.running = true
  }

  stop(): void {
    this.running = false
    this.clock.useAudio(false)
  }

  toggle(): Promise<void> | void {
    if (this.running) this.stop()
    else return this.start()
  }

  /** 每帧调用，提前 120ms 把拍点排进音频线程 */
  schedule(): void {
    if (!this.running) return
    const ctx = this.clock.audio
    if (!ctx || ctx.state !== 'running') return

    const now = this.clock.now()
    let guard = 0
    while (this.beat.beatTime(this.nextBeat) - now < this.lookahead && guard++ < 8) {
      const when = ctx.currentTime + (this.beat.beatTime(this.nextBeat) - now)
      const beatInBar = this.nextBeat % this.beat.beatsPerBar
      this.click(when, beatInBar === 0)
      this.nextBeat += 1
    }
  }

  private click(when: number, accent: boolean): void {
    const ctx = this.clock.audio
    if (!ctx) return
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'square'
    osc.frequency.setValueAtTime(accent ? 1320 : 880, when)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(accent ? 0.16 : 0.09, when + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.1)
    osc.connect(gain).connect(ctx.destination)
    osc.start(when)
    osc.stop(when + 0.12)
  }
}
