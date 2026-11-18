/**
 * 曲子的「心情 / 氛围」分析（第一版，只做旋律，不接界面）。
 *
 * 输入是曲包里**已经有**的东西：`pack.json`（bpm / 时长）+ `work/f0.json`（音符表
 * `[起点, 时长, MIDI]`）。所以不用重新解码音频，跑一遍几毫秒。
 *
 * 输出两个数 + 调性 + 标签，写进 `mood.json`：
 *
 *   valence（−1 忧郁 … +1 愉快）   arousal（0 平静 … 1 激动）
 *
 * 为什么先做两维：这两维有公开标注集（DEAM / PMEmo）可以校准，「治愈 / 燃 / 丧」这种
 * 8 类标签没有可靠标注，算出来也没法验。而且它俩正好对得上「灯要暖还是冷、动作要多烈」。
 *
 * 用法：
 *   node tools/song_mood.mjs public/songpacks/<id>            # 只打印
 *   node tools/song_mood.mjs public/songpacks/<id> --write    # 写 mood.json
 *   node tools/song_mood.mjs --all                            # 所有曲包一览
 *
 * 局限（写在这里，免得以后当成 bug）：
 * - 只看主旋律。很多「悲伤」和「温柔」在旋律上几乎一样，区分它们靠音色和编曲，
 *   所以 valence 只能当提示，别当判据；
 * - 调性靠 Krumhansl-Schmuckler 的相关，短歌 / 转调多的时候置信度低（会一起打出来）；
 * - 没有唱词情绪。歌词那条线要另做（`lyrics.units.json` 里有时间，可以接 LLM）。
 */
import fs from 'node:fs'
import path from 'node:path'

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Krumhansl-Kessler 调性轮廓（大调 / 小调），音级权重按主音起算 */
const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 2.69, 3.34, 3.17, 3.04]

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const norm = (v, lo, hi) => clamp01((v - lo) / (hi - lo))
/** 把一个量压到 −1..1（中点在中间） */
const normSigned = (v, lo, hi) => norm(v, lo, hi) * 2 - 1
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const percentile = (xs, p) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 从音符表算特征。`notes` 是 `[t, dur, midi]`，可能带 `-1`/0 的无效音，先滤掉。
 */
