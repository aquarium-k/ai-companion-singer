/**
 * 「谱面」：把逐帧基频锁到**八分音符网格**上的离散音高。
 *
 * 用户 2026-11-13 的两条约束（合并）：
 *   「音符的节奏性是很强的……把音高、音的时长锁定好即可。」
 *   「『同一时间段只能出现一种音高』——但你这版可能又太严了，1/8 音符还是得考虑的。」
 *
 * 也就是：音高必须离散（不能是逐帧连续漂移），但**最小单位是八分音符**，
 * 不能一把按 mora 拍死（mora 不等于音符：一个字可能唱两个八分音符）。
 *
 * 做法：
 *   1. 按 **1/8 音符**（60 / bpm / 2 秒）切格子；
 *   2. 每格取格内浊音帧的**中位数**，四舍五入到半音；
 *   3. 格内浊音太少（<4 帧）就沿用上一格；
 *   4. **八度保护**：新音与上一音差 ≈12 个半音、且格长只有一格时，判为追踪跳八度，
 *      折回上一音所在的八度（真唱在八分音符上跳八度的概率很低）。
 *
 * 白花 0:45 那段（原始 f0 在 1.6 秒里跨了 7 个半音）现在会被锁成
 * 「几个八分音符各一个音」，而不是一刀切成一个 mora 一个音。
 */

import type { F0Track } from './f0'

/** 一格内至少这么多帧浊音才用它自己的音高 */
const MIN_VOICED = 4
/** bpm 未知时退化成 200 ms 一格 */
const FALLBACK_GRID = 0.2

export type MoraSpan = { t: number; d: number }

export type ScoreOptions = {
  /** 每分钟拍数（0/缺省 = 用 200 ms 兜底） */
  bpm?: number
  offset?: number
}

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440)
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

/** 八分音符的长度（秒） */
export function eighthNote(bpm: number | undefined): number {
  return bpm && bpm > 20 ? 60 / bpm / 2 : FALLBACK_GRID
}

/**
 * 逐帧基频 → 八分音符网格上的离散音高（返回和 F0Track 同构，可直接替换 f0At）。
 * `spans` 只用来兜底（整条没有 bpm 时按 mora 取中位数），正常情况下不使用。
 */
export function buildScoreTrack(
  f0: F0Track,
  spans: MoraSpan[],
  options: ScoreOptions = {},
): F0Track {
  const hop = f0.hop
  const count = f0.f0.length
  const out = new Float32Array(count)
  const src = f0.f0
  if (count === 0) return { hop, f0: out, duration: f0.duration }

  const grid = eighthNote(options.bpm)
  const offset = (options.offset ?? 0) % grid
  const cellFrames = Math.max(2, Math.round(grid / hop))
  const cells = Math.ceil((f0.duration - offset) / grid) + 1

  // 1) 每格一个半音音高（0 = 这格没唱）
  const notes = new Int16Array(cells)
  for (let c = 0; c < cells; c++) {
    const from = Math.max(0, Math.round((offset + c * grid) / hop))
    const to = Math.min(count, Math.round((offset + (c + 1) * grid) / hop))
    const values: number[] = []
    for (let i = from; i < to; i++) if (src[i] > 0) values.push(src[i])
    if (values.length < Math.min(MIN_VOICED, Math.max(2, cellFrames >> 2))) continue
    values.sort((a, b) => a - b)
    notes[c] = Math.round(hzToMidi(values[values.length >> 1]))
  }

  // 2) 空洞沿用上一格（最多 2 格，超过就是真停顿）
  for (let c = 1; c < cells; c++) {
    if (notes[c] > 0) continue
    let back = 0
    while (back < 3 && c - back - 1 >= 0 && notes[c - back - 1] === 0) back++
    if (notes[c - back - 1] > 0 && back < 3) notes[c] = notes[c - back - 1]
  }

  // 3) 八度保护：与上一格差 ≈12 半音时折回
  for (let c = 1; c < cells; c++) {
    const prev = notes[c - 1]
    const cur = notes[c]
    if (prev === 0 || cur === 0) continue
    const d = cur - prev
    if (Math.abs(d) >= 10 && Math.abs(d) <= 14) notes[c] = cur - Math.sign(d) * 12
  }

  // 4) 写回逐帧
  for (let c = 0; c < cells; c++) {
    const midi = notes[c]
    if (!midi) continue
    const hz = midiToHz(midi)
    const from = Math.max(0, Math.round((offset + c * grid) / hop))
    const to = Math.min(count, Math.round((offset + (c + 1) * grid) / hop))
    for (let i = from; i < to; i++) out[i] = hz
  }

  // 5) 完全没有 bpm 的曲包：按 mora 取中位数兜底（同样的半音锁）
  if (options.bpm === undefined || options.bpm <= 20) {
    for (const span of spans) {
      const from = Math.max(0, Math.floor((span.t + 0.05) / hop))
      const to = Math.min(count, Math.floor((span.t + Math.max(span.d - 0.03, 0.05)) / hop))
      let has = false
      for (let i = from; i < to; i++) if (out[i] > 0) has = true
      if (has) continue
      let prev = 0
      for (let i = from - 1; i >= Math.max(0, from - 40); i--) {
        if (out[i] > 0) {
          prev = out[i]
          break
        }
      }
      if (prev > 0) for (let i = from; i < to; i++) out[i] = prev
    }
  }

  return { hop, f0: out, duration: f0.duration }
}

