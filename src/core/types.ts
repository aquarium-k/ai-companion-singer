/**
 * 统一动作接口的类型层。
 *
 * 设计目标：编舞时间轴、LLM 指令、音频驱动、待机物理这四路输入，
 * 最终都收敛成同一种「姿态增量」，由 ParamBus 混合后交给任意 rig。
 */

export const BONE_NAMES = [
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
  // 手指。程序化占位角色没有这些骨骼，rig 会自动跳过；
  // 但比耶、指人这类手势只有靠它们才做得出来。
  'leftThumbMetacarpal',
  'leftThumbProximal',
  'leftThumbDistal',
  'leftIndexProximal',
  'leftIndexIntermediate',
  'leftIndexDistal',
  'leftMiddleProximal',
  'leftMiddleIntermediate',
  'leftMiddleDistal',
  'leftRingProximal',
  'leftRingIntermediate',
  'leftRingDistal',
  'leftLittleProximal',
  'leftLittleIntermediate',
  'leftLittleDistal',
  'rightThumbMetacarpal',
  'rightThumbProximal',
  'rightThumbDistal',
  'rightIndexProximal',
  'rightIndexIntermediate',
  'rightIndexDistal',
  'rightMiddleProximal',
  'rightMiddleIntermediate',
  'rightMiddleDistal',
  'rightRingProximal',
  'rightRingIntermediate',
  'rightRingDistal',
  'rightLittleProximal',
  'rightLittleIntermediate',
  'rightLittleDistal',
] as const

export type BoneName = (typeof BONE_NAMES)[number]

/** 与 VRM expression preset 对齐，VRoid 导出时默认就带这些。 */
export const EXPRESSION_NAMES = [
  'blink',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
] as const

export type ExpressionName = (typeof EXPRESSION_NAMES)[number]

export type Vec3 = [number, number, number]

/** 相对「静止姿态」的增量。bone 值是欧拉角（弧度），不是绝对朝向。 */
export type PoseDelta = {
  bones?: Partial<Record<BoneName, Vec3>>
  hipsOffset?: Vec3
  expressions?: Partial<Record<ExpressionName, number>>
}

export type BeatState = {
  bpm: number
  beatsPerBar: number
  /** 浮点拍号，4.5 表示第 4 拍后半 */
  beat: number
  bar: number
  beatInBar: number
  /** 当前拍内进度 0..1 */
  phase: number
}

export type ActionContext = {
  time: number
  dt: number
  beat: BeatState
}

/**
 * 分层规则：
 * - base / upper / face  —— 加权平均（谁权重大听谁的）
 * - additive            —— 直接叠加（呼吸、惯性、视线这类永远该存在的微动）
 */
export type PoseLayer = 'base' | 'upper' | 'face' | 'additive'

export type InterruptPolicy = 'soft' | 'hard' | 'none'

export type ActionClip = {
  id: string
  layer: PoseLayer
  /** 秒；Number.POSITIVE_INFINITY 表示循环 */
  duration: number
  priority: number
  interrupt: InterruptPolicy
  blendIn: number
  blendOut: number
  /**
   * 这个 clip「拥有」哪些骨骼（P2 骨骼所有权）。
   *
   * 没声明的骨骼照旧走加权平均；声明了就是**独占**：同一根骨骼上
   * 优先级最高的拥有者说了算，其他 clip 写它只会在拥有者淡入时参与过渡。
   *
   * 不写就等于「我不在乎谁赢」——老 clip 不改也能跑，只是继续被平均稀释。
   */
  owns?: BoneName[]
  /** 髋部位移同样会被平均，要独占就得单独声明 */
  ownsHips?: boolean
  /**
   * 「中性姿势」：这个 clip 定义的是**静息站姿本身**，不是动作。
   *
   * 唯一的用途是 `setMotionScale(0)`（按住身体只看嘴型）时**不被缩放**——
   * 否则整具身体会退回 T-pose。动作 clip 不要设它。
   */
  neutral?: boolean
  /**
   * 位移速度（米/秒），沿角色面朝的方向。
   *
   * 为什么位移不放 clip 里、而是交给引擎：画面背景是**透明**的，桌面没有地面纹理。
   * 在 3D 场景里把角色往前挪，画面里她一动不动（相机不动、背景也不动），
   * 只有影子跟着走——看不出在走路。能读成「走」的只有窗口本身在桌面上移动，
   * 而窗口移动必须是引擎（主进程）干的事。
   *
   * 所以：clip 只声明「我这条动作该以多快的速度往前挪」，主进程按这个速度
   * 每帧把窗口推一点。原地 BVH 的速度由支撑脚的后退速度反推（见
   * `tools/bvh_to_clip.mjs`）；带根位移的捕捉数据则直接来自根关节。
   */
  travel?: number
  /**
   * 循环 clip 的**一个周期**是多少秒。
   *
   * 循环 clip 的 `duration` 是 `Number.POSITIVE_INFINITY`（由引擎 stop 收尾），
   * 所以「走了几个周期」这件事只能从 sample 里自己绕的时间常数推——就是它。
   */
  cycle?: number
  /** t 为 clip 内本地时间（秒） */
  sample: (t: number, ctx: ActionContext) => PoseDelta
}

export type PlayOptions = {
  weight?: number
  fadeIn?: number
}
