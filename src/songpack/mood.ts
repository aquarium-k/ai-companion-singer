/**
 * 从参考音高轨估「这首曲子是什么心情」。
 *
 * 跟 `tools/song_mood.mjs`（离线、读曲包里的音符表）是**同一套特征和权重**，
 * 区别只在于这里的输入是渲染进程已经载入的 `F0Track`（10 ms 一格的基频），
 * 所以要先把逐帧基频**切成音符**，再算同样的特征。两边数字应该接近；
 * 差太多就说明切音方法不对（离线那边用的是流水线产出的音符表）。
 *
 * 只用旋律，所以：arousal 比较可信，valence 只能当提示——「悲伤」和「温柔」
 * 在旋律上常常是一个样子，区别在音色和编曲。权重是启发式，不是训练出来的。
 */

import { t } from '../i18n'

import type { F0Track } from './f0'

export type SongMood = {
  valence: number
  arousal: number
  word: string
  tags: string[]
  /** 调性（0 = C … 11 = B） */
  key: { tonic: number; mode: 'major' | 'minor'; r: number; confidence: number }
  notes: number
  medianPitch: number
  meanAbsInterval: number
  contour: number
  voicedRatio: number
  leapRatio: number
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Krumhansl-Kessler 调性轮廓 */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 2.69, 3.34, 3.17, 3.04]

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))
const norm = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo))
const normSigned = (v: number, lo: number, hi: number): number => norm(v, lo, hi) * 2 - 1

const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440)

type Note = { t: number; dur: number; midi: number }

/**
 * 把逐帧基频切成音符。
 *
 * 判据：音高偏离当前音符超过 0.6 个半音就换音符（颤音 ±0.3、追踪抖动 ±0.2 都进不来）；
 * 中间停超过 60 ms 算断句。这是「够用」的切法，不是真正的音符检测——
 * 对统计特征（音级分布、音程）已经够了，只是音符个数会偏多。
 */
export function notesFromF0(track: F0Track): Note[] {
  const notes: Note[] = []
  let cur: { start: number; sum: number; n: number; last: number } | null = null
  const flush = (): void => {
    if (!cur) return
    const dur = cur.last - cur.start + track.hop
    if (dur >= 0.05) notes.push({ t: cur.start, dur, midi: cur.sum / cur.n })
    cur = null
  }
  for (let i = 0; i < track.f0.length; i++) {
    const hz = track.f0[i]
    const t = i * track.hop
    if (!(hz > 0)) {
      if (cur && t - cur.last > 0.06) flush()
      continue
    }
    const midi = hzToMidi(hz)
    if (cur && Math.abs(midi - cur.sum / cur.n) > 0.6) flush()
    if (!cur) cur = { start: t, sum: 0, n: 0, last: t }
    cur.sum += midi
    cur.n += 1
    cur.last = t
  }
  flush()
  return notes
}

/** 特征 + 两维情绪。权重和 `tools/song_mood.mjs` 完全一致，改一边要同步另一边 */
export function moodFromF0(track: F0Track, bpm: number): SongMood | null {
  const notes = notesFromF0(track)
  if (notes.length < 8) return null

  const hist = new Array(12).fill(0)
  let voiced = 0
  for (const n of notes) {
    hist[((Math.round(n.midi) % 12) + 12) % 12] += n.dur
    voiced += n.dur
  }

  const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const corr = (a: number[], b: number[]): number => {
    const ma = mean(a)
    const mb = mean(b)
    let num = 0
    let da = 0
    let db = 0
    for (let i = 0; i < a.length; i++) {
      num += (a[i] - ma) * (b[i] - mb)
      da += (a[i] - ma) ** 2
      db += (b[i] - mb) ** 2
    }
    return num / (Math.sqrt(da * db) || 1)
  }

  let best = { tonic: 0, mode: 'major' as 'major' | 'minor', r: -2 }
  let bestMajor = -2
  let bestMinor = -2
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const [mode, profile] of [
      ['major', KK_MAJOR],
      ['minor', KK_MINOR],
    ] as const) {
      const rotated = profile.map((_, i) => profile[(i - tonic + 12) % 12])
      const r = corr(hist, rotated)
      if (mode === 'major') bestMajor = Math.max(bestMajor, r)
      else bestMinor = Math.max(bestMinor, r)
      if (r > best.r) best = { tonic, mode, r }
    }
  }
  const modeScore = (best.mode === 'major' ? 1 : -1) * norm(best.r, 0.3, 0.75)

  const sortedMidi = notes.map((n) => n.midi).sort((a, b) => a - b)
  const medianPitch = sortedMidi[sortedMidi.length >> 1]

  const intervals: number[] = []
  for (let i = 1; i < notes.length; i++) {
    const gap = notes[i].t - (notes[i - 1].t + notes[i - 1].dur)
    if (gap > 1.5) continue
    const d = notes[i].midi - notes[i - 1].midi
    if (Math.abs(d) <= 12) intervals.push(d)
  }
  const absInt = intervals.map(Math.abs)
  const meanAbsInterval = mean(absInt)
  const leapRatio = absInt.filter((d) => d >= 5).length / (absInt.length || 1)
  const upRatio = intervals.filter((d) => d > 0).length / (intervals.length || 1)

  const half = Math.floor(notes.length / 2)
  const wmean = (arr: Note[]): number => {
    const w = arr.reduce((a, n) => a + n.dur, 0) || 1
    return arr.reduce((a, n) => a + n.midi * n.dur, 0) / w
  }
  const contour = wmean(notes.slice(half)) - wmean(notes.slice(0, half))

  const total = Math.max(1e-3, track.duration)
  const voicedRatio = voiced / total

  const arousal =
    0.5 * norm(bpm, 62, 168) +
    0.22 * norm(meanAbsInterval, 0.8, 3.4) +
    0.16 * norm(medianPitch, 56, 72) +
    0.12 * norm(voicedRatio, 0.35, 0.8)

  const valence =
    0.46 * modeScore +
    0.16 * normSigned(bpm, 62, 168) +
    0.14 * normSigned(contour, -2, 2) +
    0.12 * normSigned(medianPitch, 56, 72) +
    0.12 * normSigned(upRatio, 0.4, 0.6)

  const v = Math.max(-1, Math.min(1, valence))
  const a = clamp01(arousal)

  return {
    valence: +v.toFixed(2),
    arousal: +a.toFixed(2),
    word: moodWord(v, a),
    tags: tagsOf(v, a, modeScore, contour, leapRatio),
    key: {
      tonic: best.tonic,
      mode: best.mode,
      r: +best.r.toFixed(3),
      confidence: +Math.abs(bestMajor - bestMinor).toFixed(3),
    },
    notes: notes.length,
    medianPitch: +medianPitch.toFixed(1),
    meanAbsInterval: +meanAbsInterval.toFixed(2),
    contour: +contour.toFixed(2),
    voicedRatio: +voicedRatio.toFixed(3),
    leapRatio: +leapRatio.toFixed(3),
  }
}

