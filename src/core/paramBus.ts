import type {
  ActionClip,
  ActionContext,
  BeatState,
  BoneName,
  ExpressionName,
  PlayOptions,
  PoseLayer,
  Vec3,
} from './types'
import { BONE_NAMES, EXPRESSION_NAMES } from './types'

type Running = {
  clip: ActionClip
  start: number
  weight: number
  target: number
  fadeIn: number
  /** 被用户主动停掉（而不是自然播完），不触发「恢复上一个动作」 */
  userStopped: boolean
}

export type ResolvedPose = {
  bones: Record<BoneName, Vec3>
  hipsOffset: Vec3
  expressions: Record<ExpressionName, number>
}

export type PlayResult = 'started' | 'restarted' | 'blocked'
export type ToggleResult = 'on' | 'off' | 'blocked'

/**
 * 互斥层。
 *
 * base / upper 是「姿态层」：同一时刻只能有一个动作在驱动同一批骨骼，
 * 否则会加权平均成四不像（挥手 + 比耶 = 两臂各抬一半）。
 *
 * face 是逐表情取最大值，additive 是叠加，都不需要互斥。
 */
const MUTEX_LAYERS: ReadonlySet<PoseLayer> = new Set<PoseLayer>(['base', 'upper'])

/** 一次性动作判定「已经播完」时往前放宽的时间（秒），见 play() 里的说明 */
const EXPIRY_SLACK = 0.15

export function createPose(): ResolvedPose {
  const bones = {} as Record<BoneName, Vec3>
  for (const n of BONE_NAMES) bones[n] = [0, 0, 0]
  const expressions = {} as Record<ExpressionName, number>
  for (const n of EXPRESSION_NAMES) expressions[n] = 0
  return { bones, hipsOffset: [0, 0, 0], expressions }
}

/** 按幅度缩放一组骨骼增量（只在 motionScale ≠ 1 时才会走这里） */
function scaleBones(
  src: Partial<Record<BoneName, Vec3>>,
  k: number,
): Partial<Record<BoneName, Vec3>> {
  const out: Partial<Record<BoneName, Vec3>> = {}
  for (const key of Object.keys(src) as BoneName[]) {
    const v = src[key]
    if (!v) continue
    out[key] = [v[0] * k, v[1] * k, v[2] * k]
  }
  return out
}

/**
 * 参数总线：所有驱动源都往这里写姿态增量，rig 只负责读最终结果。
 *
 * 混合规则：
 *   base / upper / face  → 按权重求平均（新动作淡入时自然接管）
 *   additive             → 直接相加（呼吸、摆动、视线这类常驻微动）
 *
 * 互斥规则：
 *   同层新动作接管旧动作；旧动作如果是循环动作，会在新的一次性动作播完后自动恢复。
 */
export class ParamBus {
  private running: Running[] = []
  /** 每层最多记一个「被打断的循环动作」，用于一次性动作播完后恢复 */
  private resumeStack = new Map<PoseLayer, ActionClip>()
  private basePose: Partial<Record<BoneName, Vec3>> = {}
  private lookBias: Vec3 = [0, 0, 0]
  private motionScale = 1
  /** 静息站姿 clip，见 setNeutral() */
  private neutral: ActionClip | null = null
  private lastTime = 0

  setBasePose(pose: Partial<Record<BoneName, Vec3>>): void {
    this.basePose = pose
  }

  /**
   * 注册「静息站姿」。
   *
   * 以前静息态 = `basePose`（只有手臂下垂），所以动作淡出后会回到「手臂下垂、
   * 双腿笔直」的僵硬姿态，而动作的首尾帧却是作者摆的站姿——**终点对不上**。
   * 现在把站姿做成一个常驻 clip：动作淡出时回到它，动作开始/结束时也都是它。
   *
   * 它和别的 clip 走同一套混合规则（不再需要 basePose 里写站姿），只在
   * `setMotionScale(0)` 时不被缩放——否则整具身体会退回 T-pose。
   */
  setNeutral(clip: ActionClip | null): void {
    this.neutral = clip
  }

