#!/usr/bin/env node
/**
 * BVH → 我们的 clip（`ActionClip`）生成器（阶段 0：动作数据来源打通）。
 *
 * 为什么用 BVH：动作捕捉数据（CMU / LAFAN1 / AIST++）基本都是 BVH 或能导出 BVH，
 * 它只含**骨骼层级 + 每帧欧拉角**，不含网格——我们需要的是后者，不是「把图片转成 3D 模型」。
 *
 * 这个脚本做四件事：
 *   1. 解析 HIERARCHY / MOTION（按空白切词，不依赖换行——抓下来的 bvh 常被压成一行）；
 *   2. 关节名 → VRM Humanoid 名（`core/types.ts` 的 BONENAMES）；
 *   3. **静止朝向对齐**：BVH 每根骨头的 rest 方向（OFFSET）映射到 VRM rest 方向，
 *      用最短弧四元数 A 做相似变换 `q_vrm = A · q_bvh · A⁻¹`，
 *      这样「绕自己的轴转」在两边含义一致（不做这一步手会反、腿会扭）；
 *   4. 输出一个 TS 模块：帧数据 + 线性插值的 `sample()`。
 *
 * 用法：
 *   node tools/bvh_to_clip.mjs --bvh .tmp/walk.bvh --id gen.walk --name 走路 --out src/actions/gen/walk.ts
 *   node tools/bvh_to_clip.mjs --bvh ... --report    # 只看映射/尺度，不写文件
 */
import fs from 'node:fs'
import path from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true
      acc.push([key, val])
    }
    return acc
  }, []),
)

const bvhPath = args.bvh
if (!bvhPath) {
  console.error('用法: node tools/bvh_to_clip.mjs --bvh <file> --id gen.walk --out src/actions/gen/walk.ts')
  process.exit(1)
}

// ---------------------------------------------------------------- 解析
const text = fs.readFileSync(bvhPath, 'utf8')
const tokens = text.replace(/[{}]/g, ' ').split(/\s+/).filter(Boolean)

function parseBvh(toks) {
  // 栈式解析：ROOT/JOINT 压栈，遇到 End Site 跳过它的 OFFSET
  const root = { name: '', offsets: [0, 0, 0], channels: [], children: [], parent: null }
  const stack = [root]
  let i = 0
  let frames = 0
  let frameTime = 0
  while (i < toks.length) {
    const t = toks[i++]
    if (t === 'HIERARCHY' || t === 'MOTION') continue
    if (t === 'ROOT' || t === 'JOINT') {
      const name = toks[i++]
      const parent = stack[stack.length - 1]
      const node = { name, offsets: [0, 0, 0], channels: [], children: [], parent: parent === root || parent.name ? parent : null }
      if (parent === root && !root.name) {
        root.name = name
        root.offsets = node.offsets
        root.channels = node.channels
      } else {
        parent.children.push(node)
        stack.push(node)
      }
      continue
    }
    if (t === 'End') {
      // "End Site" + OFFSET：读掉，不进骨骼表
      while (i < toks.length && toks[i] !== 'OFFSET') i++
      i += 4
      continue
    }
    if (t === 'OFFSET') {
      const node = stack[stack.length - 1]
      node.offsets = [Number(toks[i]), Number(toks[i + 1]), Number(toks[i + 2])]
      if (node === root) root.offsets = node.offsets
      i += 3
      continue
    }
    if (t === 'CHANNELS') {
      const n = Number(toks[i++])
      const ch = toks.slice(i, i + n)
      i += n
      const node = stack[stack.length - 1]
      node.channels = ch
      if (node === root) root.channels = ch
      continue
    }
    if (t === 'Frames:') {
      frames = Number(toks[i++])
      continue
    }
    if (t === 'Frame') {
      i++ // "Time:"
      frameTime = Number(toks[i++])
      continue
    }
    if (t === '}') {
      // 括号已被预先去掉，这里不会出现
      continue
    }
  }

  const start = findFrameData(toks)
  const chTotal = countChannels(root)
  const rows = []
  for (let f = 0; f < frames; f++) {
    rows.push(toks.slice(start + f * chTotal, start + (f + 1) * chTotal).map(Number))
  }
  root.frames = frames
  root.frameTime = frameTime
  return { root, rows, chTotal }
}

function findFrameData(toks) {
  for (let i = 0; i < toks.length - 2; i++) {
    if (toks[i] === 'Time:') return i + 2 // 跳过 "Time:" 和帧时间
  }
  return -1
}

function countChannels(node) {
  let n = node.channels.length
  for (const c of node.children) n += countChannels(c)
  return n
}

function* walk(node) {
  yield node
  for (const c of node.children) yield* walk(c)
}

