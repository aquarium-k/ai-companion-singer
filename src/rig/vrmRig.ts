import * as THREE from 'three'
import type { VRM } from '@pixiv/three-vrm'
import type { ResolvedPose } from '../core/paramBus'
import type { BoneName, Vec3 } from '../core/types'
import { BONE_NAMES } from '../core/types'
import type { HumanoidRig, LegSide } from './rig'

/**
 * VRM 的归一化骨骼静止时是 T-Pose（手臂平举），
 * 下面这组常量把姿势拉回「自然站姿」。
 *
 * 注意：不同 VRM 的骨骼朝向可能有差异，接入真实模型后需要在这里微调。
 * 数值是「手臂下垂」的相对旋转，单位弧度。
 */
const VRM_BASE_POSE: Partial<Record<BoneName, Vec3>> = {
  leftUpperArm: [0, 0, -1.28],
  rightUpperArm: [0, 0, 1.28],
  leftLowerArm: [0, 0, -0.08],
  rightLowerArm: [0, 0, 0.08],
}

// IK 每帧都要算，别在里面 new 对象
const _hip = new THREE.Vector3()
const _knee = new THREE.Vector3()
const _ankle = new THREE.Vector3()
const _target = new THREE.Vector3()
const _u = new THREE.Vector3()
const _pole = new THREE.Vector3()
const _axis = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _seg = new THREE.Vector3()
const _qA = new THREE.Quaternion()
const _qB = new THREE.Quaternion()
const _qC = new THREE.Quaternion()
const _qD = new THREE.Quaternion()
// solveArm 的「解算前」快照（淡入淡出用，和上面的 qA..qD 分开，免得互相踩）
const _qa = new THREE.Quaternion()
const _qb = new THREE.Quaternion()
const _qc = new THREE.Quaternion()

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export class VrmRig implements HumanoidRig {
  readonly kind = 'vrm' as const
  readonly root = new THREE.Object3D()
  readonly basePose = VRM_BASE_POSE

  private lookTargetObj = new THREE.Object3D()
  private hipsRest = new THREE.Vector3()
  /** 大腿 / 小腿长度（归一化骨骼的静止偏移，和姿势无关） */
  private legLen: Record<LegSide, { thigh: number; shin: number }> = {
    left: { thigh: 0, shin: 0 },
    right: { thigh: 0, shin: 0 },
  }
  /** 上臂 / 小臂长度（世界空间手臂 IK 用） */
  private armLen: Record<LegSide, { upper: number; fore: number }> = {
    left: { upper: 0, fore: 0 },
    right: { upper: 0, fore: 0 },
  }
  /**
   * 人形骨骼在**静止姿势**下「指向哪个方向」（世界坐标，单位向量）。
   *
   * 归一化骨骼的静止旋转全是单位四元数，所以「这根骨头朝哪」从归一化层级里**读不出来**；
   * 只能到原始骨骼那棵树去量：骨头指向它的第一个子骨骼。
   * BVH 重定向要用这张表（`tools/motion/*.rest.json`）——之前硬编码的
   * `leftFoot = (0,−1,0)` 是错的（脚踝不是朝下、是朝前），实测脚会被多转约 90°。
   */
  private restDirs: Record<string, [number, number, number]> = {}

  constructor(private vrm: VRM) {
    this.root.name = 'vrm-rig'
    this.root.add(vrm.scene)
    this.root.add(this.lookTargetObj)

    const hips = vrm.humanoid.getNormalizedBoneNode('hips')
    if (hips) this.hipsRest.copy(hips.position)

    this.captureRestDirs()

    for (const side of ['left', 'right'] as const) {
      const lo = vrm.humanoid.getNormalizedBoneNode(`${side}LowerLeg`)
      const ft = vrm.humanoid.getNormalizedBoneNode(`${side}Foot`)
      if (lo && ft) {
        this.legLen[side].thigh = lo.position.length()
        this.legLen[side].shin = ft.position.length()
      }
      const up = vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`)
      const fore = vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`)
      const hand = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`)
      if (up && fore) this.armLen[side].upper = fore.position.length()
      if (fore && hand) this.armLen[side].fore = hand.position.length()
    }

    if (vrm.lookAt) vrm.lookAt.target = null
  }

  /**
   * 量一遍「每根人形骨骼静止时指向哪」。
   *
   * 用原始骨骼：`raw.getWorldPosition` 和它**人形子关节**的世界位置之差。
   *
   * 为什么不能「取第一个骨骼子节点」：VRoid 这类骨架在髋下面挂了扭骨/辅助骨，
   * 第一个子节点不一定是膝（实测取到一根朝 −Z 的辅助骨，整条腿的方向就废了）。
   * 脚没有映射到 `leftToes` 的模型，退回第一个骨骼子节点（脚尖骨），那也是对的。
   *
   * 必须在**任何姿势应用之前**调用（构造函数里），否则量到的是当前姿势。
   */
  private captureRestDirs(): void {
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const child: Partial<Record<BoneName, BoneName>> = {
      hips: 'spine',
      spine: 'chest',
      chest: 'upperChest',
      upperChest: 'neck',
      neck: 'head',
      leftShoulder: 'leftUpperArm',
      leftUpperArm: 'leftLowerArm',
      leftLowerArm: 'leftHand',
      rightShoulder: 'rightUpperArm',
      rightUpperArm: 'rightLowerArm',
      rightLowerArm: 'rightHand',
      leftUpperLeg: 'leftLowerLeg',
      leftLowerLeg: 'leftFoot',
      rightUpperLeg: 'rightLowerLeg',
      rightLowerLeg: 'rightFoot',
    }
    const toes: Partial<Record<BoneName, string>> = {
      leftFoot: 'leftToes',
      rightFoot: 'rightToes',
    }
    for (const name of BONE_NAMES) {
      const raw = this.vrm.humanoid.getRawBoneNode(name)
      if (!raw) continue
      const mapped = toes[name] ? this.vrm.humanoid.getRawBoneNode(toes[name] as never) : null
      const kidName = child[name]
      const kidNode = mapped ?? (kidName ? this.vrm.humanoid.getRawBoneNode(kidName) : null)
      const kid = kidNode && kidNode !== raw ? kidNode : (raw.children.find((c) => (c as THREE.Bone).isBone) ?? raw.children[0])
      if (!kid || kid === raw) continue
      raw.getWorldPosition(a)
      kid.getWorldPosition(b)
      b.sub(a)
      if (b.lengthSq() < 1e-10) continue
      b.normalize()
      this.restDirs[name] = [+b.x.toFixed(4), +b.y.toFixed(4), +b.z.toFixed(4)]
    }
  }

  /** 静止朝向表（生成 BVH clip 用，见 `tools/dump_rest_dirs.mjs`） */
  get restDirections(): Record<string, [number, number, number]> {
    return this.restDirs
  }

  apply(pose: ResolvedPose): void {
    for (const name of BONE_NAMES) {
      const node = this.vrm.humanoid.getNormalizedBoneNode(name)
      if (!node) continue
      const e = pose.bones[name]
      node.rotation.set(e[0], e[1], e[2])
    }

    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips')
    if (hips) {
      hips.position.set(
        this.hipsRest.x + pose.hipsOffset[0],
        this.hipsRest.y + pose.hipsOffset[1],
        this.hipsRest.z + pose.hipsOffset[2],
      )
    }

    const em = this.vrm.expressionManager
    if (em) {
      for (const name of ['blink', 'aa', 'ih', 'ou', 'ee', 'oh', 'happy', 'angry', 'sad', 'relaxed', 'surprised'] as const) {
        em.setValue(name, pose.expressions[name])
      }
    }
  }

  update(dt: number): void {
    this.vrm.update(dt)
  }

  /** 读回当前表情权重（调试用：口型幅度/元音形状要能量，不能靠肉眼） */
  getExpressionValue(name: string): number {
    return this.vrm.expressionManager?.getValue(name) ?? 0
  }

  setLookTarget(target: THREE.Vector3 | null): void {
    if (!this.vrm.lookAt) return
    if (target) {
      this.lookTargetObj.position.copy(target)
      this.lookTargetObj.updateMatrixWorld()
      this.vrm.lookAt.target = this.lookTargetObj
    } else {
      this.vrm.lookAt.target = null
    }
  }

  getHeadWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head') ?? this.vrm.humanoid.getRawBoneNode('head')
    if (head) head.getWorldPosition(out)
    else out.set(0, 1, 0)
    return out
  }

  getHeadWorldQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head')
    if (head) head.getWorldQuaternion(out)
    else out.identity()
    return out
  }

  getBoneWorldPosition(name: BoneName, out: THREE.Vector3): THREE.Vector3 {
    const node =
      this.vrm.humanoid.getNormalizedBoneNode(name) ?? this.vrm.humanoid.getRawBoneNode(name)
    if (node) node.getWorldPosition(out)
    else out.set(0, 0, 0)
    return out
  }

  /** 髋骨的世界朝向（脚 IK 用它决定膝盖朝哪边） */
  getHipsWorldQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    const hips = this.vrm.humanoid.getNormalizedBoneNode('hips')
    if (hips) hips.getWorldQuaternion(out)
    else out.identity()
    return out
  }

  getBoneWorldQuaternion(name: BoneName, out: THREE.Quaternion): THREE.Quaternion {
    const node =
      this.vrm.humanoid.getNormalizedBoneNode(name) ?? this.vrm.humanoid.getRawBoneNode(name)
    if (node) node.getWorldQuaternion(out)
    else out.identity()
    return out
  }

  /**
   * 两骨 IK：把脚踝解到世界坐标 `target`，膝盖朝角色前方。
   *
   * 解析解（余弦定理），不迭代：
   *   1. 髋 H 到目标 T 的距离 d 决定膝盖弯多少（三角形三边已知）；
   *   2. 大腿方向 = 把 H→T 朝「前方」偏一个髋角；
   *   3. 用「当前方向 → 目标方向」的四元数转骨骼，再换回局部空间。
   *
   * 传了 `footWorldQuat` 就把脚掌的世界朝向钉住（脚不跟着腿翻棱）。
   */
  solveLeg(side: LegSide, target: THREE.Vector3, footWorldQuat: THREE.Quaternion | null): void {
    const hip = this.vrm.humanoid.getNormalizedBoneNode(`${side}UpperLeg`)
    const knee = this.vrm.humanoid.getNormalizedBoneNode(`${side}LowerLeg`)
    const ankle = this.vrm.humanoid.getNormalizedBoneNode(`${side}Foot`)
    if (!hip || !knee || !ankle) return

    const L1 = this.legLen[side].thigh
    const L2 = this.legLen[side].shin
    if (!(L1 > 0.02) || !(L2 > 0.02)) return

    hip.getWorldPosition(_hip)
    knee.getWorldPosition(_knee)

    _target.copy(target).sub(_hip)
    let d = _target.length()
    if (d < 1e-4) return
    const maxD = (L1 + L2) * 0.999
    const minD = Math.abs(L1 - L2) + 1e-3
    d = clamp(d, minD, maxD)
    _target.setLength(d)
    _u.copy(_target).normalize()

    // 髋角：大腿和 H→T 的夹角
    const cosHip = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1)
    const hipAngle = Math.acos(cosHip)

    // 膝盖朝角色前方：前方向量去掉沿 u 的分量，得到「膝盖该去的方向」
    this.getHipsWorldQuaternion(_qA)
    _pole.set(0, 0, 1).applyQuaternion(_qA)
    _pole.addScaledVector(_u, -_pole.dot(_u))
    if (_pole.lengthSq() < 1e-6) _pole.set(0, 1, 0).cross(_u)
    if (_pole.lengthSq() < 1e-6) return
    _pole.normalize()

    _axis.crossVectors(_u, _pole)
    if (_axis.lengthSq() < 1e-8) return
    _axis.normalize()
    _dir.copy(_u).applyAxisAngle(_axis, hipAngle)

    // 大腿：当前 (膝-髋) → 目标方向
    _seg.copy(_knee).sub(_hip).normalize()
    _qA.setFromUnitVectors(_seg, _dir)
    this.rotateBoneWorld(hip, _qA)
    hip.updateMatrixWorld(true)

    // 小腿：转完大腿再算，直接对准目标
    knee.getWorldPosition(_knee)
    ankle.getWorldPosition(_ankle)
    _dir.copy(target).sub(_knee)
    _seg.copy(_ankle).sub(_knee)
    if (_dir.lengthSq() < 1e-8 || _seg.lengthSq() < 1e-8) return
    _qA.setFromUnitVectors(_seg.normalize(), _dir.normalize())
    this.rotateBoneWorld(knee, _qA)
    knee.updateMatrixWorld(true)

    // 脚掌：钉住世界朝向（可选）
    if (footWorldQuat) {
      const parent = ankle.parent
      if (parent) {
        parent.getWorldQuaternion(_qB)
        ankle.quaternion.copy(_qB.invert().multiply(footWorldQuat))
        ankle.updateMatrixWorld(true)
      }
    }
  }

  /** 调试：手臂 IK 的输入（骨长、肩/腕世界坐标、有没有实现 solveArm） */
  armDebug(): Record<string, number> {
    const up = this.vrm.humanoid.getNormalizedBoneNode('rightUpperArm')
    const fore = this.vrm.humanoid.getNormalizedBoneNode('rightLowerArm')
    const hand = this.vrm.humanoid.getNormalizedBoneNode('rightHand')
    const out: Record<string, number> = {
      upper: this.armLen.right.upper,
      fore: this.armLen.right.fore,
      hasNodes: up && fore && hand ? 1 : 0,
      upPos: up ? up.position.length() : -1,
      forePos: fore ? fore.position.length() : -1,
      handPos: hand ? hand.position.length() : -1,
    }
    if (up && hand) {
      up.getWorldPosition(_hip)
      hand.getWorldPosition(_ankle)
      out.shoulderToWrist = +_hip.distanceTo(_ankle).toFixed(3)
    }
    return out
  }

  /**
   * 两骨 IK（手臂）：把手腕解到世界坐标 `target`，肘朝 `polePoint`。
   *
   * 和 `solveLeg` 同一套解析解，差别有三点：
   *   1. 极点（肘往哪边拐）由调用方给——手臂的肘朝外/朝下取决于动作，
   *      不像膝盖那样永远是「角色前方」；
   *   2. 可以钉住手掌的世界朝向（拨头发时掌心要贴着头发走）；
   *   3. `weight` < 1 时把结果和**解算前**的旋转做球面插值，用来淡入淡出——
   *      否则动作一结束手臂会「啪」地弹回姿势系统算出来的位置。
   */
  solveArm(
    side: LegSide,
    target: THREE.Vector3,
    polePoint: THREE.Vector3,
    opts: { weight?: number; handWorldQuat?: THREE.Quaternion | null } = {},
  ): void {
    const shoulder = this.vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`)
    const elbow = this.vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`)
    const wrist = this.vrm.humanoid.getNormalizedBoneNode(`${side}Hand`)
    if (!shoulder || !elbow || !wrist) return

    const L1 = this.armLen[side].upper
    const L2 = this.armLen[side].fore
    if (!(L1 > 0.02) || !(L2 > 0.02)) return

    const w = clamp(opts.weight ?? 1, 0, 1)
    if (w <= 0.001) return
    _qa.copy(shoulder.quaternion)
    _qb.copy(elbow.quaternion)
    _qc.copy(wrist.quaternion)

    shoulder.getWorldPosition(_hip) // 复用临时变量：肩
    elbow.getWorldPosition(_knee)
    wrist.getWorldPosition(_ankle)

    _target.copy(target).sub(_hip)
    let d = _target.length()
    if (d < 1e-4) return
    const maxD = (L1 + L2) * 0.999
    const minD = Math.abs(L1 - L2) + 1e-3
    d = clamp(d, minD, maxD)
    _target.setLength(d)
    _u.copy(_target).normalize()

    const cosElbow = clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1)
    const shoulderAngle = Math.acos(cosElbow)

    // 肘的方向：调用方给的极点（相对肩），去掉沿 u 的分量
    _pole.copy(polePoint).sub(_hip)
    _pole.addScaledVector(_u, -_pole.dot(_u))
    if (_pole.lengthSq() < 1e-6) _pole.set(0, -1, 0).cross(_u)
    if (_pole.lengthSq() < 1e-6) return
    _pole.normalize()

    _axis.crossVectors(_u, _pole)
    if (_axis.lengthSq() < 1e-8) return
    _axis.normalize()
    _dir.copy(_u).applyAxisAngle(_axis, shoulderAngle)

    _seg.copy(_knee).sub(_hip).normalize()
    _qA.setFromUnitVectors(_seg, _dir)
    this.rotateBoneWorld(shoulder, _qA)
    shoulder.updateMatrixWorld(true)

    elbow.getWorldPosition(_knee)
    wrist.getWorldPosition(_ankle)
    _dir.copy(target).sub(_knee)
    _seg.copy(_ankle).sub(_knee)
    if (_dir.lengthSq() < 1e-8 || _seg.lengthSq() < 1e-8) return
    _qA.setFromUnitVectors(_seg.normalize(), _dir.normalize())
    this.rotateBoneWorld(elbow, _qA)
    elbow.updateMatrixWorld(true)

    if (opts.handWorldQuat) {
      const parent = wrist.parent
      if (parent) {
        parent.getWorldQuaternion(_qB)
        wrist.quaternion.copy(_qB.invert().multiply(opts.handWorldQuat))
        wrist.updateMatrixWorld(true)
      }
    }

    if (w < 0.999) {
      shoulder.quaternion.copy(_qa).slerp(shoulder.quaternion, w)
      elbow.quaternion.copy(_qb).slerp(elbow.quaternion, w)
      wrist.quaternion.copy(_qc).slerp(wrist.quaternion, w)
      shoulder.updateMatrixWorld(true)
      elbow.updateMatrixWorld(true)
      wrist.updateMatrixWorld(true)
    }
  }

  /** 把「世界空间的增量旋转」加到某根骨骼上：local = parentWorld⁻¹ · (delta · world) */  private rotateBoneWorld(node: THREE.Object3D, worldDelta: THREE.Quaternion): void {
    const parent = node.parent
    if (!parent) return
    parent.getWorldQuaternion(_qB)
    node.getWorldQuaternion(_qC)
    _qD.copy(worldDelta).multiply(_qC)
    node.quaternion.copy(_qB.invert().multiply(_qD))
  }

  dispose(): void {
    this.root.removeFromParent()
  }
}
