/**
 * 实时音高追踪（YIN）。
 *
 * 为什么自己写而不是用现成的：
 *   浏览器里没有低延迟的音高检测 API。`AnalyserNode` 只给 FFT 幅度，
 *   谐波多的女声直接挑峰值会频繁跳八度；而 YIN 的累积均值归一化正是
 *   为这个问题设计的，且我们离线流程（`tools/extract_f0.py`）已经在用它，
 *   两边结果可以直接对比。
 *
 * 参数怎么定的：
 *   - 16 kHz：人声基频 65~1000 Hz，8 kHz 带宽绰绰有余，而样本数是 44.1k 的 1/3，
 *     单帧计算量直接降到 1/3。AudioContext 可以直接以 16000 建，不需要自己重采样。
 *   - 32 ms 窗（512 点）：65 Hz 的周期是 246 点，窗里勉强有两个周期；
 *     再短就漏低音，再长则延迟变大。实测单帧 0.16 ms，实时预算的 1.6%。
 *   - 10 ms 帧移：100 帧/秒的判定频率，够用来判「跟上没跟上」。
 *
 * 单帧算法与 `tools/extract_f0.py` 的 `yin()` 一一对应（同样的 CMNDF、
 * 同样的「先找低于阈值的第一点再往谷底走」、同样的抛物线插值），
 * 这样离线验证过的结论可以直接搬到线上。实测与 numpy 版逐帧对拍：
 * 发声一致率 100%，音分中位差 0.6。
 *
 * 两种模式
 * --------
 * `yinFrame`  全音域找（65~1000 Hz）。适合「用户随便唱」的检测。
 * `yinGuided` 只在给定参考音高附近找（±2 半音）。伴唱判定必须用这个：
 *             麦克风里还有伴奏，全音域搜索会被音乐带跑（实测混音下只有 41%
 *             的帧落在 50 音分内、八度错 15.5%）；
 *             而且「跟没跟上」本来就不需要知道绝对音高，只需要知道**偏差**。
 */

/** 采样率：AudioContext 以这个值创建，AudioWorklet 拿到的就是它。 */
export const PITCH_SR = 16000
/** 帧移（样本数）= 10 ms */
export const PITCH_HOP = 160
/** 窗长（样本数）= 32 ms */
export const PITCH_WIN = 512
/** 人声范围。低于 65 Hz 通常是噪声，高于 1000 Hz 是哨音/齿音。 */
export const PITCH_F0_MIN = 65
export const PITCH_F0_MAX = 1000
/** 伴唱模式下参考音高附近的搜索半径（半音） */
export const GUIDE_SEMITONES = 2

const TAU_MIN = Math.max(2, Math.floor(PITCH_SR / PITCH_F0_MAX))
const TAU_MAX = Math.min(PITCH_WIN - 1, Math.floor(PITCH_SR / PITCH_F0_MIN))
const YIN_THRESHOLD = 0.15
/** CMNDF 最小值高于这个值时认为「没有周期」。 */
const CLARITY_FLOOR = 0.6
/** 伴唱模式更严：低于这个才认为「用户确实唱出了这个音」 */
const GUIDE_FLOOR = 0.35

export type PitchFrame = {
  /** 基频 Hz，0 = 本帧没找到周期 */
  f0: number
  /** 1 - CMNDF 最小值，0..1，越大越像周期信号 */
  clarity: number
  /** 本帧 RMS，用来做「在不在唱」的门限 */
  rms: number
}

const frame = new Float32Array(PITCH_WIN)
const diffArr = new Float32Array(TAU_MAX + 2)
const cum = new Float32Array(TAU_MAX + 2)

/** 去均值 + 算差分函数 + 累积均值归一化。两种模式共用这一半。 */
function prepare(x: Float32Array, off: number, out: PitchFrame): boolean {
  if (off + PITCH_WIN > x.length) {
    out.f0 = 0
    out.clarity = 0
    out.rms = 0
    return false
  }

  let mean = 0
  for (let i = 0; i < PITCH_WIN; i++) mean += x[off + i]
  mean /= PITCH_WIN

  let energy = 0
  for (let i = 0; i < PITCH_WIN; i++) {
    const v = x[off + i] - mean
    frame[i] = v
    energy += v * v
  }
  out.rms = Math.sqrt(energy / PITCH_WIN)

  // 差分函数 d(τ) = Σ (f[j] - f[j+τ])²
  diffArr[0] = 0
  for (let tau = 1; tau <= TAU_MAX + 1; tau++) {
    const n = PITCH_WIN - tau
    let sum = 0
    for (let j = 0; j < n; j++) {
      const d = frame[j] - frame[j + tau]
      sum += d * d
    }
    diffArr[tau] = sum
  }

  // 累积均值归一化（CMNDF）
  cum[0] = 0
  for (let tau = 1; tau <= TAU_MAX + 1; tau++) cum[tau] = cum[tau - 1] + diffArr[tau]
  return true
}

/** CMNDF 的值，随用随算，省一个数组 */
function dn(tau: number): number {
  const denom = cum[tau] / tau
  if (denom < 1e-9) return 1
  return diffArr[tau] / denom
}

/**
 * 在 [tauLo, tauHi) 里挑周期。
 * 优先取第一个低于阈值的点再往谷底走（YIN 的原始做法，避免挑到次谐波），
 * 整个区间都不过阈值时退回区间最小值。
 */
