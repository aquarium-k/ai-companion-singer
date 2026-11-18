import type { Lyrics, LyricLine } from './types'

const round2 = (v: number): number => Math.round(v * 100) / 100
const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * 歌词播放器 + 打点编辑器。
 *
 * 两个独立的概念：
 *   active —— 按时间推算「现在唱到哪一行」，只读
 *   focus  —— 编辑器当前选中的行，可自由移动
 *
 * 分开之后就能「回头重打某一行」：上下键把焦点移过去，K 重新盖时间戳。
 * 之前的实现只能顺序前进，打错一行就得整体重来，这是设计失误。
 */
export class LyricsPlayer {
  private lines: LyricLine[] = []
  private active = -1
  private focus = 0

  load(lyrics: Lyrics): void {
    this.lines = (lyrics.lines ?? []).map((line) => ({ ...line }))
    this.active = -1
    // 优先把焦点放到第一个时间倒序的行上——那通常是打歪的起点
    const broken = this.firstInversion()
    this.focus = broken >= 0 ? broken : this.firstUntimed()
  }

  /** 第一处时间倒序的行号；没有则 -1 */
  firstInversion(): number {
    for (let i = 1; i < this.lines.length; i++) {
      const prev = this.lines[i - 1].at
      const curr = this.lines[i].at
      if (prev !== null && curr !== null && curr < prev) return i
    }
    return -1
  }

  get count(): number {
    return this.lines.length
  }

  get timedCount(): number {
    return this.lines.filter((l) => l.at !== null).length
  }

  get all(): LyricLine[] {
    return this.lines
  }

  get focusIndex(): number {
    return this.focus
  }

  get currentIndex(): number {
    return this.active
  }

  currentLine(): LyricLine | null {
    return this.active >= 0 ? this.lines[this.active] ?? null : null
  }

  focusLine(): LyricLine | null {
    return this.lines[this.focus] ?? null
  }

  /** 下一行（时间意义上的），用于字幕预告 */
  nextLine(): LyricLine | null {
    return this.active + 1 < this.lines.length ? this.lines[this.active + 1] : null
  }

  firstUntimed(): number {
    const index = this.lines.findIndex((l) => l.at === null)
    return index < 0 ? 0 : index
  }

  moveFocus(delta: number): number {
    this.focus = clamp(this.focus + delta, 0, Math.max(0, this.lines.length - 1))
    return this.focus
  }

  setFocus(index: number): number {
    this.focus = clamp(index, 0, Math.max(0, this.lines.length - 1))
    return this.focus
  }

  /**
   * 按时间推算当前行。
   * 不提前 break：手工打点难免出现相邻行时间交错，全量扫描更稳。
   */
  update(t: number): void {
    let index = -1
    for (let i = 0; i < this.lines.length; i++) {
      const at = this.lines[i].at
      if (at !== null && at <= t) index = i
    }
    this.active = index
  }

  /** 把焦点行钉在当前时间，焦点顺移到下一行 */
  stampFocus(t: number): number {
    const line = this.lines[this.focus]
    if (!line) return -1
    line.at = round2(Math.max(0, t))
    line.src = 'user'
    this.focus = Math.min(this.lines.length - 1, this.focus + 1)
    return this.focus - 1
  }

  /** 微调焦点行的时间 */
  nudgeFocus(deltaSeconds: number): number {
    const line = this.lines[this.focus]
    if (!line || line.at === null) return -1
    line.at = round2(Math.max(0, line.at + deltaSeconds))
    line.src = 'user'
    return this.focus
  }

  /** 清掉焦点行的时间 */
  clearFocus(): number {
    const line = this.lines[this.focus]
    if (!line || line.at === null) return -1
    line.at = null
    line.src = undefined
    return this.focus
  }

  /** 撤销最后一个有时间戳的行 */
  undo(): number {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      if (this.lines[i].at !== null) {
        this.lines[i].at = null
        this.focus = i
        return i
      }
    }
    return -1
  }

  /** 从焦点行开始，清空这一行及之后所有时间戳（用于「从这里重打」） */
  clearFromFocus(): number {
    let count = 0
    for (let i = this.focus; i < this.lines.length; i++) {
      if (this.lines[i].at !== null) {
        this.lines[i].at = null
        count++
      }
    }
    return count
  }

  /** 统计时间戳倒序的次数，用来发现打歪的段 */
  countInversions(): number {
    let count = 0
    for (let i = 1; i < this.lines.length; i++) {
      const prev = this.lines[i - 1].at
      const curr = this.lines[i].at
      if (prev !== null && curr !== null && curr < prev) count++
    }
    return count
  }

  clearTiming(): void {
    for (const line of this.lines) line.at = null
    this.active = -1
    this.focus = 0
  }

  toJSON(language?: string): Lyrics {
    return {
      schema: 1,
      language,
      lines: this.lines.map((l) => {
        const out: LyricLine = { at: l.at, text: l.text }
        if (l.zh) out.zh = l.zh
        if (l.src) out.src = l.src
        return out
      }),
    }
  }
}

/**
 * 解析 LRC 歌词。
 *
 * 只取行级时间戳 —— 精度约 ±100ms，但零成本，
 * 任何播放器导出的 .lrc 都能直接用。
 */
export function parseLRC(text: string): Lyrics {
  const lines: LyricLine[] = []

  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.trim()
    if (!stripped) continue

    const times: number[] = []
    let rest = stripped
    const tag = /^\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/

    let match = tag.exec(rest)
    while (match) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const frac = match[3] ? Number(`0.${match[3]}`) : 0
      times.push(minutes * 60 + seconds + frac)
      rest = rest.slice(match[0].length)
      match = tag.exec(rest)
    }

    const content = rest.trim()
    if (times.length === 0 || !content) continue

    for (const at of times) lines.push({ at, text: content })
  }

  lines.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  return { schema: 1, lines }
}
