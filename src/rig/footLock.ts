import * as THREE from 'three'
import type { BoneName } from '../core/types'
import type { HumanoidRig, LegSide } from './rig'

/**
 * 脚部锁定（P9）。
 *
 * 问题：姿势系统只会「绕关节转」+「整体平移髋」。任何让髋动起来的动作
 * （摇摆的侧移、凑近的前后坐、转圈的整体旋转）都会把脚一起带走，
 * 看起来就是在地上滑。
 *
 * 做法：每帧在**姿势算完之后**、渲染之前，量一次脚踝的世界坐标：
 *
 * ```
 * 脚踝贴着地  →  PLANT：记下这个点，之后每帧用两骨 IK 把脚踝解回这个点
 * 脚踝抬起来  →  SWING：交还给动画，不干预
 * ```
 *
 * 它是**纯后处理**，所以作者摆的姿势一句都不用改。进出用一段很短的混合，
 * 免得落脚那一下「啪」地弹住。
 *
 * 已知边界：脚被锁住之后，膝和踝是解出来的，所以极限姿势（劈叉、大跨步）
 * 会被钳制到腿长以内，脚会差几厘米。真要精确得在姿势里标「这一帧脚钉在哪」，
 * 那是下一步的事。
 */

/** 抬到这个高度以上算离地（米） */
const LIFT_RELEASE = 0.05
/** 落回这个高度以内算着地（米，和上面留滞回） */
const LAND_PLANT = 0.015
/**
 * 着地时脚的水平速度还大于这个值（m/s）就先不钉。
 *
 * 不要求「站定」的话，脚会在下落中途被钉住——那时候姿势还在从上一帧往下一帧走，
 * 锚点差几厘米，之后动作结束时再慢慢挪回来，看着就是「做完还有一小段滑」。
 */
const LAND_SPEED = 0.3
/** 咬合（开始锁）的时间常数：要快，不然脚已经滑出去了才抓住 */
const BLEND_TAU_IN = 0.06
/** 松开的时间常数：慢一点，让它像「收脚站好」，不是突然一滑 */
const BLEND_TAU_OUT = 0.28

const SIDES: LegSide[] = ['left', 'right']
const FOOT: Record<LegSide, BoneName> = { left: 'leftFoot', right: 'rightFoot' }

const _ankle = new THREE.Vector3()
const _target = new THREE.Vector3()
const _hipsQ = new THREE.Quaternion()
const _footQ = new THREE.Quaternion()
const _euler = new THREE.Euler()
const _yawQ = new THREE.Quaternion()
const _plantedQ = new THREE.Quaternion()
const _blendQ = new THREE.Quaternion()
const _up = new THREE.Vector3(0, 1, 0)
const _hipsPos = new THREE.Vector3()
const _offset = new THREE.Vector3()

const yawOf = (q: THREE.Quaternion): number => _euler.setFromQuaternion(q, 'YXZ').y

/** 把角度折到 (−π, π]：`yawOf()` 在 ±π 处会跳，逐帧差要折一下才不会甩出 2π */
const wrapPi = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a))

export class FootLock {
  enabled = true

  /**
   * 每只脚各自的「踩在地上」时的脚踝高度。
   *
   * 不能两只脚共用一个参考值：作者的站姿是**一只脚高一只脚低**（重心在一条腿上），
   * 左右脚踝本身就差 3 cm。共用的话低的那只永远算「踩着」、高的那只永远算「抬着」。
   */
  private groundY: [number, number] = [0, 0]
  private calibrated = false