  /**
   * 全局动作幅度（0 = 完全不动，1 = 原样）。
   *
   * 只缩放 clip 贡献的量，**不动** basePose（手臂下垂的基准姿态）和 lookBias——
   * 否则幅度调到 0 时手臂会随着基准姿态一起消失、人变成 T-pose。
   *
   * 用途：确认口型时把身体按住，让眼睛只看嘴。表情（face 层）不受影响。
   */
  setMotionScale(scale: number): void {
    this.motionScale = Math.max(0, Math.min(2, scale))
  }

  /** 视线偏移，由 main 每帧算好塞进来（属于 additive 语义） */
  setLookBias(bias: Vec3): void {
    this.lookBias = bias
  }

  play(clip: ActionClip, now: number, opts: PlayOptions = {}): PlayResult {
    const existing = this.running.find((r) => r.clip.id === clip.id)
    if (existing) {
      // 一次性动作已经播完 / 正在淡出时，再按一次要能重新播
      const finished =
        clip.duration !== Number.POSITIVE_INFINITY && now - existing.start >= clip.duration
      if (existing.target <= 0 || finished) {
        existing.start = now
        existing.weight = 0
      }
      existing.target = opts.weight ?? 1
      existing.userStopped = false
      return 'restarted'
    }

    if (MUTEX_LAYERS.has(clip.layer)) {
      for (const r of this.running) {
        if (r.clip.layer !== clip.layer) continue
        // 静息站姿永远不会被顶掉：它优先级最低，动作自然会盖住它；
        // 一旦把它挤出去，动作**结束的那一帧**就会没有任何贡献者，
        // 整个人掉回「全零」的僵硬姿势一帧，然后再花 0.7 秒回站姿——
        // 看起来就是「动作做完之后身体塌一下又起来」。
        if (r.clip === this.neutral) continue
        if (r.target <= 0) continue
        // 已经播完的一次性动作不该再挡人：它的 duration 到了就该让位，
        // 剩下的只是淡出。否则「转圈 1.3s 结束后紧接着的弹跳」会被静默丢掉。
        //
        // 留 0.15s 余量是因为动作的**实际**开始时间比 cue 的名义时间晚一到几帧：
        // cue 在 t=22.88 触发，动作真正 start 可能是 22.95，于是下一个 cue（名义
        // 24.18）触发时 elapsed 只有 1.23 < 1.3，判定成「还没播完」就又被挡了。
        const expired =
          r.clip.duration !== Number.POSITIVE_INFINITY &&
          now - r.start >= r.clip.duration - EXPIRY_SLACK
        if (expired) continue
        // 正在跑的动作声明「不可打断」，新动作让路
        if (r.clip.interrupt === 'none') return 'blocked'

        r.target = 0
        r.userStopped = false
        // 循环动作被打断，记下来等新动作播完再恢复
        if (r.clip.duration === Number.POSITIVE_INFINITY) {
          this.resumeStack.set(r.clip.layer, r.clip)
        }
      }
    }

    this.running.push({
      clip,
      start: now,
      weight: 0,
      target: opts.weight ?? 1,
      fadeIn: opts.fadeIn ?? clip.blendIn,
      userStopped: false,
    })
    return 'started'
  }

  stop(id: string): void {
    const clip = this.running.find((r) => r.clip.id === id)?.clip
    for (const r of this.running) {
      if (r.clip.id === id) {
        r.target = 0
        r.userStopped = true
      }
    }
    if (clip) {
      const stack = this.resumeStack.get(clip.layer)
      if (stack && stack.id === clip.id) this.resumeStack.delete(clip.layer)
      // 主动停掉的动作不会走 resumeAfter（那是给「被一次性动作打断」用的），
      // 但静息站姿得接回来，否则角色会掉回手臂下垂的僵硬姿态
      else if (this.neutral && clip !== this.neutral && clip.layer === this.neutral.layer) {
        this.resumeStack.delete(clip.layer)
        this.play(this.neutral, this.lastTime)
      }
    }
  }

