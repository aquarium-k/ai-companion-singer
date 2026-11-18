import type { ActionClip, BoneName, ExpressionName, Vec3 } from '../core/types'
import { LIP_KEYS, VOWEL_SHAPE, type Vowel } from '../songpack/viseme'
import { createKeyframeClip } from './keyframes'
import { getPose } from './poses'
import walkClip from './gen/walk'

const TAU = Math.PI * 2
const PI = Math.PI

// ---------------------------------------------------------------------------
// 待机：additive 层，永远在跑，权重很低但决定「活着」的感觉
// ---------------------------------------------------------------------------

export const idleBreath: ActionClip = {
  id: 'idle.breath',
  layer: 'additive',
  duration: Number.POSITIVE_INFINITY,
  priority: 10,
  interrupt: 'none',
  blendIn: 1.2,
  blendOut: 1.2,
  sample: (t) => {
    const p = Math.sin((TAU * t) / 4.2)
    return {
      bones: {
        spine: [0.012 * p, 0, 0],
        chest: [0.018 * p, 0, 0],
        neck: [-0.012 * p, 0, 0],
        leftShoulder: [0, 0, 0.02 * p],
        rightShoulder: [0, 0, -0.02 * p],
      },
      hipsOffset: [0, 0.006 * p, 0],
    }
  },
}

export const idleSway: ActionClip = {
  id: 'idle.sway',
  layer: 'additive',
  duration: Number.POSITIVE_INFINITY,
  priority: 10,
  interrupt: 'none',
  blendIn: 2.0,
  blendOut: 2.0,
  sample: (t) => {
    const p = Math.sin((TAU * t) / 7.5)
    const q = Math.sin((TAU * t) / 3.1)
    return {
      bones: {
        hips: [0, 0.04 * p, 0.022 * p],
        chest: [0, -0.018 * p, -0.016 * p],
        head: [0.008 * q, -0.03 * p, 0],
      },
    }
  },
}

/**
 * 静息站姿（作者摆的 `idle.base`），常驻在 base 层。
 *
 * 它不是「动作」，是**基线**：所有一次性动作的首尾帧都是这个姿势，动作淡出
 * 之后也回到它。以前基线是 `rig.basePose`（只有手臂下垂），所以动作播完人
 * 就变回另一副样子——终点和起点对不上。现在站姿自己就是一个 clip。
 *
 * `neutral: true` 让它不吃 `setMotionScale`（按住身体看嘴型时不能退成 T-pose）。
 */
export const idlePose: ActionClip = (() => {
  const def = getPose('idle.base')
  const bones = def?.bones ?? {}
  return {
    id: 'idle.pose',
    layer: 'base',
    duration: Number.POSITIVE_INFINITY,
    // 优先级最低：任何 base 层的动作（律动、转圈）都能接管
    priority: 5,
    interrupt: 'soft',
    blendIn: 0.7,
    blendOut: 0.7,
    neutral: true,
    owns: Object.keys(bones) as BoneName[],
    ownsHips: Boolean(def?.hipsOffset),
    sample: () => ({ bones, hipsOffset: def?.hipsOffset }),
  }
})()

// ---------------------------------------------------------------------------
// 表情
// ---------------------------------------------------------------------------

export function createBlinkClip(): ActionClip {
  let next = 1.2
  let start = -1
  let gap = 3

  return {
    id: 'face.blink',
    layer: 'face',
    duration: Number.POSITIVE_INFINITY,
    priority: 90,
    interrupt: 'none',
    blendIn: 0.01,
    blendOut: 0.01,
    sample: (t) => {
      if (start < 0 && t >= next) {
        start = t
        gap = 2 + Math.random() * 4
      }
      let v = 0
      if (start >= 0) {
        const u = (t - start) / 0.16
        if (u >= 1) {
          start = -1
          next = t + gap
        } else {
          v = Math.sin(PI * u)
        }
      }
      return { expressions: { blink: v } }
    },
  }
}

