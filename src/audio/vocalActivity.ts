/**
 * 人声活动包络：和声「该不该响」的依据。
 *
 * 为什么不能只看谱面：`work/f0.json` 是离线基频追踪的结果，分离残留和气声
 * 会让它在**人没唱**的地方也冒出音高（实测：有声帧里有 3.1% 比中位电平低
 * 18 dB 以上，最长连续 0.92 s）。只看 f0，和声就会在换气和间奏处继续唱。
 *
 * 这里直接从**分离后的人声轨**（`stems/vocals.mp3`，播放端本来就解码了这份
 * stem）算一条 20 ms 窗 / 10 ms 跳的 RMS 包络，再用**迟滞**判「在不在唱」：
 * 超过参考电平 −22 dB 才算开始，掉到 −30 dB 以下才算结束，
 * 免得小起伏把和声切成碎块。
 *
 * 调用方会给一个**提前量**（`at(t + 0.15)`）：真人合唱会在主唱换气前先收，
 * 这里用「看未来的活动」来近似——未来没在唱，现在就开始收。
 */

export type VocalActivity = {
  /** 逐帧时长（秒） */
  hop: number
  /** 每帧 RMS（0..1，按整条轨的最大值归一） */
  rms: Float32Array
  /** 参考电平（RMS 的 90 分位） */
  ref: number
  /** 这一刻在不在唱（带迟滞；时间往回跳会自动重置） */
  at: (t: number) => boolean
  /** 这一刻的原始 RMS（调试用） */
  levelAt: (t: number) => number
}

const WIN = 0.02
const HOP = 0.01
/** 开始唱的阈值（相对参考电平，dB） */
const ON_DB = -26
/** 停下来的阈值（相对参考电平，dB），比 ON 低 10 dB 构成迟滞 */
const OFF_DB = -36
/**
 * 状态至少要稳定这么久才允许翻转（秒）。
 *
 * 实测（demo 曲包）：阈值卡在 −20 dB 时，正常演唱的 RMS 就在 −21~−28 之间来回，
 * 门控每 40 ms 翻一次，和声电平跟着在 0.37~1.0 之间抖——比不门控更糟。
 * 有了 10 dB 迟滞 + 这个驻留时间，才不会在句子里抖。
 */
const MIN_DWELL = 0.2

export function buildVocalActivity(buffer: AudioBuffer): VocalActivity {
  const sr = buffer.sampleRate
  const hop = Math.max(1, Math.round(HOP * sr))
  const win = Math.max(hop, Math.round(WIN * sr))
  const channels: Float32Array[] = []
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c))
  const count = Math.max(1, Math.floor((buffer.length - win) / hop) + 1)

  const rms = new Float32Array(count)
  for (let i = 0; i < count; i++) {
    const start = i * hop
    let sum = 0
    for (const data of channels) {
      for (let j = start; j < start + win && j < data.length; j++) {
        const v = data[j]
        sum += v * v
      }
    }
    rms[i] = Math.sqrt(sum / (win * channels.length))
  }

  // 参考电平用 90 分位：句中的正常音量，不会被个别峰值抬走
  const sorted = Float32Array.from(rms).sort()
  const ref = sorted[Math.floor(sorted.length * 0.9)] || 1e-6
  const on = ref * Math.pow(10, ON_DB / 20)
  const off = ref * Math.pow(10, OFF_DB / 20)

  let state = false
  let since = -1
  let lastIndex = -1
  const indexAt = (t: number): number => {
    const i = Math.round(t / HOP)
    return Math.max(0, Math.min(count - 1, i))
  }

  return {
    hop: HOP,
    rms,
    ref,
    levelAt: (t: number) => rms[indexAt(t)],
    at: (t: number) => {
      const i = indexAt(t)
      // 往回跳（重播/拖进度）时把迟滞状态重置，否则会带着旧状态
      if (i < lastIndex - 5) {
        state = false
        since = -1
      }
      lastIndex = i
      const v = rms[i]
      const stable = since < 0 || t - since >= MIN_DWELL
      if (state) {
        if (v < off && stable) {
          state = false
          since = t
        }
      } else if (v > on && stable) {
        state = true
        since = t
      }
      return state
    },
  }
}