// ---------------------------------------------------------------- 四元数
const D2R = Math.PI / 180
const qAxis = (axis, deg) => {
  const h = (deg * D2R) / 2
  const s = Math.sin(h)
  if (axis === 'X') return [s, 0, 0, Math.cos(h)]
  if (axis === 'Y') return [0, s, 0, Math.cos(h)]
  return [0, 0, s, Math.cos(h)]
}
const qMul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
]
const qConj = (q) => [-q[0], -q[1], -q[2], q[3]]
function qFromTo(a, b) {
  // 最短弧：把单位向量 a 转到 b
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  if (dot > 0.999999) return [0, 0, 0, 1]
  if (dot < -0.999999) {
    // 反向：绕任意正交轴转 180°
    const axis = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]
    const c = [
      a[1] * axis[2] - a[2] * axis[1],
      a[2] * axis[0] - a[0] * axis[2],
      a[0] * axis[1] - a[1] * axis[0],
    ]
    const len = Math.hypot(...c) || 1
    return [c[0] / len, c[1] / len, c[2] / len, 0]
  }
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const w = 1 + dot
  const len = Math.hypot(c[0], c[1], c[2], w) || 1
  return [c[0] / len, c[1] / len, c[2] / len, w / len]
}
/** 四元数 → 欧拉（three.js 默认 XYZ 顺序） */
function eulerXYZ(q) {
  const [x, y, z, w] = q
  const m11 = 1 - 2 * (y * y + z * z)
  const m12 = 2 * (x * y - z * w)
  const m13 = 2 * (x * z + y * w)
  const m22 = 1 - 2 * (x * x + z * z)
  const m23 = 2 * (y * z - x * w)
  const m32 = 2 * (y * z + x * w)
  const m33 = 1 - 2 * (x * x + y * y)
  const ey = Math.asin(Math.max(-1, Math.min(1, m13)))
  let ex, ez
  if (Math.abs(m13) < 0.9999999) {
    ex = Math.atan2(-m23, m33)
    ez = Math.atan2(-m12, m11)
  } else {
    ex = Math.atan2(m32, m22)
    ez = 0
  }
  return [ex, ey, ez]
}
/**
 * VRM 后端的「静止手臂下垂」补偿（`src/rig/vrmRig.ts` 的 VRM_BASE_POSE）。
 *
 * 为什么要在生成时减掉它：引擎的 base 层已经把手臂压下来 73°（Z=−1.28），
 * 而 BVH 的动作**本身**就含「手臂下垂」这 90°，两层相加会把手臂拧到背后
 * （实测 VRM 上左臂 Z 变成 −160°，手臂朝上后方）。所以 BVH 生成的 clip 要把
 * 这部分扣掉，让「base + clip」正好等于 BVH 的姿态。
 * 用 `--no-base-pose` 关掉（换成不带 basePose 的 rig，比如占位角色）。
 */
const BASE_POSE = {
  leftUpperArm: [0, 0, -1.28],
  rightUpperArm: [0, 0, 1.28],
  leftLowerArm: [0, 0, -0.08],
  rightLowerArm: [0, 0, 0.08],
}
const subtractBase = args['no-base-pose'] !== true

const norm = (v) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

// ---------------------------------------------------------------- FK（只为推髋位移）
/**
 * 带括号的层级解析。上面那套「去掉括号、当扁平链」的做法对**旋转**没影响
 * （每根骨头各自读自己的通道），但要算脚的世界坐标就必须有真正的父子关系。
 */
function parseHierarchy(text) {
  const toks = text.replace(/[{}]/g, ' $& ').split(/\s+/).filter(Boolean)
  const list = []
  const stack = []
  let i = 0
  while (i < toks.length) {
    const t = toks[i++]
    if (t === 'ROOT' || t === 'JOINT') {
      const name = toks[i++]
      const node = {
        name,
        offsets: [0, 0, 0],
        channels: [],
        parent: stack.length ? stack[stack.length - 1] : null,
        children: [],
      }
      if (node.parent) node.parent.children.push(node)
      list.push(node)
      stack.push(node)
      continue
    }
    if (t === '{') continue
    if (t === '}') {
      stack.pop()
      continue
    }
    if (t === 'End') {
      // "End Site { OFFSET x y z }"：这个 OFFSET 就是**末梢骨骼自己的方向**
      // （手、头这些没有子关节，只能靠它拿到朝向）
      while (i < toks.length && toks[i] !== 'OFFSET') i++
      if (toks[i] === 'OFFSET') {
        const n = stack[stack.length - 1]
        n.endOffset = [Number(toks[i + 1]), Number(toks[i + 2]), Number(toks[i + 3])]
        i += 4
      }
      while (i < toks.length && toks[i] !== '}') i++
      i++
      continue
    }
    if (t === 'OFFSET') {
      const n = stack[stack.length - 1]
      n.offsets = [Number(toks[i]), Number(toks[i + 1]), Number(toks[i + 2])]
      i += 3
      continue
    }
    if (t === 'CHANNELS') {
      const c = Number(toks[i++])
      const n = stack[stack.length - 1]
      n.channels = toks.slice(i, i + c)
      i += c
      continue
    }
    // MOTION 之后是纯数字，这里只关心层级，直接跳过
  }
  return list
}

const m3of = (q) => {
  const [x, y, z, w] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
    [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
    [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
  ]
}
const mmul = (a, b) => a.map((r) => [0, 1, 2].map((c) => r[0] * b[0][c] + r[1] * b[1][c] + r[2] * b[2][c]))
const mvec = (a, v) => [0, 1, 2].map((r) => a[r][0] * v[0] + a[r][1] * v[1] + a[r][2] * v[2])
const IDENT3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
]