  toggle(clip: ActionClip, now: number): ToggleResult {
    const existing = this.running.find((r) => r.clip.id === clip.id)
    if (existing && existing.target > 0) {
      this.stop(clip.id)
      return 'off'
    }
    return this.play(clip, now) === 'blocked' ? 'blocked' : 'on'
  }

  isPlaying(id: string): boolean {
    return this.running.some((r) => r.clip.id === id && r.target > 0)
  }

  /**
   * 除了「静息站姿」之外，现在有没有动作在驱动身体。
   *
   * 脚部锁定（P9）靠它判断「该不该锁」：闲置时脚应该老老实实待在站姿上，
   * 锁着不放会让后面的动作全部带着一个偏移（踩过的坑）。
   */
  hasAction(): boolean {
    return this.running.some(
      (r) =>
        r.clip !== this.neutral &&
        (r.clip.layer === 'base' || r.clip.layer === 'upper') &&
        r.weight > 0.01,
    )
  }

  activeIds(): string[] {
    return this.running.filter((r) => r.weight > 0.01).map((r) => r.clip.id)
  }

  private resumeAfter(r: Running, now: number): void {
    if (r.userStopped) return
    const queued = this.resumeStack.get(r.clip.layer)
    if (!queued || queued.id === r.clip.id) return
    this.resumeStack.delete(r.clip.layer)
    this.play(queued, now)
  }

