import type { BoneName, ExpressionName, Vec3 } from '../core/types'
import { USER_POSES } from './userPoses'

/**
 * 姿势库（P7）。
 *
 * 一个姿势 = 一组骨骼的**增量**，写法和 clip 里 `sample()` 返回的东西完全一样：
 * 值是相对「静止姿态」的欧拉角增量，不是绝对朝向。所以
 *
 * - 没写的骨骼 = 不参与（留给别的层），不是「归零」；
 * - 手臂的静息姿态是**下垂**（`VRM_BASE_POSE` 里左臂 z=-1.28、右臂 z=+1.28），
 *   抬手臂要在这个基础上加：左臂「加 +1.28」= 水平，「加 +2.7」= 举过头顶。
 *   第一版按「水平就是 0」写，结果所有手臂姿势都只抬到一半，这是踩过的坑。
 *
 * 单侧姿势只写左边、名字以 `.L` 结尾，`mirrorPose()` 自动生成 `.R`。
 * 左右对称的姿势用 `sym()`（只写左半边，右边自动镜像）。
 */
export type PoseDef = {
  bones?: Partial<Record<BoneName, Vec3>>
  /** 髋部位移（米）。不是旋转——髋部旋转写在 `bones.hips` 里 */
  hipsOffset?: Vec3
  face?: Partial<Record<ExpressionName, number>>
  /** 给 `?pose=` 界面用的一句话说明 */
  note?: string
}

const P = (def: PoseDef): PoseDef => def

/**
 * 把作者的姿势铺在站姿上。
 *
 * 作者摆「比耶」时只动了右手，摆「鼓掌」时只动了手臂和上身——编辑器里其余骨骼
 * 停在**手臂下垂的静息姿态**上，不是站姿。如果原样当关键帧用，动作一开始
 * 双腿就会从站姿（微屈、外八）弹回笔直，看起来「动作一到身体就换了一个人」。
 * 所以这些姿势一律先铺站姿，再盖上作者写的部分。
 */
const overStance = (
  bones: Partial<Record<BoneName, Vec3>>,
): Partial<Record<BoneName, Vec3>> => ({ ...USER_POSES.stance.bones, ...bones })

/** 转身的四个相位：作者的转身姿势 + 整具身体的偏航（髋部 y） */
const spinAt = (yaw: number): PoseDef =>
  P({
    note: `转身 ${Math.round((yaw * 180) / Math.PI)}°（同一套姿势，只转偏航）`,
    bones: { ...overStance(USER_POSES.spin.bones), hips: [0, yaw, 0] },
  })

/**
 * 转身时作者摆的上身（左臂收在胸前、头往左后方看）。髋偏航由 `turn.*` 各补。
 *
 * 2026-11-16：作者先要了「220°（= 顺时针 140°）」，做完发现本意是**逆时针 140°**，
 * 于是两个都留：`turn.cw140`（髋 −140°）和 `turn.ccw140`（髋 +140°）。
 */
const TURN_BODY: Partial<Record<BoneName, Vec3>> = {
  leftShoulder: [-0.6, -0.56, -0.05],
  leftUpperArm: [-0.32, 0.53, -0.18],
  leftLowerArm: [0.15, 0.3, -1.65],
  leftHand: [-0.27, 0.39, -0.75],
  leftIndexProximal: [0, 0, 0.06],
  leftIndexIntermediate: [0, 0, 0.08],
  leftIndexDistal: [0, 0, 0.04],
  leftMiddleProximal: [0, 0, 0.07],
  leftMiddleIntermediate: [0, 0, 0.09],
  leftMiddleDistal: [0, 0, 0.05],
  leftRingProximal: [0, 0, 0.09],
  leftRingIntermediate: [0, 0, 0.11],
  leftRingDistal: [0, 0, 0.06],
  leftLittleProximal: [0, 0, 0.12],
  leftLittleIntermediate: [0, 0, 0.14],
  leftLittleDistal: [0, 0, 0.08],
  leftThumbProximal: [-0.6, 0, -0.12],
  leftThumbDistal: [0, 0, -0.08],
  chest: [0.06, -0.18, 0.06],
  head: [-0.08, -0.84, -0.08],
  rightShoulder: [0.01, -0.27, 0.09],
  rightUpperArm: [0.06, 0.11, -0.13],
  rightLowerArm: [-0.04, -0.04, 0.06],
  rightHand: [-0.2, -0.18, 0.34],
  rightIndexProximal: [0, 0, -0.18],
  rightIndexIntermediate: [0, 0, -0.22],
  rightIndexDistal: [0, 0, -0.12],
  rightMiddleProximal: [0, 0, -0.2],
  rightMiddleIntermediate: [0, 0, -0.26],
  rightMiddleDistal: [0, 0, -0.14],
  rightRingProximal: [0, 0, -0.24],
  rightRingIntermediate: [0, 0, -0.3],
  rightRingDistal: [0, 0, -0.16],
  rightLittleProximal: [0, 0, -0.28],
  rightLittleIntermediate: [0, 0, -0.34],
  rightLittleDistal: [0, 0, -0.18],
  rightThumbProximal: [0.06, -0.08, 0.11],
  rightThumbDistal: [0, 0, 0.12],
  spine: [-0.05, 0.06, 0],
  leftUpperLeg: [-0.04, 0.08, -0.04],
  leftLowerLeg: [0.06, 0.03, 0],
  leftFoot: [0, 0.2, 0],
  rightFoot: [0, -0.32, 0],
  rightLowerLeg: [0.15, -0.08, -0.04],
  rightUpperLeg: [0.15, 0.06, 0.01],
  upperChest: [-0.04, 0, 0],
  neck: [0, -0.32, 0],
}

