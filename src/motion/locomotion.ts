/**
 * 走路位移（root motion）：把动作里的「该走多快」变成**窗口在桌面上移动**。
 *
 * 为什么不在 3D 场景里挪角色：窗口背景是透明的，桌面没有地面纹理。
 * 相机不动、背景不动，角色在场景里平移 ＝ 画面里她一动不动，只有脚下的影子在动，
 * 完全看不出在走路。所以真正能读成「走」的位移只能发生在窗口这一层
 * （`window.pet.nudgeWindow`，主进程 setBounds）。
 *
 * 分三步，缺一个都会读成「滑」：
 *   1. **转身**：先绕 Y 转 90° 侧身（0.28 s）。不转就是「面朝你横向平移」，
 *      看着像被拖走；
 *   2. **推窗口**：转到位之后按 `travel`（米/秒）× 每米像素数 累加，够 2 px 发一次；
 *   3. **收脚**：停下后转回面向镜头。撞到屏幕边缘就立刻收，不要贴边磨。
 *
 * 位移的**方向和距离都在渲染层算**，主进程只管「往前推这些像素」和夹边界——
 * 这样主进程完全不用懂动作系统，换 clip 不用改它。
 */
import * as THREE from 'three'

/** 侧身角度（弧度）：±90° */
const SIDE = Math.PI / 2
/** 转身角速度（弧度/秒）：90° 约 0.28 s，够快但不「啪」 */
const TURN_RATE = 5.6
/** 攒够这么多像素才发一次 IPC（60 fps 下约每秒 20–40 次，够顺） */
const PX_STEP = 2

export type LocoState = {
  /** 当前朝向（弧度，0 = 面向镜头） */
  yaw: number
  /** 是否已经转到「能走」的角度 */
  moving: boolean
  /** 这一帧走掉的米数 */
  meters: number
}

export class Locomotion {
  /** 目标朝向 */
  private targetYaw = 0
  private yawNow = 0
  /** 没发出去的零头（像素） */
  private pxAcc = 0
  /** 撞边缘了：这一轮别再推，等收脚 */
  private blocked = false

  get yaw(): number {
    return this.yawNow
  }

  /** 转向左（-1）还是右（+1）；null = 站住面向镜头 */
  setDirection(dir: -1 | 1 | null): void {
    this.targetYaw = dir === null ? 0 : dir * SIDE
    if (dir === null) this.blocked = false
  }

  /**
   * @param dt 秒
   * @param speed 米/秒（clip 的 travel；0 = 不走）
   * @param pxPerMeter 当前镜头下「1 米」是多少像素
   * @returns 需要推窗口的像素（已取整，0 表示这帧不发）
   */
  update(dt: number, speed: number, pxPerMeter: number): { yaw: number; dxPx: number } {
    // 朝向按角速度逼近（不用指数：角速度恒定才看得清「转身」这个过程）
    const dYaw = this.targetYaw - this.yawNow
    const step = TURN_RATE * dt
    this.yawNow += Math.abs(dYaw) <= step ? dYaw : Math.sign(dYaw) * step

    let dxPx = 0
    const walking = speed > 0 && !this.blocked
    // 只转了 70% 就先别位移：否则开头那 0.1 秒是「斜着蹭过去」
    const turned = Math.abs(this.yawNow - this.targetYaw) < 0.3
    if (walking && turned) {
      this.pxAcc += speed * pxPerMeter * dt * Math.sign(this.targetYaw)
      if (Math.abs(this.pxAcc) >= PX_STEP) {
        dxPx = Math.round(this.pxAcc)
        this.pxAcc -= dxPx
      }
    } else if (!walking) {
      this.pxAcc = 0
    }
    return { yaw: this.yawNow, dxPx }
  }

  /** 朝目标转到位了吗（差 < 0.3 rad） */
  get isAligned(): boolean {
    return Math.abs(this.yawNow - this.targetYaw) < 0.3
  }

  /** 主进程说「撞到边了」：这一轮到此为止，别再磨 */
  markBlocked(): void {
    this.blocked = true
  }

  get isBlocked(): boolean {
    return this.blocked
  }

  reset(): void {
    this.targetYaw = 0
    this.yawNow = 0
    this.pxAcc = 0
    this.blocked = false
  }
}

/** 当前镜头下「1 米 = 多少像素」（在角色所处深度上量，随缩放/构图自动变） */
const _a = new THREE.Vector3()
const _b = new THREE.Vector3()

export function pixelsPerMeter(camera: THREE.PerspectiveCamera, viewportHeight: number): number {
  // 用投影量：把世界原点和「原点 + 1 米 X」投到 NDC，两者像素差就是 1 米
  _a.set(0, 0.9, 0).project(camera)
  _b.set(1, 0.9, 0).project(camera)
  const scale = Math.abs(_b.x - _a.x) * 0.5 * (viewportHeight * (camera.aspect || 1))
  return Number.isFinite(scale) && scale > 1 ? scale : 0
}