/** 一帧的全部世界坐标 + 世界旋转（BVH 自己的单位、自己的坐标系） */
function fkFull(tree, row) {
  const res = new Map()
  for (const n of tree) {
    let q = [0, 0, 0, 1]
    for (let c = 0; c < n.channels.length; c++) {
      const ch = n.channels[c]
      if (!ch.toLowerCase().endsWith('rotation')) continue
      q = qMul(q, qAxis(ch[0].toUpperCase(), row[n.chStart + c]))
    }
    let p
    if (!n.parent) {
      // 根关节：位置通道就在这里
      p = [0, 1, 2].map((k) => {
        const idx = n.channels.findIndex((ch) => ch.toLowerCase().endsWith('position') && ch[0].toUpperCase() === 'XYZ'[k])
        return idx >= 0 ? row[n.chStart + idx] : 0
      })
    } else {
      const par = res.get(n.parent)
      const d = mvec(m3of(par.q), n.offsets)
      p = [d[0] + par.p[0], d[1] + par.p[1], d[2] + par.p[2]]
    }
    res.set(n, { p, q: n.parent ? qMul(res.get(n.parent).q, q) : q })
  }
  return res
}

/** 一帧的全部世界坐标（BVH 自己的单位、自己的坐标系） */
function fkFrame(tree, row) {
  const out = new Map()
  for (const [n, v] of fkFull(tree, row)) out.set(n, v.p)
  return out
}

/** 5 点 / 3 点 Hann 平滑（脚步切换处 min() 会出折角，不磨一下会「一顿一顿」） */
function smooth1(arr, cyclic, taps = 5) {
  const w = taps === 3 ? [1, 2, 1] : [1, 4, 6, 4, 1]
  const r = (w.length - 1) / 2
  const n = arr.length
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    let sum = 0
    for (let k = -r; k <= r; k++) {
      let j = i + k
      if (cyclic) j = ((j % n) + n) % n
      else if (j < 0 || j >= n) continue
      s += arr[j] * w[k + r]
      sum += w[k + r]
    }
    out[i] = s / sum
  }
  return out
}

// ---------------------------------------------------------------- 映射
/**
 * BVH 关节名 → VRM Humanoid 名。
 * 覆盖 CMU 那套（LHipJoint / LeftUpLeg…）和 Mixamo 的点分名前缀。
 */
const MAP = {
  hips: 'hips',
  lowerback: 'spine',
  spine: 'chest',
  spine1: 'upperChest',
  chest: 'chest',
  upperchest: 'upperChest',
  neck: 'neck',
  neck1: 'neck',
  head: 'head',
  leftshoulder: 'leftShoulder',
  leftarm: 'leftUpperArm',
  leftforearm: 'leftLowerArm',
  lefthand: 'leftHand',
  rightshoulder: 'rightShoulder',
  rightarm: 'rightUpperArm',
  rightforearm: 'rightLowerArm',
  righthand: 'rightHand',
  leftupleg: 'leftUpperLeg',
  leftleg: 'leftLowerLeg',
  leftfoot: 'leftFoot',
  rightupleg: 'rightUpperLeg',
  rightleg: 'rightLowerLeg',
  rightfoot: 'rightFoot',
}

/** VRM 人形骨骼的 rest 朝向（T-pose，归一化骨骼空间，Y 上）。 */
const VRM_REST_DIR = {
  hips: [0, 1, 0],
  spine: [0, 1, 0],
  chest: [0, 1, 0],
  upperChest: [0, 1, 0],
  neck: [0, 1, 0],
  head: [0, 1, 0],
  leftShoulder: [1, 0, 0],
  leftUpperArm: [1, 0, 0],
  leftLowerArm: [1, 0, 0],
  leftHand: [1, 0, 0],
  rightShoulder: [-1, 0, 0],
  rightUpperArm: [-1, 0, 0],
  rightLowerArm: [-1, 0, 0],
  rightHand: [-1, 0, 0],
  leftUpperLeg: [0, -1, 0],
  leftLowerLeg: [0, -1, 0],
  leftFoot: [0, -1, 0],
  rightUpperLeg: [0, -1, 0],
  rightLowerLeg: [0, -1, 0],
  rightFoot: [0, -1, 0],
}

function baseName(name) {
  return String(name).toLowerCase().replace(/^mixamorig:?/, '').replace(/[_\s-]/g, '')
}

/**
 * 覆盖「VRM 静止朝向」表。
 *
 * 内置的 `VRM_REST_DIR` 是按 T-Pose 常识写的，但**脚掌那条是错的**：
 * 脚踝不是朝下、是朝前，硬编码会让整段走路的脚被多转约 90°
 * （实测生成出来的脚踝 delta X 在 −59…−98°，看着就是「脚背/脚尖怪」）。
 * 正确做法是从真模型量（`tools/dump_rest_dirs.mjs`），用 `--rest-dirs` 传进来。
 */
const restOverrides = (() => {
  const p = args['rest-dirs']
  if (!p) return null
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'))
    const dirs = json.dirs ?? json
    const n = Object.keys(dirs).length
    console.log(`静止朝向：用 ${path.basename(p)} 覆盖 ${n} 根骨骼`)
    return dirs
  } catch (err) {
    console.error(`读不了 --rest-dirs ${p}: ${err.message}`)
    process.exit(1)
  }
})()