/** 站姿里的手臂部分（肩 / 上臂 / 前臂 / 手 / 五根手指） */
const ARM_BONE = /^(left|right)(Shoulder|UpperArm|LowerArm|Hand|Index|Middle|Ring|Little|Thumb)/
const stanceArms: Partial<Record<BoneName, Vec3>> = Object.fromEntries(
  Object.entries(USER_POSES.stance.bones).filter(([name]) => ARM_BONE.test(name)),
) as Partial<Record<BoneName, Vec3>>

/** 作者摇摆姿势里的手臂（比站姿张开一些）——摇摆全程用这套，手就不动 */
const swayArms: Partial<Record<BoneName, Vec3>> = Object.fromEntries(
  Object.entries(USER_POSES.sway.bones).filter(([name]) => ARM_BONE.test(name)),
) as Partial<Record<BoneName, Vec3>>

/**
 * 摇摆时手臂的「滞后」：整条手臂在 z 上偏一点点（换算成手的位置约 2 cm）。
 *
 * 手完全钉死会像雕塑——身体在动、手纹丝不动，眼睛一眼就能看出来。
 * 真正的惯性是「手臂比躯干慢半拍」，所以左右两帧的手稍微反着偏一点，
 * 幅度小到不会被看成「在摆手」。
 */
const tiltSwayArms = (dz: number): Partial<Record<BoneName, Vec3>> => {
  const bump = (v: Vec3 | undefined, d: number): Vec3 => [
    v?.[0] ?? 0,
    v?.[1] ?? 0,
    (v?.[2] ?? 0) + d,
  ]
  return {
    ...swayArms,
    leftUpperArm: bump(swayArms.leftUpperArm, dz),
    rightUpperArm: bump(swayArms.rightUpperArm, -dz),
  }
}

/**
 * 站姿 + 增量。
 *
 * 专门给「点头 / 摇头」这类**局部动作**用：它们原本只写了 head/neck/chest，
 * 别的骨骼不在姿势里，于是动作一开始双腿和手臂就掉回笔直的静息——
 * 这正是点头摇头看着别扭的原因。现在铺上站姿，并把写的几根**加**在站姿上
 * （不是覆盖），头的细微朝向得以保留。
 */
const overStanceAdd = (
  delta: Partial<Record<BoneName, Vec3>>,
): Partial<Record<BoneName, Vec3>> => {
  const out: Partial<Record<BoneName, Vec3>> = { ...USER_POSES.stance.bones }
  for (const [name, v] of Object.entries(delta) as [BoneName, Vec3][]) {
    const base = out[name] ?? [0, 0, 0]
    out[name] = [base[0] + v[0], base[1] + v[1], base[2] + v[2]]
  }
  return out
}

/** 左臂：静止时 z 是 -1.28（下垂）。下面三个常量是「加多少」 */
const ARM_HORIZONTAL = 1.28
const ARM_45_UP = 2.05
const ARM_OVERHEAD = 2.72

/** 手指：自然微蜷（不是全直，全直像僵尸手） */
const FINGERS_RELAXED = {
  leftIndexProximal: [0, 0, 0.18],
  leftIndexIntermediate: [0, 0, 0.22],
  leftIndexDistal: [0, 0, 0.12],
  leftMiddleProximal: [0, 0, 0.2],
  leftMiddleIntermediate: [0, 0, 0.26],
  leftMiddleDistal: [0, 0, 0.14],
  leftRingProximal: [0, 0, 0.24],
  leftRingIntermediate: [0, 0, 0.3],
  leftRingDistal: [0, 0, 0.16],
  leftLittleProximal: [0, 0, 0.28],
  leftLittleIntermediate: [0, 0, 0.34],
  leftLittleDistal: [0, 0, 0.18],
  leftThumbProximal: [0, 0, -0.16],
  leftThumbDistal: [0, 0, -0.12],
} satisfies Partial<Record<BoneName, Vec3>>

/** 蜷起（比耶 / 指人时压住其余手指） */
const FINGERS_CURLED = {
  leftIndexProximal: [0, 0, 0.05],
  leftIndexIntermediate: [0, 0, 0.05],
  leftIndexDistal: [0, 0, 0.03],
  leftMiddleProximal: [0, 0, 0.05],
  leftMiddleIntermediate: [0, 0, 0.05],
  leftMiddleDistal: [0, 0, 0.03],
  leftRingProximal: [0, 0, -1.2],
  leftRingIntermediate: [0, 0, -1.3],
  leftRingDistal: [0, 0, -0.7],
  leftLittleProximal: [0, 0, -1.35],
  leftLittleIntermediate: [0, 0, -1.4],
  leftLittleDistal: [0, 0, -0.75],
  leftThumbMetacarpal: [0, 0, -0.5],
  leftThumbProximal: [0, 0, -0.75],
  leftThumbDistal: [0, 0, -0.55],
} satisfies Partial<Record<BoneName, Vec3>>

/** 自然张开（唱歌时伸出去的那只手：不蜷、也不僵直） */
const FINGERS_OPEN = {
  leftIndexProximal: [0, 0, 0.06],
  leftIndexIntermediate: [0, 0, 0.08],
  leftIndexDistal: [0, 0, 0.04],
  leftMiddleProximal: [0, 0, 0.07],
  leftMiddleIntermediate: [0, 0, 0.09],
  leftMiddleDistal: [0, 0, 0.05],
  leftRingProximal: [0, 0, 0.09],
  leftRingIntermediate: [0, 0, 0.11],
  leftRingDistal: [0, 0, 0.06],
  leftLittleProximal: [0, 0, 0.12],
  leftLittleIntermediate: [0, 0, 0.14],
  leftLittleDistal: [0, 0, 0.08],
  leftThumbProximal: [0, 0, -0.12],
  leftThumbDistal: [0, 0, -0.08],
} satisfies Partial<Record<BoneName, Vec3>>

/**
 * 左右对称的姿势：只写左半边，右边用镜像拼上。
 * 手写两遍迟早会出现「两边不对称 0.05 rad」这种自己都看不出来的错误。
 */