/** 调名（给面板显示）：A# 小调 */
export function keyLabel(mood: SongMood): string {
  return `${NOTES[mood.key.tonic]} ${t(mood.key.mode === 'major' ? 'bubble.key.major' : 'bubble.key.minor')}`
}

/**
 * 「这首歌是什么风格 + 推荐怎么唱」——换歌时她说的那一句。
 *
 * 纯规则拼句子，不调模型：所有输入都是算出来的数，所以同一首歌每次说的一样，
 * 也能在日志里对回去（哪句是哪个特征触发的）。以后接 LLM 的话，
 * 这一段就是「prompt 里的结构」，不是要删掉的东西。
 *
 * 语气按「她听过一遍、给个建议」来写，别写成分析报告。
 */
export function describeSong(mood: SongMood, bpm: number): { style: string; advice: string; line: string } {
  const tempo = t(bpm < 95 ? 'bubble.tempo.slow' : bpm < 125 ? 'bubble.tempo.mid' : 'bubble.tempo.fast')
  const contour = t(
    mood.contour > 2 ? 'bubble.contour.up' : mood.contour < -2 ? 'bubble.contour.down' : 'bubble.contour.flat',
  )
  const style = t('bubble.styleLine', {
    key: keyLabel(mood),
    bpm: Math.round(bpm),
    tempo,
    mood: mood.word,
    contour,
  })

  const tips: string[] = []
  if (mood.arousal >= 0.65) tips.push(t('bubble.advice.fromStart'))
  else if (mood.arousal <= 0.4) tips.push(t('bubble.advice.breathy'))
  else tips.push(t('bubble.advice.build'))

  if (mood.leapRatio > 0.28) tips.push(t('bubble.advice.leap'))
  if (mood.medianPitch >= 68) tips.push(t('bubble.advice.high'))
  else if (mood.medianPitch <= 60) tips.push(t('bubble.advice.low'))
  if (mood.key.mode === 'minor' && mood.key.confidence > 0.08) tips.push(t('bubble.advice.semitone'))
  if (mood.voicedRatio > 0.75) tips.push(t('bubble.advice.busy'))

  // 建议最多三条：三条以上读不完，气泡也会挡脸
  const advice = tips.slice(0, 3).join(t('bubble.join'))
  return { style, advice, line: t('bubble.full', { style, advice }) }
}

function moodWord(valence: number, arousal: number): string {
  if (arousal >= 0.6 && valence >= 0.15) return t('bubble.mood.warm')
  if (arousal >= 0.6 && valence <= -0.15) return t('bubble.mood.tense')
  if (arousal >= 0.6) return t('bubble.mood.strong')
  if (arousal <= 0.4 && valence >= 0.2) return t('bubble.mood.soft')
  if (arousal <= 0.4 && valence <= -0.15) return t('bubble.mood.heavy')
  if (arousal <= 0.4) return t('bubble.mood.quiet')
  if (valence >= 0.15) return t('bubble.mood.bright')
  if (valence <= -0.15) return t('bubble.mood.oppressed')
  return t('bubble.mood.flat')
}

function tagsOf(
  valence: number,
  arousal: number,
  modeScore: number,
  contour: number,
  leapRatio: number,
): string[] {
  const tags: string[] = []
  if (arousal >= 0.6 && valence >= 0.15) tags.push('燃', '上头')
  else if (arousal >= 0.6 && valence <= -0.15) tags.push('冲', '压迫')
  else if (arousal >= 0.6) tags.push('有力')
  else if (arousal <= 0.4 && valence >= 0.2) tags.push('温柔', '治愈')
  else if (arousal <= 0.4 && valence <= -0.15) tags.push('闷', '丧')
  else if (arousal <= 0.4) tags.push('安静')
  else if (valence >= 0.15) tags.push('轻快')
  else if (valence <= -0.15) tags.push('克制')
  else tags.push('叙事')
  if (modeScore < -0.15) tags.push('小调')
  if (modeScore > 0.15) tags.push('大调')
  if (leapRatio > 0.28) tags.push('跳进多')
  if (contour > 2) tags.push('上行')
  if (contour < -2) tags.push('下行')
  return tags
}