export function featuresOf(notes, bpm, duration) {
  const ns = notes
    .filter((n) => Array.isArray(n) && n.length >= 3 && n[2] > 0 && n[1] > 0)
    .map(([t, dur, midi]) => ({ t, dur, midi }))
    .sort((a, b) => a.t - b.t)
  if (ns.length < 8) return null

  // 音级直方图（按时长加权，避免长音多的调被短音淹没）
  const hist = new Array(12).fill(0)
  for (const n of ns) hist[((n.midi % 12) + 12) % 12] += n.dur
  const histSum = hist.reduce((a, b) => a + b, 0) || 1

  // 调性：和 24 个轮廓做相关，取最大；置信度 = 大调最佳与另一个的最佳之差
  const corr = (a, b) => {
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
  let best = { tonic: 0, mode: 'major', r: -2 }
  let bestMajor = -2
  let bestMinor = -2
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = (profile) => profile.map((_, i) => profile[(i - tonic + 12) % 12])
    for (const [mode, profile] of [
      ['major', KK_MAJOR],
      ['minor', KK_MINOR],
    ]) {
      const r = corr(hist, rot(profile))
      if (mode === 'major') bestMajor = Math.max(bestMajor, r)
      else bestMinor = Math.max(bestMinor, r)
      if (r > best.r) best = { tonic, mode, r }
    }
  }
  const modeScore = (best.mode === 'major' ? 1 : -1) * norm(best.r, 0.3, 0.75)
  const keyConfidence = Math.abs(bestMajor - bestMinor)

  const midis = ns.map((n) => n.midi)
  /** 按时长加权的平均音高（不能用 mean(midi*dur)，那是乘积的平均，量纲都不对） */
  const wmeanPitch = (arr) => {
    const w = arr.reduce((a, n) => a + n.dur, 0) || 1
    return arr.reduce((a, n) => a + n.midi * n.dur, 0) / w
  }
  const durWeightedPitch = wmeanPitch(ns)

  // 音程（跳过跨休止的大跳，>1.5 s 认为换句）
  const intervals = []
  for (let i = 1; i < ns.length; i++) {
    const gap = ns[i].t - (ns[i - 1].t + ns[i - 1].dur)
    if (gap > 1.5) continue
    const d = ns[i].midi - ns[i - 1].midi
    if (Math.abs(d) <= 12) intervals.push(d)
  }
  const absInt = intervals.map(Math.abs)
  const stepRatio = absInt.filter((d) => d <= 2).length / (absInt.length || 1)
  const leapRatio = absInt.filter((d) => d >= 5).length / (absInt.length || 1)
  const upRatio = intervals.filter((d) => d > 0).length / (intervals.length || 1)

  // 旋律轮廓：前后半段的平均音高差（半音），>0 上行
  const half = Math.floor(ns.length / 2)
  const firstHalf = wmeanPitch(ns.slice(0, half))
  const secondHalf = wmeanPitch(ns.slice(half))
  const contour = secondHalf - firstHalf

  const voiced = ns.reduce((a, n) => a + n.dur, 0)
  const spanNotes = Math.max(1e-3, ns[ns.length - 1].t + ns[ns.length - 1].dur - ns[0].t)
  const spanAll = Math.max(1e-3, duration || spanNotes)
  const density = ns.length / spanAll
  const meanDur = voiced / ns.length
  const staccatoRatio = ns.filter((n) => n.dur < 0.25).length / ns.length
  const voicedRatio = voiced / spanAll

  // 落在拍点上（±80 ms）的起音比例：稳不稳
  const secPerBeat = 60 / (bpm || 120)
  let onBeat = 0
  for (const n of ns) {
    const phase = (n.t / secPerBeat) % 1
    if (Math.min(phase, 1 - phase) * secPerBeat < 0.08) onBeat += 1
  }
  const onBeatRatio = onBeat / ns.length

  return {
    notes: ns.length,
    bpm: +(bpm || 0).toFixed(1),
    duration: +spanAll.toFixed(1),
    medianPitch: +median(midis).toFixed(1),
    pitchP10: percentile(midis, 0.1),
    pitchP90: percentile(midis, 0.9),
    meanPitchWeighted: +durWeightedPitch.toFixed(1),
    key: { tonic: NOTES[best.tonic], mode: best.mode, r: +best.r.toFixed(3), confidence: +keyConfidence.toFixed(3) },
    modeScore: +modeScore.toFixed(3),
    meanAbsInterval: +mean(absInt).toFixed(2),
    stepRatio: +stepRatio.toFixed(3),
    leapRatio: +leapRatio.toFixed(3),
    upRatio: +upRatio.toFixed(3),
    contour: +contour.toFixed(2),
    density: +density.toFixed(3),
    meanDur: +meanDur.toFixed(3),
    staccatoRatio: +staccatoRatio.toFixed(3),
    voicedRatio: +voicedRatio.toFixed(3),
    onBeatRatio: +onBeatRatio.toFixed(3),
  }
}

/**
 * 特征 → 两维情绪。权重的挑法：先让每个量和「能量 / 明暗」直觉同向，
 * 再用线上三首对照用户听感调。**这是启发式，不是训练出来的**——
 * 要真数字得拿 DEAM / PMEmo 拟合（下一步）。
 */
export function moodOf(f) {
  // 密度（notes/s）**故意不参与**：f0 的音符切分会把连音/滑音切碎，
  // 实测白花（88 BPM 的慢歌）notes 密度 2.68 反而比 147 BPM 的 CHAINSAW 高，
  // 拿它当「能量」会把慢歌推高。等接了真正的起音检测再用。
  const arousal =
    0.50 * norm(f.bpm, 62, 168) +
    0.22 * norm(f.meanAbsInterval, 0.8, 3.4) +
    0.16 * norm(f.medianPitch, 56, 72) +
    0.12 * norm(f.voicedRatio, 0.35, 0.8)

  const valence =
    0.46 * f.modeScore +
    0.16 * normSigned(f.bpm, 62, 168) +
    0.14 * normSigned(f.contour, -2, 2) +
    0.12 * normSigned(f.medianPitch, 56, 72) +
    0.12 * normSigned(f.upRatio, 0.4, 0.6)

  const v = +Math.max(-1, Math.min(1, valence)).toFixed(2)
  const a = +clamp01(arousal).toFixed(2)
  return { valence: v, arousal: a, tags: tagsOf(v, a, f), mood: moodWord(v, a) }
}