/** 取 t 秒处的谱面音高（Hz），越界返回 0 */
export function scoreAt(track: F0Track | null, t: number): number {
  if (!track) return 0
  const i = Math.floor(t / track.hop)
  if (i < 0 || i >= track.f0.length) return 0
  return track.f0[i]
}

/** 一个**音符**：同音高的连续格子合并成一段。`t` 起点、`d` 时长、`hz` 音高。 */
export type NoteSpan = { t: number; d: number; hz: number }

/**
 * 谱面 → 音符表（同音高的连续帧合并）。
 *
 * 用户 2026-11-14：「还是需要继续引入每个音时长的判定，这应该是现在有些不够稳定的原因之一」。
 * 谱面只回答了「这一刻是什么音高」，没回答「这个音还有多久」——而咬字的凹陷、
 * 辅音替换的让位长度、颤音重启，全都要按**这个音还剩多少时间**来定：
 * 一个 100 ms 的音上砸 41 ms 的闭塞，等于把这个音吃掉一半。
 *
 * `minSec` 滤掉毛刺（默认 50 ms）。
 */
export function buildNoteSpans(track: F0Track | null, minSec = 0.05): NoteSpan[] {
  if (!track || track.f0.length === 0) return []
  const hop = track.hop
  const data = track.f0
  const out: NoteSpan[] = []
  let start = -1
  let hz = 0
  const flush = (endIndex: number): void => {
    if (start < 0 || hz <= 0) return
    const d = (endIndex - start) * hop
    if (d >= minSec) out.push({ t: start * hop, d, hz })
  }
  for (let i = 0; i < data.length; i++) {
    const cur = data[i]
    // 同一个音 = 同一个半音（谱面已经锁到半音，所以容差给 0.5 个半音就够）
    const same = cur > 0 && hz > 0 && Math.abs(12 * Math.log2(cur / hz)) < 0.5
    if (!same) {
      flush(i)
      start = cur > 0 ? i : -1
      hz = cur
    }
  }
  flush(data.length)
  return out
}

/** 二分查 t 秒落在哪个音符里；不在任何音符里返回 null */
export function noteAt(spans: NoteSpan[], t: number): NoteSpan | null {
  if (spans.length === 0) return null
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = spans[mid]
    if (t < s.t) hi = mid - 1
    else if (t >= s.t + s.d) lo = mid + 1
    else return s
  }
  return null
}
