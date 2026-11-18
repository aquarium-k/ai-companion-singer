/**
 * `.songpack` 曲包格式。
 *
 * 设计原则：把所有「理解一首歌」的重活放在离线入库阶段，
 * 运行时只负责按时间轴回放。所以这里的结构尽量扁平、可校验、可手写。
 *
 * 一个曲包是一个目录：
 *   songpacks/<id>/
 *     pack.json       元信息（本文件的 PackMeta）
 *     actions.json    编舞时间轴（ActionTrack）
 *     stems/          音频分轨（后续）
 *     chart.json      音符谱面（后续，用于演唱反馈）
 *     lyrics.json     字级歌词（后续）
 *     viseme.json     口型曲线（后续）
 */

export type PackMeta = {
  /** 格式版本，改结构时递增 */
  schema: number
  id: string
  title: string
  artist?: string
  /** 节拍，用于动作对齐和节拍器 */
  bpm?: number
  beatsPerBar?: number
  /** 总时长（秒） */
  duration: number
  /** 播完是否循环 */
  loop?: boolean
  /** 音轨相对歌曲起点的偏移（秒），有伴奏后才会用到 */
  offset?: number
  /** 编舞文件名，默认 actions.json */
  choreography?: string
  /** 资源清单，暂时都允许为 null */
  assets?: {
    instrumental?: string | null
    vocal?: string | null
    chart?: string | null
    lyrics?: string | null
    /** mora 级时间轴，逐字口型用 */
    units?: string | null
    viseme?: string | null
    /** 参考音高（work/f0.json），跟着唱判定用 */
    f0?: string | null
    /**
     * 「她的翻唱」人声（C2 烘焙成品，可选）。
     * 和 `vocal`（原唱分离轨）二选一：`Y` 键切换、`?vocal=cover` 直接进。
     */
    cover?: string | null
    /**
     * **曲包自带的和声音色**（可选，路径相对曲包目录，如 `voices/loop_258.wav`）。
     *
     * 不给就用全局那套 `public/voices/loop_*.wav`（白花那版翻唱抠出来的）。
     * 每首歌的「她的音色」其实来自**这首歌自己**的翻唱，所以曲包带上自己的
     * 采样，换歌时和声才还是同一个人、同一个录音环境。
     */
    voices?: string[] | null
    /**
     * 曲包自带的起音片段库（可选，`bank.json` 同格式，路径相对曲包目录）。
     * 不给就用全局 `public/voices/bank.json`。
     */
    attackBank?: string | null
    /**
     * 选曲面板的缩略图（可选，路径相对曲包目录，如 `thumb.jpg`）。
     * 不给就显示「首字 + 按 id 上色的方块」——导入流程不做封面，用户自己丢一张进去即可。
     */
    thumb?: string | null
  }
}

/** 在 at 秒处播放某动作 */
export type PlayCue = {
  at: number
  clip: string
  weight?: number
  action?: 'play'
}

/** 在 at 秒处停止某动作（用于关闭循环动作） */
export type StopCue = {
  at: number
  action: 'stop'
  clip: string
}

export type Cue = PlayCue | StopCue

export type Section = {
  at: number
  name: string
  /** 0..1，留给编舞强度、灯光、镜头用 */
  energy?: number
}

export type ActionTrack = {
  /** 覆盖 pack.meta.duration */
  duration?: number
  cues: Cue[]
  sections?: Section[]
}

export type SongPack = {
  meta: PackMeta
  track: ActionTrack
}

/**
 * 歌词。目前做的是**行级**时间轴。
 *
 * 逐音节（viseme）需要汉字读音，日文歌要靠强制对齐或人工注音，
 * 所以先把行级打通 —— 它同时也是后面字级对齐的骨架。
 *
 * `at` 为 null 表示这一行还没打点。
 */
/**
 * 一个 mora（日文的最小节奏单位）。
 * 「しょ」算一个 mora，不是两个字符。
 */
export type LyricUnit = {
  /** 绝对时间（秒） */
  t: number
  /** 时长（秒） */
  d: number
  /** mora 本身，如「しょ」 */
  ch?: string
  /** 元音：a / i / u / e / o，n = 拨音，空串 = 促音 */
  v?: string
}

export type LyricLine = {
  /** 该行开始时间（秒），null = 未打点 */
  at: number | null
  text: string
  /** 中文翻译，可选 */
  zh?: string
  /** 平假名读音，P3 口型用 */
  kana?: string
  /** mora 级时间轴 */
  units?: LyricUnit[]
  /**
   * 时间戳来源。缺省 = 人工或可信锚点。
   * `interp` = 自动对齐时 ASR 没锚到、只能按行序插值补的，精度不可信。
   * `user`   = 手工打点/微调过的，重跑自动对齐时会保留这个值。
   */
  src?: 'asr' | 'interp' | 'user'
}

export type Lyrics = {
  schema: number
  /** ISO 语言码：ja / zh / en */
  language?: string
  lines: LyricLine[]
}

export type PackEntry = {
  id: string
  title: string
  dir: string
  /** 选曲面板上显示用，读不到就是 undefined */
  bpm?: number
  duration?: number
  /** 缩略图（相对曲包目录的路径），没有就是 undefined */
  thumb?: string | null
}