/** VRM rest 方向：默认表 + 模型覆盖 */
const vrmRestDir = (bone) => restOverrides?.[bone] ?? VRM_REST_DIR[bone] ?? [0, 1, 0]

/** VRM 人形骨骼的父子关系（aim 重定向要按层级累乘，不能按数组顺序猜） */
const VRM_PARENT = {
  hips: null,
  spine: 'hips',
  chest: 'spine',
  upperChest: 'chest',
  neck: 'upperChest',
  head: 'neck',
  leftShoulder: 'upperChest',
  leftUpperArm: 'leftShoulder',
  leftLowerArm: 'leftUpperArm',
  leftHand: 'leftLowerArm',
  rightShoulder: 'upperChest',
  rightUpperArm: 'rightShoulder',
  rightLowerArm: 'rightUpperArm',
  rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips',
  leftLowerLeg: 'leftUpperLeg',
  leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips',
  rightLowerLeg: 'rightUpperLeg',
  rightFoot: 'rightLowerLeg',
}
/** 父在前、子在后 */
const VRM_ORDER = [
  'hips',
  'spine',
  'chest',
  'upperChest',
  'neck',
  'head',
  'leftShoulder',
  'leftUpperArm',
  'leftLowerArm',
  'leftHand',
  'rightShoulder',
  'rightUpperArm',
  'rightLowerArm',
  'rightHand',
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
]

const qAxisAngle = (axis, rad) => {
  const s = Math.sin(rad / 2)
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)]
}

/** 末梢/有子关节两种情况都能给出一根骨头的“自家方向” */
function restDirOf(n) {
  for (const c of n.children) {
    const d = norm(c.offsets)
    if (Math.hypot(d[0], d[1], d[2]) > 0.5) return d
  }
  if (n.endOffset) {
    const d = norm(n.endOffset)
    if (Math.hypot(d[0], d[1], d[2]) > 0.5) return d
  }
  return null
}

/** 该帧这根骨头在世界的朝向（父空间里量，直接看子关节位置差） */
function worldDirOf(n, fk) {
  for (const c of n.children) {
    if (Math.hypot(...c.offsets) < 1e-6) continue
    const a = fk.get(n).p
    const b = fk.get(c).p
    const d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]])
    return d
  }
  if (n.endOffset) return norm(mvec(m3of(fk.get(n).q), n.endOffset))
  return null
}

/**
 * 从脚的世界坐标反推髋位移。
 * feet[i] = { left, right, leftToe?, rightToe? }，坐标已减去根关节位置（即相对髋）。
 * 返回每帧 [x,y,z]（米）；返回 null 表示「用源数据」。
 */
function deriveHips(feet, scale, mode, rootMoves) {
  if (mode === 'none') {
    console.log('髋位移：--hips none，全部置零')
    return feet.map(() => [0, 0, 0])
  }
  if (mode === 'source' || (mode !== 'auto' && rootMoves)) {
    console.log('髋位移：用源数据的根位移')
    return null
  }
  if (rootMoves && mode === 'auto') {
    console.log('髋位移：源数据自带根位移，直接搬（不合成）')
    return null
  }

  const n = feet.length
  /**
   * 只量脚踝，不量脚尖。脚尖比脚踝低 3 cm，但 BVH 里**没有脚跟**，
   * 混进来会把「哪一帧腿最伸直」的判定挪到别的帧去，结果整段比站姿低 18 mm
   * （一开头就往下沉一下）。脚踝是唯一左右对称、且和 VRM rest 对得上的量。
   */
  const minY = feet.map((f) => Math.min(f.left[1], f.right[1]))
  // 最伸直的那一帧 → 髋最高，记作 0（源姿态下腿是直的）。之后每一帧腿弯多少就降多少。
  const ref = Math.min(...minY)
  const rawY = minY.map((v) => -(v - ref))
  let hY = smooth1(rawY, true, 3)
  hY = hY.map((v) => Math.min(v, 0)) // 平滑后会略微过冲，压回来：宁可少升，不要悬浮

  // 支撑脚：哪只脚低（y 更负）就是哪只在承重，用 sigmoid 做软权重避免切换时跳
  const eps = 0.2
  const wl = feet.map((f) => 1 / (1 + Math.exp((f.left[1] - f.right[1]) / eps)))
  /**
   * 横向**不能用**「让髋跟着支撑脚走」：这套原地 BVH 里脚在横向上是慢慢飘的
   * （整段左移了 8 cm），照搬会变成「人往一侧缓缓倒过去」。
   * 真正的骨盆侧移是**每步一次的往复**，幅度约 ±15 mm，所以按支撑相合成。
   */
  const SWAY = 0.016 / scale // 米 → BVH 单位，单侧峰值
  const hX = smooth1(
    wl.map((w) => (w * 2 - 1) * SWAY),
    true,
    3,
  )

  const range = (a) => Math.max(...a) - Math.min(...a)
  const mm = (v) => ((v * scale) / 0.001).toFixed(1)
  if (args.verbose) {
    for (let i = 0; i < n; i++) {
      console.log(`  f${String(i).padStart(2)} 最低脚 ${mm(minY[i])} 原始 ${mm(rawY[i])} 平滑后 ${mm(hY[i])}`)
    }
  }
  console.log(
    `髋位移：合成 —— 上下 ${mm(range(hY))} mm（最低 ${mm(Math.min(...hY))}，最高 ${mm(Math.max(...hY))}），` +
      `左右 ${mm(range(hX))} mm`,
  )
  return feet.map((_, i) => [hX[i] * scale, hY[i] * scale, 0])
}