/** 二维网格上的粗标签。阈值故意宽：数值差一点不该换一个词。 */
function tagsOf(valence, arousal, f) {
  const tags = []
  if (arousal >= 0.6 && valence >= 0.15) tags.push('燃', '上头')
  else if (arousal >= 0.6 && valence <= -0.15) tags.push('冲', '压迫')
  else if (arousal >= 0.6) tags.push('有力')
  else if (arousal <= 0.4 && valence >= 0.2) tags.push('温柔', '治愈')
  else if (arousal <= 0.4 && valence <= -0.15) tags.push('闷', '丧')
  else if (arousal <= 0.4) tags.push('安静')
  else if (valence >= 0.15) tags.push('轻快')
  else if (valence <= -0.15) tags.push('克制')
  else tags.push('叙事')
  if (f.modeScore < -0.15) tags.push('小调')
  if (f.modeScore > 0.15) tags.push('大调')
  if (f.leapRatio > 0.28) tags.push('跳进多')
  if (f.stepRatio > 0.75) tags.push('级进多')
  if (f.contour > 2) tags.push('上行')
  if (f.contour < -2) tags.push('下行')
  return tags
}

function moodWord(valence, arousal) {
  if (arousal >= 0.6 && valence >= 0.15) return '热烈'
  if (arousal >= 0.6 && valence <= -0.15) return '紧绷'
  if (arousal >= 0.6) return '有劲'
  if (arousal <= 0.4 && valence >= 0.2) return '柔和'
  if (arousal <= 0.4 && valence <= -0.15) return '沉'
  if (arousal <= 0.4) return '安静'
  if (valence >= 0.15) return '明快'
  if (valence <= -0.15) return '压抑'
  return '平缓'
}

function packMood(dir) {
  const pack = readJson(path.join(dir, 'pack.json'))
  const f0Path = path.join(dir, pack.assets?.f0 ?? 'work/f0.json')
  if (!fs.existsSync(f0Path)) return { id: pack.id ?? path.basename(dir), error: `没有 ${path.relative(dir, f0Path)}` }
  const f0 = readJson(f0Path)
  const features = featuresOf(f0.notes ?? [], pack.bpm, pack.duration ?? f0.duration ?? 0)
  if (!features) return { id: pack.id ?? path.basename(dir), error: '音符太少' }
  const mood = moodOf(features)
  return {
    id: pack.id ?? path.basename(dir),
    title: pack.title ?? '',
    mood: {
      schema: 1,
      computedAt: new Date().toISOString(),
      valence: mood.valence,
      arousal: mood.arousal,
      word: mood.mood,
      tags: mood.tags,
      key: features.key,
      features,
    },
  }
}

const args = process.argv.slice(2)
const write = args.includes('--write')
const all = args.includes('--all')
const dirs = args.filter((a) => !a.startsWith('--'))

if (all || dirs.length === 0) {
  const root = path.join(process.cwd(), 'public', 'songpacks')
  const packs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'pack.json')))
  console.log('曲包'.padEnd(34) + 'BPM   调性        valence arousal 词    标签')
  for (const d of packs) {
    const r = packMood(path.join(root, d))
    if (r.error) {
      console.log(d.padEnd(34) + '  — ' + r.error)
      continue
    }
    const m = r.mood
    const key = `${m.key.tonic} ${m.key.mode === 'major' ? '大' : '小'}`
    console.log(
      d.padEnd(30) +
        String(m.features.bpm).padStart(6) +
        '  ' +
        key.padEnd(10) +
        String(m.valence).padStart(7) +
        String(m.arousal).padStart(8) +
        '  ' +
        m.word.padEnd(5) +
        m.tags.join('/'),
    )
    if (write) fs.writeFileSync(path.join(root, d, 'mood.json'), JSON.stringify(m, null, 2) + '\n')
  }
} else {
  for (const dir of dirs) {
    const r = packMood(dir)
    if (r.error) {
      console.error(`${dir}: ${r.error}`)
      continue
    }
    console.log(JSON.stringify(r.mood, null, 2))
    if (write) {
      fs.writeFileSync(path.join(dir, 'mood.json'), JSON.stringify(r.mood, null, 2) + '\n')
      console.log(`→ ${path.join(dir, 'mood.json')}`)
    }
  }
}