  update(time: number, dt: number, beat: BeatState): ResolvedPose {
    const ctx: ActionContext = { time, dt, beat }
    const pose = createPose()
    this.lastTime = time

    type Contribution = {
      run: Running
      weight: number
      bones: Partial<Record<BoneName, Vec3>>
      hips: Vec3 | null
      owns: ReadonlySet<BoneName>
      ownsHips: boolean
      order: number
    }

    const contributions: Contribution[] = []
    const addV = new Map<BoneName, Vec3>()
    const exprBest = new Map<ExpressionName, number>()
    const hipsAdd: Vec3 = [0, 0, 0]

    const keep: Running[] = []
    const finished: Running[] = []

    for (const r of this.running) {
      const elapsed = time - r.start

      // 一次性动作播完自动淡出
      if (r.clip.duration !== Number.POSITIVE_INFINITY && elapsed >= r.clip.duration) {
        r.target = 0
      }

      // 淡入用 blendIn，淡出用 blendOut —— 两者时间常数不一样
      const fadeTime = r.target > r.weight ? r.fadeIn : r.clip.blendOut
      const step = dt / Math.max(0.001, fadeTime)
      if (r.weight < r.target) r.weight = Math.min(r.target, r.weight + step)
      else if (r.weight > r.target) r.weight = Math.max(r.target, r.weight - step)

      if (r.weight <= 0.002 && r.target === 0) {
        finished.push(r)
        continue
      }
      keep.push(r)

      const localT =
        r.clip.duration === Number.POSITIVE_INFINITY
          ? elapsed
          : Math.min(elapsed, r.clip.duration)

      const delta = r.clip.sample(localT, ctx)
      const w = r.weight
      // 幅度缩放（`setMotionScale`）：动作 clip 要跟着缩，静息站姿不能缩，
      // 否则按住身体时人退回 T-pose。缩放放在**收集阶段**而不是最后统一乘，
      // 就是为了让这两种 clip 能在同一套加权/独占规则里共存。
      const k = r.clip.neutral ? 1 : this.motionScale
      const f = w * k

      if (r.clip.layer === 'additive') {
        if (delta.bones) {
          for (const key of Object.keys(delta.bones) as BoneName[]) {
            const v = delta.bones[key]
            if (!v) continue
            const cur = addV.get(key) ?? [0, 0, 0]
            addV.set(key, [cur[0] + v[0] * f, cur[1] + v[1] * f, cur[2] + v[2] * f])
          }
        }
        if (delta.hipsOffset) {
          const h = delta.hipsOffset
          hipsAdd[0] += h[0] * f
          hipsAdd[1] += h[1] * f
          hipsAdd[2] += h[2] * f
        }
      } else {
        contributions.push({
          run: r,
          weight: w,
          bones: k === 1 ? (delta.bones ?? {}) : scaleBones(delta.bones ?? {}, k),
          hips: delta.hipsOffset
            ? [delta.hipsOffset[0] * k, delta.hipsOffset[1] * k, delta.hipsOffset[2] * k]
            : null,
          owns: new Set(r.clip.owns ?? []),
          ownsHips: r.clip.ownsHips === true,
          order: contributions.length,
        })
      }

      if (delta.expressions) {
        for (const key of Object.keys(delta.expressions) as ExpressionName[]) {
          const v = delta.expressions[key]
          if (v === undefined) continue
          const scaled = v * w
          const prev = exprBest.get(key) ?? 0
          if (scaled > prev) exprBest.set(key, scaled)
        }
      }
    }

    this.running = keep

    // 一次性动作播完，恢复被它打断的循环动作
    for (const r of finished) {
      if (r.clip.duration !== Number.POSITIVE_INFINITY) this.resumeAfter(r, time)
    }

    /**
     * 一根骨骼的合成规则（P2 + 2026-11-12 修淡入）：
     *
     *   1. 先把所有「没声明所有权」的贡献加权平均——这是以前的唯一规则；
     *   2. 如果有 clip 声明了自己拥有这根骨骼，优先级最高的那个独占：
     *      `拥有者值 × 它的权重 + 被它盖住的下一层 × (1 - 权重)`。
     *
     * **「下一层」是 2026-11-12 补的**。以前只有「没所有权的贡献」算下一层，
     * 而基座（静息站姿）和律动（bounce）**都声明了所有权**，于是它们被排除在外，
     * 下一层变成「什么都没有」，走到 `sumW <= 0.0001` 那条捷径上——**权重被忽略，
     * 直接返回满值**。结果是：任何 upper 动作（比耶、凑近、自我介绍…）起手和收手
     * 的那一帧，整个人从律动姿势**瞬间**跳到动作姿势、再瞬间跳回来。
     * 实测每帧最大骨骼跳变 0.710 rad（右前臂），正好等于「站姿手臂」和
     * 「摇摆手臂」的差——用户说的「一卡一卡、前一个动作没完全结束就接上了」。
     *
     * 现在把「下一个拥有者」也当混合目标：淡入时 owner.w 从 0 长到 1，
     * 姿势就在两层之间插值，不再跳。**没有下一个拥有者时仍然保留旧行为**
     * （直接给满值），否则单层动作淡入会变成「从很轻长到正常」。
     */
    const resolve = (
      sumV: Vec3,
      sumW: number,
      owner: { v: Vec3; w: number } | null,
      below: Vec3 | null,
    ): Vec3 => {
      if (!owner) {
        if (sumW <= 0.0001) return [0, 0, 0]
        return [sumV[0] / sumW, sumV[1] / sumW, sumV[2] / sumW]
      }
      if (owner.w >= 1) return [owner.v[0], owner.v[1], owner.v[2]]
      // 下面没有任何参考（既没有次高优先级的拥有者，也没有普通贡献）：
      // 保持「直接给满值」，不然动作会像从很轻长到正常。
      if (!below && sumW <= 0.0001) return [owner.v[0], owner.v[1], owner.v[2]]

      const other: Vec3 = below ?? [sumV[0] / sumW, sumV[1] / sumW, sumV[2] / sumW]
      const k = owner.w
      return [
        owner.v[0] * k + other[0] * (1 - k),
        owner.v[1] * k + other[1] * (1 - k),
        owner.v[2] * k + other[2] * (1 - k),
      ]
    }

    for (const n of BONE_NAMES) {
      const base = this.basePose[n]
      let sum: Vec3 = [0, 0, 0]
      let sumW = 0
      let owner: { v: Vec3; w: number } | null = null
      let ownerPrio = -Infinity
      let ownerOrder = -1
      // 次高优先级的拥有者：淡入时当混合目标（见 resolve 的注释）
      let below: Vec3 | null = null
      let belowPrio = -Infinity
      let belowOrder = -1

      for (const c of contributions) {
        const v = c.bones[n]
        if (!v) continue
        if (c.owns.has(n)) {
          const prio = c.run.clip.priority
          if (prio > ownerPrio || (prio === ownerPrio && c.order > ownerOrder)) {
            // 原来的拥有者降级成「下面那层」
            below = owner ? [owner.v[0], owner.v[1], owner.v[2]] : null
            belowPrio = ownerPrio
            belowOrder = ownerOrder
            ownerPrio = prio
            ownerOrder = c.order
            owner = { v: [v[0], v[1], v[2]], w: c.weight }
          } else if (prio > belowPrio || (prio === belowPrio && c.order > belowOrder)) {
            belowPrio = prio
            belowOrder = c.order
            below = [v[0], v[1], v[2]]
          }
          continue // 拥有者不参与平均
        }
        sum = [sum[0] + v[0] * c.weight, sum[1] + v[1] * c.weight, sum[2] + v[2] * c.weight]
        sumW += c.weight
      }

      const resolved = resolve(sum, sumW, owner, below)

      let x = base ? base[0] : 0
      let y = base ? base[1] : 0
      let z = base ? base[2] : 0
      x += resolved[0]
      y += resolved[1]
      z += resolved[2]

      const add = addV.get(n)
      if (add) {
        x += add[0]
        y += add[1]
        z += add[2]
      }

      pose.bones[n] = [x, y, z]
    }

    // 视线是叠加在头部上的，不和表情/动作抢权重
    const head = pose.bones.head
    pose.bones.head = [
      head[0] + this.lookBias[0],
      head[1] + this.lookBias[1],
      head[2] + this.lookBias[2],
    ]

    // 髋部位移同一套规则
    let hipsSum: Vec3 = [0, 0, 0]
    let hipsW = 0
    let hipsOwner: { v: Vec3; w: number } | null = null
    let hipsOwnerPrio = -Infinity
    let hipsOwnerOrder = -1
    let hipsBelow: Vec3 | null = null
    let hipsBelowPrio = -Infinity
    let hipsBelowOrder = -1
    for (const c of contributions) {
      if (!c.hips) continue
      if (c.ownsHips) {
        const prio = c.run.clip.priority
        if (prio > hipsOwnerPrio || (prio === hipsOwnerPrio && c.order > hipsOwnerOrder)) {
          hipsBelow = hipsOwner ? [hipsOwner.v[0], hipsOwner.v[1], hipsOwner.v[2]] : null
          hipsBelowPrio = hipsOwnerPrio
          hipsBelowOrder = hipsOwnerOrder
          hipsOwnerPrio = prio
          hipsOwnerOrder = c.order
          hipsOwner = { v: c.hips, w: c.weight }
        } else if (
          prio > hipsBelowPrio ||
          (prio === hipsBelowPrio && c.order > hipsBelowOrder)
        ) {
          hipsBelowPrio = prio
          hipsBelowOrder = c.order
          hipsBelow = [c.hips[0], c.hips[1], c.hips[2]]
        }
        continue
      }
      hipsSum = [
        hipsSum[0] + c.hips[0] * c.weight,
        hipsSum[1] + c.hips[1] * c.weight,
        hipsSum[2] + c.hips[2] * c.weight,
      ]
      hipsW += c.weight
    }
    const hipsBase = resolve(hipsSum, hipsW, hipsOwner, hipsBelow)

    pose.hipsOffset = [
      hipsBase[0] + hipsAdd[0],
      hipsBase[1] + hipsAdd[1],
      hipsBase[2] + hipsAdd[2],
    ]

    for (const n of EXPRESSION_NAMES) {
      pose.expressions[n] = Math.min(1, Math.max(0, exprBest.get(n) ?? 0))
    }

    // 静息站姿的兜底：被同层动作顶掉之后（尤其是用户手动关掉循环动作时），
    // 这里把它接回来。没有它的话，动作一停人就掉回手臂下垂的僵硬姿态。
    const neutral = this.neutral
    if (neutral && !this.isPlaying(neutral.id)) {
      const busy = this.running.some(
        (r) => r.clip !== neutral && r.clip.layer === neutral.layer && r.target > 0,
      )
      if (!busy) this.play(neutral, time)
    }

    return pose
  }
}
