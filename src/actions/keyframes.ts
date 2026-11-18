import type { ActionClip, ActionContext, BoneName, ExpressionName, PoseLayer, Vec3 } from '../core/types'
import { getPose } from './poses'

/**
 * 关键帧 clip（P8）。
 *
 * 老 clip 是「时间的函数」：`sample()` 里写满 `Math.sin()`，动作没有起手、
 * 没有到位、没有停顿——看起来像在匀速飘。关键帧把**姿势**和时间分开：
 *
 * ```ts
 * keys: [
 *   { pose: 'prep.dip',     at: 0.00, ease: 'in' },   // 预备：往下沉
 *   { pose: 'arm.up.full.L', at: 0.12, ease: 'out' }, // 击：0.12 s 到位
 *   { pose: 'arm.up.full.L', at: 0.30 },              // 停：保持不变
 *   { pose: 'idle.base',    at: 0.70, ease: 'inOut' },// 回落
 * ]
 * ```
 *
 * 三条规则：
 *
 * 1. `ease` 属于**这一段的起点**（从这一帧出发的那条曲线）。想要「快起慢停」用 `out`，
 *    想要「过冲再回来」用 `back`，想要匀速用 `linear`。
 * 2. 段与段之间在两个姿势的**并集**上插值。某一帧没写的骨骼按 0 处理，
 *    也就是「回到静息」——所以 `idle.base`（空姿势）就是一个合法终点。
 * 3. 姿势交替时**只插值姿势里出现过的骨骼**，不会把没提到的骨骼拽回 0。
 *    但一旦某个骨骼在任意一帧里出现过，它就会全程参与（由 `owns` 决定归谁）。
 */
export type EaseName = 'linear' | 'in' | 'out' | 'inOut' | 'back'

export type Key = {
  pose: string
  /** 秒；`loopBeats` 存在时是「拍」 */
  at: number
  ease?: EaseName
}

const c1 = 1.70158
const c3 = c1 + 1

const EASES: Record<EaseName, (u: number) => number> = {
  linear: (u) => u,
  in: (u) => u * u,
  out: (u) => 1 - (1 - u) * (1 - u),
  inOut: (u) => u * u * (3 - 2 * u),
  // 冲出一点再回来：落地、点头的「顿」感全靠它
  back: (u) => 1 + c3 * (u - 1) ** 3 + c1 * (u - 1) ** 2,
}

const ZERO: Vec3 = [0, 0, 0]

/** 两个解析后的姿势是否等价（骨骼、髋位移、表情都比，容差 1e-3） */
function samePose(a: Resolved, b: Resolved): boolean {
  const eps = 1e-3
  const same = (x: number, y: number): boolean => Math.abs(x - y) < eps
  const boneNames = new Set<BoneName>([
    ...(Object.keys(a.bones) as BoneName[]),
    ...(Object.keys(b.bones) as BoneName[]),
  ])
  for (const name of boneNames) {
    const va = a.bones[name] ?? ZERO
    const vb = b.bones[name] ?? ZERO
    if (!same(va[0], vb[0]) || !same(va[1], vb[1]) || !same(va[2], vb[2])) return false
  }
  const ha = a.hips ?? ZERO
  const hb = b.hips ?? ZERO
  if (!same(ha[0], hb[0]) || !same(ha[1], hb[1]) || !same(ha[2], hb[2])) return false
  const faceNames = new Set<ExpressionName>([
    ...(Object.keys(a.face) as ExpressionName[]),
    ...(Object.keys(b.face) as ExpressionName[]),
  ])
  for (const name of faceNames) {
    if (!same(a.face[name] ?? 0, b.face[name] ?? 0)) return false
  }
  return true
}

type Resolved = {
  bones: Partial<Record<BoneName, Vec3>>
  hips: Vec3 | null
  face: Partial<Record<ExpressionName, number>>
}

function resolvePose(id: string): Resolved {
  const def = getPose(id)
  if (!def) {
    console.warn(`[keyframes] 没有这个姿势: ${id}`)
    return { bones: {}, hips: null, face: {} }
  }
  return {
    bones: def.bones ?? {},
    hips: def.hipsOffset ?? null,
    face: def.face ?? {},
  }
}

function blend(a: Resolved, b: Resolved, e: number): {
  bones: Partial<Record<BoneName, Vec3>>
  hips: Vec3 | null
  face: Partial<Record<ExpressionName, number>>
} {
  const bones: Partial<Record<BoneName, Vec3>> = {}
  const seen = new Set<BoneName>()
  for (const key of Object.keys(a.bones) as BoneName[]) seen.add(key)
  for (const key of Object.keys(b.bones) as BoneName[]) seen.add(key)
  for (const key of seen) {
    const va = a.bones[key] ?? ZERO
    const vb = b.bones[key] ?? ZERO
    bones[key] = [
      va[0] + (vb[0] - va[0]) * e,
      va[1] + (vb[1] - va[1]) * e,
      va[2] + (vb[2] - va[2]) * e,
    ]
  }

  let hips: Vec3 | null = null
  if (a.hips || b.hips) {
    const ha = a.hips ?? ZERO
    const hb = b.hips ?? ZERO
    hips = [
      ha[0] + (hb[0] - ha[0]) * e,
      ha[1] + (hb[1] - ha[1]) * e,
      ha[2] + (hb[2] - ha[2]) * e,
    ]
  }

  const face: Partial<Record<ExpressionName, number>> = {}
  const faces = new Set<ExpressionName>()
  for (const key of Object.keys(a.face) as ExpressionName[]) faces.add(key)
  for (const key of Object.keys(b.face) as ExpressionName[]) faces.add(key)
  for (const key of faces) {
    const va = a.face[key] ?? 0
    const vb = b.face[key] ?? 0
    face[key] = va + (vb - va) * e
  }

  return { bones, hips, face }
}