/** 假口型：先用包络代替真实歌声，验证「音频 → 表情」这条链路 */
export const faceTalk: ActionClip = {
  id: 'face.talk',
  layer: 'face',
  duration: Number.POSITIVE_INFINITY,
  priority: 80,
  interrupt: 'hard',
  blendIn: 0.12,
  blendOut: 0.2,
  sample: (t) => {
    const env = 0.45 + 0.55 * Math.abs(Math.sin((TAU * 0.7 * t)) as number)
    const syl = Math.max(0, Math.sin((TAU * 3.4) * t))
    const open = env * syl
    const shape = Math.sin((TAU * 0.31) * t)
    return {
      expressions: {
        aa: open * (shape > 0 ? 0.95 : 0.45),
        oh: open * (shape > 0 ? 0.25 : 0.7),
        ou: open * 0.18,
      } as Partial<Record<ExpressionName, number>>,
    }
  },
}

// ---------------------------------------------------------------------------
// 舞蹈：base / upper 层，关键帧驱动（P8）
// ---------------------------------------------------------------------------

/**
 * 主力律动：左右摇摆（P8 关键帧）。
 *
 * 老版本是三个我手写的姿势（`idle.weight.L` / `idle.dip`），和新姿势库不搭。
 * 现在用作者摆的 `sway`（重心偏一侧、上身反向、头跟着偏）+ 它的镜像。
 *
 * 反「僵硬」的三件事（2026-11-11 二改）：
 *
 * 1. **两头有停顿**：到边上停 0.3 拍再走。一直匀速摆看着像节拍器，
 *    真实的重心转移是「落定 → 停一下 → 再推回去」。
 * 2. **速度曲线要接得上**：离开边用 `in`（由慢到快），到中间用 `out`（由快到慢），
 *    两段在中间那一帧的速度是连着的——所以过中点不会顿一下。
 * 3. **上下也有起伏**：重心落到一条腿上时人往下坐（−1.4 cm），过中点时弹起来（+0.5 cm）。
 *    只有左右移动、没有上下，是「滑」；有了上下才有重量。
 */
export const danceBounce: ActionClip = createKeyframeClip({
  id: 'dance.bounce',
  layer: 'base',
  priority: 50,
  interrupt: 'soft',
  blendIn: 0.35,
  blendOut: 0.25,
  loopBeats: 4,
  keys: [
    { pose: 'sway.L', at: 0, ease: 'inOut' },
    { pose: 'sway.L', at: 0.3, ease: 'in' }, // 停一下，然后加速离开
    { pose: 'sway.center', at: 1.2, ease: 'out' }, // 过中点速度最快，再减速到右边
    { pose: 'sway.R', at: 2.0, ease: 'inOut' },
    { pose: 'sway.R', at: 2.3, ease: 'in' },
    { pose: 'sway.center', at: 3.2, ease: 'out' },
  ],
})

/**
 * 挥手：作者的「手偏外 / 手偏内」两帧交替三下。
 *
 * 两帧之间的间隔从 0.28 s 收到 0.16 s：挥手是手腕在动，节奏比手臂抬起来快得多。
 * 起手和收手仍然走 `idle.base`，所以接在任何动作后面都不跳。
 */
export const danceWave: ActionClip = createKeyframeClip({
  id: 'dance.wave',
  layer: 'upper',
  priority: 60,
  interrupt: 'hard',
  blendIn: 0.18,
  blendOut: 0.28,
  duration: 1.3,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'wave.1', at: 0.18, ease: 'out' },
    { pose: 'wave.in', at: 0.34, ease: 'inOut' },
    { pose: 'wave.1', at: 0.5, ease: 'inOut' },
    { pose: 'wave.in', at: 0.66, ease: 'inOut' },
    { pose: 'wave.1', at: 0.82, ease: 'inOut' },
    { pose: 'idle.base', at: 1.18, ease: 'in' },
  ],
})

/**
 * 转圈：作者的转身姿势 × 四个偏航相位。
 *
 * 老版本用的是我自己拼的 `turn.*`（手臂外张、迈步），和现在的姿势库不是一套。
 * 现在每一步都是作者的姿势，只是整具身体的偏航在转：0 → 180 → 360。
 *
 * 为什么只用两个段（`in` 加速、`out` 减速），而不是四段 90°：
 * 四段里每一段的末尾速度都不一样，接缝处会「顿」一下——转得越快越明显。
 * 两段的话角速度从 0 升到峰值再降回 0，全程只有一次加速一次减速。
 *
 * **脚仍然会滑**——这一版靠 P9 的脚部锁定兜（着地那只脚钉住，身体拧过去）。
 */
