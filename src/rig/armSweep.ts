import * as THREE from 'three'
import type { HumanoidRig } from './rig'

/**
 * 世界坐标手臂动画（拨头发）。
 *
 * 为什么需要它：姿势系统只会「绕关节转欧拉角再线性插值」，两帧差得远的时候
 * 中间帧不受控——拨头发那段扫动，肘的滚动角会先转过去、小臂横着甩出去
 * （2026-11-12 记录的坑）。真正的做法是**给手腕一条世界空间的轨迹**，
 * 每帧用两骨 IK 把手臂解到轨迹上，肘的朝向由极点决定。
 *
 * 轨迹写在**头部坐标系**里（相对头骨 + 用头的朝向旋转），所以头一转，
 * 手也跟着走；换成身高的比例也不用手改。
 *
 * 坐标约定（角色面朝 +Z、上 +Y）：
 *   x 正 = 角色的**左**，x 负 = 角色的右，z 正 = 前。
 * 所以右手在头左侧扫头发时 x 取负——`SIDE` 就是干这个的。
 */

/** 头的半径（米）：轨迹不能进到球里，这是硬约束 */
export const HEAD_RADIUS = 0.128
/** 头心相对头骨的位置（米，沿头部 +Y） */
export const HEAD_CENTER_DY = 0.09

type Key = { t: number; pos: [number, number, number]; pole: [number, number, number] }

/**
 * 右手：从身前抬起 → 贴到耳侧的头发（**最高点用作者摆的 `hair.ear`**）→
 * 顺着脸颊边往下抹 → 落回身侧。
 *
 * 最高点不是拍脑袋写的：打开 `?pose=hair.ear` 量了作者那一帧的手腕世界坐标，
 * 换算成「相对头骨」就是 (−0.085, +0.068, +0.180)——手在脸前偏右、额角高度、
 * 距头心 20 cm。这里直接采用，所以扫到最高点时和作者摆的姿势一致。
 *
 * 其余各帧的 z 都 ≥ 0.12（始终在身前），只在脸颊外侧上下走：第一版写成
 * 「绕到脑后」（z 到 −0.16），用户评价「有点抽象」，像在挠后脑勺。
 */
const KEYS: Key[] = [
  { t: 0.0, pos: [-0.26, -0.3, 0.16], pole: [-0.45, -0.28, 0.12] },
  { t: 0.35, pos: [-0.2, -0.08, 0.2], pole: [-0.45, -0.28, 0.12] },
  { t: 0.7, pos: [-0.13, 0.1, 0.22], pole: [-0.45, -0.25, 0.12] },
  // ← 作者 `hair.ear` 那一帧的实测值
  { t: 1.0, pos: [-0.085, 0.068, 0.18], pole: [-0.45, -0.22, 0.12] },
  { t: 1.45, pos: [-0.16, -0.02, 0.16], pole: [-0.45, -0.26, 0.12] },
  { t: 1.85, pos: [-0.24, -0.16, 0.14], pole: [-0.45, -0.3, 0.12] },
  { t: 2.2, pos: [-0.28, -0.3, 0.12], pole: [-0.45, -0.3, 0.12] },
]

const DURATION = KEYS[KEYS.length - 1].t
/** 首尾各淡入/淡出这么久（秒），否则动作一开始/结束手臂会弹 */
const FADE = 0.3

const _pos = new THREE.Vector3()
const _pole = new THREE.Vector3()
const _headQ = new THREE.Quaternion()
const _headP = new THREE.Vector3()
const _rest = new THREE.Vector3()
const _target = new THREE.Vector3()
const _handQ = new THREE.Quaternion()
const _qBefore = new THREE.Quaternion()
const UP = new THREE.Vector3(0, 1, 0)
/** 掌心从「朝前」转到「贴着头」需要绕世界 Y 轴转的角度 */
const PALM_TURN = Math.PI / 2

/**
 * Catmull-Rom（标量版）。
 *
 * 早先用 THREE.Vector3 的临时变量写，结果 `catmull()` 内部又用了同一批模块级
 * 临时量——传进去的 p0..p3 在计算途中被改写，轨迹帧与帧之间乱跳（实测手腕
 * 逐帧位移 80 cm、还会穿过头）。改成纯标量，就没有可以踩的共享状态了。
 */
function catmullScalar(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u
  const u3 = u2 * u
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)
  )
}

