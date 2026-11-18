/**
 * 待机哼歌：从谱面里挑一段能哼的旋律，交给和声那个合成器代唱。
 *
 * 为什么从 `work/f0.json` 里挑，而不是存音频：曲包本来就有谱面，音频可以从
 * 采样现算（和声那套循环采样 + playbackRate）；存音频反而占体积、还要处理授权。
 *
 * 挑法（简单但够用）：
 *   1. 找出所有**连续有声**的段（10 ms 一格）；
 *   2. 只看长度 ≥ 目标时长的；
 *   3. 优先「音高变化适中」的段——太平像念经，跳太多哼不出来；
 *   4. 从段首开始截，段首通常正好是乐句开头（前面是换气）。
 */

import type { F0Track } from '../songpack/f0'

export type HumPhrase = {
  /** 旋律从谱面的哪一秒开始（调试用） */
  from: number
  /** 时长（秒） */
  dur: number
  /** 逐帧 Hz（10 ms 一格），0 = 不发声 */
  hz: Float32Array
}

const GRID = 0.01

/** 半音距离（用来衡量「这段好不好哼」） */
function semitones(a: number, b: number): number {
  return Math.abs(12 * Math.log2(a / b))
}

export function pickHumPhrase(
  track: F0Track,
  seconds = 4,
  random: () => number = Math.random,
): HumPhrase | null {
  const f0 = track.f0
  const need = Math.round(seconds / GRID)
  if (f0.length < need) return null

  // 1) 连续有声段
  const runs: Array<{ start: number; len: number }> = []
  let i = 0
  while (i < f0.length) {
    if (f0[i] > 0) {
      const start = i
      while (i < f0.length && f0[i] > 0) i++
      runs.push({ start, len: i - start })
    } else {
      i++
    }
  }

  // 2) 够长的段，按「音高变化适中」打分
  const candidates = runs
    .filter((r) => r.len >= need)
    .map((r) => {
      let jump = 0
      let last = 0
      let n = 0
      for (let k = r.start; k < r.start + need; k++) {
        const hz = f0[k]
        if (hz <= 0) continue
        if (last > 0) {
          jump += semitones(hz, last)
          n++
        }
        last = hz
      }
      // 平均每 10 ms 的音高变化：0.02~0.15 半音算自然，太平/太跳都扣分
      const avg = n > 0 ? jump / n : 0
      const score = 1 / (1 + Math.abs(Math.log((avg + 0.005) / 0.05)))
      return { ...r, avg, score }
    })
    .sort((a, b) => b.score - a.score)

  if (candidates.length === 0) return null
  // 在前几名里随机挑一个，免得每次哼同一句
  const top = candidates.slice(0, Math.min(3, candidates.length))
  const pick = top[Math.floor(random() * top.length)]

  const hz = new Float32Array(need)
  for (let k = 0; k < need; k++) hz[k] = f0[pick.start + k]

  return {
    from: +(pick.start * GRID).toFixed(2),
    dur: need * GRID,
    hz,
  }
}