export const danceSpin: ActionClip = createKeyframeClip({
  id: 'dance.spin',
  layer: 'base',
  priority: 70,
  interrupt: 'none',
  blendIn: 0.15,
  // 结束在 2π 的姿势上。淡出必须是**硬切**（≈0）：交叉淡入淡出会把 6.283 线性
  // 插值回 0，中间会有一帧整个人转到背面；而末帧本身就是「站姿 + 360°」，
  // 视觉上和站姿一模一样，所以硬切反而看不出接缝。
  blendOut: 0.001,
  duration: 0.92,
  // 结束在 2π：视觉上等于首帧，数值上不等于，所以豁免首尾一致性检查
  skipPoseCheck: true,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'spin', at: 0.14, ease: 'in' },
    { pose: 'spin.half', at: 0.52, ease: 'out' },
    { pose: 'spin.full', at: 0.92, ease: 'out' },
  ],
})

/**
 * 比耶：用作者摆的姿势（右手），抬手 → 停 → 放下。
 *
 * 手指的形是作者摆的，我不再自己拼 `hand.peace.*`。
 */
export const posePeace: ActionClip = createKeyframeClip({
  id: 'pose.peace',
  layer: 'upper',
  priority: 65,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.3,
  duration: 2.1,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'peace', at: 0.3, ease: 'out' },
    { pose: 'peace', at: 1.5 },
    { pose: 'idle.base', at: 1.85, ease: 'in' },
  ],
})

/**
 * 鼓掌：分开 ↔ 合上，来回三次。
 *
 * 作者摆的是「分开」那一帧，合上的帧由我把上臂往里收推出来（见 `clap.shut`），
 * 两帧手的高度一样，所以是沿着同一条弧线拍合，不会上下飘。
 */
export const gestureClap: ActionClip = createKeyframeClip({
  id: 'gesture.clap',
  layer: 'upper',
  priority: 58,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.28,
  duration: 1.15,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'clap', at: 0.18, ease: 'out' },
    { pose: 'clap.shut', at: 0.3, ease: 'in' },
    { pose: 'clap', at: 0.42, ease: 'inOut' },
    { pose: 'clap.shut', at: 0.54, ease: 'in' },
    { pose: 'clap', at: 0.66, ease: 'inOut' },
    { pose: 'clap.shut', at: 0.78, ease: 'in' },
    { pose: 'idle.base', at: 1.1, ease: 'inOut' },
  ],
})

/**
 * 欢呼：真的跳起来。
 *
 * 第一版只是「举起双手 + 髋上浮 4.5 cm 然后停住」，看着僵——因为它只动了
 * 手臂，身体没有离地、也没有蓄力和缓冲，所以既不像跳也不像欢呼。
 *
 * 现在按跳跃的力学拆成五段，关键在**垂直方向**：
 *
 * ```
 * 0.13  蓄力：屈膝下沉 10 cm，双臂后摆（in：加速下蹲，像被重力压下去）
 * 0.21  蓄力停顿（起跳前的那一拍）
 * 0.30  蹬伸：腿伸直、踮脚，双臂前上甩（out：爆发，一上来就快）
 * 0.44  腾空：髋 +15.5 cm，作者的欢呼姿势（out：越接近顶点越慢）
 * 0.53  顶点悬停 0.09 s（滞空感全靠这一帧）
 * 0.66  下落（in：越掉越快，重力是加速的）
 * 0.78  触地（in：脚砸到地上）
 * 0.86  缓冲：蹲到 9.5 cm，双臂外展（落地不卸力就会像纸片人）
 * 1.15  起身回到站姿
 * ```
 */
export const poseCheer: ActionClip = createKeyframeClip({
  id: 'pose.cheer',
  layer: 'upper',
  priority: 64,
  interrupt: 'hard',
  blendIn: 0.18,
  blendOut: 0.3,
  duration: 1.15,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'jump.prep', at: 0.13, ease: 'in' },
    { pose: 'jump.prep', at: 0.21 },
    { pose: 'jump.push', at: 0.3, ease: 'out' },
    { pose: 'jump.air', at: 0.44, ease: 'out' },
    { pose: 'jump.air', at: 0.53 },
    { pose: 'jump.fall', at: 0.66, ease: 'in' },
    { pose: 'jump.land', at: 0.78, ease: 'in' },
    { pose: 'jump.land', at: 0.86 },
    { pose: 'idle.base', at: 1.15, ease: 'inOut' },
  ],
})

