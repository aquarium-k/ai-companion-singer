import * as THREE from 'three'
import type { ResolvedPose } from '../core/paramBus'
import type { BoneName, ExpressionName, Vec3 } from '../core/types'
import type { HumanoidRig } from './rig'

const SKIN = 0xf7ddc9
const HAIR = 0xffa8c9
const HAIR_DARK = 0xf58bb4
const DRESS = 0xffc2d4
const LEG = 0xf6ecf8
const EYE = 0x35304d

function toon(color: number): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color })
}

function joint(parent: THREE.Object3D, name: string, pos: Vec3): THREE.Object3D {
  const o = new THREE.Object3D()
  o.name = name
  o.position.set(pos[0], pos[1], pos[2])
  parent.add(o)
  return o
}

/** 从关节沿 -Y 方向长出一根肢体 */
function limb(
  parent: THREE.Object3D,
  length: number,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const geo = new THREE.CapsuleGeometry(radius, Math.max(0.001, length - radius * 2), 6, 12)
  const mesh = new THREE.Mesh(geo, material)
  mesh.position.y = -length / 2
  parent.add(mesh)
  return mesh
}

/**
 * 程序化占位角色。
 *
 * 存在的意义：在没有 VRM 的情况下把「参数总线 → 骨骼 → 动作」整条链路跑通。
 * 比例刻意做成 chibi：舞蹈时的穿模、关节扭曲在这个比例下不明显。
 */
export class PrimitiveRig implements HumanoidRig {
  readonly kind = 'primitive' as const
  readonly root = new THREE.Group()
  readonly basePose: Partial<Record<BoneName, Vec3>> = {}

  private bones = new Map<BoneName, THREE.Object3D>()
  private restPos = new Map<BoneName, THREE.Vector3>()
  private eyes: THREE.Mesh[] = []
  private mouth!: THREE.Mesh
  /** 最近一次应用的表情权重（调试读回用） */
  private lastExpressions: Partial<Record<ExpressionName, number>> = {}
  private owned: THREE.BufferGeometry[] = []
  private materials: THREE.Material[] = []

  constructor() {
    this.root.name = 'primitive-rig'
    this.build()
  }

  private track<T extends THREE.BufferGeometry>(geo: T): T {
    this.owned.push(geo)
    return geo
  }

