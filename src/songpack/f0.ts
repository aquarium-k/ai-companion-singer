/**
 * 参考音高：从曲包的 `work/f0.json` 载入，重采样到 10 ms 网格。
 *
 * 为什么存成 10 ms 的 `Float32Array`：
 *   原始文件是 11.6 ms 一帧（256/22050）、每帧四个数，230 秒的歌有 2 万帧。
 *   跟着唱的时候每秒要查 100 次，直接二分查 JSON 数组也行，但摊平成定长数组
 *   之后是纯数值索引，且和麦克风侧的帧率对齐（都是 10 ms），不用做时间换算。
 *
 * 数据来源是离线流程 `tools/extract_f0.py` 的结果（含谐波修正），
 * 不是实时估计——跟随判定要的就是「谱面上这一拍应该唱多高」。
 */

export type F0Doc = {
  sr: number
  hop: number
  duration: number
  frames: [number, number, number, number][]
}

export type F0Track = {
  /** 每帧时长（秒），固定 0.01 */
  hop: number
  /** 逐帧基频（Hz），0 = 这一帧没人声 */
  f0: Float32Array
  duration: number
}

const GRID = 0.01
/**
 * 补掉不超过这么多帧（60 ms）的「没音高」空洞。
 *
 * 实测（2026-11-12）：demo 的 f0 有 393 段无声，其中 348 段 ≤100 ms——
 * 这些几乎都是**基频追踪掉帧**，不是真的停顿（日文的辅音更长、会被留在外面）。
 * 不补的话这些帧既不判也不说原因，用户看到的就是「明明有词，却是一片不判」。
 * 超过 60 ms 的不补：那多半是真的没在唱（换气、断句），补了会变成误判。
 */
const FILL_GAP = 6

/**
 * 中值滤波的窗口（帧）。9 帧 = ±40 ms。
 *
 * 为什么需要（用户 2026-11-13）：「分离人声做参考，会有一些时候音高不稳，
 * 应该都在字头」。原因有三层：
 *   1. 辅音段 YIN 本来就容易给出假基频（气声、爆破），字头正是辅音；
 *   2. 真人每个音开头都有 30–50 音分的**上滑**（scoop），和声原样跟就会「抖一下」；
 *   3. 参考轨还带着原唱的颤音，而和声自己已经有 LFO 颤音，两层叠起来更不稳。
 * 中值滤波一次解决这三条：保留音符之间的**台阶**（中值不糊边），
 * 但把单帧毛刺、上滑和颤音都压掉。和声要的是「这一拍该多高」，不是复刻演唱细节。
 */
const SMOOTH_WINDOW = 9

export function buildF0Track(doc: F0Doc, smoothWindow = SMOOTH_WINDOW): F0Track {
  const duration = doc.duration || (doc.frames.at(-1)?.[0] ?? 0)
  const count = Math.max(1, Math.ceil(duration / GRID))
  const out = new Float32Array(count)
  const frames = doc.frames ?? []
  if (frames.length === 0) {
    return { hop: GRID, f0: out, duration }
  }
  let j = 0
  for (let i = 0; i < count; i++) {
    const t = i * GRID
    // 帧时间单调，跟着指针走，避免每帧二分
    while (j + 1 < frames.length && frames[j + 1][0] <= t) j++
    out[i] = frames[j][1] ?? 0
  }

  // 短空洞线性补值（只在左右都有声的区间里补）
  let i = 0
  while (i < out.length) {
    if (out[i] > 0) {
      i++
      continue
    }
    let end = i
    while (end < out.length && out[end] <= 0) end++
    const run = end - i
    if (run <= FILL_GAP && i > 0 && end < out.length && out[i - 1] > 0 && out[end] > 0) {
      const a = out[i - 1]
      const b = out[end]
      for (let k = 0; k < run; k++) out[i + k] = a + ((b - a) * (k + 1)) / (run + 1)
    }
    i = end
  }

  // 中值滤波：只对「窗口里有足够浊音帧」的位置动手，清音/静音保持 0。
  // 用中值而不是均值，是为了在音符边界上保住台阶（均值会把 300→400 Hz 的
  // 跳变抹成一条 40 ms 的斜坡，听着像跑调）。
  if (smoothWindow >= 3) {
    const half = Math.floor(smoothWindow / 2)
    const src = out.slice()
    const scratch: number[] = []
    for (let i = 0; i < src.length; i++) {
      scratch.length = 0
      for (let k = Math.max(0, i - half); k <= Math.min(src.length - 1, i + half); k++) {
        if (src[k] > 0) scratch.push(src[k])
      }
      // 浊音帧不到一半就不动（起音/收尾的边缘）
      if (scratch.length * 2 < smoothWindow) continue
      scratch.sort((a, b) => a - b)
      out[i] = scratch[scratch.length >> 1]
    }
  }

  return { hop: GRID, f0: out, duration }
}

/** 取 t 秒处的参考音高（Hz），超出范围返回 0 */
export function f0At(track: F0Track | null, t: number): number {
  if (!track) return 0
  const i = Math.floor(t / track.hop)
  if (i < 0 || i >= track.f0.length) return 0
  return track.f0[i]
}