/**
 * 转身后**保持住**的通用壳：用来在固定机位下检查那一侧的镜头角度。
 *
 * `duration` 无穷 = 转过去就一直站着；「转回正面」不是 stop 它（那只是一次 0.3 s 的
 * 权重淡出，140° 会在一瞬间甩回去），而是换成一段 0.8 s 的**过门**（见 main.ts 的 turnBack）。
 */
function turnHoldClip(id: string, poseId: string): ActionClip {
  return createKeyframeClip({
    id,
    layer: 'base',
    priority: 62,
    interrupt: 'soft',
    blendIn: 0.3,
    blendOut: 0.4,
    duration: Number.POSITIVE_INFINITY,
    skipPoseCheck: true,
    keys: [
      { pose: 'idle.base', at: 0, ease: 'out' },
      { pose: poseId, at: 1.1, ease: 'inOut' },
    ],
  })
}

/** 转身 220°（= 顺时针 140°）并保持 */
export const poseTurn220: ActionClip = turnHoldClip('pose.turn220', 'turn.cw140')

/** 转身 140°（逆时针）并保持 */
export const poseTurn140ccw: ActionClip = turnHoldClip('pose.turn140ccw', 'turn.ccw140')

/** 凑近镜头：慢慢探过来，停一会儿，再缩回去 */
export const poseLean: ActionClip = createKeyframeClip({
  id: 'pose.lean',
  layer: 'upper',
  priority: 63,
  interrupt: 'hard',
  blendIn: 0.3,
  blendOut: 0.35,
  duration: 3.6,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'inOut' },
    { pose: 'lean.in', at: 0.8, ease: 'out' },
    { pose: 'lean.in', at: 2.7 },
    { pose: 'idle.base', at: 3.3, ease: 'inOut' },
  ],
})

/** 向前伸手（招呼你过来 / 递东西） */
export const gestureReach: ActionClip = createKeyframeClip({
  id: 'gesture.reach',
  layer: 'upper',
  priority: 58,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.25,
  duration: 2.4,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'inOut' },
    { pose: 'arm.far.L', at: 0.3, ease: 'out' },
    { pose: 'arm.forward.L', at: 0.55, ease: 'inOut' },
    { pose: 'arm.forward.L', at: 1.6 },
    { pose: 'idle.base', at: 2.1, ease: 'in' },
  ],
})

/**
 * 经典唱歌姿势：一手前伸掌心向上，一手抚胸。
 *
 * 四秒：抬起来 → 停住（靠 idle 层的呼吸带一点点起伏）→ 落回去。
 * 首帧和尾帧都是 `idle.base`，所以接在任何动作后面、或被别的动作打断，
 * 都不会在边界上跳一下（见 keyframes.ts 的首尾一致性检查）。
 */
export const poseSing: ActionClip = createKeyframeClip({
  id: 'pose.sing',
  layer: 'upper',
  priority: 62,
  interrupt: 'hard',
  blendIn: 0.4,
  blendOut: 0.45,
  duration: 4.3,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'sing.ballad', at: 0.6, ease: 'out' },
    { pose: 'sing.ballad', at: 3.4 },
    { pose: 'idle.base', at: 4.0, ease: 'inOut' },
  ],
})

/** 点头：先微抬头（预备），点头两下，第二下轻一点 */export const gestureNod: ActionClip = createKeyframeClip({
  id: 'gesture.nod',
  layer: 'upper',
  priority: 55,
  interrupt: 'hard',
  blendIn: 0.08,
  blendOut: 0.15,
  duration: 0.95,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'head.up', at: 0.08, ease: 'in' },
    { pose: 'head.down', at: 0.24, ease: 'back' },
    { pose: 'head.up', at: 0.42, ease: 'in' },
    { pose: 'head.down', at: 0.56, ease: 'back' },
    { pose: 'idle.base', at: 0.85, ease: 'inOut' },
  ],
})

/** 摇头：左右各一次（偏航，不是歪头），两头慢中间快 */
export const gestureShake: ActionClip = createKeyframeClip({
  id: 'gesture.shake',
  layer: 'upper',
  priority: 55,
  interrupt: 'hard',
  blendIn: 0.08,
  blendOut: 0.15,
  duration: 0.95,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'inOut' },
    { pose: 'head.turn.L', at: 0.14, ease: 'inOut' },
    { pose: 'head.turn.R', at: 0.36, ease: 'inOut' },
    { pose: 'head.turn.L', at: 0.56, ease: 'inOut' },
    { pose: 'idle.base', at: 0.82, ease: 'in' },
  ],
})