  private build(): void {
    const skin = toon(SKIN)
    const hair = toon(HAIR)
    const hairDark = toon(HAIR_DARK)
    const dress = toon(DRESS)
    const leg = toon(LEG)
    const eye = new THREE.MeshBasicMaterial({ color: EYE })
    this.materials.push(skin, hair, hairDark, dress, leg, eye)

    // ---- 躯干链（世界坐标：髋 0.60 → 头 0.94）----
    const hips = joint(this.root, 'hips', [0, 0.6, 0])
    const spine = joint(hips, 'spine', [0, 0.06, 0])
    const chest = joint(spine, 'chest', [0, 0.09, 0])
    const upperChest = joint(chest, 'upperChest', [0, 0.08, 0])
    const neck = joint(upperChest, 'neck', [0, 0.06, 0])
    const head = joint(neck, 'head', [0, 0.05, 0])

    // 躯干本体
    const torso = new THREE.Mesh(this.track(new THREE.CapsuleGeometry(0.085, 0.3, 6, 18)), dress)
    torso.position.y = 0.09
    spine.add(torso)

    // 裙摆
    const skirt = new THREE.Mesh(
      this.track(new THREE.ConeGeometry(0.155, 0.17, 22, 1, true)),
      dress,
    )
    skirt.position.y = -0.015
    hips.add(skirt)

    // 脖子
    const neckMesh = new THREE.Mesh(
      this.track(new THREE.CylinderGeometry(0.026, 0.03, 0.07, 12)),
      skin,
    )
    neckMesh.position.y = 0.035
    upperChest.add(neckMesh)

    // ---- 头 ----
    const headGroup = new THREE.Group()
    headGroup.position.y = 0.09
    head.add(headGroup)

    const skull = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.128, 28, 22)), skin)
    skull.scale.set(1, 0.99, 0.97)
    headGroup.add(skull)

    // 顶盖（只盖到眉毛以上，露出脸）
    const hairTop = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.133, 28, 20, 0, Math.PI * 2, 0, Math.PI * 0.42)),
      hair,
    )
    hairTop.position.y = 0.004
    headGroup.add(hairTop)

    // 后脑壳（只占 z<0 半球）
    const hairBack = new THREE.Mesh(
      this.track(new THREE.SphereGeometry(0.134, 28, 20, Math.PI, Math.PI, 0, Math.PI * 0.9)),
      hair,
    )
    hairBack.position.y = 0.002
    headGroup.add(hairBack)

    // 双马尾
    for (const side of [-1, 1]) {
      const tail = new THREE.Mesh(
        this.track(new THREE.CapsuleGeometry(0.03, 0.19, 6, 10)),
        hairDark,
      )
      tail.position.set(side * 0.125, -0.03, -0.06)
      tail.rotation.z = side * 0.42
      tail.rotation.x = 0.22
      headGroup.add(tail)
    }

    // 眼睛
    for (const side of [-1, 1]) {
      const e = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.019, 16, 12)), eye)
      e.position.set(side * 0.05, 0.004, 0.111)
      e.scale.set(1, 1.3, 0.45)
      headGroup.add(e)
      this.eyes.push(e)
    }

    // 嘴
    const mouth = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.016, 14, 12)), eye)
    mouth.position.set(0, -0.052, 0.118)
    mouth.scale.set(1, 0.35, 0.6)
    headGroup.add(mouth)
    this.mouth = mouth

    // ---- 手臂（放在躯干外侧，避免被吞进去）----
    for (const side of [-1, 1] as const) {
      const key = side < 0 ? 'left' : 'right'
      const shoulder = joint(upperChest, `${key}Shoulder`, [side * 0.085, 0.03, 0])
      const upperArm = joint(shoulder, `${key}UpperArm`, [side * 0.035, 0, 0])
      const lowerArm = joint(upperArm, `${key}LowerArm`, [0, -0.155, 0])
      const hand = joint(lowerArm, `${key}Hand`, [0, -0.145, 0])

      limb(upperArm, 0.155, 0.028, skin)
      limb(lowerArm, 0.145, 0.025, skin)

      const palm = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.031, 14, 12)), skin)
      palm.position.y = -0.016
      palm.scale.set(1, 1.15, 0.8)
      hand.add(palm)

      this.register(`${key}Shoulder` as BoneName, shoulder)
      this.register(`${key}UpperArm` as BoneName, upperArm)
      this.register(`${key}LowerArm` as BoneName, lowerArm)
      this.register(`${key}Hand` as BoneName, hand)
    }

    // ---- 腿 ----
    for (const side of [-1, 1] as const) {
      const key = side < 0 ? 'left' : 'right'
      const upperLeg = joint(hips, `${key}UpperLeg`, [side * 0.055, -0.03, 0])
      const lowerLeg = joint(upperLeg, `${key}LowerLeg`, [0, -0.19, 0])
      const foot = joint(lowerLeg, `${key}Foot`, [0, -0.18, 0])

      limb(upperLeg, 0.19, 0.04, leg)
      limb(lowerLeg, 0.18, 0.033, leg)

      const shoe = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.072, 0.05, 0.13)), hairDark)
      shoe.position.set(0, -0.012, 0.022)
      foot.add(shoe)

      this.register(`${key}UpperLeg` as BoneName, upperLeg)
      this.register(`${key}LowerLeg` as BoneName, lowerLeg)
      this.register(`${key}Foot` as BoneName, foot)
    }

    this.register('hips', hips)
    this.register('spine', spine)
    this.register('chest', chest)
    this.register('upperChest', upperChest)
    this.register('neck', neck)
    this.register('head', head)

    // 脚底对齐 y=0，否则角色会浮在阴影上方
    this.root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(this.root)
    if (!box.isEmpty()) this.root.position.y -= box.min.y
  }

  private register(name: BoneName, node: THREE.Object3D): void {
    this.bones.set(name, node)
    this.restPos.set(name, node.position.clone())
  }

  apply(pose: ResolvedPose): void {
    for (const [name, node] of this.bones) {
      const e = pose.bones[name]
      node.rotation.set(e[0], e[1], e[2])
    }

    const hips = this.bones.get('hips')
    const rest = this.restPos.get('hips')
    if (hips && rest) {
      hips.position.set(
        rest.x + pose.hipsOffset[0],
        rest.y + pose.hipsOffset[1],
        rest.z + pose.hipsOffset[2],
      )
    }

    const blink = pose.expressions.blink
    for (const eye of this.eyes) {
      eye.scale.y = 1.3 * (1 - 0.92 * blink)
    }

    const e = pose.expressions
    this.lastExpressions = e
    const open = Math.max(e.aa, e.oh * 0.9, e.ou * 0.7, e.ih * 0.5, e.ee * 0.4)
    this.mouth.scale.set(1 + 0.35 * open, 0.35 + 1.7 * open, 0.6)
  }

  /** 读回当前表情权重（和 VRM 后端的同名方法对齐，口型量测用） */
  getExpressionValue(name: string): number {
    return this.lastExpressions[name as keyof typeof this.lastExpressions] ?? 0
  }

  update(_dt: number): void {
    // 程序化角色没有 spring bone，留空
  }

  setLookTarget(_target: THREE.Vector3 | null): void {
    // 头部朝向由 ParamBus 的 lookBias 驱动，这里不需要额外处理
  }

  getHeadWorldPosition(out: THREE.Vector3): THREE.Vector3 {
    const head = this.bones.get('head')
    if (head) head.getWorldPosition(out)
    else out.set(0, 1, 0)
    return out
  }

  getHeadWorldQuaternion(out: THREE.Quaternion): THREE.Quaternion {
    const head = this.bones.get('head')
    if (head) head.getWorldQuaternion(out)
    else out.identity()
    return out
  }

  getBoneWorldPosition(name: BoneName, out: THREE.Vector3): THREE.Vector3 {
    const node = this.bones.get(name)
    if (node) node.getWorldPosition(out)
    else out.set(0, 0, 0)
    return out
  }

  /**
   * 骨骼世界朝向。
   *
   * 加这个是为了**重定向校准**：BVH 的骨骼局部轴和我们的骨骼局部轴不是一套
   * （实测这只占位角色左上臂绕局部 X 才是抬起/放下，绕 Z 是前后摆），
   * 所以 `tools/bvh_to_clip.mjs` 需要静息世界四元数做坐标换算。
   */
  getBoneWorldQuaternion(name: BoneName, out: THREE.Quaternion): THREE.Quaternion {
    const node = this.bones.get(name)
    if (node) node.getWorldQuaternion(out)
    else out.identity()
    return out
  }

  dispose(): void {
    for (const geo of this.owned) geo.dispose()
    for (const m of this.materials) m.dispose()
    this.owned = []
    this.materials = []
  }
}