function main() {
  const { root, rows: rowsRaw, chTotal } = parseBvh(tokens)
  if (!root.frames || !rowsRaw.length) {
    console.error('解析失败：没读到帧数据')
    process.exit(1)
  }
  /**
   * 有些捕捉数据开头会垫一帧「站立静止帧」（所有通道都是 0），它不是动作的一部分。
   * 留着的话：走路第一帧腿是直的、第二帧就已经双支撑屈膝，髋要一帧掉 4 cm，
   * 看起来是「先站一下，然后整个人往下一沉再开始走」。默认扔掉开头的静止帧。
   */
  const trim = Number(args.trim ?? 0)
  const rows = rowsRaw.slice(trim)
  if (trim) console.log(`扔掉开头 ${trim} 帧（站立引导帧），剩 ${rows.length} 帧`)
  const nodes = [...walk(root)]
  console.log(`关节 ${nodes.length} 个，帧 ${rows.length}，每帧 ${chTotal} 通道，dt=${root.frameTime}`)

  // 每个节点：通道偏移（在行里的位置）
  let cursor = 0
  for (const n of nodes) {
    n.chStart = cursor
    cursor += n.channels.length
  }

  // 静止世界位置（累加 OFFSET）→ 每根骨头在父空间的方向 = 自己的 OFFSET 方向
  const mapped = []
  for (const n of nodes) {
    const bone = MAP[baseName(n.name)]
    if (!bone) continue
    const dir = norm(n.offsets)
    const align = qFromTo(vrmRestDir(bone), dir)
    mapped.push({ node: n, bone, align })
  }
  console.log(`映射到 VRM 骨骼 ${mapped.length} 根：${mapped.map((m) => m.bone).join(' ')}`)
  const missing = Object.keys(VRM_REST_DIR).filter((b) => !mapped.some((m) => m.bone === b))
  if (missing.length) console.log(`⚠ 没映射到：${missing.join(' ')}`)

  // 髋高度（用来定尺度）
  const hip = mapped.find((m) => m.bone === 'hips')
  const bvhHipY = rows[0][hip.node.chStart + 1]
  const scale = 0.9 / bvhHipY // VRM 站立时髋高约 0.9 m（归一化骨骼空间的量级）
  console.log(`BVH 髋高 ${bvhHipY.toFixed(3)} 单位 → 缩放 ${scale.toFixed(4)}`)

  // ------------------------------------------------------------ 髋位移
  /**
   * 源 BVH 分两种：
   *   A. 带根位移的捕捉数据 —— Xposition/Zposition 在变，直接搬过来就行；
   *   B. **原地动作** —— 根位移全程恒定（CMU 的原地步、跑步机步都是这种），
   *      这时候「脚在地上走」这件事**只存在于关节角里**，髋是一动不动的。
   *
   * B 必须自己推，否则：髋固定、腿一弯，两只脚就轮流悬空 6 cm，
   * 看起来是在原地蹬腿，而不是走路。
   *
   *   hY(t) = -(最低脚相对髋的高度(t) − 全片最伸直的那一帧)   ← 腿弯多少，髋就降多少
   *   hX(t) = 支撑脚 x(t) − 均值                               ← 重心必须落在支撑脚上方
   */
  const tree = parseHierarchy(text)
  if (tree.length === nodes.length) {
    tree.forEach((n, k) => {
      n.chStart = nodes[k].chStart
    })
    const footIdx = {}
    for (const side of ['left', 'right']) {
      const n = tree.find((t) => t.name.toLowerCase() === `${side}foot`)
      if (n) footIdx[side] = n
      const toe = tree.find((t) => t.name.toLowerCase() === `${side}toebase`)
      if (toe) footIdx[`${side}Toe`] = toe
    }
    if (footIdx.left && footIdx.right) {
      const rootMoves = [0, 1, 2].some((k) => {
        const vals = rows.map((r) => r[k])
        return Math.max(...vals) - Math.min(...vals) > 1e-4
      })
      const hipRow0 = [rows[0][hip.node.chStart], rows[0][hip.node.chStart + 1], rows[0][hip.node.chStart + 2]]
      const feet = rows.map((row) => {
        const pos = fkFrame(tree, row)
        const out = {}
        for (const key of Object.keys(footIdx)) {
          const p = pos.get(footIdx[key])
          out[key] = [p[0] - hipRow0[0], p[1] - hipRow0[1], p[2] - hipRow0[2]]
        }
        return out
      })
      hip.derive = deriveHips(feet, scale, args.hips, rootMoves)
      /**
       * 位移速度：原地动作里，支撑脚相对髋在**往后退**，那正是「身体往前走」的另一面。
       * 一只脚在一次支撑期里从最前退到最后，退了多少 = 这一步迈出去多远；
       * 一个周期两步，所以 `travel = 2 × 单脚前后行程 / 周期`。
       * 引擎按这个速度推窗口，支撑脚在世界里就是静止的（不滑）。
       */
      const spanZ = (side) => Math.max(...feet.map((f) => f[side][2])) - Math.min(...feet.map((f) => f[side][2]))
      let step = ((spanZ('left') + spanZ('right')) / 2) * scale
      const cycle = (rows.length - 1) * root.frameTime
      hip.travel = (2 * step) / cycle
      console.log(
        `位移速度：一步 ${step.toFixed(2)} m（源骨架 FK），周期 ${cycle.toFixed(2)} s → ${hip.travel.toFixed(2)} m/s`,
      )
      // 可选：用真机量出来的表覆盖上下位移（见 tools/README「髋位移标定」）
      const calPath = args['hips-cal']
      if (calPath && hip.derive) {
        const cal = JSON.parse(fs.readFileSync(calPath, 'utf8'))
        const need = cal.samples.map((s) => cal.restAnkleY - s.legReach - cal.hipsRestY)
        const sorted = [...need].sort((a, b) => a - b)
        const med = sorted[Math.floor(sorted.length / 2)]
        // 量测偶尔会撞上加载中的一帧（髋瞬移半米），离群值直接用中位数替掉
        const clean = need.map((v, i) => (Math.abs(v - med) > 0.08 ? sorted.find((x) => Math.abs(x - med) < 0.08) ?? med : v))
        const tAt = (i) => i * cal.frameDt
        const needAt = (t) => {
          const s = cal.samples
          for (let k = 0; k < s.length - 1; k++) {
            if (t <= s[k + 1].t || k === s.length - 2) {
              const u = (t - s[k].t) / (s[k + 1].t - s[k].t || 1)
              return clean[k] + (clean[k + 1] - clean[k]) * Math.max(0, Math.min(1, u))
            }
          }
          return clean[clean.length - 1]
        }
        hip.derive = hip.derive.map((h, i) => [h[0], needAt(tAt(i)), 0])
        const ys = hip.derive.map((h) => h[1])
        console.log(
          `髋位移：用标定表 ${path.basename(calPath)} 覆盖上下位移 —— ${(Math.min(...ys) * 1000).toFixed(1)} … ${(Math.max(...ys) * 1000).toFixed(1)} mm`,
        )
        // 位移速度也用**真模型**的脚行程：重定向之后 VRM 的腿比源骨架长，
        // 用源骨架的 0.61 m 会让她走得太慢、脚往前打滑
        const zsL = cal.samples.map((s) => s.lz).filter((z) => Number.isFinite(z))
        const zsR = cal.samples.map((s) => s.rz).filter((z) => Number.isFinite(z))
        if (zsL.length > 4 && zsR.length > 4) {
          const span = (a) => Math.max(...a) - Math.min(...a)
          const stepM = (span(zsL) + span(zsR)) / 2
          // 采样是每 `step` 帧一次，所以一个周期 = (样本数-1) × step × dt
          const cycleSec = (cal.samples.length - 1) * (cal.step ?? 1) * cal.frameDt
          hip.travel = (2 * stepM) / cycleSec
          console.log(
            `位移速度：一步 ${stepM.toFixed(2)} m（真模型单脚行程），周期 ${cycleSec.toFixed(2)} s → ${hip.travel.toFixed(2)} m/s`,
          )
        }
      }
    } else {
      console.log('⚠ 没找到 leftFoot/rightFoot，髋位移只能用源数据')
    }
  } else {
    console.log(`⚠ 层级解析节点数不符（${tree.length} vs ${nodes.length}），髋位移只能用源数据`)
  }

  // 逐帧 —— 每根骨头：对齐后的局部欧拉角
  // 同一个 VRM 骨骼可能对应多个 BVH 关节（例如 Neck + Neck1、Spine 链），
  // 按层级顺序把它们的局部旋转**乘起来**，不然后一个会盖掉前一个。
  const groups = new Map()
  for (const m of mapped) {
    if (!groups.has(m.bone)) groups.set(m.bone, [])
    groups.get(m.bone).push(m)
  }
  // 一个 VRM 骨骼对上多个 BVH 关节时，取**链上最末**的那个代表它（Spine 链 → Chest）
  const pick = new Map()
  for (const n of tree) {
    const bone = MAP[baseName(n.name)]
    if (bone) pick.set(bone, n)
  }

  const RETARGET = args.retarget ?? 'aim-legs'

  /** 某个 BVH 关节的局部旋转（按通道顺序乘） */
  const localQuatOf = (node, row) => {
    let q = [0, 0, 0, 1]
    for (let k = 0; k < node.channels.length; k++) {
      const ch = node.channels[k]
      if (!ch.toLowerCase().endsWith('rotation')) continue
      q = qMul(q, qAxis(ch[0].toUpperCase(), row[node.chStart + k]))
    }
    return q
  }

  /** 老做法：把局部旋转按静止朝向共轭一下搬过来（`--retarget local`） */
  function localFrame(row) {
    const out = {}
    for (const [bone, list] of groups) {
      let q = [0, 0, 0, 1]
      for (const m of list) q = qMul(q, qMul(qMul(m.align, localQuatOf(m.node, row)), qConj(m.align)))
      out[bone] = eulerXYZ(q)
    }
    return out
  }

  /**
   * 保方向重定向（默认只用在腿上）。
   *
   * 为什么不能直接搬局部旋转：BVH 的每根骨头都带着**自己骨架的静止朝向**。
   * 这套 CMU 数据里 `LeftUpLeg` 的 OFFSET 本身外撇 20°，通道里那个恒定的
   * `Zrotation≈−31°` 正好把它抵回竖直；把局部旋转原样搬到 VRM（它的 rest 是
   * 竖直的），就变成「两条腿永远外撇 20–31°」——腿一撇就短了 6–11 cm，
   * 脚离地，看着就是走路时人浮在半空、两腿分开。
   *
   * 所以腿改成**对齐世界方向**：
   *   1. FK 出这根骨头这一帧的世界方向 w(t)，以及它静止时的世界方向 s；
   *   2. 取「把 s 转到 w」的最短弧 A（只保留方向，不搬静止朝向）；
   *   3. 绕骨轴的那点扭转（脚的翻转）单独拆出来，按同一角度补回去；
   *   4. 用 VRM 的父骨当前朝向反解出局部旋转。
   *
   * 只对腿用：手臂的局部旋转本来是对的（base 层那 73° 就是给它留的），
   * 换成就地保方向反而会把肩/肘的扭转解坏（实测手臂会摊成 T 字或抱在肚子前）。
   */
  const AIM_BONES = new Set([
    'leftUpperLeg',
    'leftLowerLeg',
    'leftFoot',
    'rightUpperLeg',
    'rightLowerLeg',
    'rightFoot',
  ])

  function aimFrame(row) {
    const out = {}
    const fk = fkFull(tree, row)
    const worldQ = new Map()
    for (const bone of VRM_ORDER) {
      const node = pick.get(bone)
      const parent = VRM_PARENT[bone]
      const pQ = parent ? worldQ.get(parent) ?? [0, 0, 0, 1] : [0, 0, 0, 1]
      let qLocal = [0, 0, 0, 1]
      const useAim = RETARGET === 'aim' || (RETARGET === 'aim-legs' && AIM_BONES.has(bone))
      if (node && useAim && bone !== 'hips') {
        const s = restDirOf(node)
        const w = worldDirOf(node, fk)
        if (s && w) {
          const dV = vrmRestDir(bone)
          const srcQ = fk.get(node).q
          // 只保留方向的“无扭转”姿态，剩下的就是绕骨轴的扭转量
          const res = qMul(qConj(qFromTo(s, w)), srcQ)
          const theta = 2 * Math.atan2(res[0] * w[0] + res[1] * w[1] + res[2] * w[2], res[3])
          const targetWorld = qMul(qFromTo(dV, w), qAxisAngle(dV, theta))
          qLocal = qMul(qConj(pQ), targetWorld)
        }
      } else if (node) {
        // 局部旋转 + 静止朝向共轭（老做法，手臂/躯干用它）
        for (const g of groups.get(bone) ?? []) {
          qLocal = qMul(qLocal, qMul(qMul(g.align, localQuatOf(g.node, row)), qConj(g.align)))
        }
      }
      worldQ.set(bone, qMul(pQ, qLocal))
      out[bone] = eulerXYZ(qLocal)
    }
    return out
  }

  const frames = rows.map((row, fi) => {
    const out = RETARGET === 'local' ? localFrame(row) : aimFrame(row)
    // 扣掉 basePose（引擎会在 base 层加回来）：BVH 里手臂已经「垂下来」了，
    // 不扣的话两层叠加会把手臂拧到背后。
    // aim 模式给的是**绝对世界方向**，而引擎的 base 层已经把手压下来 73°，
    // 所以同样要扣——扣完之后「base + clip」才等于 aim 算出来的那个方向。
    if (subtractBase) {
      for (const [bone, off] of Object.entries(BASE_POSE)) {
        const e = out[bone]
        if (!e) continue
        out[bone] = [e[0] - off[0], e[1] - off[1], e[2] - off[2]]
      }
    }
    const hipsPos = hip.derive
      ? hip.derive[fi]
      : [
          (row[hip.node.chStart] - rows[0][hip.node.chStart]) * scale,
          (row[hip.node.chStart + 1] - rows[0][hip.node.chStart + 1]) * scale,
          (row[hip.node.chStart + 2] - rows[0][hip.node.chStart + 2]) * scale,
        ]
    out.__hips = hipsPos
    return out
  })

  const duration = (frames.length - 1) * root.frameTime
  console.log(`时长 ${duration.toFixed(2)}s，${frames.length} 帧`)

  if (args.report) {
    // 抽查：第 0 帧与中间帧的左右大腿角度
    const mid = Math.floor(frames.length / 2)
    for (const f of [0, mid]) {
      const a = frames[f].leftUpperLeg.map((v) => (v * 180) / Math.PI)
      const b = frames[f].rightUpperLeg.map((v) => (v * 180) / Math.PI)
      console.log(
        `  帧 ${f}: 左大腿 ${a.map((v) => v.toFixed(0)).join(',')}°  右大腿 ${b.map((v) => v.toFixed(0)).join(',')}°  髋 ${frames[f].__hips.map((v) => v.toFixed(2)).join(',')}`,
      )
    }
    return
  }

  const out = args.out
  if (!out) {
    console.error('缺 --out')
    process.exit(1)
  }
  const id = args.id ?? path.basename(out, '.ts')
  const name = args.name ?? id
  /**
   * 不交给这条 clip 的骨骼（默认 `head,neck`）。
   *
   * 为什么头颈不归走路 clip 管：动捕里那个人的颈姿是**前倾 15°**，淡入的 0.25 s 里
   * 她的脖子会摆过去——作者摆的站姿颈是 ±0.5°，看着就是「脖子突然抻出去又回来」。
   * 头颈交给 base 层（作者站姿）之后，走路时头跟着躯干走、不另摆，衔接是连续的。
   */
  const exclude = new Set(
    String(args['owns-exclude'] ?? 'head,neck')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  if (exclude.size) {
    const dropped = []
    for (const f of frames) {
      for (const b of exclude) {
        if (f[b]) {
          delete f[b]
          dropped.push(b)
        }
      }
    }
    if (dropped.length) {
      console.log(`不归这条 clip 管：${[...new Set(dropped)].join(' ')}（交给 base 层，避免淡入时甩脖子）`)
    }
  }
  const armOut = Number(args['arm-out'] ?? 0.1)
  if (armOut) {
    for (const f of frames) {
      if (f.leftUpperArm) f.leftUpperArm = [f.leftUpperArm[0], f.leftUpperArm[1], f.leftUpperArm[2] + armOut]
      if (f.rightUpperArm) f.rightUpperArm = [f.rightUpperArm[0], f.rightUpperArm[1], f.rightUpperArm[2] - armOut]
    }
    console.log(`手臂外扩：上臂 Z ${armOut >= 0 ? '+' : ''}${armOut} rad（${((armOut * 180) / Math.PI).toFixed(1)}°）`)
  }
  const round = (v) => Math.round(v * 1e4) / 1e4
  const body = frames
    .map((f) => {
      const bones = Object.entries(f)
        .filter(([k]) => k !== '__hips')
        .map(([k, v]) => `${k}:[${v.map(round).join(',')}]`)
        .join(',')
      return `  { b: {${bones}}, h: [${f.__hips.map(round).join(',')}] },`
    })
    .join('\n')

  const src = `/* 由 tools/bvh_to_clip.mjs 生成，别手改。
 * 源：${path.basename(bvhPath)}，${frames.length} 帧 / ${duration.toFixed(2)}s / dt=${root.frameTime}
 * 重定向：${RETARGET}（腿保世界方向，手臂/躯干用局部旋转 + basePose 补偿）
${trim ? ` * 已扔掉开头 ${trim} 帧（站立引导帧）\n` : ''}${args['hips-cal'] ? ` * 髋位移：标定表 ${path.basename(args['hips-cal'])}（在真模型上量出来的，见 tools/README）\n` : ' * 髋位移：由源骨架 FK 反推（最低那只脚踩地）\n'} * 骨骼映射 + 静止朝向对齐见生成脚本的注释。
 */
import type { ActionClip, ActionContext, BoneName, PoseDelta, Vec3 } from '../../core/types'

type Frame = { b: Partial<Record<BoneName, Vec3>>; h: Vec3 }

const FRAMES: Frame[] = [
${body}
]

const OWNED = Object.keys(FRAMES[0].b) as BoneName[]
const FPS = 1 / ${root.frameTime}
const CYCLE = ${duration.toFixed(4)}

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/**
 * 走路是**循环**的：\`duration\` 是无穷，引擎用 stop 收尾。
 *
 * 为什么不「播完再 play 一次」：同一个 id 重放会在接缝处掉 1–2 帧，
 * 姿势退回站姿再重新进——实测每圈中间有 ~150 ms 腿是不动的，而窗口还在平移，
 * 看着就是「人在飘」。所以把循环做进 sample 里，接缝处只差一帧。
 */
export const clip: ActionClip = {
  id: ${JSON.stringify(id)},
  layer: 'base',
  duration: Number.POSITIVE_INFINITY,
  priority: 6,
  interrupt: 'soft',
  blendIn: 0.25,
  blendOut: 0.25,
  owns: OWNED,
  ownsHips: true,
  travel: ${(hip.travel ?? 0).toFixed(3)},
  cycle: CYCLE,
  sample(t: number, _ctx: ActionContext): PoseDelta {
    const n = FRAMES.length
    const local = ((t % CYCLE) + CYCLE) % CYCLE
    const x = Math.min(n - 1, local * FPS)
    const i = Math.min(n - 2, Math.floor(x))
    const u = n < 2 ? 0 : x - i
    const a = FRAMES[Math.max(0, i)]
    const b = FRAMES[Math.min(n - 1, i + 1)]
    const bones: Partial<Record<BoneName, Vec3>> = {}
    for (const k of OWNED) {
      const va = a.b[k] ?? [0, 0, 0]
      const vb = b.b[k] ?? va
      bones[k] = lerp3(va, vb, u)
    }
    return { bones, hipsOffset: lerp3(a.h, b.h, u) }
  },
}

export default clip
`
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, src, 'utf8')
  console.log(`写入 ${out}（${(src.length / 1024).toFixed(0)} KB，${name}）`)
}

main()
