/**
 * 两个姿势之间的「过门」（阶段 1：程序化 in-betweening，不训练模型）。
 *
 * 为什么需要它：现在换动作靠**交叉淡化**——两段动作各算一半再加权，结果是
 * 「两条腿各自滑过去」，重心不跟、脚会滑，也没有预备动作。人做动作不是这样的：
 *
 *   预备（anticipation）→ 到位（overshoot 一点点）→ 回落（settle）
 *
 * 这里只做三件事，都是能看出效果的：
 *
 * 1. **缓动**：默认 inOut（起步慢、中间快、收尾慢），端点导数为 0，不会「撞」。
 * 2. **预备**：开头把上半身/手臂**反向**摆一点（默认 8%），再转过去。
 *    这是让过门像人最关键的一下——手臂先往回带，身体才走。
 * 3. **只做上身预备**：腿不反向（腿反向就变成原地抖一下，很怪）。
 *
 * 没做的（留给阶段 2）：接触约束（脚真正的落点）、动力学（惯性/重量）。
 * 脚部的落地由渲染链上的 P9 脚锁兜着，所以这里不重复做。
 */
import type { ActionClip, ActionContext, BoneName, PoseDelta, Vec3 } from '../core/types'

/** 会做「预备」的骨骼：上臂、小臂、胸、头。腿不做（见文件头说明）。 */
const ANTICIPATION_BONES: BoneName[] = [
  'leftUpperArm',
  'rightUpperArm',
  'leftLowerArm',
  'rightLowerArm',
  'chest',
  'upperChest',
  'head',
]

const ZERO: Vec3 = [0, 0, 0]

const easeInOut = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u))

function addScaled(a: Vec3, b: Vec3, k: number): Vec3 {
  return [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k]
}

export type TransitionOptions = {
  /** 过门总时长（秒） */
  duration: number
  /** 预备量：0 = 不做，0.08 = 反向摆 8%（默认），0.2 = 夸张 */
  anticipation?: number
  /** 预备持续多久（占总时长的比例，默认 0.22） */
  anticipationSpan?: number
}

/**
 * 生成一个「从 from 走到 to」的 clip。
 *
 * 关键点：`from` / `to` 里没写的骨骼按 0（静息）处理——和 `keyframes.ts` 的规则一致，
 * 这样传 `{}` 也能从静息出发。
 */
export function buildTransition(
  id: string,
  from: PoseDelta,
  to: PoseDelta,
  opts: TransitionOptions,
): ActionClip {
  const duration = Math.max(0.08, opts.duration)
  const antic = Math.max(0, Math.min(0.25, opts.anticipation ?? 0.08))
  const span = Math.max(0.05, Math.min(0.5, opts.anticipationSpan ?? 0.22))

  // 参与过门的骨骼 = 两端的并集
  const bones = new Set<BoneName>()
  for (const k of Object.keys(from.bones ?? {}) as BoneName[]) bones.add(k)
  for (const k of Object.keys(to.bones ?? {}) as BoneName[]) bones.add(k)
  const list = [...bones]

  const fromHips = from.hipsOffset ?? ZERO
  const toHips = to.hipsOffset ?? ZERO

  return {
    id,
    layer: 'base',
    duration,
    priority: 7,
    interrupt: 'soft',
    blendIn: 0.12,
    blendOut: 0.18,
    owns: list,
    ownsHips: true,
    sample(t: number, _ctx: ActionContext): PoseDelta {
      const u = Math.max(0, Math.min(1, t / duration))
      const e = easeInOut(u)
      const out: Partial<Record<BoneName, Vec3>> = {}
      for (const bone of list) {
        const a = from.bones?.[bone] ?? ZERO
        const b = to.bones?.[bone] ?? ZERO
        const delta: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
        // 线性部分
        let v: Vec3 = [a[0] + delta[0] * e, a[1] + delta[1] * e, a[2] + delta[2] * e]
        // 预备：在开头 span 区间里往反方向带一点，然后松开
        if (antic > 0 && ANTICIPATION_BONES.includes(bone) && u < span) {
          const k = -antic * Math.sin((Math.PI * u) / span)
          v = addScaled(v, delta, k)
        }
        out[bone] = v
      }
      return {
        bones: out,
        hipsOffset: [
          fromHips[0] + (toHips[0] - fromHips[0]) * e,
          fromHips[1] + (toHips[1] - fromHips[1]) * e,
          fromHips[2] + (toHips[2] - fromHips[2]) * e,
        ],
      }
    },
  }
}