// ---------------------------------------------------------------------------
// 对话 / 待机手势（作者第三批姿势，2026-11-12）
//
// 这批和编舞池里那些不是一类东西：指向前方、自我介绍、双手交握、回头看、
// 侧对镜头，都是「有人在跟她说话」时才会做的动作。编舞里随机冒出来会很怪
// ——和摇头、鼓掌同一个毛病，但原因不同：那些是**不适配**，这些是**用途不同**。
// 所以 `ROLE` 里全部标 manual，等 LLM 那层接上来再按语义点名调用。
// ---------------------------------------------------------------------------

/** 指向前方：抬起来 → 指一下 → 放下 */
export const gesturePoint: ActionClip = createKeyframeClip({
  id: 'gesture.point',
  layer: 'upper',
  priority: 60,
  interrupt: 'hard',
  blendIn: 0.15,
  blendOut: 0.25,
  duration: 1.9,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    // 指出去是「击」：一起手就快、到位前减速（`out`），匀速抬会像机械臂
    { pose: 'point.fwd', at: 0.26, ease: 'out' },
    { pose: 'point.fwd', at: 1.25 },
    { pose: 'idle.base', at: 1.7, ease: 'inOut' },
  ],
})

/**
 * 回头看：上身拧过去 → 停住 → 转回来。
 *
 * 作者的姿势里髋不动、脊柱拧 0.39 + 上胸 −0.37 + 头 −0.98 rad，加起来快 100°，
 * 所以拧身给到 0.55 s——再快就像被叫了一声猛地扭脖子。停顿给足 1.35 s，
 * 「回头看」的意思全靠这一停，不停就成了「甩头」。
 */
export const poseLookBack: ActionClip = createKeyframeClip({
  id: 'pose.lookBack',
  layer: 'upper',
  priority: 58,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.3,
  duration: 2.7,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'inOut' },
    { pose: 'look.back', at: 0.55, ease: 'inOut' },
    { pose: 'look.back', at: 1.9 },
    { pose: 'idle.base', at: 2.5, ease: 'inOut' },
  ],
})

/** 双手身前交握：两只手从两侧收到身前，停一会儿再放开 */
export const poseClasp: ActionClip = createKeyframeClip({
  id: 'pose.clasp',
  layer: 'upper',
  priority: 56,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.28,
  duration: 2.6,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'inOut' },
    { pose: 'hands.clasp', at: 0.5, ease: 'out' },
    { pose: 'hands.clasp', at: 1.9 },
    { pose: 'idle.base', at: 2.4, ease: 'inOut' },
  ],
})

/** 自我介绍：右手往外一摊（拇指翘着），停一秒多 */
export const poseIntro: ActionClip = createKeyframeClip({
  id: 'pose.intro',
  layer: 'upper',
  priority: 58,
  interrupt: 'hard',
  blendIn: 0.18,
  blendOut: 0.26,
  duration: 2.05,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    // 中间这一帧是**过渡落点**：直接 idle → intro 插值，右手会从肚子前面穿过去
    // （实测离躯干轴只剩 11.7 cm，肚子表面约 12 cm）。收回来时也走它。
    { pose: 'intro.raise', at: 0.2, ease: 'out' },
    { pose: 'intro', at: 0.44, ease: 'out' },
    { pose: 'intro', at: 1.36 },
    { pose: 'intro.raise', at: 1.6, ease: 'inOut' },
    { pose: 'idle.base', at: 1.95, ease: 'inOut' },
  ],
})

