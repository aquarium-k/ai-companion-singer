import type { Cue, Section, SongPack } from './types'

export type TrackPlayerOptions = {
  onPlay: (clipId: string, weight?: number) => void
  onStop: (clipId: string) => void
  onSection?: (name: string, energy?: number) => void
  onEnd?: () => void
  onLoop?: () => void
}

/**
 * 编舞时间轴播放器。
 *
 * 它只做一件事：按主时钟把 cue 推到 ParamBus。
 * 不直接碰骨骼、不直接碰音频，这样换成真实伴奏时只要换时钟源。
 *
 * 时间语义：
 *   time(now) = offset + (now - startedAt)
 * 暂停时把当前时间存进 offset，恢复时重置 startedAt，计时连续。
 */
export class TrackPlayer {
  private cues: Cue[] = []
  private sections: Section[] = []
  private duration = 0
  private loop = false

  private cursor = 0
  private sectionCursor = 0
  private startedAt = 0
  private offset = 0
  private running = false
  private currentSection = ''
  /** 本播放器启动过的动作，重来时负责收尾，避免残留循环动作 */
  private started = new Set<string>()

  constructor(private opts: TrackPlayerOptions) {}

  get isPlaying(): boolean {
    return this.running
  }

  get durationSeconds(): number {
    return this.duration
  }

  get section(): string {
    return this.currentSection
  }

  time(now: number): number {
    if (!this.running) return this.offset
    return Math.min(this.duration, this.offset + (now - this.startedAt))
  }

  load(pack: SongPack): void {
    this.cues = [...(pack.track.cues ?? [])].sort((a, b) => a.at - b.at)
    this.sections = [...(pack.track.sections ?? [])].sort((a, b) => a.at - b.at)

    const lastCue = this.cues.length ? this.cues[this.cues.length - 1].at : 0
    this.duration = pack.track.duration ?? pack.meta.duration ?? lastCue
    this.loop = Boolean(pack.meta.loop)

    this.reset()
  }

  private reset(): void {
    this.cursor = 0
    this.sectionCursor = 0
    this.offset = 0
    this.startedAt = 0
    this.running = false
    this.currentSection = ''
  }

  private releaseAll(): void {
    for (const id of this.started) this.opts.onStop(id)
    this.started.clear()
  }

  play(now: number): void {
    if (this.running || this.duration <= 0) return
    this.running = true
    this.startedAt = now
  }

  pause(now: number): void {
    if (!this.running) return
    this.offset = this.time(now)
    this.running = false
  }

  toggle(now: number): boolean {
    if (this.running) this.pause(now)
    else this.play(now)
    return this.running
  }

  /**
   * 跳到指定时间。保持播放/暂停状态。
   * 会把 cue 游标推到目标位置之后，所以跳转前已经触发的动作不会被重放。
   */
  seek(now: number, target: number): void {
    const t = Math.max(0, Math.min(this.duration, target))

    if (this.running) {
      this.offset = 0
      this.startedAt = now - t
    } else {
      this.offset = t
    }

    this.cursor = 0
    while (this.cursor < this.cues.length && this.cues[this.cursor].at <= t) this.cursor++

    this.sectionCursor = 0
    this.currentSection = ''
    while (
      this.sectionCursor < this.sections.length &&
      this.sections[this.sectionCursor].at <= t
    ) {
      this.currentSection = this.sections[this.sectionCursor].name
      this.sectionCursor++
    }
  }

  /** 从头开始（同时清掉上一轮残留的动作） */
  restart(now: number): void {
    this.releaseAll()
    this.cursor = 0
    this.sectionCursor = 0
    this.offset = 0
    this.startedAt = now
    this.currentSection = ''
    this.running = true
  }

  stop(): void {
    this.releaseAll()
    this.reset()
  }

  update(now: number): void {
    if (!this.running) return

    let t = this.offset + (now - this.startedAt)

    if (t >= this.duration) {
      if (this.loop) {
        const overflow = t - this.duration
        this.startedAt = now - overflow
        this.offset = 0
        this.cursor = 0
        this.sectionCursor = 0
        this.currentSection = ''
        this.opts.onLoop?.()
        t = overflow
      } else {
        this.fireUpTo(this.duration)
        this.running = false
        this.offset = this.duration
        this.opts.onEnd?.()
        return
      }
    }

    this.fireUpTo(t)
    this.fireSections(t)
  }

  private fireUpTo(t: number): void {
    while (this.cursor < this.cues.length && this.cues[this.cursor].at <= t) {
      const cue = this.cues[this.cursor++]

      if (cue.action === 'stop') {
        this.started.delete(cue.clip)
        this.opts.onStop(cue.clip)
        continue
      }

      this.started.add(cue.clip)
      this.opts.onPlay(cue.clip, cue.weight)
    }
  }

  private fireSections(t: number): void {
    while (this.sectionCursor < this.sections.length && this.sections[this.sectionCursor].at <= t) {
      const section = this.sections[this.sectionCursor++]
      this.currentSection = section.name
      this.opts.onSection?.(section.name, section.energy)
    }
  }
}