function sym(left: PoseDef): PoseDef {
  const right = mirrorPose(left)
  return {
    bones: { ...left.bones, ...right.bones },
    hipsOffset: left.hipsOffset,
    face: left.face,
    note: left.note,
  }
}

/**
 * 上臂的两个旋转轴（实测确认，见 `.tmp` 里的探针对照）：
 *
 * - `z`：在**冠状面**里抬起/放下。+1.28 = 水平，+2.72 = 举过头顶（左臂）
 * - `x`：向前/向后摆。**负值是向前**（-0.8 大约前摆 45°）
 * - `y`：绕上臂自身轴的拧转，基本只影响手掌朝向
 *
 * 所以「手臂向前平伸」是 `[-1.35, 0, 1.15]` 这种组合，不是把 y 拧过去。
 * 第一版把 y 当成前摆轴，结果「合掌」「抱胸」都变成了举手欢呼。
 */

/**
 * 经典唱歌姿势（用户 2026-11-11 在姿势编辑器里自己摆的，原样收录）。
 *
 * 右手抚胸、左手向侧面伸出掌心向上，头略微转向并轻抬，两脚外八站开。
 * 这是第一版「描述 → 我猜」失败之后改走「用户自己摆」的产物，
 * 所以数值不再由我推导——**要改就再摆一次发 JSON**，别在这里手调。
 */
const SING_BALLAD_BONES = {
  spine: [-0.05, 0.06, 0],
  chest: [0.06, -0.18, 0.06],
  upperChest: [-0.04, 0, 0],
  head: [-0.18, 0.44, -0.18],
  leftShoulder: [0, 0, -0.05],
  leftUpperArm: [-0.2, -0.43, 0.94],
  leftLowerArm: [-0.31, -0.54, 0.31],
  leftHand: [-1.28, -0.54, 0.31],
  rightShoulder: [-1.13, 0.03, 0.09],
  rightUpperArm: [-0.09, -0.43, -0.2],
  rightLowerArm: [0.2, 0.37, 1.51],
  rightHand: [-0.2, -0.37, 1.11],
  leftUpperLeg: [-0.04, 0.08, -0.04],
  leftLowerLeg: [0.06, 0.03, 0],
  leftFoot: [0, 0.2, 0],
  rightUpperLeg: [0.01, -0.04, 0.01],
  rightLowerLeg: [0.11, -0.18, 0],
  rightFoot: [0, -0.32, 0],
  leftIndexProximal: [0, 0, 0.06],
  leftIndexIntermediate: [0, 0, 0.08],
  leftIndexDistal: [0, 0, 0.04],
  leftMiddleProximal: [0, 0, 0.07],
  leftMiddleIntermediate: [0, 0, 0.09],
  leftMiddleDistal: [0, 0, 0.05],
  leftRingProximal: [0, 0, 0.09],
  leftRingIntermediate: [0, 0, 0.11],
  leftRingDistal: [0, 0, 0.06],
  leftLittleProximal: [0, 0, 0.12],
  leftLittleIntermediate: [0, 0, 0.14],
  leftLittleDistal: [0, 0, 0.08],
  leftThumbProximal: [-0.6, 0, -0.12],
  leftThumbDistal: [0, 0, -0.08],
  rightIndexProximal: [0, 0, -0.18],
  rightIndexIntermediate: [0, 0, -0.22],
  rightIndexDistal: [0, 0, -0.12],
  rightMiddleProximal: [0, 0, -0.2],
  rightMiddleIntermediate: [0, 0, -0.26],
  rightMiddleDistal: [0, 0, -0.14],
  rightRingProximal: [0, 0, -0.24],
  rightRingIntermediate: [0, 0, -0.3],
  rightRingDistal: [0, 0, -0.16],
  rightLittleProximal: [0, 0, -0.28],
  rightLittleIntermediate: [0, 0, -0.34],
  rightLittleDistal: [0, 0, -0.18],
  rightThumbProximal: [0.49, 0, 0.16],
  rightThumbDistal: [0, 0, 0.12],
} satisfies Partial<Record<BoneName, Vec3>>