/**
 * 拨头发：抬手把鬓角别到耳后，停一下，放下来。
 *
 * **只有一帧到位姿势，没有来回扫**。试过做「耳侧 → 颈侧」的扫动：两帧各自
 * 都对（手腕误差 3 mm / 1 mm，都不穿模），但拼起来不对——中间帧的肘会抬到
 * 耳朵高度、整条小臂朝侧面伸出去，看着像在够东西。原因是两帧在欧拉角空间里
 * 差得远，插值路径不受控（肘的滚动角会先转过去）。
 * 要做真正的扫动，得在世界空间里绕肘转，而不是对欧拉角做线性插值——
 * 记在 `docs/backlog.md` 的「记下来的点子」里了。
 *
 * 到位帧是 `hair.ear.fix`（作者躯干 + 我推的手臂）：手腕离头心 17.9 cm，
 * 贴着头外侧，不穿模。作者的 `hair.ear` / `hair.shoulder` 和海搜出来的
 * `hair.shoulder.fix` 都还在库里，想看原版就 `?pose=hair.ear`。
 */
export const gestureHair: ActionClip = createKeyframeClip({
  id: 'gesture.hair',
  layer: 'upper',
  priority: 57,
  interrupt: 'hard',
  blendIn: 0.18,
  blendOut: 0.28,
  duration: 1.55,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'hair.ear.fix', at: 0.34, ease: 'out' },
    { pose: 'hair.ear.fix', at: 0.95 },
    { pose: 'idle.base', at: 1.35, ease: 'inOut' },
  ],
})

/**
 * 侧对镜头：整个人侧过去约 59°（作者写的髋部偏航 1.03 rad），停两秒再转回来。
 *
 * 唯一一个带**髋部偏航**的一次性动作。脚由 P9 锁在地上，所以看到的是
 * 「脚不动、人拧过去」——真人是会迈半步的，但 380 px 的窗口里拧过去更干净，
 * 迈步留给转圈那条。
 */
export const poseProfile: ActionClip = createKeyframeClip({
  id: 'pose.profile',
  layer: 'upper',
  priority: 57,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.3,
  duration: 3.2,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'inOut' },
    { pose: 'profile', at: 0.7, ease: 'inOut' },
    { pose: 'profile', at: 2.2 },
    { pose: 'idle.base', at: 3.0, ease: 'inOut' },
  ],
})

/**
 * 「注意到你在说话」（D5 便宜版）。
 *
 * 只做**能量检测**，不做语音识别——用户 2026-11-12 拍板：往上做实时互动要常驻
 * 大模型，往下做指令又不如直接点按钮，所以只保留「你说话时她有反应」这个彩蛋。
 *
 * 动作直接用作者摆的那张「左手展望」（`arm.far.L`）：抬左手、前臂折上，
 * 像在听你说。头会跟着视线自己转过去（`lookBias` 已经在做），所以这一条
 * 只需要管手臂。
 */
export const gestureNotice: ActionClip = createKeyframeClip({
  id: 'gesture.notice',
  layer: 'upper',
  priority: 59,
  interrupt: 'hard',
  blendIn: 0.2,
  blendOut: 0.3,
  duration: 1.9,
  keys: [
    { pose: 'idle.base', at: 0, ease: 'out' },
    { pose: 'arm.far.L', at: 0.32, ease: 'out' },
    { pose: 'arm.far.L', at: 1.35 },
    { pose: 'idle.base', at: 1.75, ease: 'inOut' },
  ],
})

/** 调试：把姿势库里任意一个姿势钉住（`?pose=<id>`），用来出姿势对照表。 *  `id` 可以换：ParamBus 认 id，同一个 id 重复 play 只会重置时间、**不会换掉 clip 内容**。 */
export function createPoseClip(poseId: string, id = 'debug.pose'): ActionClip {
  const def = getPose(poseId)
  return {
    id,
    layer: 'upper',
    priority: 99,
    interrupt: 'hard',
    duration: Number.POSITIVE_INFINITY,
    blendIn: 0.01,
    blendOut: 0.01,
    owns: Object.keys(def?.bones ?? {}) as BoneName[],
    ownsHips: Boolean(def?.hipsOffset),
    sample: () => ({
      bones: def?.bones ?? {},
      hipsOffset: def?.hipsOffset,
      expressions: def?.face,
    }),
  }
}

// ---------------------------------------------------------------------------
// 音频驱动：口型与摇摆
// ---------------------------------------------------------------------------