  private planted: [boolean, boolean] = [false, false]
  private anchors: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]
  /**
   * 锚点绕着转的那根轴（髋在地面上的投影）。
   *
   * 踩住的脚不能永远**钉死在世界坐标**里：身体原地转身 140°、两只脚都着地时，
   * 锚点不动就等于让两条腿绕髋拧过去，膝盖撞在一起（实测大腿间距 14.9 → 0.3 cm）。
   * 真实的双脚踏地转身是上身带着脚**碾**过去——踝绕轴转，但不跟着髋平移。
   *
   * 但**单腿站立**（`dance.spin` 那种）时不能这么干：唯一的支撑脚就是转轴本身，
   * 它一动就变成「脚在地上画圈」。所以碾转只在**两只脚同时着地**时累加，
   * 支撑脚单独着地时角度冻结（既不转，也不会弹回去）。
   */
  private pivots: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]
  /** 这只脚已经「碾」出去多少弧度（只在双脚着地时累加） */
  private pivotAngle: [number, number] = [0, 0]
  /** 上一帧的脚踝位置：动作刚起手时拿它当锚点（那一帧才是真正的站姿） */
  private lastRaw: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()]
  private lastQuat: [THREE.Quaternion, THREE.Quaternion] = [
    new THREE.Quaternion(),
    new THREE.Quaternion(),
  ]
  private lastYaw = 0
  /** 上一帧髋的位置：和 `lastRaw` 配套（起手那一帧的锚点要配那一帧的轴） */
  private lastHips = new THREE.Vector3()
  private hasLast = false
  private wasAllowed = false
  private plantedQuat: [THREE.Quaternion, THREE.Quaternion] = [
    new THREE.Quaternion(),
    new THREE.Quaternion(),
  ]
  private plantedYaw: [number, number] = [0, 0]
  private weight: [number, number] = [0, 0]

  /** 给 HUD / 调试看的状态 */
  status(): string {
    const tag = (i: number): string => (this.planted[i] ? `锁${this.weight[i].toFixed(2)}` : '—')
    return `脚 ${tag(0)}/${tag(1)}`
  }

  /** `?dbg` 用：把状态摊平，方便逐帧打印 */
  snapshot(): Record<string, unknown> {
    return {
      groundY: this.groundY.map((v) => +v.toFixed(3)),
      left: {
        raw: this.lastRaw[0].toArray().map((v) => +v.toFixed(3)),
        planted: this.planted[0],
        w: +this.weight[0].toFixed(2),
        anchor: this.anchors[0].toArray().map((v) => +v.toFixed(3)),
      },
      right: {
        raw: this.lastRaw[1].toArray().map((v) => +v.toFixed(3)),
        planted: this.planted[1],
        w: +this.weight[1].toFixed(2),
        anchor: this.anchors[1].toArray().map((v) => +v.toFixed(3)),
      },
    }
  }

  reset(): void {
    this.planted = [false, false]
    this.weight = [0, 0]
    this.calibrated = false
  }

  /**
   * 记锚点。
   *
   * 脚踝高度不许记到地面以下：落地那一帧是从「离地」掉进来的，采样可能已经穿过地面
   * 2–3 cm（`pose.cheer` 实测 −3.3 cm），照抄下来的话那只脚会被钉在地下，一直到抬起来。
   */
  private anchorAt(i: number, pos: THREE.Vector3): void {
    this.anchors[i].copy(pos)
    if (this.anchors[i].y < this.groundY[i]) this.anchors[i].y = this.groundY[i]
  }

  /**
   * @param allow 有没有动作在驱动身体。没有的话脚要交还给站姿——
   *   否则动作结束后脚会一直钉在落地那次的位置上，之后每个动作都带着那个偏移。
   */
  update(rig: HumanoidRig, dt: number, allow: boolean): void {
    if (!this.enabled || !rig.solveLeg) return

    // 先量两只脚踝（姿势算完、IK 之前）
    const raw: THREE.Vector3[] = []
    for (let i = 0; i < 2; i++) {
      const v = new THREE.Vector3()
      rig.getBoneWorldPosition(FOOT[SIDES[i]], v)
      raw.push(v)
    }

    if (!this.calibrated) {
      this.groundY = [raw[0].y, raw[1].y]
      this.calibrated = true
    }
    rig.getBoneWorldPosition('hips', _hipsPos)
    rig.getHipsWorldQuaternion?.(_hipsQ) ?? _hipsQ.identity()
    const hipsYaw = yawOf(_hipsQ)
    // 这一帧身体转了多少（折到 ±π：单帧不可能转半圈以上）
    const dYaw = this.hasLast ? wrapPi(hipsYaw - this.lastYaw) : 0

    // 动作刚起手的那一帧，姿势已经混进去一部分了（一帧 50 ms 就是 30%）。
    // 所以锚点不能用「现在」的脚踝，要用**上一步**的——那才是站姿里的位置。
    if (allow && !this.wasAllowed && this.hasLast) {
      for (let i = 0; i < 2; i++) {
        if (this.lastRaw[i].y - this.groundY[i] < LAND_PLANT) {
          this.planted[i] = true
          this.anchorAt(i, this.lastRaw[i])
          this.pivots[i].copy(this.lastHips)
          this.plantedQuat[i].copy(this.lastQuat[i])
          this.plantedYaw[i] = this.lastYaw
          this.pivotAngle[i] = 0
          // 起手这一帧锚点**就是**脚现在的位置，所以权重要直接给满：
          // 淡入的 0.06 s 里目标点会往动画那边偏，遇到下蹲这种快动作，
          // 脚会先沉到地面以下（`pose.cheer` 实测 −3.4 cm）再被拉回来。
          this.weight[i] = 1
        }
      }
    }

    for (let i = 0; i < 2; i++) {
      const side = SIDES[i]
      const ankle = raw[i]
      const above = ankle.y - this.groundY[i]

      const speed = this.hasLast
        ? this.lastRaw[i].distanceTo(ankle) / Math.max(1e-3, dt)
        : 0

      if (!this.planted[i]) {
        if (above < LAND_PLANT && speed < LAND_SPEED) {
          this.planted[i] = true
          this.anchorAt(i, ankle)
          this.pivots[i].copy(_hipsPos)
          this.pivotAngle[i] = 0
          rig.getBoneWorldQuaternion?.(FOOT[side], _footQ) ?? _footQ.identity()
          this.plantedQuat[i].copy(_footQ)
          this.plantedYaw[i] = hipsYaw
        }
      } else if (above > LIFT_RELEASE) {
        this.planted[i] = false
      }

      const goal = this.planted[i] && allow ? 1 : 0
      // 指数趋近，并且**夹住**：dt 异常大（页面刚恢复、掉帧）时不能让权重冲出 [0,1]，
      // 否则下面的 lerp 会把目标点甩到几百万米外，腿直接飞出去
      const tau = goal > this.weight[i] ? BLEND_TAU_IN : BLEND_TAU_OUT
      const k = Math.min(1, Math.max(0, dt) / tau)
      this.weight[i] += (goal - this.weight[i]) * k
      this.weight[i] = Math.min(1, Math.max(0, this.weight[i]))

      if (this.weight[i] <= 0.002) {
        // 没锁：锚点跟着脚走，下次一有动作就能从「现在的位置」接管，不会弹
        this.anchors[i].copy(ankle)
        this.pivots[i].copy(_hipsPos)
        this.pivotAngle[i] = 0
        rig.getBoneWorldQuaternion?.(FOOT[side], _footQ) ?? _footQ.identity()
        this.plantedQuat[i].copy(_footQ)
        this.plantedYaw[i] = hipsYaw
        continue
      }

      // 双脚同时着地才让锚点跟着身体碾：单腿站立时支撑脚就是转轴，它不能动
      if (this.planted[0] && this.planted[1] && allow) this.pivotAngle[i] += dYaw

      // 脚掌朝向永远跟身体的偏航走（支撑脚在原地碾，脚尖是会转的）
      const yawDelta = hipsYaw - this.plantedYaw[i]

      // 目标 = 锚点绕髋轴碾过 pivotAngle，再和「动画想去的点」按权重插值
      _offset.copy(this.anchors[i]).sub(this.pivots[i])
      _offset.y = 0
      _offset.applyAxisAngle(_up, this.pivotAngle[i])
      _target.copy(this.pivots[i]).add(_offset)
      _target.y = this.anchors[i].y
      _target.lerp(ankle, 1 - this.weight[i])

      _yawQ.setFromAxisAngle(_up, yawDelta)
      _plantedQ.copy(_yawQ).multiply(this.plantedQuat[i])
      const cur = rig.getBoneWorldQuaternion?.(FOOT[side], _footQ)
      if (cur) _blendQ.copy(cur).slerp(_plantedQ, this.weight[i])
      else _blendQ.copy(_plantedQ)

      rig.solveLeg(side, _target, this.weight[i] > 0.02 ? _blendQ : null)
    }

    // 记下这一帧「动画想要的位置」，下一帧动作起手时拿它当锚点
    for (let i = 0; i < 2; i++) {
      this.lastRaw[i].copy(raw[i])
      rig.getBoneWorldQuaternion?.(FOOT[SIDES[i]], _footQ) ?? _footQ.identity()
      this.lastQuat[i].copy(_footQ)
    }
    this.lastYaw = hipsYaw
    this.lastHips.copy(_hipsPos)
    this.hasLast = true
    this.wasAllowed = allow
  }
}