export const POSES: Record<string, PoseDef> = {
  // 作者（用户）在编辑器里摆的姿势，脚本生成，见 userPoses.ts。
  // 它们排在前面，所以下面同名的「我早期手写的版本」会被覆盖——这是有意的，
  // 作者摆的永远比量出来的准。
  ...Object.fromEntries(
    Object.entries(USER_POSES).map(
      ([id, pose]) => [id, P({ note: pose.note, bones: pose.bones })] as const,
    ),
  ),

  // -------------------------------------------------------------------------
  // 站姿 / 重心
  // -------------------------------------------------------------------------

  // 作者摆的姿势没有带髋位移（编辑器里那一项他没动）。欢呼改成真跳之后，
  // 高度由 `jump.*` 那几帧给，这个姿势就保持「脚踩在地上」的样子。
  'cheer': P({
    note: '双手举高欢呼（作者的姿势，跳跃时用作顶点那一帧）',
    bones: USER_POSES.cheer.bones,
  }),

  // ---- 跳跃（pose.cheer）：蓄力 → 蹬伸 → 腾空 → 下落 → 落地缓冲 ----
  //
  // 作者摆的 `cheer` 本身就是「后踢一条腿 + 双手上举」，所以它当顶点最合适；
  // 剩下要补的是垂直方向的前后文。这几个姿势里的腿部数值是照 `crouch` /
  // `idle.dip` 的读法推的（大腿 x 负、小腿 x 正 = 屈膝），不是从编辑器量的。

  'jump.prep': P({
    note: '起跳蓄力：屈膝下蹲、上身前倾、双臂后摆（跳跃用）',
    bones: {
      hips: [0.08, 0, 0],
      spine: [0.26, 0, 0],
      chest: [0.14, 0, 0],
      head: [-0.16, 0, 0],
      leftUpperLeg: [-0.68, 0.08, -0.05],
      rightUpperLeg: [-0.68, 0.06, 0.05],
      leftLowerLeg: [1.25, 0.03, 0],
      rightLowerLeg: [1.25, -0.08, -0.04],
      leftFoot: [0.5, 0.2, 0],
      rightFoot: [0.5, -0.32, 0],
      leftUpperArm: [0.52, 0, -0.06],
      rightUpperArm: [0.52, 0, 0.06],
      leftLowerArm: [0, 0, 0.4],
      rightLowerArm: [0, 0, -0.4],
      ...FINGERS_RELAXED,
      ...mirrorPose({ bones: FINGERS_RELAXED }).bones,
    },
    hipsOffset: [0, -0.157, 0],
  }),

  'jump.push': P({
    note: '蹬伸：双腿伸直、踮起脚（手臂交给插值自己甩上去）',
    bones: {
      hips: [0.01, 0, 0],
      spine: [0.03, 0, 0],
      chest: [0.02, 0, 0],
      head: [0.04, 0, 0],
      leftUpperLeg: [0.02, 0.08, -0.04],
      rightUpperLeg: [0.02, 0.06, 0.02],
      leftLowerLeg: [0.05, 0.03, 0],
      rightLowerLeg: [0.05, -0.08, -0.04],
      leftFoot: [0.45, 0.2, 0],
      rightFoot: [0.45, -0.32, 0],
      ...FINGERS_RELAXED,
      ...mirrorPose({ bones: FINGERS_RELAXED }).bones,
    },
    hipsOffset: [0, 0.03, 0],
  }),

  'jump.air': P({
    note: '腾空顶点：作者的欢呼姿势 + 整个人离地 15.5 cm（跳跃用）',
    bones: {
      ...USER_POSES.cheer.bones,
      // 作者只写了左手手指，右手不动会变成直指，补上镜像
      ...mirrorPose({ bones: FINGERS_RELAXED }).bones,
    },
    hipsOffset: [0, 0.155, 0],
  }),

  'jump.fall': P({
    note: '下落：双手保持举着，双腿伸向地面（跳跃用）',
    bones: {
      ...USER_POSES.cheer.bones,
      leftUpperLeg: [-0.1, 0.08, -0.04],
      leftLowerLeg: [0.22, 0.03, 0],
      rightUpperLeg: [-0.06, 0.06, 0.02],
      rightLowerLeg: [0.18, -0.08, -0.04],
      leftFoot: [0.2, 0.2, 0],
      rightFoot: [0.2, -0.32, 0],
      head: [-0.04, -0.04, 0.04],
      // 还在举着，只比顶点低一点点（下落途中就收手会显得没劲）
      leftUpperArm: [-0.12, -0.16, 1.08],
      rightUpperArm: [0, 0, -0.84],
      ...mirrorPose({ bones: FINGERS_RELAXED }).bones,
    },
    hipsOffset: [0, 0.06, 0],
  }),

  'jump.land': P({
    note: '落地缓冲：屈膝、上身前倾、双臂放下来找平衡（跳跃用）',
    bones: {
      hips: [0.06, 0, 0],
      spine: [0.2, 0, 0],
      chest: [0.12, 0, 0],
      head: [-0.14, 0, 0],
      leftUpperLeg: [-0.6, 0.08, -0.06],
      rightUpperLeg: [-0.6, 0.06, 0.06],
      leftLowerLeg: [1.1, 0.03, 0],
      rightLowerLeg: [1.1, -0.08, -0.04],
      leftFoot: [0.45, 0.2, 0],
      rightFoot: [0.45, -0.32, 0],
      leftUpperArm: [-0.1, 0, 0.34],
      rightUpperArm: [-0.1, 0, -0.34],
      leftLowerArm: [0, 0, 0.46],
      rightLowerArm: [0, 0, -0.46],
      ...FINGERS_RELAXED,
      ...mirrorPose({ bones: FINGERS_RELAXED }).bones,
    },
    hipsOffset: [0, -0.125, 0],
  }),

  // ---- 作者第二批（转圈 / 摇摆 / 挥手 / 鼓掌 / 比耶）----
  // 全部铺在站姿上，理由见 `overStance()`。

  'spin': P({
    note: '转身起步：一条腿收起来、手臂收在身前（作者摆的）',
    bones: overStance(USER_POSES.spin.bones),
  }),

  /**
   * 转身姿势：作者摆的上身（左臂收在胸前、头往左后方看）。
   * 髋的偏航由下面两个姿势各自补，所以上身可以共用。
   *
   * 用途是**检查镜头角度**：把她的朝向拧到那一侧，就能在固定机位下看那一边的脸/身体，
   * 而不是靠转相机（相机一转，构图的判断也会跟着变）。
   */
  'turn.cw140': P({
    note: '转身 220°（= 顺时针 140°）：作者摆的回头姿势 + 髋偏航 −140°',
    bones: { ...TURN_BODY, hips: [0, (-140 * Math.PI) / 180, 0] },
  }),

  'turn.ccw140': P({
    note: '转身 140°（逆时针）：同一套上身 + 髋偏航 +140°',
    bones: { ...TURN_BODY, hips: [0, (140 * Math.PI) / 180, 0] },
  }),


  'spin.quarter': spinAt(Math.PI / 2),
  'spin.half': spinAt(Math.PI),
  'spin.three': spinAt((Math.PI * 3) / 2),
  // 收尾这一帧用**站姿** + 2π，不是「转身姿势 + 2π」：
  // 转完腿要落回站姿，否则剪辑一结束，腿会在 20 ms 的淡出里从转身姿势
  // 弹回站姿（脚会瞬间挪 15 cm）。
  'spin.full': P({
    note: '转身 360°：回到站姿（偏航正好 2π，和 idle.base 视觉一致，但不会倒着转回去）',
    bones: { ...USER_POSES.stance.bones, hips: [0, Math.PI * 2, 0] },
  }),

  'sway.L': P({
    note: '摇摆：重心偏一侧，手臂是作者摇摆帧的位置（只带约 2 cm 的滞后）',
    bones: { ...overStance(USER_POSES.sway.bones), ...tiltSwayArms(0.05) },
    // 重心落到一条腿上：髋往那条腿偏，人同时往下坐一点。
    // 侧移 3 cm 是「摇摆」和「原地歪一下」的分界——只有上身转、髋不动，看着就是僵硬。
    // 方向要跟作者那张姿势本身的倾向往一边（他是往 -X 倾的），否则互相抵消。
    hipsOffset: [-0.03, -0.014, 0],
  }),

  // 显式写出来，这样自动镜像不会把左右手臂的值互换
  'sway.R': P({
    note: '摇摆：镜像（手臂反着滞后一点）',
    bones: {
      ...mirrorPose({ bones: { ...overStance(USER_POSES.sway.bones), ...tiltSwayArms(0.05) } })
        .bones,
      ...tiltSwayArms(-0.05),
    },
    hipsOffset: [0.03, -0.014, 0],
  }),

  // 循环中间那一拍身体回中，但手臂不能跟着回——否则每拍手臂都会张合一次
  'sway.center': P({
    note: '摇摆：重心回中间（身体是站姿，手臂保持摇摆的张开度，并且往上弹一点）',
    bones: { ...USER_POSES.stance.bones, ...swayArms },
    hipsOffset: [0, 0.005, 0],
  }),

  'wave.1': P({
    note: '挥手：手偏外（作者摆的）',
    bones: overStance(USER_POSES['wave.1'].bones),
  }),

  // 作者给的「手偏内」那一帧会把整条胳膊压下来，看着像手往下掉，弃用。
  // 挥手的实质是**手腕在动、上臂几乎不动**：保持作者那张抬手的帧，
  // 只把前臂摆过去。数值用 `.tmp/hand_probe.mjs` 量过：手横向摆 13 cm、
  // 高度只差 3 cm、前后几乎不动——这才像挥手，不像胳膊晃。
  'wave.in': P({
    note: '挥手：手摆到内侧（在作者的抬手帧上只转前臂，我推的）',
    bones: {
      ...overStance(USER_POSES['wave.1'].bones),
      leftLowerArm: [-0.04, -0.8, 0.42],
    },
  }),

  'clap': P({
    note: '鼓掌：双手分开在胸前（作者摆的）',
    bones: overStance(USER_POSES.clap.bones),
  }),

  // 作者摆的是「分开」的那一帧（两手腕间距 19 cm），合上的要另外做。
  // 合上不只是把两手靠近：**手本身也得转**，不然两只手插在一起（穿模）。
  // 现在的值是在 `.tmp/variant_shots.mjs` 里一比一截图选出来的：
  // 上臂往里收到两腕 9 cm，掌心转成相对（`hands.x ±0.5`），
  // 高度 1.17 m 不变，指缝不交叉。
  'clap.shut': P({
    note: '鼓掌：双手合上（作者的分开帧收上臂 + 转手腕，我推的）',
    bones: {
      ...overStance(USER_POSES.clap.bones),
      leftUpperArm: [0.15, -0.95, 0.3],
      rightUpperArm: [-0.15, 0.83, -0.18],
      leftHand: [0.5, -0.2, 0],
      rightHand: [-0.5, 0.2, 0],
    },
  }),

  'peace': P({
    note: '比耶：右手（作者摆的）',
    bones: overStance(USER_POSES.peace.bones),
  }),

  // ---- 拨头发（作者说原版「效果不太好」，这两帧是我推的）----
  //
  // 量出来的病根：作者那两帧的右手在**头前方 25 cm、下方 15 cm**，
  // 离开头骨 33 cm——根本不在耳边，看着是「手端在胸前」。
  //
  // 几何上这里有个硬约束：肩到手 10 cm、上臂 14.5 cm、前臂 14.5 cm，
  // 要让手腕落在耳侧（离肩只有 10 cm），**肘必须往侧面撑出去**，
  // 撑到下巴到眼之间；肘垂在身前的话，手腕怎么转都在胸前。
  //
  // 头的尺度（`src/rig/primitiveRig.ts`）：**头心在头骨上方 9 cm**，
  // 颅球半径 0.128、头发 0.133，马尾胶囊挂在 x≈0.125 处。
  // 第一版我把「头骨」当成了头心，目标点离头心只有 12.4 cm——手整个埋进脸里，
  // 看着像在捂嘴（用户 2026-11-12 指出「做的有问题」，就是这里）。
  // 第二版又给肘加了「必须在肩外侧 15~30 cm」的盒子，可这套骨架里肩在 x=0.107，
  // **肘天然落在 0.05~0.09**，盒子把整条手臂逼到身体外面去了：
  // 中间帧的手甩到 x=0.25、离头 27 cm，比原版还怪。
  // 现在改成只惩罚「肘或腕进颅球」，手臂就会沿着身体前面收进来。
  //
  // 数值在 `.tmp/hair_search.mjs` 里随机重启 + 坐标下降搜出来，误差 3 mm / 1 mm，
  // 手腕离头心 17.9 cm / 19.2 cm（颅球 13.3 cm，所以贴着头发外侧）。
  // 两帧之间手腕只往下移 9 cm、x/z 几乎不动，插值就是「顺着鬓角抹下去」。
  'hair.ear.fix': P({
    note: '拨头发：手到耳侧/太阳穴（作者的躯干 + 我推的手臂）',
    bones: {
      ...USER_POSES['hair.ear'].bones,
      rightUpperArm: [-1.62, 1.28, -0.71],
      rightLowerArm: [-2.26, 2.91, 1.05],
    },
  }),

  'hair.shoulder.fix': P({
    note: '拨头发：手扫到颈侧/发梢（作者的躯干 + 我推的手臂）',
    bones: {
      ...USER_POSES['hair.shoulder'].bones,
      rightUpperArm: [-1.32, 1.28, -0.76],
      rightLowerArm: [-2.8, 2.83, 0.62],
    },
  }),

  'lean.in': P({
    note: '上身前倾凑近镜头（髋后坐下沉，避免看起来像弯腰捡东西）',
    bones: USER_POSES['lean.in'].bones,
    hipsOffset: [0, -0.05, -0.06],
  }),

  'idle.base': P({
    note: '基础站姿（作者摆的）：所有一次性动作的起点和终点都是它',
    bones: USER_POSES.stance.bones,
  }),

  'idle.weight.L': P({
    note: '重心压左腿：髋左移、左腿撑直、右膝松、上身反向',
    bones: {
      hips: [0, 0.03, 0.045],
      spine: [0.01, -0.02, -0.05],
      chest: [0.01, -0.03, -0.06],
      neck: [0, 0, -0.02],
      head: [0.015, -0.05, 0.035],
      // 支撑腿（左）接近伸直，自由腿（右）松一点并略提踵
      leftUpperLeg: [-0.02, 0, -0.02],
      leftLowerLeg: [0.04, 0, 0],
      leftFoot: [-0.02, 0, 0.03],
      rightUpperLeg: [-0.08, 0, 0.04],
      rightLowerLeg: [0.16, 0, 0],
      rightFoot: [0.1, 0, 0.02],
      leftUpperArm: [0.02, 0, -0.06],
      rightUpperArm: [0.02, 0, -0.02],
      leftLowerArm: [0, 0, 0.1],
      rightLowerArm: [0, 0, -0.14],
    },
    hipsOffset: [0.032, -0.008, 0],
  }),

  'idle.dip': P({
    note: '屈伸：双膝下沉，重心居中',
    bones: {
      hips: [0.01, 0, 0],
      spine: [0.04, 0, 0],
      chest: [0.03, 0, 0],
      head: [0.04, 0, 0],
      leftUpperLeg: [-0.12, 0, -0.01],
      rightUpperLeg: [-0.12, 0, 0.01],
      leftLowerLeg: [0.24, 0, 0],
      rightLowerLeg: [0.24, 0, 0],
      leftFoot: [0.11, 0, 0.01],
      rightFoot: [0.11, 0, -0.01],
      leftUpperArm: [0.04, 0, 0.05],
      rightUpperArm: [0.04, 0, -0.05],
    },
    hipsOffset: [0, -0.022, 0],
  }),

  'crouch': P({
    note: '半蹲（预备/落地）',
    bones: {
      hips: [0.04, 0, 0],
      spine: [0.1, 0, 0],
      chest: [0.07, 0, 0],
      head: [-0.02, 0, 0],
      leftUpperLeg: [-0.34, 0, -0.02],
      rightUpperLeg: [-0.34, 0, 0.02],
      leftLowerLeg: [0.62, 0, 0],
      rightLowerLeg: [0.62, 0, 0],
      leftFoot: [0.3, 0, 0.02],
      rightFoot: [0.3, 0, -0.02],
      leftUpperArm: [0.1, 0, 0.08],
      rightUpperArm: [0.1, 0, -0.08],
      leftLowerArm: [0, 0, 0.2],
      rightLowerArm: [0, 0, -0.2],
    },
    hipsOffset: [0, -0.07, 0],
  }),

  'step.L': P({
    note: '左脚向前迈半步（转圈 pivot 用）',
    bones: {
      hips: [0.02, 0.12, 0],
      leftUpperLeg: [-0.34, 0, -0.03],
      leftLowerLeg: [0.3, 0, 0],
      leftFoot: [0.06, 0, 0.02],
      rightUpperLeg: [0.12, 0, 0.02],
      rightLowerLeg: [0.06, 0, 0],
      rightFoot: [-0.04, 0, -0.02],
      spine: [0.02, -0.06, 0],
      chest: [0.01, -0.05, 0],
    },
    hipsOffset: [0.01, -0.012, 0],
  }),

  // -------------------------------------------------------------------------
  // 手臂（注意：z 是在「下垂」基础上的增量，见文件头）
  // -------------------------------------------------------------------------

  'arm.up.half.L': P({
    note: '左臂抬到水平上方 45°（起手）',
    bones: {
      leftShoulder: [0, 0, -0.1],
      leftUpperArm: [-0.08, -0.22, ARM_45_UP],
      leftLowerArm: [0, 0, 0.22],
      chest: [0, -0.02, -0.03],
      head: [0, -0.03, 0.02],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.up.full.L': P({
    note: '左臂举过头顶',
    bones: {
      leftShoulder: [0, 0, -0.16],
      leftUpperArm: [-0.12, -0.16, ARM_OVERHEAD],
      leftLowerArm: [0, 0, 0.16],
      chest: [0, -0.03, -0.05],
      head: [0, -0.04, 0.04],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.wave.out.L': P({
    note: '举手 + 前臂外摆',
    bones: {
      leftShoulder: [0, 0, -0.16],
      leftUpperArm: [-0.12, -0.16, ARM_OVERHEAD - 0.04],
      leftLowerArm: [0, 0, 0.46],
      leftHand: [0, 0, 0.16],
      head: [0, -0.05, 0.05],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.wave.in.L': P({
    note: '举手 + 前臂内摆',
    bones: {
      leftShoulder: [0, 0, -0.16],
      leftUpperArm: [-0.12, -0.16, ARM_OVERHEAD],
      leftLowerArm: [0, 0, -0.08],
      leftHand: [0, 0, -0.14],
      head: [0, -0.05, 0.03],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.hip.L': P({
    note: '左手叉腰',
    bones: {
      leftShoulder: [0, 0, -0.04],
      leftUpperArm: [0.8, -0.4, 0],
      leftLowerArm: [0, 1.4, 2.4],
      leftHand: [0, -0.4, 0],
      chest: [0, 0.03, -0.02],
      head: [0, 0.06, -0.03],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.cross': sym({
    note: '双手抱在身前（交叉）',
    bones: {
      leftShoulder: [0, 0, -0.05],
      leftUpperArm: [0, -1.8, 0.28],
      leftLowerArm: [0, -1.5, 1.9],
      leftHand: [0, 0.5, 0],
      chest: [0.02, 0, 0],
      head: [0.02, 0, 0],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.open': sym({
    note: '双臂张开、掌心朝上',
    bones: {
      leftUpperArm: [-0.15, -0.1, ARM_HORIZONTAL - 0.12],
      leftLowerArm: [0, 0, 0.1],
      leftHand: [0, -0.5, 0],
      chest: [-0.04, 0, 0],
      head: [-0.06, 0, 0],
      ...FINGERS_RELAXED,
    },
  }),

  'arm.reach.L': P({
    note: '左臂向前平伸',
    bones: {
      leftShoulder: [0, 0, -0.06],
      leftUpperArm: [0, -1.5, 1.2],
      leftLowerArm: [0, 0, 0.1],
      leftHand: [0, -0.4, 0],
      chest: [0, -0.05, 0],
      head: [0, -0.08, 0],
      ...FINGERS_RELAXED,
    },
  }),

  'stretch': sym({
    note: '伸懒腰：双臂上举、挺胸、抬头',
    bones: {
      leftUpperArm: [-0.15, 0, ARM_OVERHEAD - 0.02],
      leftLowerArm: [0, 0, -0.05],
      spine: [-0.06, 0, 0],
      chest: [-0.1, 0, 0],
      head: [-0.14, 0, 0],
      ...FINGERS_RELAXED,
    },
    hipsOffset: [0, 0.012, 0],
  }),

  // -------------------------------------------------------------------------
  // 手型
  // -------------------------------------------------------------------------

  'hand.peace.arm.L': P({
    note: '左手抬到脸侧（手指还是松的）',
    bones: {
      leftShoulder: [0, 0, -0.1],
      leftUpperArm: [-0.35, 0, 0.85],
      leftLowerArm: [0, 0, 1.95],
      leftHand: [0, -1.5, 0],
      head: [0, 0.06, -0.06],
      chest: [0, 0.02, 0],
      ...FINGERS_RELAXED,
    },
  }),

  'hand.peace.L': P({
    note: '比耶：食指中指伸直、无名指小指蜷起',
    bones: {
      leftShoulder: [0, 0, -0.1],
      leftUpperArm: [-0.35, 0, 0.85],
      leftLowerArm: [0, 0, 1.95],
      leftHand: [0, -1.5, 0],
      head: [0, 0.06, -0.06],
      chest: [0, 0.02, 0],
      ...FINGERS_CURLED,
    },
    face: { happy: 0.5 },
  }),

  'hand.point.L': P({
    note: '指人：食指伸出，其余蜷起',
    bones: {
      leftShoulder: [0, 0, -0.06],
      leftUpperArm: [0, -1.5, 1.2],
      leftLowerArm: [0, 0, 0.15],
      leftHand: [0, -0.3, 0],
      ...FINGERS_CURLED,
      leftIndexProximal: [0, 0, 0],
      leftIndexIntermediate: [0, 0, 0],
      leftIndexDistal: [0, 0, 0],
    },
    face: { happy: 0.3 },
  }),

  // -------------------------------------------------------------------------
  // 唱歌
  // -------------------------------------------------------------------------

  'sing.ballad': P({
    note: '经典唱歌姿势：右手抚胸、左手向侧面伸出掌心向上（用户在编辑器里摆的）',
    bones: { ...SING_BALLAD_BONES },
    face: { happy: 0.2, relaxed: 0.35 },
  }),

  // -------------------------------------------------------------------------
  // 头 / 肩
  // -------------------------------------------------------------------------

  'head.tilt.L': P({
    note: '歪头（向左侧倾）',
    bones: overStanceAdd({
      head: [0.02, 0.1, 0.22],
      neck: [0, 0.04, 0.09],
      chest: [0, 0.02, 0.03],
    }),
  }),

  'head.turn.L': P({
    note: '转头看左边（偏航，摇头用）',
    bones: overStanceAdd({
      head: [0, 0.34, 0.02],
      neck: [0, 0.14, 0],
      chest: [0, 0.05, 0],
    }),
  }),

  'head.down': P({
    note: '低头',
    bones: overStanceAdd({
      head: [0.16, 0, 0],
      neck: [0.06, 0, 0],
      chest: [0.02, 0, 0],
    }),
  }),

  'head.up': P({
    note: '抬头（预备拍）',
    bones: overStanceAdd({
      head: [-0.12, 0, 0],
      neck: [-0.04, 0, 0],
      chest: [-0.02, 0, 0],
    }),
  }),

  'shrug': sym({
    note: '耸肩',
    bones: {
      leftShoulder: [0, 0, -0.2],
      leftLowerArm: [0, 0, 0.3],
      head: [0.03, 0, 0],
      chest: [0.02, 0, 0],
    },
  }),

  'lean.back': P({
    note: '上身后仰',
    bones: {
      hips: [-0.06, 0, 0],
      spine: [-0.06, 0, 0],
      chest: [-0.05, 0, 0],
      head: [-0.02, 0, 0],
      leftUpperLeg: [-0.04, 0, 0],
      rightUpperLeg: [-0.04, 0, 0],
    },
    hipsOffset: [0, -0.01, -0.012],
  }),

  // -------------------------------------------------------------------------
  // 转身（按偏航角拆成四段，转圈 clip 用）
  // -------------------------------------------------------------------------

  'turn.quarter.L': P({
    note: '转身 90°：迈左步、手臂外张',
    bones: {
      hips: [0.02, 1.571, 0],
      leftUpperLeg: [-0.3, 0, -0.04],
      leftLowerLeg: [0.34, 0, 0],
      rightUpperLeg: [0.14, 0, 0.04],
      rightLowerLeg: [0.1, 0, 0],
      spine: [0.03, -0.1, 0],
      chest: [0.02, -0.12, 0],
      head: [0, -0.16, 0.04],
      leftUpperArm: [-0.12, 0, 0.5],
      rightUpperArm: [-0.12, 0, -0.5],
      leftLowerArm: [0, 0, 0.2],
      rightLowerArm: [0, 0, -0.2],
    },
    hipsOffset: [-0.008, -0.014, 0],
  }),

  'turn.half.L': P({
    note: '转身 180°：两脚交替，手臂收紧',
    bones: {
      hips: [0.02, 3.142, 0],
      leftUpperLeg: [-0.16, 0, -0.03],
      leftLowerLeg: [0.22, 0, 0],
      rightUpperLeg: [-0.1, 0, 0.03],
      rightLowerLeg: [0.3, 0, 0],
      spine: [0.02, -0.06, 0],
      chest: [0.02, -0.08, 0],
      head: [0, -0.1, 0.02],
      leftUpperArm: [-0.06, 0, 0.34],
      rightUpperArm: [-0.06, 0, -0.34],
      leftLowerArm: [0, 0, 0.4],
      rightLowerArm: [0, 0, -0.4],
    },
    hipsOffset: [0, -0.02, 0],
  }),

  'turn.three.L': P({
    note: '转身 270°：手臂重新外张',
    bones: {
      hips: [0.02, 4.712, 0],
      leftUpperLeg: [0.12, 0, -0.04],
      leftLowerLeg: [0.12, 0, 0],
      rightUpperLeg: [-0.28, 0, 0.04],
      rightLowerLeg: [0.36, 0, 0],
      spine: [0.03, 0.08, 0],
      chest: [0.02, 0.1, 0],
      head: [0, 0.12, 0.03],
      leftUpperArm: [-0.14, 0, 0.52],
      rightUpperArm: [-0.14, 0, -0.52],
      leftLowerArm: [0, 0, 0.16],
      rightLowerArm: [0, 0, -0.16],
    },
    hipsOffset: [0.008, -0.014, 0],
  }),

  'turn.full': P({
    note: '转身 360°：回到站姿（偏航正好 2π，和 idle.base 视觉一致，但不会倒着转回去）',
    bones: {
      hips: [0, 6.283, 0],
      leftUpperLeg: [-0.02, 0, -0.02],
      leftLowerLeg: [0.04, 0, 0],
      rightUpperLeg: [-0.04, 0, 0.02],
      rightLowerLeg: [0.08, 0, 0],
      spine: [0, -0.01, -0.03],
      chest: [0, -0.02, -0.03],
      head: [0, -0.02, 0.02],
      leftUpperArm: [0.02, 0, -0.05],
      rightUpperArm: [0.02, 0, 0.02],
      leftLowerArm: [0, 0, 0.08],
      rightLowerArm: [0, 0, -0.1],
    },
    hipsOffset: [0.01, -0.008, 0],
  }),

  /** 预备拍：微微下沉、手臂收到身侧 —— 所有「击」前面都该有这一帧 */
  'prep.dip': P({
    note: '预备：微沉 + 手臂收到身侧',
    bones: {
      hips: [0.02, 0, 0],
      spine: [0.05, 0, 0],
      chest: [0.04, 0, 0],
      head: [0.03, 0, 0],
      leftUpperLeg: [-0.07, 0, 0],
      rightUpperLeg: [-0.07, 0, 0],
      leftLowerLeg: [0.14, 0, 0],
      rightLowerLeg: [0.14, 0, 0],
      leftFoot: [0.06, 0, 0],
      rightFoot: [0.06, 0, 0],
      leftUpperArm: [0.06, 0, -0.08],
      rightUpperArm: [0.06, 0, 0.08],
      leftLowerArm: [0, 0, 0.26],
      rightLowerArm: [0, 0, -0.26],
    },
    hipsOffset: [0, -0.028, 0],
  }),
}

// ---------------------------------------------------------------------------
// 镜像
// ---------------------------------------------------------------------------

/** 左右骨骼名互换。写成函数声明，这样模块初始化时调用它已经可用（`const` 箭头函数会踩 TDZ）。 */
function swapSide(name: string): string {
  if (name.startsWith('left')) return `right${name.slice(4)}`
  if (name.startsWith('right')) return `left${name.slice(5)}`
  return name
}

/**
 * 镜像一个姿势。
 *
 * 欧拉角按 `(x, -y, -z)` 变换是「绕 YZ 平面镜像」的标准结果：
 * 以手臂下垂为例，左臂 `z=-1.28` 镜像后是右臂的 `z=+1.28`，和 `VRM_BASE_POSE` 一致。
 */
export function mirrorPose(def: PoseDef): PoseDef {
  const bones: Partial<Record<BoneName, Vec3>> = {}
  for (const key of Object.keys(def.bones ?? {}) as BoneName[]) {
    const v = def.bones?.[key]
    if (!v) continue
    bones[swapSide(key) as BoneName] = [v[0], -v[1], -v[2]]
  }
  const mirrored: PoseDef = { bones }
  if (def.hipsOffset) mirrored.hipsOffset = [-def.hipsOffset[0], def.hipsOffset[1], def.hipsOffset[2]]
  if (def.face) mirrored.face = { ...def.face }
  if (def.note) mirrored.note = def.note.includes('左') ? def.note.replace('左', '右') : def.note
  return mirrored
}

// 所有以 .L 结尾的姿势自动生成 .R
const withMirrors: Record<string, PoseDef> = { ...POSES }
for (const [id, def] of Object.entries(POSES)) {
  if (id.endsWith('.L') && !(id.slice(0, -2) + '.R' in POSES)) {
    withMirrors[id.slice(0, -2) + '.R'] = mirrorPose(def)
  }
}

export const POSE_IDS: string[] = Object.keys(withMirrors).sort()

export function getPose(id: string): PoseDef | undefined {
  return withMirrors[id]
}