function pickLag(tauLo: number, tauHi: number, floor: number): { lag: number; value: number } {
  const lo = Math.max(TAU_MIN, tauLo)
  const hi = Math.min(TAU_MAX, tauHi)
  if (hi - lo < 2) return { lag: -1, value: 1 }

  for (let tau = lo; tau < hi; tau++) {
    if (dn(tau) < YIN_THRESHOLD) {
      let lag = tau
      while (lag + 1 < hi && dn(lag + 1) < dn(lag)) lag++
      return { lag, value: dn(lag) }
    }
  }

  let best = lo
  let bestVal = Infinity
  for (let tau = lo; tau < hi; tau++) {
    const v = dn(tau)
    if (v < bestVal) {
      bestVal = v
      best = tau
    }
  }
  if (bestVal > floor) return { lag: -1, value: bestVal }
  return { lag: best, value: bestVal }
}

function finish(lag: number, value: number, out: PitchFrame): PitchFrame {
  let shift = 0
  if (lag > TAU_MIN && lag < TAU_MAX - 1) {
    const a = dn(lag - 1)
    const b = dn(lag)
    const c = dn(lag + 1)
    const denom = a - 2 * b + c
    if (Math.abs(denom) > 1e-9) shift = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom))
  }
  out.f0 = PITCH_SR / (lag + shift)
  out.clarity = Math.max(0, Math.min(1, 1 - value))
  return out
}

/** 全音域一帧（65~1000 Hz）。`out` 由调用方复用，避免每帧分配。 */
export function yinFrame(x: Float32Array, off: number, out: PitchFrame): PitchFrame {
  if (!prepare(x, off, out)) return out
  const { lag, value } = pickLag(TAU_MIN, TAU_MAX, CLARITY_FLOOR)
  if (lag < 0) {
    out.f0 = 0
    out.clarity = 0
    return out
  }
  return finish(lag, value, out)
}

/**
 * 受限一帧：只在 `refHz` 的 ±GUIDE_SEMITONES 内找。
 * `refHz <= 0`（这一拍本来就没人声）时直接返回无声。
 */
export function yinGuided(
  x: Float32Array,
  off: number,
  refHz: number,
  out: PitchFrame,
  floor = GUIDE_FLOOR,
): PitchFrame {
  if (!(refHz > 0) || !prepare(x, off, out)) {
    out.f0 = 0
    out.clarity = 0
    return out
  }
  const ratio = Math.pow(2, GUIDE_SEMITONES / 12)
  const tauLo = Math.floor(PITCH_SR / (refHz * ratio))
  const tauHi = Math.ceil(PITCH_SR / (refHz / ratio)) + 1
  const { lag, value } = pickLag(tauLo, tauHi, floor)
  if (lag < 0) {
    out.f0 = 0
    out.clarity = 0
    return out
  }
  return finish(lag, value, out)
}

/**
 * 流式封装：喂任意长度的块，按 10 ms 产出一帧。
 *
 * 内部维护一段连续的样本缓冲和一个「下一帧起点」。取样块很便宜（一次 set），
 * 帧起点每 10 ms 前进 160 点；左侧用过的样本攒到一定量再整体丢弃，
 * 避免每帧都做 512 点的搬移。
 */
export class PitchStream {
  private buf = new Float32Array(PITCH_WIN * 8)
  private len = 0
  private offset = 0

  /** 已经产出的帧数，用于对齐时间轴 */
  frames = 0

  write(block: Float32Array): void {
    const need = this.len + block.length
    if (need > this.buf.length) {
      // 和离线实现保持同样的帧起点，所以先把左边没用到的部分搬走再扩容
      const keepFrom = Math.min(this.offset, this.len)
      const keep = this.len - keepFrom
      const next = new Float32Array(Math.max(need - keepFrom, PITCH_WIN * 8))
      next.set(this.buf.subarray(keepFrom, this.len), 0)
      this.buf = next
      this.len = keep
      this.offset -= keepFrom
    }
    this.buf.set(block, this.len)
    this.len += block.length
  }

  /** 有一整帧可取时写进 `out` 并返回 true；`refHz` 给了就走受限模式 */
  pull(out: PitchFrame, refHz = 0): boolean {
    if (this.len - this.offset < PITCH_WIN) return false
    if (refHz > 0) yinGuided(this.buf, this.offset, refHz, out)
    else yinFrame(this.buf, this.offset, out)
    this.offset += PITCH_HOP
    this.frames++
    if (this.offset > PITCH_WIN * 4) {
      this.buf.copyWithin(0, this.offset, this.len)
      this.len -= this.offset
      this.offset = 0
    }
    return true
  }

  /** 缓冲里最多还能排出多少帧（不给新样本的话） */
  get available(): number {
    return Math.max(0, Math.floor((this.len - this.offset - PITCH_WIN) / PITCH_HOP) + 1)
  }
}

/**
 * 把 Hz 转成相对某个参考的半音数（12 = 一个八度）。
 * 人耳对音高差是等比感知的，所有阈值都该用这个单位，而不是 Hz。
 */
export function semitones(f0: number, ref: number): number {
  if (f0 <= 0 || ref <= 0) return NaN
  return 12 * Math.log2(f0 / ref)
}