function sampleKeys(t: number, outPos: THREE.Vector3, outPole: THREE.Vector3): void {
  // 找 t 落在哪一段
  let i = 0
  while (i < KEYS.length - 1 && t > KEYS[i + 1].t) i++
  const k0 = KEYS[Math.max(0, i - 1)]
  const k1 = KEYS[i]
  const k2 = KEYS[Math.min(i + 1, KEYS.length - 1)]
  const k3 = KEYS[Math.min(i + 2, KEYS.length - 1)]
  const span = Math.max(1e-6, k2.t - k1.t)
  const u = Math.min(1, Math.max(0, (t - k1.t) / span))

  outPos.set(
    catmullScalar(k0.pos[0], k1.pos[0], k2.pos[0], k3.pos[0], u),
    catmullScalar(k0.pos[1], k1.pos[1], k2.pos[1], k3.pos[1], u),
    catmullScalar(k0.pos[2], k1.pos[2], k2.pos[2], k3.pos[2], u),
  )
  outPole.set(
    catmullScalar(k0.pole[0], k1.pole[0], k2.pole[0], k3.pole[0], u),
    catmullScalar(k0.pole[1], k1.pole[1], k2.pole[1], k3.pole[1], u),
    catmullScalar(k0.pole[2], k1.pole[2], k2.pole[2], k3.pole[2], u),
  )
}

export class ArmSweep {
  private t = -1

  get active(): boolean {
    return this.t >= 0
  }

  start(): void {
    this.t = 0
  }

  stop(): void {
    this.t = -1
  }

  /** 采样当前时刻的手腕/极点（世界坐标），调试和验收用 */
  probe(rig: HumanoidRig): { pos: THREE.Vector3; pole: THREE.Vector3; weight: number; t: number } | null {
    if (this.t < 0) return null
    const weight = Math.min(1, this.t / FADE) * Math.min(1, (DURATION + FADE - this.t) / FADE)
    sampleKeys(this.t, _pos, _pole)
    rig.getHeadWorldPosition(_headP)
    rig.getHeadWorldQuaternion(_headQ)
    return {
      pos: _pos.clone().applyQuaternion(_headQ).add(_headP),
      pole: _pole.clone().applyQuaternion(_headQ).add(_headP),
      weight: Math.max(0, weight),
      t: this.t,
    }
  }

  update(rig: HumanoidRig, dt: number): void {
    if (this.t < 0) return
    this.t += Math.min(0.12, dt)
    if (this.t > DURATION + FADE) {
      this.t = -1
      return
    }
    const w = Math.max(0, Math.min(1, Math.min(1, this.t / FADE) * Math.min(1, (DURATION + FADE - this.t) / FADE)))

    sampleKeys(this.t, _pos, _pole)
    rig.getHeadWorldPosition(_headP)
    // 用**身体**（髋）的朝向，不用头的：VRM 头骨的局部轴和世界轴不一定同向
    // （实测用头的朝向时，z 正负反了——手应该抹到耳后，结果跑到了脸前）。
    // 髋的世界朝向在腿 IK 里已经验证过是「+Z 朝前」。
    if (rig.getHipsWorldQuaternion) rig.getHipsWorldQuaternion(_headQ)
    else _headQ.identity()
    _pos.applyQuaternion(_headQ).add(_headP)
    _pole.applyQuaternion(_headQ).add(_headP)

    // 首尾把目标从「姿势本来算出来的腕位」渐变到轨迹上。
    // 只靠旋转混合不够：轨迹起点离站姿有 40~50 cm，淡入那几帧会被一次拉过去，
    // 看起来就是手臂弹了一下（实测单帧 53 cm）。
    rig.getBoneWorldPosition('rightHand', _rest)
    _target.lerpVectors(_rest, _pos, w)

    // 手掌朝向：腕子解完之后手只是「跟着小臂」，掌心朝前，看着像在「举手喊停」。
    // 拨头发要把掌心转到**贴着头**的那一侧（朝 +X = 她的右）：
    // 实测这具模型掌心朝 +Z、手指朝 +Y，所以绕世界 Y 轴转 +90° 就把掌心转向了头。
    if (rig.getBoneWorldQuaternion) {
      rig.getBoneWorldQuaternion('rightHand', _qBefore)
      _handQ.setFromAxisAngle(UP, PALM_TURN * w).multiply(_qBefore)
    }

    if (rig.solveArm)
      rig.solveArm('right', _target, _pole, {
        weight: 1,
        handWorldQuat: rig.getBoneWorldQuaternion ? _handQ : null,
      })
  }
}
