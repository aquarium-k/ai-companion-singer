import type { Lyrics } from './types'

/**
 * 元音类型。
 * `n` 是拨音（口型闭住），空串是促音（停顿）。
 */
export type Vowel = 'a' | 'i' | 'u' | 'e' | 'o' | 'n' | ''

const VALID = new Set<string>(['a', 'i', 'u', 'e', 'o', 'n', ''])

type FlatUnit = { t: number; d: number; v: Vowel; ch: string }

/**
 * mora 级口型时间轴。
 *
 * 和「音量包络驱动」的区别：包络只知道「张嘴多大」，不知道「嘴型是什么」，
 * 所以唱什么都是同一个 a 的嘴。有了 mora 就能按元音换嘴型。
 *
 * 数据来自 `tools/build_units.py`（歌词 → 假名 → mora → 元音），
 * 一个 mora 一个元音，日文是 mora-timed 语言，行内均分就够准。
 */
export class VisemePlayer {
  private units: FlatUnit[] = []

  /** 从 `lyrics.units.json` 载入，返回 mora 总数 */
  load(data: Lyrics): number {
    const flat: FlatUnit[] = []
    for (const line of data.lines ?? []) {
      for (const unit of line.units ?? []) {
        if (typeof unit.t !== 'number' || typeof unit.d !== 'number') continue
        const v = unit.v ?? ''
        flat.push({
          t: unit.t,
          d: unit.d,
          v: (VALID.has(v) ? v : '') as Vowel,
          // 「ら行」要靠它：和声的咬字按 mora 的辅音选起音片段
          ch: unit.ch ?? '',
        })
      }
    }
    flat.sort((a, b) => a.t - b.t)
    this.units = flat
    return flat.length
  }

  get count(): number {
    return this.units.length
  }

  get firstTime(): number {
    return this.units[0]?.t ?? 0
  }

  /**
   * 当前 mora 的序号；-1 = 落在空隙/前奏。
   *
   * 和声要「每个字重新咬一下」，需要知道 mora 换了没有——只比元音不够，
   * 连着两个 `a` 的字会被当成同一个。
   */
  indexAt(time: number): number {
    const units = this.units
    if (units.length === 0) return -1
    let lo = 0
    let hi = units.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (units[mid].t <= time) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (found < 0) return -1
    const unit = units[found]
    return time > unit.t + unit.d ? -1 : found
  }

  /** 某个 mora 的假名（和声咬字要用它区分「ら行」和其它）。越界返回空串。 */
  chAt(index: number): string {
    const unit = this.units[index]
    return unit?.ch ?? ''
  }

  /** 所有 mora 的时间跨度（「谱面」量化按 mora 切段用） */
  spans(): Array<{ t: number; d: number }> {
    return this.units.map((u) => ({ t: u.t, d: u.d }))
  }

  /** 第 index 个 mora 的时间跨度；越界返回 null */
  span(index: number): { t: number; d: number } | null {
    const unit = this.units[index]
    return unit ? { t: unit.t, d: unit.d } : null
  }

  /**
   * 当前时刻正在唱哪个元音。
   * 落在两个 mora 之间（换气、间奏）返回 null，嘴应该闭上。
   */
  at(time: number): Vowel | null {
    const units = this.units
    if (units.length === 0) return null

    let lo = 0
    let hi = units.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (units[mid].t <= time) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (found < 0) return null

    const unit = units[found]
    if (time > unit.t + unit.d) return null
    return unit.v
  }

  /**
   * 某一行唱到哪了，0..1，用于逐字高亮。
   *
   * 分母用 **mora 数**而不是字符数：`所業` 两个字读 4 个 mora，
   * 按字符数算会让这两个字扫得比旁边慢一倍。
   *
   * 这一行没有 mora 数据时退回按时间线性推进，至少不会突然停住。
   */
  lineProgress(start: number, end: number, time: number): number {
    if (!(end > start)) return 0
    const units = this.units

    let lo = 0
    let hi = units.length - 1
    let first = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (units[mid].t >= start) {
        first = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }

    let total = 0
    let sung = 0
    for (let i = first; i >= 0 && i < units.length && units[i].t < end; i++) {
      total++
      if (time >= units[i].t + units[i].d) sung++
      else if (time > units[i].t) sung += (time - units[i].t) / units[i].d
    }

    if (total === 0) return Math.min(1, Math.max(0, (time - start) / (end - start)))
    return Math.min(1, Math.max(0, sung / total))
  }
}

/**
 * 元音 → VRM 表情权重。
 *
 * 两个原则：
 *
 * 1. **`aa` 必须承担下巴**。VRM 里只有 `aa` 一定带张嘴，`ih/ou/ee/oh` 带不带下巴
 *    完全由模型作者决定。以前 `i/u/e/o` 的 `aa` 只给了 0.06~0.20，
 *    如果这个模型的那几个表情不含下巴，就有 2/3 的演唱时间嘴几乎不动，
 *    只有 `a` 一张一合——看着像在拍。
 *    按 mora 时长加权，`aa` 的时间均值从 0.36~0.43 提到 0.59~0.66。
 *
 * 2. **次要形状只给一半权重**。如果模型的 `ih` 本身也带下巴，再叠一个高权重 `aa`
 *    会张得过大，所以 `ih/ou/ee/oh` 只取 0.55，`aa` 负责开合、它们负责宽窄。
 *
 * 开口度按日语音素的实际比例：a > o > e > i > u（u 最扁，接近闭口）。
 * 权重仍只是相对比例，实际张合由音量包络乘上去。
 */
export const VOWEL_SHAPE: Record<Vowel, Record<string, number>> = {
  a: { aa: 1.0 },
  o: { aa: 0.72, oh: 0.55 },
  e: { aa: 0.55, ee: 0.55 },
  i: { aa: 0.4, ih: 0.55 },
  u: { aa: 0.3, ou: 0.55 },
  n: { aa: 0.02 },
  '': { aa: 0.0 },
}

/** 表情名集合（固定顺序，过渡平滑用） */
export const LIP_KEYS = ['aa', 'ih', 'ou', 'ee', 'oh'] as const