/**
 * 口型。
 *
 * 两个数据源叠加：
 *   `getLevel` —— AnalyserNode 的音量包络，决定「张多大」；没有它静音时也会张嘴
 *   `getVowel` —— mora 级元音时间轴，决定「什么嘴型」；没有它只会 a 的嘴
 *
 * 只给包络时（有伴奏但没有 mora 数据）退回原来的行为，不会更差。
 * 给了 mora 之后，包络仍然负责幅度——静音、换气、间奏时嘴自然会闭上。
 *
 * 形状是**平滑过渡**的：元音是一个 5 维权重向量，每帧朝目标一阶低通
 * （张开快、合拢慢）。直接阶跃的话，日文歌 2~3.4 次/秒的换嘴会看得一清二楚，
 * 像木偶在开合。40/80 ms 是「看起来连续但不拖泥带水」的经验值。
 */
const LIP_ATTACK = 0.04
const LIP_RELEASE = 0.08

/**
 * 有 mora 时的最小张口度。
 *
 * 量出来的问题（2026-11-12，20 秒采样 355 帧）：**演唱中有 32.7% 的帧张口度
 * 低于 0.10**，等于小半首歌嘴是闭着的。原因是包络按「声段内 p10~p90」归一，
 * 而人声逐帧 RMS 的分布很密地压在低位，归一后一大片落在 0 附近。
 *
 * 但物理上不是这样：唱一个字的时候嘴是张开的，闭口只发生在辅音起音的那几十毫秒。
 * 所以**有 mora 就把张口度垫到 0.25**，字与字之间只是半闭，不是闭死；
 * 真正的闭口留给没 mora 的间隙（那时 shape 的 aa 也是 0）。
 */
const LIP_FLOOR = 0.25

export function createLipSyncClip(
  getLevel: () => number,
  getVowel?: () => Vowel | null,
): ActionClip {
  const cur: Record<string, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 }
  let last = 0

  return {
    id: 'face.lipsync',
    layer: 'face',
    duration: Number.POSITIVE_INFINITY,
    priority: 85,
    interrupt: 'none',
    blendIn: 0.04,
    blendOut: 0.06,
    sample: () => {
      const now = performance.now() / 1000
      const dt = last > 0 ? Math.min(0.1, Math.max(0.001, now - last)) : 1 / 60
      last = now

      const level = Math.max(0, Math.min(1, getLevel()))
      // 开方压低动态范围：弱音也能张嘴，强音不至于糊成一团
      const env = level <= 0.001 ? 0 : Math.pow(level, 0.65)

      const vowel = getVowel ? getVowel() : null
      // 没有 mora（间奏、无词吟唱）时给一个 a 形的嘴
      const shape = vowel === null
        ? { aa: 0.9, oh: 0.28, ee: 0.1 }
        : (VOWEL_SHAPE[vowel] ?? VOWEL_SHAPE[''])

      // 有 mora：至少半张；没 mora：完全跟着包络（间隙要闭嘴，不然像在假唱）
      const open = vowel === null ? env : Math.max(env, LIP_FLOOR)

      const expressions: Partial<Record<ExpressionName, number>> = {}
      for (const key of LIP_KEYS) {
        const target = open * (shape[key] ?? 0)
        const delta = target - cur[key]
        if (Math.abs(delta) < 1e-4) {
          cur[key] = target
        } else {
          const tau = delta > 0 ? LIP_ATTACK : LIP_RELEASE
          cur[key] += delta * (1 - Math.exp(-dt / tau))
        }
        expressions[key] = cur[key]
      }
      return { expressions }
    },
  }
}

/**
 * 跟唱反馈的表情。
 *
 * 不动鼻子眼睛的骨架，只叠一层「情绪」：跟得好就高兴，一直跟不上就有点担心。
 * 权重刻意压得低（0.55 / 0.35）——桌宠是陪着唱的，不是评委，
 * 不该在人家跑调时摆脸色。
 *
 * 和口型的关系：两者都写 face 层，但表情在 paramBus 里是取 max，
 * 而口型只碰 aa/ih/ou/ee/oh，happy/sad 互不干扰。
 */
export function createSingFeedbackClip(
  getMood: () => 'happy' | 'neutral' | 'sad',
): ActionClip {
  const cur = { happy: 0, sad: 0 }
  let last = 0
  const TAU = 0.35

  return {
    id: 'face.sing-feedback',
    layer: 'face',
    duration: Number.POSITIVE_INFINITY,
    priority: 70,
    interrupt: 'none',
    blendIn: 0.2,
    blendOut: 0.3,
    sample: () => {
      const now = performance.now() / 1000
      const dt = last > 0 ? Math.min(0.1, Math.max(0.001, now - last)) : 1 / 60
      last = now

      const mood = getMood()
      const target = {
        happy: mood === 'happy' ? 0.5 : 0,
        sad: mood === 'sad' ? 0.3 : 0,
      }
      for (const key of ['happy', 'sad'] as const) {
        const d = target[key] - cur[key]
        cur[key] += Math.abs(d) < 1e-4 ? d : d * (1 - Math.exp(-dt / TAU))
      }
      return { expressions: { happy: cur.happy, sad: cur.sad } }
    },
  }
}