export type KeyframeSpec = {
  id: string
  layer: PoseLayer
  priority: number
  interrupt: ActionClip['interrupt']
  blendIn: number
  blendOut: number
  keys: Key[]
  /** >0 时 `keys[].at` 的单位是「拍」，并且循环（用来做律动） */
  loopBeats?: number
  /** 非循环 clip 的时长；缺省用最后一帧的时间 */
  duration?: number
  owns?: BoneName[]
  ownsHips?: boolean
  /**
   * 跳过「首尾姿势一致」检查。
   *
   * 规则：一次性 clip 的第一帧和最后一帧必须是**同一个姿势**，
   * 这样接在别的动作后面、或者被别的动作接走时，两端都是连续的，
   * 多动作拼起来才不会在边界上跳一下。
   *
   * 唯一需要豁免的是转圈：它结束在偏航 2π 的姿势上，视觉上等于 0，
   * 但数值上不等于首帧的 0（这样它才不会在淡出时倒着转回去）。
   */
  skipPoseCheck?: boolean
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

export function createKeyframeClip(spec: KeyframeSpec): ActionClip {
  const keys = [...spec.keys].sort((x, y) => x.at - y.at)
  if (keys.length < 2) throw new Error(`[keyframes] ${spec.id} 至少要有两帧`)

  const resolved = keys.map((k) => resolvePose(k.pose))
  const loop = spec.loopBeats ?? 0

  if (loop > 0 && keys[0].at !== 0) {
    console.warn(`[keyframes] ${spec.id} 是循环 clip，第一帧必须在 0 拍`)
  }

  // 一次性动作的首尾必须是同一个姿势，否则接在别的动作后面会跳
  if (loop === 0 && !spec.skipPoseCheck) {
    const first = resolved[0]
    const last = resolved[resolved.length - 1]
    if (!samePose(first, last)) {
      console.warn(
        `[keyframes] ${spec.id} 首尾姿势不一致（${keys[0].pose} → ${keys[keys.length - 1].pose}），` +
          '接到别的动作上会跳一下',
      )
    }
  }

  // 没有显式声明 owns 时，按「所有帧里出现过的骨骼」自动算：
  // 不然这些骨骼会被别的层平均稀释，姿势就不成形了。
  let owns = spec.owns
  if (!owns) {
    const set = new Set<BoneName>()
    for (const r of resolved) for (const k of Object.keys(r.bones) as BoneName[]) set.add(k)
    owns = [...set]
  }
  const ownsHips = spec.ownsHips ?? resolved.some((r) => r.hips !== null)

  // 段：循环时最后一段接回第 0 帧（时间轴上加一个周期）
  const segmentEnd = (i: number): number =>
    i + 1 < keys.length ? keys[i + 1].at : keys[0].at + loop

  const duration = loop > 0 ? Number.POSITIVE_INFINITY : (spec.duration ?? keys[keys.length - 1].at)

  const frameAt = (pos: number): { a: Resolved; b: Resolved; e: number } => {
    if (loop > 0) {
      for (let i = 0; i < keys.length; i++) {
        const from = keys[i].at
        const to = segmentEnd(i)
        if (pos >= from && pos < to) {
          const u = clamp01((pos - from) / Math.max(1e-6, to - from))
          const ease = EASES[keys[i].ease ?? 'inOut'](u)
          return { a: resolved[i], b: resolved[(i + 1) % keys.length], e: ease }
        }
      }
      return { a: resolved[0], b: resolved[0], e: 0 }
    }

    if (pos <= keys[0].at) return { a: resolved[0], b: resolved[0], e: 0 }
    let i = keys.length - 2
    while (i > 0 && pos < keys[i].at) i--
    if (pos >= keys[keys.length - 1].at) {
      return { a: resolved[keys.length - 1], b: resolved[keys.length - 1], e: 0 }
    }
    const u = clamp01((pos - keys[i].at) / Math.max(1e-6, keys[i + 1].at - keys[i].at))
    const ease = EASES[keys[i].ease ?? 'inOut'](u)
    return { a: resolved[i], b: resolved[i + 1], e: ease }
  }

  return {
    id: spec.id,
    layer: spec.layer,
    duration,
    priority: spec.priority,
    interrupt: spec.interrupt,
    blendIn: spec.blendIn,
    blendOut: spec.blendOut,
    owns,
    ownsHips,
    sample: (t: number, ctx: ActionContext) => {
      const pos = loop > 0 ? ((ctx.beat.beat % loop) + loop) % loop : t
      const { a, b, e } = frameAt(pos)
      const mixed = blend(a, b, e)
      return {
        bones: mixed.bones,
        hipsOffset: mixed.hips ?? undefined,
        expressions: mixed.face,
      }
    },
  }
}
