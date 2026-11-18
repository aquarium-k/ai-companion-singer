import type { Object3D, Quaternion, Vector3 } from 'three'
import type { ResolvedPose } from '../core/paramBus'
import type { BoneName, Vec3 } from '../core/types'

/** 左/右腿。脚部 IK 只作用于这两条。 */
export type LegSide = 'left' | 'right'

/**
 * 角色后端抽象。VRM 和程序化占位角色都实现它，
 * 上层（ParamBus / 动作 / 时间轴）完全不需要知道自己驱动的是哪种角色。
 */
export interface HumanoidRig {
  readonly kind: 'vrm' | 'primitive'
  readonly root: Object3D

  /**
   * 静止姿态修正。VRM 的归一化骨骼静止时是 T-Pose，
   * 这里给出「手臂自然下垂」的常量偏移；程序化角色本身就是站姿，留空。
   */
  readonly basePose: Partial<Record<BoneName, Vec3>>

  apply(pose: ResolvedPose): void
  update(dt: number): void
  setLookTarget(target: Vector3 | null): void
  getHeadWorldPosition(out: Vector3): Vector3
  /** 头骨的世界朝向。嘴部偏移要在这个坐标系里给，否则一低头就偏。 */
  getHeadWorldQuaternion(out: Quaternion): Quaternion
  /**
   * 任意骨骼的世界坐标。P9 的脚部 IK 要靠它量「脚到底滑了多少」，
   * 姿势标定也用它（比如「手有没有真的放到腰上」）。
   */
  getBoneWorldPosition(name: BoneName, out: Vector3): Vector3

  /** 任意骨骼的世界朝向（脚 IK 要钉住脚掌朝向） */
  getBoneWorldQuaternion?(name: BoneName, out: Quaternion): Quaternion

  /**
   * 读回某个表情的当前权重。口型的幅度和元音形状只能量，不能靠看
   * （380 px 的窗口里 0.15 和 0.55 的张嘴差别看不出来）。两个后端都实现。
   */
  getExpressionValue?(name: string): number

  /**
   * 髋骨的世界朝向。脚 IK 用它决定膝盖朝哪边（跟着角色朝向转）。
   * 程序化角色可以不实现。
   */
  getHipsWorldQuaternion?(out: Quaternion): Quaternion

  /**
   * 两骨 IK：把脚踝解到世界坐标 `target`，`footWorldQuat` 给了就钉住脚掌朝向。
   * 只有 VRM 后端实现；没实现时脚部锁定自动关闭。
   */
  solveLeg?(side: LegSide, target: Vector3, footWorldQuat: Quaternion | null): void

  /**
   * 两骨 IK（手臂）：把手腕解到世界坐标 `target`，肘朝 `polePoint` 拐。
   * `weight` < 1 时按权重和原姿势混合（动作首尾淡入淡出）。
   * 只有 VRM 后端实现；没实现时世界坐标手臂动画自动跳过。
   */
  solveArm?(
    side: LegSide,
    target: Vector3,
    polePoint: Vector3,
    opts?: { weight?: number; handWorldQuat?: Quaternion | null },
  ): void

  /** 调试：手臂 IK 的输入量（骨长、肩到腕距离）。只有 VRM 后端实现。 */
  armDebug?(): Record<string, number>

  /**
   * 静止时每根骨骼「指向哪」（世界单位向量，已归一化）。
   *
   * BVH 重定向要用它：归一化骨骼的静止旋转都是单位四元数，骨头朝向读不出来，
   * 必须去原始骨骼那棵树量。只有 VRM 后端实现。
   */
  restDirections?: Record<string, [number, number, number]>

  dispose(): void
}