/**
 * 跟唱时的头部反应。
 *
 * 小窗里表情权重只有几十个像素，`happy`/`sad` 的差别很容易被忽略；
 * 而「歪头」「抬头」这种整体姿态的变化，在 380 px 的窗口里一眼就能看见。
 * 所以情绪同时驱动表情（face 层）和这一条（additive 层）。
 */
export function createSingMoodClip(
  getMood: () => 'happy' | 'neutral' | 'sad',
): ActionClip {
  let cur = 0 // -1 = sad, +1 = happy
  let last = 0
  return {
    id: 'pose.sing-mood',
    layer: 'additive',
    duration: Number.POSITIVE_INFINITY,
    priority: 40,
    interrupt: 'none',
    owns: ['head', 'neck'],
    blendIn: 0.3,
    blendOut: 0.5,
    sample: () => {
      const now = performance.now() / 1000
      const dt = last > 0 ? Math.min(0.1, Math.max(0.001, now - last)) : 1 / 60
      last = now
      const mood = getMood()
      const target = mood === 'happy' ? 1 : mood === 'sad' ? -1 : 0
      cur += (target - cur) * (1 - Math.exp(-dt / 0.4))

      // 高兴：下巴微抬；跟不上：歪头 + 略低头
      const up = Math.max(0, cur)
      const down = Math.max(0, -cur)
      return {
        bones: {
          head: [0.05 * up - 0.04 * down, 0, 0.09 * down],
          neck: [0.02 * up - 0.02 * down, 0, 0.03 * down],
        },
      }
    },
  }
}

/**
 * 跟着节拍的轻度摇摆。
 * 幅度刻意做得很小 —— 参照 VTB 直播的实际情况，观众要的是「有反应」而不是「在跳舞」。
 */
export function createGrooveClip(getIntensity: () => number): ActionClip {
  return {
    id: 'idle.groove',
    layer: 'additive',
    duration: Number.POSITIVE_INFINITY,
    priority: 20,
    interrupt: 'none',
    blendIn: 0.8,
    blendOut: 0.8,
    sample: (_t, ctx) => {
      const k = Math.max(0, Math.min(1, getIntensity()))
      if (k <= 0.001) return {}

      const bounce = Math.sin(TAU * ctx.beat.phase)
      const slow = Math.sin(TAU * (ctx.beat.beat / 4))

      return {
        bones: {
          head: [0.035 * bounce * k, 0.018 * slow * k, 0.02 * slow * k],
          neck: [0.014 * bounce * k, 0, 0],
          chest: [0.01 * bounce * k, 0, 0],
          hips: [0, 0.014 * slow * k, 0.01 * slow * k],
        },
        hipsOffset: [0, -0.006 * bounce * k, 0],
      }
    },
  }
}

// ---------------------------------------------------------------------------

export const ACTIONS: Record<string, ActionClip> = {
  'dance.bounce': danceBounce,
  'dance.wave': danceWave,
  'dance.spin': danceSpin,
  'pose.peace': posePeace,
  'pose.sing': poseSing,
  'pose.cheer': poseCheer,
  'pose.lean': poseLean,
  'pose.turn220': poseTurn220,
  'pose.turn140ccw': poseTurn140ccw,
  'gesture.reach': gestureReach,
  'gesture.nod': gestureNod,
  'gesture.shake': gestureShake,
  'gesture.clap': gestureClap,
  'gesture.point': gesturePoint,
  'gesture.hair': gestureHair,
  'gesture.notice': gestureNotice,
  'pose.lookBack': poseLookBack,
  'pose.clasp': poseClasp,
  'pose.intro': poseIntro,
  'pose.profile': poseProfile,
  'gen.walk': walkClip,
  'face.talk': faceTalk,
}

export function getClip(id: string): ActionClip | undefined {
  return ACTIONS[id]
}
