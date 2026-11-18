import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { applyStaticI18n, initI18n, lang, langName, t } from './i18n'
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm'
import type { VRM } from '@pixiv/three-vrm'

import { createStage } from './scene/stage'
import { moodFromF0, describeSong, keyLabel, type SongMood } from './songpack/mood'
import { BeatClock, MasterClock, Metronome } from './core/clock'
import { ParamBus } from './core/paramBus'
import type { ResolvedPose } from './core/paramBus'
import type { HumanoidRig } from './rig/rig'
import { BONE_NAMES, type BoneName, type Vec3 } from './core/types'
import { PrimitiveRig } from './rig/primitiveRig'
import { VrmRig } from './rig/vrmRig'
import { FootLock } from './rig/footLock'
import { ArmSweep } from './rig/armSweep'
import { Locomotion, pixelsPerMeter } from './motion/locomotion'
import {
  ACTIONS,
  createBlinkClip,
  createGrooveClip,
  createLipSyncClip,
  createPoseClip,
  createSingFeedbackClip,
  createSingMoodClip,
  idleBreath,
  idlePose,
  idleSway,
} from './actions'
import { getPose, POSE_IDS } from './actions/poses'
import { createPoseEditor, type PoseEditorApi } from './ui/poseEditor'
import { createHud } from './ui/hud'
import { createSpeech } from './ui/speech'
import { createMixer, HARMONY_DEFAULT } from './ui/mixer'
import { createImporter } from './ui/importer'
import { createPicker } from './ui/picker'
import { createCamPanel, type CamPanelApi } from './ui/camPanel'
import { createSeekBar } from './ui/seekbar'
import { TrackPlayer } from './songpack/player'
import {
  absolutePath,
  initSongPackLoader,
  listSongPacks,
  loadAudioAsset,
  loadF0,
  loadLyrics,
  loadSongPack,
  validateSongPack,
} from './songpack/loader'
import { LyricsPlayer } from './songpack/lyrics'
import type { PackMeta } from './songpack/types'
import { LIP_KEYS, VisemePlayer, type Vowel } from './songpack/viseme'
import { AudioEngine, type StemName } from './audio/engine'
import { buildVocalActivity, type VocalActivity } from './audio/vocalActivity'
import { pickHumPhrase, type HumPhrase } from './audio/humming'
import { pickSung, rememberSung, sungList } from './state/sungMemory'
import { flushSettings, loadSettings, patchSettings, type CameraState } from './state/settings'
import {
  HarmonyVoice,
  HARMONY_LABEL,
  isHarmonyMode,
  type ArticulationKind,
  type VoiceAsset,
} from './audio/harmony'
import { DEFAULT_PRESET, PRESETS } from './audio/preset'
import { buildF0Track, f0At, type F0Track } from './songpack/f0'
import { buildNoteSpans, buildScoreTrack, noteAt, scoreAt, type NoteSpan } from './songpack/score'
import { fetchAssetJson } from './audio/assets'
import { startMic, type MicSession } from './audio/mic'
import { SingAlong } from './audio/singalong'
import { buildTransition } from './actions/inbetween'

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
/** 每次整页载入换一个；用来验证「切歌没有触发整页重载」 */
const PAGE_ID = Math.random().toString(36).slice(2, 8)
const basename = (p: string): string => p.split(/[\\/]/).pop() ?? p

// ---------------------------------------------------------------------------
// 基础装配
// ---------------------------------------------------------------------------

const stageEl = document.getElementById('stage') as HTMLElement
const hudEl = document.getElementById('hud') as HTMLElement
const bannerEl = document.getElementById('banner') as HTMLElement
const dropEl = document.getElementById('drop-hint') as HTMLElement
const lyricEl = document.getElementById('lyric') as HTMLElement
const mixerEl = document.getElementById('mixer') as HTMLElement
const importEl = document.getElementById('import') as HTMLElement
const packsEl = document.getElementById('packs') as HTMLElement
const camBtnEl = document.getElementById('cam-btn') as HTMLButtonElement

const bootParams = new URLSearchParams(location.search)

/**
 * 多语言：`?lang=zh-CN|ja|en-US` > 存档里的 `lang` > 系统语言（navigator.language）> 中文。
 *
 * 在构造任何 UI 之前调用：`applyStaticI18n()` 把 `data-i18n` 的静态文案填好，
 * 之后动态文案都用 `t('key')`。词典在 `src/i18n/*.json`，加语言见 `docs/i18n.md`。
 */
initI18n({
  queryLang: bootParams.get('lang'),
  savedLang: loadSettings().lang ?? null,
  system: typeof navigator !== 'undefined' ? navigator.language : null,
})
applyStaticI18n()
document.title = t('app.title')
if (bootParams.get('lang')) patchSettings({ lang: lang() })

/**
 * 这个版本能不能导入歌曲。
 *
 * 安装包**不带** `tools/`（导入要 Python 3.12 + `.pylibs` 276 MB + SVC 权重 2.5 GB），
 * 所以打包版里「按 I 导入」是一条死路：以前点了会抛 `ENOTDIR`（2026-11-18 实测）。
 * 这里先问一次主进程，把入口和空面板的文案降级成「这个版本不含导入组件」。
 * `null` = 还没问完（浏览器模式永远是 null）。
 */
let importAvailable: boolean | null = null
if (window.pet) {
  void window.pet.importStatus().then((st) => {
    importAvailable = st?.available !== false
    if (importAvailable) return
    // 选曲面板的空状态：不再教用户「按 I 导入」
    const emptyText = document.querySelector('#pack-empty [data-i18n]')
    if (emptyText) {
      emptyText.setAttribute('data-i18n', 'ui.packs.emptyNoImport')
      applyStaticI18n()
    }
  })
}

// 逐字换元音（2026-11-15）：按歌词的 mora 让和声唱 a/e，而不是永远「あ」。
// ?vowel=off 退回「只会あ」，用来 A/B 有没有变好。
const vowelSwap = bootParams.get('vowel') !== 'off'
const shotMode = bootParams.has('shot')
// 调试用：?freeze=<clipId>&t=<秒> 冻结在某个动作的某一帧，方便截图核对姿态
const freezeId = bootParams.get('freeze')
const freezeT = Number(bootParams.get('t') ?? 0)
const freeze = Boolean(freezeId && ACTIONS[freezeId])
const beatParam = bootParams.get('beat')
const freezeBeat = beatParam === null ? null : Number(beatParam)
if (shotMode) document.body.classList.add('shot-mode')

// ---------------------------------------------------------------------------
// 确认口型用的两个调试开关
// ---------------------------------------------------------------------------

/**
 * 动作幅度。`X` 键在 100% → 35% → 0 之间循环。
 * 0 只压 clip 贡献，基础姿态（手臂下垂）和视线不受影响，见 ParamBus.setMotionScale。
 */
const DEFAULT_MOTION = 1
const MOTION_STEPS = [1, 0.35, 0]
const motionParam = Number(bootParams.get('motion') ?? NaN)
let motionScale = Number.isFinite(motionParam) ? Math.max(0, Math.min(2, motionParam)) : DEFAULT_MOTION
let motionStep = Math.max(0, MOTION_STEPS.indexOf(motionScale))

/** 嘴部放大副视口：`Z` 键开关，或 `?zoom=1`。副视口高 0.10 m ≈ 主画面 4.3 倍 */
const PIP_HEIGHT = 0.1
let pipOn = bootParams.get('zoom') !== null && bootParams.get('zoom') !== '0'
const headWorld = new THREE.Vector3()
const headQuat = new THREE.Quaternion()
const pipTarget = { center: new THREE.Vector3(), height: PIP_HEIGHT }

/**
 * 嘴部中心相对头骨的世界偏移，**按头骨自己的坐标系给**。
 *
 * 用世界坐标时代的写法（直接 headY - 0.03）在头一低就偏 —— 实测同一帧
 * 偏差 3 cm 以上，副视口一会儿照到额头一会儿照到脖子。所以这里用头骨朝向变换。
 *
 * `text.vrm` 实测：嘴几乎就在头骨原点上（偏下 0.8 cm），前方 2 cm。
 * 这个模型的头骨挂在下颌高度，不是颅底——所以别按解剖学猜，按截图量。
 * 换模型要重测，`?mouth=` 可以临时覆盖 dy 用来标定。
 */
const MOUTH_DY = -0.008
const MOUTH_DZ = 0.02
/** ?mouth=<米> 覆盖 dy，标定专用 */
const MOUTH_DY_OVERRIDE = Number(bootParams.get('mouth') ?? NaN)
/** ?vowel=a|i|u|e|o|n|none&lip=0.9 钉住嘴型，用来逐个元音对比（不播放也行） */
const VOWEL_PIN = bootParams.get('vowel')
const LIP_PIN = Number(bootParams.get('lip') ?? 0.9)

/** 姿势编辑器：`?editor=1`。面板宽度要和 poseEditor 的实际宽度一致 */
const EDITOR_WIDTH = 214
const editorMode = bootParams.has('editor') && bootParams.get('editor') !== '0'
/** 编辑器实例，overUi() 要用它判断「点在面板上」，所以要提前声明 */
let poseEditor: PoseEditorApi | null = null
/** 取景水平平移（像素），frameRig 重算构图后要重新应用 */
let cameraPanPx = 0
/** `?orbit=<度>` 固定视角，截图核对前后深度用（180 = 背面） */
const orbitParam = Number(bootParams.get('orbit') ?? NaN)

const stage = createStage(stageEl)
const clock = new MasterClock()
const beat = new BeatClock(96)
const bus = new ParamBus()
bus.setMotionScale(motionScale)
/** 最近一帧合成出来的姿势（`?dbg` 的自检用，正常渲染路径只多一次赋值） */
let lastPose: ResolvedPose | null = null
const metronome = new Metronome(clock, beat)
const hud = createHud(hudEl, bannerEl, dropEl)
const speechEl = document.getElementById('speech') as HTMLElement
const speech = createSpeech(speechEl)
const mixer = createMixer(mixerEl)
// 混音条上的「跟唱」按钮 = 开关麦克风（键盘是 G；以前界面上完全找不到这个入口）
mixer.onMicClick(() => {
  void toggleMic()
})

// ---------------------------------------------------------------------------
// 机位：默认正面平视，第二个机位在角色右上方（画面上是左上角那种 3/4 视角）
// ---------------------------------------------------------------------------

type CamPreset = 'front' | 'over'

const CAM_PRESETS: Record<CamPreset, { orbit: number; elev: number; dist: number; look: number; label: string }> = {
  // orbit 为负 = 相机转到 -X 一侧，也就是角色的右手边；elev 是机位比注视点高多少米
  front: { orbit: 0, elev: 0, dist: 2.65, look: 0.78, label: '正面' },
  over: { orbit: -0.48, elev: 0.62, dist: 2.65, look: 0.78, label: '右上方' },
}

const savedSettings = loadSettings()

/**
 * 灯光：**保持恒定**（2026-11-17 按用户要求回退）。
 *
 * 之前做过「按曲子的情绪换色温 / 曝光」和「背后一团柔光」，用户的实际判断是
 * 「像是人物在变色」「感觉好奇怪」——透明窗口里没有东西接光，换灯只能改她身上的颜色。
 * 那套实现留在 `docs/backlog.md` 的 D 表（真舞台方向）里，等有背景了再说。
 */

/** 当前曲子的情绪（没有 f0 / 没载入 = null） */
let songMood: SongMood | null = null
/** 当前曲子的 BPM（她说那一句时要用；和 songMood 一起设/清） */
let songBpm = 0

/** 换歌时她说的那一句：这首什么风格、推荐怎么唱（气泡在头顶，见 ui/speech.ts） */
function saySong(): void {
  if (!songMood) {
    speech.show('这首我还没听过，先放一遍我再告诉你。', 5000)
    return
  }
  speech.show(describeSong(songMood, songBpm).line, 13000)
}

let camPreset: CamPreset =
  bootParams.get('cam') === 'over' || (!bootParams.has('cam') && savedSettings.cam === 'over')
    ? 'over'
    : 'front'

/** 面板滑杆的当前值（度 / 米），来源是 `savedSettings.camera`；没调过就跟着预设走 */
let cameraState: CameraState = savedSettings.camera
  ? { ...savedSettings.camera }
  : {
      orbit: (CAM_PRESETS[camPreset].orbit * 180) / Math.PI,
      elev: CAM_PRESETS[camPreset].elev,
      dist: CAM_PRESETS[camPreset].dist,
      look: CAM_PRESETS[camPreset].look,
    }

/** 手动调过镜头之后，预设按钮/`F` 键的循环就不再等于画面上看到的东西 */
let cameraCustom = Boolean(savedSettings.camera)

let camPanel: CamPanelApi | null = null

function applyCameraState(state: CameraState): void {
  stage.setOrbit((state.orbit * Math.PI) / 180)
  stage.setElevation(state.elev)
  stage.setFraming(state.dist, state.look)
  camPanel?.sync(state)
}

function camBtnLabel(): void {
  if (!camBtnEl) return
  const presetLabel = cameraCustom ? t('ui.cam.custom') : t(camPreset === 'over' ? 'ui.cam.over' : 'ui.cam.front')
  camBtnEl.textContent = `${t('ui.cam')} ${presetLabel}`
  camBtnEl.dataset.preset = cameraCustom ? 'custom' : camPreset
}

function applyCamPreset(): void {
  const p = CAM_PRESETS[camPreset]
  // 预设只换角度：距离/注视点沿用 frameRig 给这次取景算出来的值，
  // 否则「点一下镜头按钮把人放大 17%」（预设里的 2.65 是写死的旧数值）
  const dist = framedDist > 0 ? framedDist : p.dist
  const look = framedDist > 0 ? framedLook : p.look
  cameraState = { orbit: (p.orbit * 180) / Math.PI, elev: p.elev, dist, look }
  cameraCustom = false
  applyCameraState(cameraState)
  camBtnLabel()
}

function toggleCamPreset(): void {
  camPreset = camPreset === 'front' ? 'over' : 'front'
  applyCamPreset()
  patchSettings({ cam: camPreset, camera: undefined })
  hud.banner(`镜头：${CAM_PRESETS[camPreset].label}`, 1200)
}

/** 面板里拖滑杆：落到 stage + 存进 localStorage（`patchSettings` 自带 400 ms 防抖） */
function onCameraSlider(state: CameraState): void {
  cameraState = state
  cameraCustom = true
  applyCameraState(state)
  camBtnLabel()
  patchSettings({ camera: state })
}

camBtnEl?.addEventListener('click', (e) => {
  e.stopPropagation()
  toggleCamPreset()
})

// AudioContext 在某些环境下建不出来，此时退化为「只跑编舞不播音」
const audio = clock.audio ? new AudioEngine(clock.audio) : null
// 音量 / 混音 / 机位 / 上次的曲包都从 localStorage 里恢复（见 state/settings.ts）
let lastVolume = typeof savedSettings.volume === 'number' ? savedSettings.volume : 0.85
if (audio) audio.setVolume(lastVolume)

// 和声跟唱：接在播放用的 AudioContext 上，才能和伴奏一起被渲染、一起过音量滑杆
const harmony = audio ? new HarmonyVoice(audio.context, audio.output) : null
// 和声的亮度：`?tilt=2` 抬 3 kHz 高架 +2 dB（循环采样偏闷时试这个，做 A/B 用）
const tiltDb = Number(bootParams.get('tilt') ?? 0)
if (harmony && Number.isFinite(tiltDb) && tiltDb !== 0) harmony.setTilt(tiltDb)
// 换音滑行：`?porta=0.012` 更连、`?porta=0` 回到硬切（默认 8 ms/半音）
const portaParam = Number(bootParams.get('porta') ?? NaN)
if (harmony && Number.isFinite(portaParam)) harmony.setPortamento(portaParam)
// 双声部副本的低通：`?dblLp=2500` 更暗（默认 6000，削掉和高频的梳状打架）
const dblLpParam = Number(bootParams.get('dblLp') ?? NaN)
if (harmony && Number.isFinite(dblLpParam)) harmony.setDoublerLowpass(dblLpParam)
// 双声部延迟的抖动深度：`?dblLfo=0.0022` 回旧行为（默认 0.0004 —— 旧值会让包络
// 有 8.9 dB 的 2–5 Hz 起伏，听感是「不够干净」，见 docs/history.md 2026-11-17 夜）
const dblLfoParam = Number(bootParams.get('dblLfo') ?? NaN)
if (harmony && Number.isFinite(dblLfoParam)) harmony.setDoublerLfo(dblLfoParam)
// 家族混合宽度：`?sigma=1.2` 回旧的宽度（2026-11-17 夜从 1.2 收到 0.6，
// 因为库里每档都是 SVC 直出，混两族 = 同一个人的两份共振峰不同的副本）
const sigmaParam = Number(bootParams.get('sigma') ?? NaN)
if (harmony && Number.isFinite(sigmaParam)) harmony.setLoopSigma(sigmaParam)
// 气声层：`?breath=0` 关掉做 A/B（默认 0.05）
const breathParam = Number(bootParams.get('breath') ?? NaN)
if (harmony && Number.isFinite(breathParam)) harmony.setBreath(breathParam)
// 音色来自 C2「原唱 → seed-vc 换音色」那一版的成品（几段可循环的持续元音）。
// 载入失败会自动退回振荡器合成，不会没声。
//
// **为什么是六段**（2026-11-14）：旧库只有 220/419 两段，隔 12 个半音，
// 目标音高落在两段中间时两段各被拉开 6 个半音——共振峰错位近一倍、颤音率差一倍，
// 同一个音高听起来是**两个人在唱**（用户反复报的「两种声音」）。
//
// 选段要同时满足四条（`tools/make_harmony_voice.py`）：
//   1. 音高稳（YIN 逐帧跨度 ≤40 音分）
//   2. 音量平（30 ms RMS 在 ±3 dB 内——旧低音段是一段渐弱尾音，比别段低 11 dB）
//   3. **元音不滑**（三个时间片的频带比变化 ≤3 dB；跨过滑音的段直接不要）
//   4. 响度归一到 −16 dBFS + 谱线对齐到 `voices/timbre-target.json`
//
// 现在的六段来自用户 2026-11-15 新录的 `A3toD4.m4a`（11 s，四个稳定平台
// 258/324/384/571 Hz，经 SVC 换成她的音色）加白花原曲里的 419/516。
// 之前那批 267/315/386/474 里的 386/474 在循环内换元音（频带比差 8–10 dB），已弃用。
// 路径必须是相对路径：Electron 用 `loadFile(dist/index.html)` 打开页面，
// 绝对路径 `/voices/x.wav` 在 file:// 下会解析成 `file:///C:/voices/x.wav`（404），
// 结果是打包/run.bat 启动时和声一路退回振荡器（用户 2026-11-13：「runbat 和声没更新」）。
const GLOBAL_LOOPS: VoiceAsset[] = [
  'voices/loop_258.wav',
  'voices/loop_324.wav',
  'voices/loop_384.wav',
  'voices/loop_419.wav',
  'voices/loop_516.wav',
  'voices/loop_575.wav',
]

/**
 * 循环库清单（`public/voices/loops.json`，`tools/build_loop_library.py` 生成）。
 *
 * 为什么要清单：2026-11-15 起库里不止六段——为了压住「变调把共振峰也拉走」，
 * 用 TD-PSOLA 把音域补成 210–850 Hz 共 24 段（`tools/make_pitch_variants.py`，
 * 保共振峰的变调）。硬编码那个列表就成了两份真相。
 *
 * `?loops=legacy` 强制回老六段，用来 A/B「花栗鼠」到底治好了没有。
 */
async function loadLoopSet(): Promise<VoiceAsset[]> {
  if (bootParams.get('loops') === 'legacy') {
    console.info('[harmony] 循环库：老六段（?loops=legacy）')
    return GLOBAL_LOOPS
  }
  try {
    const doc = await fetchAssetJson<{ loops?: { url?: string; rootHz?: number }[] }>(
      'voices/loops.json',
    )
    const list = (doc.loops ?? []).map((l) => l.url).filter((u): u is string => Boolean(u))
    if (list.length >= GLOBAL_LOOPS.length) return list
    console.warn(`[harmony] loops.json 只有 ${list.length} 段，退回老六段`)
  } catch (err) {
    console.warn('[harmony] 读不到 voices/loops.json，退回老六段', err)
  }
  return GLOBAL_LOOPS
}
// 起音素材（片段库）。v2 是**替换式**：mora 开头循环让位，片段独占那几十毫秒。
//
// 2026-11-13 深夜：改成**样本库**——用户录了一条 あ/ら/は 的音阶（C→C），
// 用 seed-vc 换成她的音色（`tools/bake_cover.py --ref shots/svc/refvoice3.wav`），
// 再按每个音高切成独立片段（`public/voices/bank.json`）。
// 这样每个音高都有自己的样本，变调 ≤1 个半音——低音区不再靠 536 Hz 硬拉。
// 读不到 bank.json 时退回原来那几段手工样本。
const GLOBAL_ATTACK_FALLBACK: VoiceAsset[] = [
  'voices/att_ra_hi.wav',
  'voices/att_ha_288.wav',
  'voices/att_ha_335.wav',
  'voices/att_ha_558.wav',
]

/**
 * 一套和声音色 = 几段循环 + 一份起音片段库。
 *
 * 为什么要按曲包换（2026-11-15，待做清单 6b）：采样是从**某一首歌的翻唱**里
 * 抠出来的，全局共用意味着换歌后和声还是白花那次的录音环境（混响、齿音、
 * 那个人当时的音色）。曲包自带 `assets.voices` 后，每个曲包用的是它自己的
 * 翻唱——同一首歌里三个声部听起来才是同一个人。
 */
type VoiceSet = {
  label: string
  loops: VoiceAsset[]
  /** 起音片段库；缺省 = 全局那套 */
  attacks?: () => Promise<VoiceAsset[]>
  /** 来自曲包（载入全失败要回退全局） */
  fromPack: boolean
}

/** 曲包内的资源 → 走曲包加载器（生产环境读 `public/songpacks`，不是 `dist`） */
function packAsset(packId: string, rel: string): VoiceAsset {
  const clean = rel.replace(/^\/+/, '')
  return {
    key: `songpacks/${packId}/${clean}`,
    open: () => loadAudioAsset(packId, clean),
    openJson: async () => {
      const bytes = await loadAudioAsset(packId, clean.replace(/\.wav$/i, '.json'))
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown
    },
  }
}

/** 读一份 `bank.json`，把里面的相对路径映射成当前曲包（或全局）的素材 */
async function readBank(
  bank: VoiceAsset,
  map: (rel: string) => VoiceAsset,
): Promise<VoiceAsset[]> {
  const doc = (await resolveBankJson(bank)) as { samples?: { url?: string }[] } | null
  const list = doc?.samples?.map((s) => s.url).filter((u): u is string => Boolean(u)) ?? []
  if (list.length === 0) throw new Error('bank.json 里没有样本')
  return list.map(map)
}

/** 字符串来源交给 fetchAssetJson（全局 `/voices/bank.json`），描述符走它自己的 openJson */
function resolveBankJson(bank: VoiceAsset): Promise<unknown> {
  if (typeof bank === 'string') return fetchAssetJson<unknown>(bank)
  return bank.openJson ? bank.openJson() : fetchAssetJson<unknown>(bank.key)
}

const GLOBAL_VOICE: VoiceSet = {
  label: '全局',
  loops: GLOBAL_LOOPS,
  attacks: () => readBank('voices/bank.json', (rel) => rel),
  fromPack: false,
}

/** 曲包没声明 `assets.voices` 就用全局那套；`?voice=global` 可以强制回全局做 A/B */
function voiceSetForPack(packId: string, assets: PackMeta['assets']): VoiceSet {
  const voices = (assets?.voices ?? []).filter((v): v is string => Boolean(v))
  if (voices.length === 0 || bootParams.get('voice') === 'global') return GLOBAL_VOICE
  const bank = assets?.attackBank
  return {
    label: `曲包 ${packId}`,
    loops: voices.map((v) => packAsset(packId, v)),
    attacks: bank
      ? () => readBank(packAsset(packId, bank), (rel) => packAsset(packId, rel))
      : GLOBAL_VOICE.attacks,
    fromPack: true,
  }
}

let voiceLabel = '全局'
let voiceLoopCount = 0
/** 已经装上的那套（label + 采样列表）。相同的就不用重载 */
let appliedVoiceKey = ''

function voiceKeyOf(set: VoiceSet): string {
  return `${set.label}|${set.loops.map((a) => (typeof a === 'string' ? a : a.key)).join(',')}`
}

async function applyVoiceSet(set: VoiceSet): Promise<void> {
  if (!harmony) return
  // 曲包没声明 voices 时 `voiceSetForPack` 返回的就是全局那套：启动时已经装过，
  // 这里再清空+重载一遍等于白解码 6 段循环和 42 段起音（每次开曲包都发生）
  const key = voiceKeyOf(set)
  if (key === appliedVoiceKey) return
  // 先清空：新旧两套同时挂在 env 上就会变成「一个音高两个声音」
  harmony.clearSamples()
  harmony.clearAttacks()
  const loops = await harmony.loadSamples(set.loops)
  if (loops === 0) {
    if (set.fromPack) {
      console.warn('[harmony] 曲包自带的音色全部载入失败，回退全局那套')
      await applyVoiceSet(GLOBAL_VOICE)
    }
    return
  }
  appliedVoiceKey = key
  voiceLabel = set.label
  voiceLoopCount = loops
  let attacks: VoiceAsset[] = []
  try {
    attacks = (await set.attacks?.()) ?? []
  } catch (err) {
    console.warn('[harmony] 起音片段库读不到，退回旧的几段手工样本', err)
    attacks = GLOBAL_ATTACK_FALLBACK
  }
  await Promise.all(attacks.map((a) => harmony?.loadAttack(a)))
  console.info(`[harmony] 音色：${set.label}，${loops} 段循环 + ${attacks.length} 段起音`)
}

/** 串行换音色：并发调用会往同一个 samples 数组里塞两套 */
let voiceChain: Promise<void> = Promise.resolve()
function setHarmonyVoice(set: VoiceSet): Promise<void> {
  voiceChain = voiceChain.then(() => applyVoiceSet(set)).catch((err) => {
    console.warn('[harmony] 换音色失败', err)
  })
  return voiceChain
}

// 启动先用全局那套；曲包载入完再覆盖成它自己的（见 bootSongPacks）。
// 循环库清单是异步读的，所以先等它，免得先装六段、再拆掉换 24 段。
void (async () => {
  GLOBAL_VOICE.loops = await loadLoopSet()
  console.info(`[harmony] 循环库 ${GLOBAL_VOICE.loops.length} 段`)
  await setHarmonyVoice(GLOBAL_VOICE)
})()

/**
 * 咬字方式。
 *
 * - `auto`：按歌词假名走——ら行播辅音片段（替换式），其它 mora 只做软起伏。
 * - `vowel`：全部按「あ」处理（软起伏 + 上滑）。用户 2026-11-13：「凸陷不用那么深」。
 * - `ra`：全部都咬辅音（拿来判断「ら 到底能不能听出来」，不按歌词）。
 * - `off`：只跟音高。
 */
type AttMode = 'auto' | 'vowel' | 'ra' | 'ha' | 'off'
const ATT_LABEL: Record<AttMode, string> = {
  auto: '自动',
  vowel: 'あ',
  ra: 'ら',
  ha: 'は',
  off: '关',
}
const ATT_CYCLE: AttMode[] = ['auto', 'vowel', 'ra', 'ha', 'off']

function parseAttMode(value: string | undefined | null): AttMode | null {
  if (value === 'off') return 'off'
  if (value === 'a' || value === 'vowel') return 'vowel'
  if (value === 'ra' || value === 'consonant') return 'ra'
  if (value === 'ha' || value === 'aspirate') return 'ha'
  if (value === 'auto' || value === 'splice') return 'auto'
  return null
}

const attBoot = parseAttMode(bootParams.get('att')) ?? parseAttMode(savedSettings.att) ?? 'auto'
let attMode: AttMode = attBoot

function setAttMode(mode: AttMode, persist = true): void {
  attMode = mode
  harmony?.setAttackEnabled(mode !== 'off')
  mixer.setAttLabel(ATT_LABEL[mode])
  if (persist) patchSettings({ att: mode })
}

setAttMode(attBoot, false)
mixer.onAttClick(() => {
  const next = ATT_CYCLE[(ATT_CYCLE.indexOf(attMode) + 1) % ATT_CYCLE.length]
  setAttMode(next)
  hud.banner(
    next === 'off' ? '咬字：关（只跟音高）' : `咬字：${ATT_LABEL[next]}`,
    1500,
  )
})
// `?harmony=thirdDown|fifth|octave` 可以直接进不常用的音程——
// 按 A 的循环里只剩「关 ↔ 三度」（试听结论：五度会把人也带偏，八度太高，低三度怪）。
/** 两个音符之间隔多久算新乐句（秒）。预设会改它（`?preset=`） */
let phraseGap = 0.35
/** 当前和声预设名（混音条「音色」按钮循环用） */
let currentPreset = DEFAULT_PRESET
{
  const want = bootParams.get('harmony')
  // 没指定就恢复上次的模式（但「关」不恢复：那是用户临时按的，重开时还是按上次听的样子来）
  const restore = savedSettings.harmonyMode
  if (want && isHarmonyMode(want)) harmony?.setMode(want)
  else if (restore && isHarmonyMode(restore) && restore !== 'off') harmony?.setMode(restore)
  /**
   * **预设**：一整套听感参数，可以从 URL 或混音条那个「音色」按钮切换。
   *
   * `?preset=default` 回到上一版默认；混音条上的按钮循环所有预设，并记进 localStorage，
   * 下次启动沿用（用户 2026-11-15 调的这套是默认值）。
   * 下面的单参数 URL（`?vib=` `?verb=` …）在预设之后应用，所以仍能单独覆盖。
   */
  /**
   * 音色预设的显示名。前两个是用户自己调定并认可的版本，名字保留「用户版」的语义；
   * 多语言下用 i18n 的对应词（`ui.preset.*`），后面的序号保留（1/2 是版本顺序，不翻译）。
   */
  function presetLabelOf(name: string): string {
    if (name === 'user-2026-11-17') return `${t('ui.preset.user')} 2`
    if (name === 'user-2026-11-15') return `${t('ui.preset.user')} 1`
    if (name === 'default') return t('ui.preset.plain')
    return name
  }
  const presetCycle = Object.keys(PRESETS)
  function applyPreset(name: string, persist = true): void {
    const p = PRESETS[name] ?? PRESETS[DEFAULT_PRESET]
    if (harmony) {
      harmony.setVibratoHz(p.vibHz)
      harmony.setVibrato(p.vibCents, p.vibDelay)
      harmony.setGlide(p.glideCents, p.glideMs / 1000, p.glideMin)
      harmony.setVowelDip(p.vowelDip)
      harmony.setLoopSigma(p.sigma)
      harmony.setReverb(p.verb)
      harmony.setDrive(p.drive)
      harmony.setComp(p.comp)
      harmony.setDoubler(p.dbl)
      harmony.setAttackGain(p.attGain)
    }
    phraseGap = p.phraseGap
    currentPreset = name
    mixer.setPresetLabel(presetLabelOf(name))
    if (persist) patchSettings({ harmonyPreset: name })
    console.info(`[harmony] 预设 ${name}`)
  }

  // 存档里如果还记着「用户版 1」（混响 0.43），自动迁到「用户版 2」（混响 0.22）：
  // 2026-11-17 用户明确说 `?verb=0.2` 更好听，否则他们会一直听到旧的那套。
  // 想回旧的那套：`?preset=user-2026-11-15`（或混音条按钮循环）。
  const savedPreset =
    savedSettings.harmonyPreset === 'user-2026-11-15'
      ? 'user-2026-11-17'
      : savedSettings.harmonyPreset
  const bootPreset = bootParams.get('preset') ?? savedPreset ?? DEFAULT_PRESET
  applyPreset(bootPreset, false)
  mixer.onPresetClick(() => {
    const next = presetCycle[(presetCycle.indexOf(currentPreset) + 1) % presetCycle.length]
    applyPreset(next)
    hud.banner(`${t('ui.timbre')}: ${presetLabelOf(next)}`, 1500)
  })

  // 循环音色 A/B：`?loop=low` 只播 220 Hz 那段、`?loop=high` 只播 419 Hz 那段。
  // 默认是两段加权混合（她的音色靠这个混合才厚）。
  const loopMode = bootParams.get('loop')
  if (loopMode === 'low' || loopMode === 'high' || loopMode === 'mix') {
    harmony?.setLoopMode(loopMode)
  }
  // 颤音 A/B：`?vib=0` 关掉、`?vibdelay=0` 让每个音从头就抖（用来对比「像不像电子琴」）
  const vib = Number(bootParams.get('vib') ?? NaN)
  const vibDelay = Number(bootParams.get('vibdelay') ?? NaN)
  if (Number.isFinite(vib) || Number.isFinite(vibDelay)) {
    const base = PRESETS[currentPreset] ?? PRESETS[DEFAULT_PRESET]
    harmony?.setVibrato(Number.isFinite(vib) ? vib : base.vibCents,
                        Number.isFinite(vibDelay) ? vibDelay : base.vibDelay)
  }
  const vibHz = Number(bootParams.get('vibhz') ?? NaN)
  if (Number.isFinite(vibHz)) harmony?.setVibratoHz(vibHz)
  const sigma = Number(bootParams.get('sigma') ?? NaN)
  if (Number.isFinite(sigma)) harmony?.setLoopSigma(sigma)
  // 咬字凹陷深度 A/B：`?duck=1` 片段纯叠加（听不出字）、`?duck=0` 片段完全替掉循环
  const duck = Number(bootParams.get('duck') ?? NaN)
  if (Number.isFinite(duck)) harmony?.setDuck(duck)
  // 元音凹陷 A/B：默认**不凹**（2026-11-14「あ本来该是一个平滑的音」）。
  // `?dip=0.3` 把旧版的软凹槽放回来；`?dip=0.62` 是更浅的一版。
  const dip = Number(bootParams.get('dip') ?? NaN)
  if (Number.isFinite(dip)) harmony?.setVowelDip(dip)
  // 后期链：`?fx=off` 整条旁路；`?verb=0.2` `?drive=0.2` `?comp=4` 单独调
  if (bootParams.get('fx') === 'off') harmony?.setFx(false)
  const verb = Number(bootParams.get('verb') ?? NaN)
  if (Number.isFinite(verb)) harmony?.setReverb(verb)
  const drive = Number(bootParams.get('drive') ?? NaN)
  if (Number.isFinite(drive)) harmony?.setDrive(drive)
  const comp = Number(bootParams.get('comp') ?? NaN)
  if (Number.isFinite(comp)) harmony?.setComp(comp)
  // 双声部（doubler）：`?dbl=0` 关，`?dbl=0.6` 更厚
  const dbl = Number(bootParams.get('dbl') ?? NaN)
  if (Number.isFinite(dbl)) harmony?.setDoubler(dbl)
  // 混响尾巴长度：`?rt=1.2`
  const rt = Number(bootParams.get('rt') ?? NaN)
  if (Number.isFinite(rt)) harmony?.setReverbTime(rt)
  // 起音片段电平：`?attg=0.5` 更轻、`?attg=1` 和循环一样响（默认 0.7）
  const attg = Number(bootParams.get('attg') ?? NaN)
  if (Number.isFinite(attg)) harmony?.setAttackGain(attg)
}

// 拖滑杆 → 直接改那条轨的 GainNode。人声 0 = 伴唱，和声 0 = 只要伴奏和人声。
mixer.onChange((channel, value) => {
  const mix = { ...(loadSettings().mix ?? { vocal: 1, instrumental: 1, harmony: HARMONY_DEFAULT }) }
  mix[channel] = value
  patchSettings({ mix })
  if (channel === 'harmony') {
    harmony?.setLevel(value)
    // 把和声拉起来说明想听：模式还是「关」的话顺手打开，不然拖了没反应。
    if (value > 0.01 && harmony && harmony.currentMode === 'off') {
      harmony.setMode('third')
      patchSettings({ harmonyMode: 'third' })
      hud.banner(`和声：${HARMONY_LABEL.third}（${harmony.key}）`, 1600)
    }
    return
  }
  audio?.setStemVolume(channel, value)
})
// 滑杆初值：上次调过的位置，没调过就用默认（引擎里和声是 0.28，这里默认 16%）
const savedMix = savedSettings.mix
mixer.setValue('harmony', savedMix?.harmony ?? HARMONY_DEFAULT)
mixer.setValue('vocal', savedMix?.vocal ?? 1)
mixer.setValue('instrumental', savedMix?.instrumental ?? 1)
if (savedMix) {
  harmony?.setLevel(savedMix.harmony ?? HARMONY_DEFAULT)
  audio?.setStemVolume('vocal', savedMix.vocal ?? 1)
  audio?.setStemVolume('instrumental', savedMix.instrumental ?? 1)
}
mixer.setAvailable('harmony', harmony !== null)

// 导入完成 / 选曲之后整页重开，用 ?pack=<id> 载入新曲包。
// 曲包加载是一次性的（模块级状态），热切换要重构加载器，现在不值得。
function reloadWithPack(packId: string): void {
  patchSettings({ packId })
  // 马上要整页重开，攒着的写入等不到 400 ms 的防抖，先落盘
  flushSettings()
  const url = new URL(location.href)
  url.searchParams.set('pack', packId)
  url.searchParams.delete('at')
  url.searchParams.delete('autoplay')
  location.href = url.toString()
}

/**
 * 重开页面，但不指定曲包：删掉「当前正在听的那首」之后走这里。
 * 必须把 `pack` 参数删掉，否则 URL 里还留着刚被删掉的那个 id。
 */
function reloadWithoutPack(): void {
  patchSettings({ packId: '' })
  flushSettings()
  const url = new URL(location.href)
  url.searchParams.delete('pack')
  url.searchParams.delete('at')
  url.searchParams.delete('autoplay')
  location.href = url.toString()
}

/**
 * 删除曲包。目录和 `index.json` 都在主进程处理（`packs:delete`）。
 *
 * 删的正好是当前这首时，重开页面挑剩下第一个；一首都不剩就进空状态
 * （`bootSongPacks()` 见到空索引会直接 return，角色照常站着，只是没歌）。
 */
async function deletePackById(id: string): Promise<boolean> {
  const result = await window.pet?.deletePack(id)
  if (!result?.ok) {
    hud.banner(result?.error ?? '删除失败', 3200)
    return false
  }
  hud.banner('已删除曲包', 1600)
  if (id === currentPackId) {
    reloadWithoutPack()
    return true
  }
  const entries = await listSongPacks()
  picker.refresh(entries, currentPackId)
  return true
}

/**
 * 改曲包名字。目录名就是曲包 id，所以主进程会**连带改目录**，
 * 回来后按返回的新 id 重开页面（当前正在听的那首必须重开：它的路径全变了）。
 */
async function renamePackById(id: string, title: string): Promise<boolean> {
  const api = window.pet
  if (!api?.renamePack) {
    hud.banner('只有桌面版能改曲包名字（浏览器里没有文件权限）', 3000)
    return false
  }
  const result = await api.renamePack(id, title)
  if (!result?.ok || !result.id) {
    hud.banner(result?.error ?? '改名失败', 3200)
    return false
  }
  hud.banner(`已改名为「${result.title ?? title}」`, 1800)
  if (id === currentPackId || result.id === currentPackId) {
    reloadWithPack(result.id)
    return true
  }
  const entries = await listSongPacks()
  picker.refresh(entries, currentPackId)
  return true
}

const importer = createImporter(importEl, {
  banner: (text, ms) => hud.banner(text, ms),
  onComplete: reloadWithPack,
})

/**
 * 窗口重开时接回上次没跑完的导入。
 *
 * 主进程里 `import:start` 会把 {packId, audioPath} 写进 config.json（`lastJob`），
 * 进度本身在曲包目录的 job.json 里——所以渲染层这边只要「问一句、把面板打开、
 * 重新开始轮询」就够了，不需要主进程保持什么内存状态。
 */
if (window.pet) {
  void (async () => {
    try {
      const cfg = await window.pet?.getConfig()
      const last = cfg?.lastJob
      if (!last?.packId) return
      if (await importer.resume(last.packId)) {
        hud.banner('接上上次没跑完的导入', 2600)
      }
    } catch (err) {
      console.warn('[import] 接回上次任务失败', err)
    }
  })()
}

const picker = createPicker(packsEl, {
  onPick: (id: string) => void switchPack(id),
  onDelete: deletePackById,
  onRename: renamePackById,
  /**
   * 缩略图：走曲包加载器取字节再做 blob URL。
   * `file://` 下 `<img src="songpacks/…">` 只认识打包那一刻就在 `dist` 里的文件，
   * 运行时新导入的曲包会 404——所以这里和音频走同一条路。
   */
  loadThumb: async (entry) => {
    if (!entry.thumb) return null
    try {
      const bytes = await loadAudioAsset(entry.id, entry.thumb)
      return URL.createObjectURL(new Blob([bytes]))
    } catch {
      return null
    }
  },
})

/**
 * 镜头微调面板。菜单只做入口，滑杆才是连续量（原生菜单改不了「环绕 37°」这种值）。
 * 入口：右键菜单「镜头 → 调整…」；也认 `?campanel=1`，方便截图核对。
 */
camPanel = createCamPanel(document.getElementById('cam')!, {
  onChange: onCameraSlider,
  onPreset: (which) => {
    camPreset = which
    applyCamPreset()
    patchSettings({ cam: which, camera: undefined })
    hud.banner(`镜头：${CAM_PRESETS[which].label}`, 1200)
  },
})

/** 曲目进度条：松手才 seek（见 ui/seekbar.ts 里的说明） */const seekbar = createSeekBar(document.getElementById('seek')!, {
  onSeek: (seconds) => {
    const now = clock.now()
    track.seek(now, seconds)
    if (track.isPlaying) audio?.play(seconds)
    // 跳转后立刻把时间刷上去，别等下一帧
    seekbar.setTime(track.time(now))
  },
})

/** 当前载入的曲包 id，选曲面板用来标「当前」 */
let currentPackId = ''

async function openPicker(): Promise<void> {
  const entries = await listSongPacks()
  picker.toggle(entries, currentPackId)
}

// 这两条是「音频驱动」通道：
// lipLevel 来自 AnalyserNode 的音量包络，grooveLevel 是跟拍摇摆的强度。
// 都用可变引用而不是改 clip 内部状态，方便在 tick 里每帧更新。
let lipLevel = 0
let grooveLevel = 0
// mora 级元音：来自 lyrics.units.json，决定嘴型而不是张合
let lipVowel: Vowel | null = null
/** 和声上一次「咬字」对应的 mora 序号（换了才咬） */
let lastHarmonyMora = -1
/** 咬字计数：は 发了多少 / 因为上行被抑制了多少（验证规则用） */
let aspirateCount = 0
let aspirateSkipped = 0
/** 音符太短（<70 ms）而跳过咬字的次数（2026-11-14 引入音长判定） */
let skippedShort = 0
/**
 * 乐句内部不再重新发音的次数。
 *
 * 用户 2026-11-14：「あ这边其实不超出整个乐句的话是不必重新发音的（正常唱歌时就是如此）」。
 * 以前是「换一个音就咬一次」，白花 341 ms 的音上等于每秒 3 次重新起音。
 */
let skippedInPhrase = 0
/** 上一个音符的结束时间：和它的间隔决定「这是不是新乐句」 */
let prevNoteEnd = 0
/** mora 数据载入的条数：HUD 靠它区分「这首没数据」和「当前落在空隙里」 */
let visemeCount = 0

// 跟着唱：麦克风 + 参考音高 + 判定
// ?tol=150 可以把「算跟上」的容差放宽（默认 100 音分）
const tolParam = Number(bootParams.get('tol') ?? NaN)
const singAlong = new SingAlong(Number.isFinite(tolParam) ? tolParam : undefined)
// ?singtest=1：不用麦克风，直接把原唱人声按实时喂进判定链。
// 用来区分「判定链有 bug」和「麦克风/AEC 那边的问题」——前者在自测里也会低。
const singTest = bootParams.has('singtest')
let singTestBuf: Float32Array | null = null
let singTestCursor = 0
let micSession: MicSession | null = null
let micBusy = false
let f0Track: F0Track | null = null
/** 按 mora 量化的「谱面」：和声跟它，而不是跟逐帧 f0（见 songpack/score.ts） */
let scoreTrack: F0Track | null = null
/** 谱面 → 音符表（同音高的连续格子合并）。咬字的凹陷/替换长度要按**音符时长**定。 */
let noteSpans: NoteSpan[] = []
/**
 * 人声活动包络（从 `stems/vocals.mp3` 现算）：和声「该不该响」的依据。
 * 只看谱面会在换气/间奏处继续唱——分离残留会让 f0 在没人唱的地方冒出音高。
 */
let vocalActivity: VocalActivity | null = null
/** 门控的提前量：看未来 150 ms 的活动，主唱要停就先收，不要滞后 */
const ACTIVITY_LEAD = 0.15
/** `?gate=0` 关掉人声门控（退回只看谱面），用来 A/B */
const GATE_ON = bootParams.get('gate') !== '0'

/**
 * 待机哼歌（「记住你们唱过的歌」的落地版）。
 *
 * 记忆只有元信息（`src/state/sungMemory.ts`，localStorage，几十字节），音频一个字节
 * 都不存——要哼的时候从那个曲包的 `work/f0.json` 现取一段旋律，用和声那套
 * 循环采样唱出来（`setHumming(true)` 让它唱同音而不是三度）。
 *
 * 触发条件：没在放歌、没在听麦克风、**至少 40 秒没碰过窗口**、没有面板开着、
 * 而且离上次哼歌超过 2~4 分钟。
 *
 * 「没碰过窗口」这一条 2026-11-15 才真的加上（之前注释里写了、代码里没有）：
 * 原来只要没在放歌、时间到了就哼，于是在摆姿势、点混音条、切曲包的时候冷不丁开始哼。
 */
const HUM_LEVEL = 0.11
const HUM_PHRASE_SEC = 4
/** 判定「你真的闲着了」的阈值（秒）：最后一次鼠标/键盘之后要安静这么久 */
const HUM_IDLE_SEC = 40
/** 最后一次用户操作的时刻（`clock.now()` 的秒）。pointermove 也算——你在看就是没闲 */
let lastUserAt = 0
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown'] as const) {
  window.addEventListener(ev, () => {
    lastUserAt = clock.now()
  }, { passive: true })
}
/** 有面板开着的时候不该有「待机行为」：她在你摆姿势的时候哼歌会打断思路 */
function uiBusy(): boolean {
  return picker.isVisible() || importer.isVisible() || Boolean(poseEditor?.isVisible())
}
type HumState = {
  phrase: HumPhrase
  title: string
  startAt: number
  dur: number
  prevLevel: number
  attWasOn: boolean
}
let hum: HumState | null = null
let humLoading = false
let humNextAt = 0
let wasSongPlaying = false
let songPlayStart = 0
const humTrackCache = new Map<string, F0Track>()

function stopHum(now: number): void {
  if (!hum) return
  harmony?.setHumming(false)
  harmony?.setLevel(hum.prevLevel)
  harmony?.setAttackEnabled(hum.attWasOn)
  harmony?.update(0)
  hum = null
  humNextAt = now + 120 + Math.random() * 120
}

async function startHum(now: number): Promise<void> {
  if (hum || humLoading || !harmony) return
  const entry = pickSung()
  if (!entry) {
    humNextAt = now + 60
    return
  }
  humLoading = true
  try {
    let source = entry.id === currentPackId ? f0Track : (humTrackCache.get(entry.id) ?? null)
    if (!source) {
      // 走曲包加载器（fs 通道），不用 fetch：Electron 用 file:// 打开页面时
      // fetch 读不到本地文件（和声采样踩过同一个坑），表现就是「一直没哼成」，
      // 而且不会报错——只在 console 里留一句 warn。
      source = buildF0Track(await loadF0(entry.id, 'work/f0.json'))
      humTrackCache.set(entry.id, source)
    }
    const phrase = pickHumPhrase(source, HUM_PHRASE_SEC)
    if (!phrase) {
      humNextAt = now + 120
      return
    }
    const st = harmony.status()
    harmony.setHumming(true)
    harmony.setAttackEnabled(false)
    harmony.setLevel(HUM_LEVEL)
    hum = {
      phrase,
      title: entry.title,
      startAt: now,
      dur: phrase.dur,
      prevLevel: st.level,
      attWasOn: st.attackOn,
    }
    hud.banner(`哼一段《${entry.title}》`, 2400)
    console.info(`[hum] 哼「${entry.title}」${phrase.from}s 起 ${phrase.dur.toFixed(1)}s`)
  } catch (err) {
    console.warn('[hum] 这次没哼成', err)
    humNextAt = now + 60
  } finally {
    humLoading = false
  }
}

/**
 * 自测：不用麦克风，把原唱人声按实时喂进同一条判定链。
 * 原唱就是「完美的跟唱者」，所以正常情况下命中率应该接近 100%；
 * 如果自测也低，说明问题在判定链，不在麦克风/AEC。
 */
async function toggleSingTest(): Promise<void> {
  if (singTestBuf) {
    singTestBuf = null
    singTestCursor = 0
    singAlong.reset()
    hud.banner('自测：关', 1600)
    return
  }
  if (!f0Track) {
    hud.banner('这个曲包没有参考音高', 2200)
    return
  }
  if (!currentVocalAsset) {
    hud.banner('这个曲包没有人声轨，没法自测', 2200)
    return
  }
  try {
    const data = await loadAudioAsset(currentPackId, currentVocalAsset)
    const offline = new OfflineAudioContext(1, 1, 16000)
    const decoded = await offline.decodeAudioData(data)
    singTestBuf = new Float32Array(decoded.getChannelData(0))
    singTestCursor = 0
    singAlong.reset()
    enterListening()
    hud.banner(`自测：把原唱当成你跟唱（${(singTestBuf.length / 16000).toFixed(0)}s）`, 2600)
  } catch (err) {
    console.warn('[sing] 自测素材解码失败', err)
    hud.banner(`自测素材解码失败：${(err as Error).message}`, 4000)
  }
}

/**
 * 「听你唱」模式：开麦（或自测）时把编舞停掉、嘴也停下来。
 *
 * 不然角色一边跳大动作一边对口型，用户根本看不出它在对你笑还是皱眉——
 * 跟唱这个功能的价值是「有反应」，不是「同时表演两件事」。
 */
function isListening(): boolean {
  return micSession !== null || singTestBuf !== null
}

function enterListening(): void {
  for (const id of bus.activeIds()) {
    if (ACTIONS[id]) bus.stop(id)
  }
  singMood = 'neutral'
  singMoodHold = 0
}

/**
 * 开/关麦克风。第一次会弹系统权限（主进程已放行 media）。
 * 失败一律走 banner，不抛到主循环里。
 */
async function toggleMic(): Promise<void> {
  if (micBusy) return
  if (micSession) {
    micSession.stop()
    micSession = null
    singAlong.reset()
    mixer.setMicLabel(t('ui.mic.off'))
    hud.banner('跟唱：麦克风已关', 1600)
    return
  }
  if (!f0Track) {
    hud.banner('这个曲包没有参考音高（work/f0.json）', 2400)
    return
  }
  micBusy = true
  mixer.setMicLabel('…')
  try {
    micSession = await startMic((block) => singAlong.push(block))
    mixer.setMicLabel(t('ui.mic.on'))
    if (micSession.sampleRate !== 16000) {
      // 采样率不对的话，YIN 的帧参数全错，判定会整体失效——必须让用户看见
      hud.banner(`麦克风采样率是 ${micSession.sampleRate}Hz（应为 16000），判定会不准`, 6000)
      console.warn(`[sing] 麦克风采样率 ${micSession.sampleRate}`)
    }
    enterListening()
    hud.banner('跟唱：麦克风已开，角色会停下来听你唱', 2600)
  } catch (err) {
    console.warn('[sing] 麦克风打开失败', err)
    mixer.setMicLabel(t('ui.mic.off'))
    hud.banner(`麦克风打不开：${(err as Error).message}`, 3600)
  } finally {
    micBusy = false
  }
}

const lipSyncClip = createLipSyncClip(
  () => lipLevel,
  () => lipVowel,
)
const grooveClip = createGrooveClip(() => grooveLevel)

// 跟唱情绪：跟得好就高兴，长时间跟不上就有点担心（权重很低，不摆脸色）
let singMood: 'happy' | 'neutral' | 'sad' = 'neutral'
let singMoodHold = 0
const singFeedbackClip = createSingFeedbackClip(() => singMood)
const singMoodClip = createSingMoodClip(() => singMood)

/**
 * 情绪切换要带滞回：命中率在阈值附近抖动时不能来回翻。
 * 连续 1.2 秒满足新条件才切换。
 */
function updateSingMood(dt: number): void {
  if (!micSession && !singTestBuf) {
    singMood = 'neutral'
    singMoodHold = 0
    return
  }
  const r = singAlong.report
  if (r.judged < 80) {
    singMood = 'neutral'
    singMoodHold = 0
    return
  }
  // 判定容差 2026-11-17 从 210 收到 120 音分（自测：原唱当歌手时 99% → 94%，
  // 少掉的那 5% 是换音/滑音），所以「高兴」的门也跟着松一点，否则好唱也变得难。
  const want: 'happy' | 'neutral' | 'sad' =
    r.hitRate >= 0.68 ? 'happy' : r.hitRate <= 0.35 ? 'sad' : 'neutral'
  if (want === singMood) {
    singMoodHold = 0
    return
  }
  singMoodHold += dt
  if (singMoodHold >= 1.2) {
    singMood = want
    singMoodHold = 0
  }
}

// ---------------------------------------------------------------------------
// D5 便宜版：只判「有没有人在说话」，不做语音识别
//
// 用户 2026-11-12 拍板：往上做实时互动要常驻大模型，往下做指令又不如点按钮，
// 所以只留这个彩蛋——你说话时她抬左手「展望」一下（作者摆的 `arm.far.L`）。
//
// 只在**没在放歌**的时候触发：唱歌时麦克风一直是满电平，按能量判会把整首歌
// 都判成「你在说话」。资源代价：一个 250 ms 的计数器，零模型、零新依赖。
// ---------------------------------------------------------------------------

let voiceHold = 0
let voiceCooldown = 0

function updateVoicePresence(dt: number): void {
  if (voiceCooldown > 0) voiceCooldown = Math.max(0, voiceCooldown - dt)
  if (!isListening() || track.isPlaying) {
    voiceHold = 0
    return
  }
  // inputLevel 是**自适应增益之前**的原始电平（HUD 里的「输入 xx%」），
  // 说话大约 20~50%，唱歌 50% 以上；这里取 30% 当前提。
  const loud = singAlong.inputLevel > 0.3
  voiceHold = loud ? voiceHold + dt : Math.max(0, voiceHold - dt * 2)
  if (voiceHold > 0.25 && voiceCooldown <= 0) {
    voiceHold = 0
    voiceCooldown = 8
    fire('gesture.notice')
    hud.banner('（她注意到你在说话）', 1400)
  }
}

/**
 * 和声的「节奏」：不跟着每个音换音高。
 *
 * 用户 2026-11-17：ギンギラ那种 BPM 很高的歌，「原曲一音一和会有点奇怪」——
 * 和声如果逐音跟着旋律跑，快句就变成机关枪（一音一和）。真人和声在这种情况下
 * 会把音**保持住**，只在大跳或换句时才换。
 *
 * 规则（都以拍为单位，所以快歌自动更快、慢歌自动更慢）：
 *   - 音级没变（< 1 个半音）→ 不动（顺便吃掉颤音/滑音造成的抖动）；
 *   - 新音高要**稳定 0.35 拍**才被采纳（经过音不跟）；
 *   - 两次换音至少隔 **0.5 拍**；
 *   - 跳进 ≥ 3 个半音 → 立刻换（那是真的换句/大跳，不该拖）。
 *
 * `?hr=off` 退回旧行为（逐音跟），做 A/B。
 */
const hrOff = bootParams.get('hr') === 'off'
let hrHz = 0
let hrCandidate = 0
let hrCandidateAt = 0
let hrLastChangeAt = 0
/** 一共换过多少次（按秒归一就是「每秒换几次」，A/B 用） */
let hrChanges = 0
/** 上一次真正输出的音高（计数用；`hr=off` 也要能数） */
let hrPrevOut = 0

function countHrChange(out: number): void {
  if (out > 0) {
    if (!(hrPrevOut > 0) || Math.abs(12 * Math.log2(out / hrPrevOut)) >= 1) hrChanges++
    hrPrevOut = out
  } else {
    hrPrevOut = 0
  }
}

function harmonyRhythm(ideal: number, nowMs: number, secPerBeat: number): number {
  if (!(ideal > 0)) {
    hrHz = 0
    countHrChange(0)
    return 0
  }
  if (hrOff) {
    countHrChange(ideal)
    return ideal
  }
  if (!(hrHz > 0)) {
    hrHz = ideal
    hrLastChangeAt = nowMs
    countHrChange(hrHz)
    return hrHz
  }
  const semis = 12 * Math.log2(ideal / hrHz)
  if (Math.abs(semis) < 1) {
    hrCandidate = 0
    countHrChange(hrHz)
    return hrHz
  }
  if (ideal !== hrCandidate) {
    hrCandidate = ideal
    hrCandidateAt = nowMs
  }
  const stable = nowMs - hrCandidateAt >= Math.max(80, secPerBeat * 350)
  const ready = nowMs - hrLastChangeAt >= Math.max(120, secPerBeat * 500)
  if ((stable && ready) || Math.abs(semis) >= 3) {
    hrHz = ideal
    hrLastChangeAt = nowMs
    hrCandidate = 0
  }
  countHrChange(hrHz)
  return hrHz
}

/**
 * 和声的慢速微漂移（音分）。`?drift=4` 打开。
 *
 * 循环采样是**完全静止**的：同一段波形反复播，没有任何微小变化，听感就「像合成器」。
 * 真人的长音每秒都在几十音分的范围里慢慢游走。这里加一个 0.11 Hz 的慢正弦
 * （周期 9 s）。默认 3 音分（用户 2026-11-17 听下来「drift 略好」），`?drift=0` 关掉。
 */
const driftCents = Number(bootParams.get('drift') ?? 3)
function driftOf(nowMs: number): number {
  if (!Number.isFinite(driftCents) || driftCents === 0) return 1
  return Math.pow(2, (driftCents * Math.sin((2 * Math.PI * 0.11 * nowMs) / 1000)) / 1200)
}

/**
 * 音域建议：整首歌都用低八度唱的话，提示一次。
 *
 * D1 的失败模式里最难自己发现的一个是「你其实低了整整一个八度」——
 * 判定会一直说「没跟上」，但你自己听着是对的。这里把它说出来。
 * 只提示一次：每首歌一次，不唠叨。
 */
let octaveDownTime = 0
let octaveHintShown = false

function updateOctaveHint(dt: number): void {
  if (!micSession || octaveHintShown) return
  const r = singAlong.report
  if (r.judged < 60) return
  if (r.octave === -1) octaveDownTime += dt
  else octaveDownTime = Math.max(0, octaveDownTime - dt * 0.5)
  if (octaveDownTime > 10) {
    octaveHintShown = true
    hud.banner('你在低八度唱这首（原唱的音域高一个八度）—— 可以试试假声，或者把伴奏升八度', 6000)
    console.info('[sing] 音域建议：整首在低八度')
  }
}


// ---------------------------------------------------------------------------

let rig: HumanoidRig = new PrimitiveRig()
stage.scene.add(rig.root)

/** P9 脚部锁定：姿势算完之后把着地的脚钉住（`?ik=0` 关掉做对比） */
const footLock = new FootLock()
footLock.enabled = bootParams.get('ik') !== '0'

/**
 * 世界坐标手臂动画：拨头发那条扫动手腕轨迹（`src/rig/armSweep.ts`）。
 * 每帧在姿势算完后用两骨 IK 把右手解到轨迹上，所以中间帧不再受欧拉插值影响。
 */
const armSweep = new ArmSweep()

function adoptRig(next: HumanoidRig): void {
  stage.scene.remove(rig.root)
  try {
    rig.dispose()
  } catch (err) {
    console.warn('[rig] dispose failed', err)
  }
  rig = next
  stage.scene.add(rig.root)
  bus.setBasePose(rig.basePose)
  footLock.reset()
  frameRig()
  boundsDirty = true
}

/**
 * `frameRig()` 算出来的构图（模型一换/窗口一改就变）。
 * 机位预设只切**角度**，距离和注视点跟着这个走——写死数值的话，
 * 模型或窗口一变，点一下预设就把人放大/缩小（实测点右上角会放大 17%）。
 */
let framedDist = 0
let framedLook = 0.78

function frameRig(): void {
  const box = new THREE.Box3().setFromObject(rig.root)
  if (box.isEmpty()) return

  const size = box.getSize(new THREE.Vector3())
  const h = Math.max(0.8, size.y)
  const w = Math.max(0.4, size.x)

  // 静止包围盒不够用：挥手、举手都会超出它，手臂就被窗口边缘切掉。
  // 上方留 24%（够挥手举到最高）、下方留 4%、横向留 35%。
  const top = box.max.y + h * 0.24
  const bottom = box.min.y - h * 0.04
  const viewH = Math.max(0.5, top - bottom)
  const lookAtY = (top + bottom) / 2

  const pxW = stageEl.clientWidth || window.innerWidth
  const pxH = stageEl.clientHeight || window.innerHeight
  const aspect = pxW / pxH

  const vFov = THREE.MathUtils.degToRad(stage.camera.fov)
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect)

  const distV = viewH / 2 / Math.tan(vFov / 2)
  const distH = (w * 1.35) / 2 / Math.tan(hFov / 2)
  const dist = Math.max(distV, distH)

  stage.camera.aspect = aspect
  stage.camera.updateProjectionMatrix()
  framedDist = dist
  framedLook = lookAtY
  // 手动调过构图（面板滑杆）：距离/注视点用用户的，别被重新取景冲掉；
  // 否则「存了镜头，重开还是老样子」——设置持久化等于白存
  const useDist = cameraCustom ? cameraState.dist : dist
  const useLook = cameraCustom ? cameraState.look : lookAtY
  // 构图变了就把面板上的数字同步过来，否则面板显示的距离是旧的
  // （开机时先用占位角色取景、模型载入后重新取景，面板就会一直显示占位角色那组数）
  cameraState = { ...cameraState, dist: useDist, look: useLook }
  camPanel?.sync(cameraState)
  // 构图、平移、环绕由 stage 统一算，三个来源各管各的状态
  stage.setFraming(useDist, useLook)
  stage.setPan(cameraPanPx)
}

// 窗口尺寸变了（预设 / Ctrl+滚轮）就重新取景，保证不同长宽比下都不裁切
let refitTimer = 0
window.addEventListener('resize', () => {
  window.clearTimeout(refitTimer)
  refitTimer = window.setTimeout(frameRig, 120)
})

// ---------------------------------------------------------------------------
// VRM 载入
// ---------------------------------------------------------------------------

const vrmLoader = new GLTFLoader()
vrmLoader.register((parser) => new VRMLoaderPlugin(parser))

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(u8.byteLength)
  copy.set(u8)
  return copy.buffer
}

async function loadVrmBuffer(buffer: ArrayBuffer, label: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'model/gltf-binary' }))
  try {
    const gltf = await vrmLoader.loadAsync(url)
    const vrm = gltf.userData.vrm as VRM | undefined
    if (!vrm) throw new Error('文件里没有 VRM 数据，确认导出的是 .vrm 而不是 .vroid')

    VRMUtils.removeUnnecessaryVertices(gltf.scene)
    try {
      VRMUtils.combineSkeletons(gltf.scene)
    } catch {
      /* 某些模型不支持合并，忽略 */
    }
    VRMUtils.rotateVRM0(vrm)

    vrm.scene.traverse((obj) => {
      obj.frustumCulled = false
    })

    adoptRig(new VrmRig(vrm))
    hud.banner(`已载入 ${label}`)
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function bootModel(): Promise<void> {
  // 调试/验证用：?model=/models/xxx.vrm
  const modelParam = bootParams.get('model')
  if (modelParam) {
    try {
      const res = await fetch(modelParam)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      await loadVrmBuffer(await res.arrayBuffer(), modelParam.split(/[\\/]/).pop() ?? 'model')
      return
    } catch (err) {
      console.warn('[vrm] 通过 ?model= 载入失败', err)
      hud.banner('模型载入失败，改用占位角色', 3000)
    }
  }

  if (!window.pet) {
    hud.banner('浏览器模式：把 .vrm 拖进来')
    return
  }

  const cfg = await window.pet.getConfig()
  const candidates: string[] = []
  if (cfg?.lastModel) candidates.push(cfg.lastModel)

  const listed = await window.pet.listModels()
  for (const p of listed) if (!candidates.includes(p)) candidates.push(p)

  for (const p of candidates) {
    const data = await window.pet.readFile(p)
    if (!data) continue
    try {
      await loadVrmBuffer(toArrayBuffer(data), basename(p))
      return
    } catch (err) {
      console.warn('[vrm] 载入失败', p, err)
    }
  }

  hud.banner('未找到 VRM，先用占位角色（按 O 载入）', 3200)
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

if (freeze && freezeId) {
  bus.play(ACTIONS[freezeId], 0, { fadeIn: 0.001 })
} else {
  // ?idle=0 把待机微动也停掉，出姿势对照表时画面才干净；编辑器里同理
  const idleOn = bootParams.get('idle') !== '0' && !editorMode
  if (idleOn) {
    // 静息站姿是「基线」不是「微动」：注册进去之后，任何动作淡出都会回到它
    bus.setNeutral(idlePose)
    bus.play(idlePose, 0)
    bus.play(idleBreath, 0)
    bus.play(idleSway, 0)
  }
  bus.play(createBlinkClip(), 0)
  bus.play(lipSyncClip, 0)
  bus.play(singFeedbackClip, 0)
  bus.play(singMoodClip, 0)
  if (idleOn) bus.play(grooveClip, 0)

  // 调试：?pose=<id> 把姿势库里的一帧钉住，用来出姿势对照表
  const poseParam = bootParams.get('pose')
  if (poseParam) {
    if (!POSE_IDS.includes(poseParam)) {
      console.warn(`[pose] 没有这个姿势: ${poseParam}`)
      hud.banner(`没有姿势 ${poseParam}`, 3000)
    } else {
      bus.play(createPoseClip(poseParam), 0, { fadeIn: 0.001 })
    }
  }
}

// ---------------------------------------------------------------------------
// 曲包时间轴
// ---------------------------------------------------------------------------

let packTitle = ''
/** 当前曲包的人声资源，自测模式要用（currentPackId 在上面已经声明） */
let currentVocalAsset: string | null = null
/** 「她的翻唱」人声资源（C2 烘焙成品，可能没有） */
let currentCoverAsset: string | null = null
/** 当前人声用的是哪一版 */
let vocalSource: 'original' | 'cover' = 'original'
let packLoaded = false

// 歌词：行级时间轴 + 打点工具
const lyrics = new LyricsPlayer()
const viseme = new VisemePlayer()
let lyricsLoaded = false
let lyricsRelPath = ''
let lyricsLanguage = 'ja'
let lyricsSaveTimer = 0
let lastLyricHtml = ''
// 逐字高亮：缓存当前行的扫过元素和进度，避免每帧重建字幕 DOM
let sweepEl: HTMLElement | null = null
let sweepProgress = -1
// 只有动过编辑键才显示「焦点行」，否则正常听歌时那行是噪音
let lyricsEditing = false

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )

function renderLyricCaption(): void {
  if (!lyricsLoaded) return

  const current = lyrics.currentLine()
  const focus = lyrics.focusLine()
  const parts: string[] = []

  if (current) parts.push(`<span class="current"><span class="sweep">${escapeHtml(current.text)}</span></span>`)

  if (focus && (lyricsEditing || document.body.classList.contains('show-keys'))) {
    const time = focus.at === null ? '未打点' : `${focus.at.toFixed(2)}s`
    const mark = focus.src === 'interp' ? '≈' : focus.src === 'user' ? '✎' : ''
    const meta = `${time}${mark}　${lyrics.focusIndex + 1}/${lyrics.count}`
    if (focus === current) {
      parts.push(`<span class="next">${meta}</span>`)
    } else {
      parts.push(`<span class="next">▶ ${escapeHtml(focus.text)}　${meta}</span>`)
    }
  }

  if (document.body.classList.contains('show-keys')) {
    parts.push(`<span class="next">↑↓ 选行 · K 打点 · , . 微调 · Enter 跳转 · Del 清除</span>`)
  }

  const html = parts.join('')
  if (html === lastLyricHtml) return
  lastLyricHtml = html
  lyricEl.innerHTML = html
  lyricEl.classList.toggle('on', html.length > 0)
  // 换行时重新取一次高亮元素，并把进度归零
  sweepEl = lyricEl.querySelector<HTMLElement>('.sweep')
  sweepProgress = -1
}

/** 逐字高亮进度，0..1。文本不变时只改样式，不重建 DOM */
function updateSweep(progress: number): void {
  if (!sweepEl) return
  const p = Math.min(1, Math.max(0, progress))
  if (Math.abs(p - sweepProgress) < 0.002) return
  sweepProgress = p
  sweepEl.style.setProperty('--p', p.toFixed(3))
}

function lyricsNudge(delta: number): void {
  if (!lyricsLoaded) return
  const index = lyrics.nudgeFocus(delta)
  if (index < 0) {
    hud.banner('这一行还没打点', 1200)
    return
  }
  const at = lyrics.focusLine()?.at ?? 0
  hud.banner(`第 ${index + 1} 行 → ${at.toFixed(2)}s`, 800)
  saveLyricsSoon()
}

function lyricsSeekFocus(): void {
  if (!lyricsLoaded) return
  const line = lyrics.focusLine()
  if (!line || line.at === null) {
    hud.banner('焦点行还没打点', 1200)
    return
  }
  const now = clock.now()
  track.seek(now, line.at)
  if (track.isPlaying) audio?.play(line.at)
  hud.banner(`跳到 ${line.at.toFixed(2)}s`, 900)
}

async function saveLyricsNow(): Promise<void> {
  if (!lyricsLoaded) return
  const target = absolutePath(lyricsRelPath)
  if (!target || !window.pet) {
    hud.banner('浏览器模式无法回写歌词文件', 2000)
    return
  }
  const ok = await window.pet.writeFile(
    target,
    `${JSON.stringify(lyrics.toJSON(lyricsLanguage), null, 2)}\n`,
  )
  if (!ok) hud.banner('歌词保存失败，看 data/main.log', 2400)
}

function saveLyricsSoon(): void {
  window.clearTimeout(lyricsSaveTimer)
  lyricsSaveTimer = window.setTimeout(() => {
    void saveLyricsNow()
  }, 700)
}

const track = new TrackPlayer({
  onPlay: (clipId, weight) => {
    const clip = ACTIONS[clipId]
    if (!clip) {
      console.warn('[songpack] 未知动作', clipId)
      return
    }
    // 听你唱的时候不要跳舞：这时候要的是「有反应」，不是「同时表演两件事」
    if (isListening()) return
    // 被互斥层挡掉时一定要出声：之前这个返回值没人看，
    // 结果「转圈之后弹跳没起来」查了很久才找到
    const result = bus.play(clip, clock.now(), { weight })
    if (result === 'blocked') console.warn('[songpack] 动作被挡：', clipId, '@', clock.now().toFixed(2))
  },
  onStop: (clipId) => bus.stop(clipId),
  onSection: (name) => hud.banner(`段落 ${name}`, 1100),
  onEnd: () => {
    audio?.stop()
    hud.banner('曲目结束（R 重来）', 2000)
  },
  onLoop: () => {
    audio?.play(0)
    hud.banner('循环', 700)
  },
})

/**
 * 软切换曲包（按 S 选曲走这里）。
 *
 * 以前是 `location.href = '?pack=...'`——整页重载：VRM、AudioContext、所有模块级
 * 状态全部重建，看起来就像「重启了一次」（用户 2026-11-14）。
 * 现在只换「歌」：停播 → 扔掉旧分轨 → 清掉旧谱面/歌词/口型 → 重跑 bootSongPacks()。
 */
let switchingPack = false
async function switchPack(id: string): Promise<void> {
  if (!id || switchingPack) return
  if (id === currentPackId && packLoaded) {
    hud.banner(`已经是《${packTitle}》了`, 1600)
    return
  }
  switchingPack = true
  try {
    for (const action of bus.activeIds()) bus.stop(action)
    track.stop()
    audio?.stop()
    if (hum) stopHum(clock.now())
    // 分轨必须显式扔掉：loadStem 只覆盖同名 buffer，新曲没人声轨时旧人声会留着
    audio?.unloadStems([])
    lastHarmonyMora = -1
    lyricsLoaded = false
    visemeCount = 0
    f0Track = null
    scoreTrack = null
    noteSpans = []
    // 没歌了：情绪清掉（她下次换歌会重新说一句）
    songMood = null
    songBpm = 0
    speech.hide()
    vocalActivity = null
    currentVocalAsset = null
    currentCoverAsset = null
    vocalSource = 'original'
    mixer.setAvailable('harmony', Boolean(harmony))
    mixer.setAvailable('vocal', true)
    mixer.setAvailable('instrumental', true)

    await queueBoot(id)

    patchSettings({ packId: id })
    flushSettings()
    const url = new URL(location.href)
    url.searchParams.set('pack', id)
    url.searchParams.delete('at')
    url.searchParams.delete('autoplay')
    history.replaceState(null, '', url.toString())
    hud.banner(`切到《${packTitle}》— P 播放`, 2400)
  } catch (err) {
    console.warn('[songpack] 切歌失败', err)
    hud.banner('切歌失败：可以按 R 重来，或者重开页面', 3200)
  } finally {
    switchingPack = false
  }
}

/**
 * 串行化曲包载入。
 *
 * 启动时那次载入可能还没跑完用户就按了 S——两次 bootSongPacks 并发会把
 * f0Track / 分轨 / 歌词互相覆盖（实测：切到白花后 refPitch 还是 demo 的 204.6 s）。
 */
let bootChain: Promise<void> = Promise.resolve()
function queueBoot(id?: string): Promise<void> {
  bootChain = bootChain.then(() => bootSongPacks(id)).catch((err) => {
    console.warn('[songpack] 载入失败', err)
  })
  return bootChain
}

async function bootSongPacks(overrideId?: string): Promise<void> {
  try {
    await initSongPackLoader()

    const packs = await listSongPacks()
    if (packs.length === 0) {
      console.info('[songpack] songpacks/index.json 里没有登记任何曲包')
      return
    }

    // 曲包：?pack 优先，其次上次听的那张，最后第一张
    // overrideId：软切换（按 S 换歌）时直接指定，不走 URL 参数
    const wanted = overrideId ?? bootParams.get('pack') ?? savedSettings.packId
    const entry =
      (wanted && packs.find((p) => p.id === wanted)) ||
      (savedSettings.packId && packs.find((p) => p.id === savedSettings.packId)) ||
      packs[0]
    currentPackId = entry.id
    patchSettings({ packId: entry.id })
    const pack = await loadSongPack(entry.id)
    currentVocalAsset = pack.meta.assets?.vocal ?? null
    currentCoverAsset = pack.meta.assets?.cover ?? null
    vocalSource = 'original'
    // 曲包自带的和声音色（`assets.voices`）。没声明就继续用全局那套；
    // 走 voiceChain 串行，避免和启动时那次全局载入互相覆盖。
    void setHarmonyVoice(voiceSetForPack(entry.id, pack.meta.assets))
    const issues = validateSongPack(pack, new Set(Object.keys(ACTIONS)))
    for (const issue of issues) console.warn('[songpack]', issue)

    track.load(pack)
    seekbar.setDuration(pack.meta.duration ?? 0)
    packTitle = pack.meta.title
    packLoaded = true
    if (pack.meta.bpm) beat.setBpm(pack.meta.bpm, clock.now())

    hud.banner(
      issues.length > 0
        ? `曲包「${pack.meta.title}」有 ${issues.length} 处问题，看控制台`
        : `曲包「${pack.meta.title}」 — P 播放 / R 重来`,
      3200,
    )

    // 分轨：伴奏 + 人声，各载各的，缺哪条就只播另一条
    const stemAssets: Array<[StemName, string | null | undefined]> = [
      ['instrumental', pack.meta.assets?.instrumental],
      ['vocal', pack.meta.assets?.vocal],
    ]
    let longest = 0
    for (const [name, asset] of stemAssets) {
      if (!asset || !audio) continue
      try {
        const bytes = await loadAudioAsset(entry.id, asset)
        const full = await audio.loadStem(name, bytes)
        longest = Math.max(longest, full)
        console.info(`[audio] ${name} ${asset} 全长 ${full.toFixed(1)}s`)
      } catch (err) {
        console.warn(`[audio] ${name} 载入失败`, err)
      }
    }

    // 人声活动包络（和声门控用）：从已经解码好的 vocal stem 现算，不再解码一遍
    const vocalBuf = audio?.stemBuffer('vocal') ?? null
    vocalActivity = vocalBuf ? buildVocalActivity(vocalBuf) : null
    if (vocalActivity) {
      console.info(
        `[harmony] 人声活动包络 ${vocalActivity.rms.length} 帧，参考电平 ${(20 * Math.log10(vocalActivity.ref)).toFixed(1)} dB`,
      )
    }

    // `?vocal=cover`：直接用她的翻唱当人声（曲包得有 assets.cover）
    if (bootParams.get('vocal') === 'cover' && currentCoverAsset) {
      void setVocalSource('cover')
    }

    // 分轨是异步解码的，而 `track.load()` 在它之前就完成了：用户在解码期间按 P，
    // 会只听到已经就绪的伴奏——人声随后解码完**不会自己接进去**，于是整首歌
    // 只有伴奏（用户 2026-11-12：「有时开始播放会光放伴奏」）。
    // 载完之后如果已经在播，按当前进度重新起一次，把人声接进来。
    if (audio?.hasTrack && track.isPlaying) {
      console.info('[audio] 分轨载入完成，按当前进度重新起播（之前可能只有伴奏）')
      audio.play(track.time(clock.now()))
      if (!audio.hasStem('vocal')) {
        hud.banner('这个曲包没有人声分轨：只有伴奏，跟唱不可用', 3000)
      }
    }

    if (audio && audio.hasTrack) {
      audio.setSegment(pack.meta.offset ?? 0, pack.meta.duration)
      console.info(`[audio] 使用片段 ${audio.segmentLength.toFixed(1)}s，口型参考 ${audio.guide}`)

      // 没有分离出人声的曲包，混音条那一行置灰，避免以为是 bug
      mixer.setAvailable('vocal', audio.hasStem('vocal'))
      mixer.setAvailable('instrumental', audio.hasStem('instrumental'))

      const packDur = pack.meta.duration ?? 0
      if (longest > packDur + 1) {
        console.warn(
          `[audio] pack.json 的 duration=${packDur} 比音频实际长度 ${longest.toFixed(1)}s 短，` +
            `后 ${(longest - packDur).toFixed(1)}s 不会播放，歌词/编舞也会被截断`,
        )
        hud.banner(
          `duration=${packDur}s 比音频(${longest.toFixed(0)}s)短，后面的不会播：改 pack.json`,
          4200,
        )
      }
    }

    // 歌词：有就载入（行级时间轴，可能全部未打点）
    // ?lyrics=lyrics.json 可以临时切到另一份（用于对比手工版 / 自动对齐版）
    const lyricsAsset = bootParams.get('lyrics') || pack.meta.assets?.lyrics
    if (lyricsAsset) {
      try {
        const data = await loadLyrics(entry.id, lyricsAsset)
        lyrics.load(data)
        lyricsRelPath = `${entry.id}/${lyricsAsset}`
        lyricsLanguage = data.language ?? 'ja'
        lyricsLoaded = true
        console.info(`[lyrics] ${lyrics.count} 行，已打点 ${lyrics.timedCount} 行`)

        // 自动对齐产物会把「没锚到、只能插值」的行标成 src=interp
        const guessed = lyrics.all.filter((l) => l.src === 'interp').length
        if (guessed > 0) {
          console.warn(`[lyrics] ${guessed} 行是插值补的，时间不可信（标 ≈）`)
          hud.banner(`${guessed}/${lyrics.count} 行是插值补的，听的时候注意这几行`, 4200)
        }

        const inversions = lyrics.countInversions()
        if (inversions > 0) {
          console.warn(`[lyrics] 检测到 ${inversions} 处时间倒序`)
          hud.banner(
            `歌词有 ${inversions} 处时间倒序：↑↓ 选到该行，按 K 重打，或 Shift+Del 从该行起重置`,
            5200,
          )
        }
      } catch (err) {
        console.warn('[lyrics] 载入失败', err)
      }
    }

    // mora 级口型数据：有就按元音换嘴型，没有就退回纯音量包络
    const unitsAsset = pack.meta.assets?.units
    if (unitsAsset) {
      try {
        const data = await loadLyrics(entry.id, unitsAsset)
        const count = viseme.load(data)
        visemeCount = count
        console.info(`[viseme] ${count} 个 mora，覆盖 ${viseme.firstTime.toFixed(1)}s 起`)
      } catch (err) {
        console.warn('[viseme] mora 数据载入失败，口型退回音量驱动', err)
      }
    }

    // 参考音高：跟着唱判定用（work/f0.json）
    //
    // 路径是流水线定死的（`tools/pipeline.py` 的 f0 阶段）。2026-11-13 之前导入的
    // 曲包 pack.json 里没有 `assets.f0` 字段（那时候流水线还不产 f0），
    // 而那正是「新歌导入后跟唱/和声全都不生效」的真正原因。所以这里不靠字段：
    // 字段没有就按约定路径读，读不到才算真的没有。
    f0Track = null
    singAlong.track = null
    songMood = null
    songBpm = 0
    speech.hide()
    const f0Asset = pack.meta.assets?.f0 ?? 'work/f0.json'
    try {
      // 参考音高中值滤波（帧）：压掉字头毛刺、原唱的上滑和颤音（和声自己有 LFO 颤音）。
      // `?smooth=0` 关掉做 A/B；默认 9 帧 = ±40 ms。
      const smoothParam = Number(bootParams.get('smooth') ?? NaN)
      const smoothFrames = Number.isFinite(smoothParam)
        ? Math.max(0, Math.round(smoothParam))
        : 9
      f0Track = buildF0Track(await loadF0(entry.id, f0Asset), smoothFrames)
      // 「谱面」：音高锁到半音、时长锁到 1/8 拍（见 songpack/score.ts）。没有 units 也照样能用。
      scoreTrack = buildScoreTrack(f0Track, viseme.spans(), {
        bpm: pack.meta.bpm ?? 0,
        offset: pack.meta.offset ?? 0,
      })
      // 音符表：同音高的连续格子合成一段，带上「这个音还有多久」。
      // 咬字的凹陷深度、辅音替换的让位长度、气声长度都按它算（2026-11-14）。
      noteSpans = buildNoteSpans(scoreTrack)
      singAlong.track = f0Track
      singAlong.reset()
      // 曲子情绪（只用来「说一句」；灯光已回退成恒定，见上方注释）。
      // 算法和 tools/song_mood.mjs 一样，只是这里直接从刚载入的基频轨算，不读文件。
      songMood = moodFromF0(f0Track, pack.meta.bpm ?? 0)
      songBpm = pack.meta.bpm ?? 0
      if (songMood) {
        console.info(
          `[mood] ${songMood.word} · ${keyLabel(songMood)} · valence ${songMood.valence} / arousal ${songMood.arousal}`,
        )
        // 换歌时她说一句：这是什么风格、推荐怎么唱（气泡在头顶，见 ui/speech.ts）
        saySong()
      }
      // 换歌就等于换音域：八度建议和说话检测都重新计
      octaveHintShown = false
      octaveDownTime = 0
      voiceHold = 0
      voiceCooldown = 0
      // 和声要按这首歌的调性取三度，所以把整条参考音高喂给它估调性
      harmony?.setReference(scoreTrack ?? f0Track)
      const noteDur = noteSpans.map((n) => n.d).sort((a, b) => a - b)
      const noteMedian = noteDur.length ? noteDur[noteDur.length >> 1] : 0
      console.info(`[sing] 参考音高 ${f0Track.duration.toFixed(0)}s / ${f0Track.f0.length} 帧，` +
          `谱面 ${scoreTrack ? `${scoreTrack.f0.length} 帧` : `未启用`}，` +
          `音符 ${noteSpans.length} 个（中位 ${(noteMedian * 1000).toFixed(0)} ms）`)
    } catch (err) {
      // demo 曲包就是这么安静地废掉的：没人写 f0，跟唱每帧都判成「不用唱」，
      // 界面上看不出是缺数据还是真没词。缺了就要喊一声。
      console.warn(`[sing] 读不到参考音高 ${entry.id}/${f0Asset}，跟唱/和声不可用`, err)
      hud.banner('这个曲包没有参考音高（work/f0.json）：跟唱/和声不可用', 4200)
    }
    // 和声要靠参考音高轨才能算出音程；没有 f0 就把混音条那一条置灰，
    // 免得用户拖了滑杆却听不到声音还以为是坏的。
    mixer.setAvailable('harmony', Boolean(harmony && f0Track))

    // 判定只有「这一拍确实该唱」时才做：用 mora 时间轴当门。
    // 不然参考音高在间奏里的残留（白花有 27% 的「有声帧」落在没有 mora 的地方）
    // 会把「你没唱」记成「没跟上」。
    //
    // 2026-11-17 又加了一条：**原唱人声本身得在那儿**。分离轨里混着背景和声/伴奏残留，
    // f0 会在没人唱的地方也给出音高（自测里开头 0–4 s 的命中只有 56%，就是这么来的）。
    // 门里再要求人声活动包络「有声」，这些假帧就不会被算成你没唱。
    singAlong.gate = (t) =>
      viseme.at(t) !== null && (vocalActivity ? vocalActivity.at(t + ACTIVITY_LEAD) : true)

    // ?singtest=1：把原唱人声解码到 16k，当成「完美的跟唱者」喂进判定链
    singTestBuf = null
    if (singTest && pack.meta.assets?.vocal) {
      try {
        const data = await loadAudioAsset(entry.id, pack.meta.assets.vocal)
        const offline = new OfflineAudioContext(1, 1, 16000)
        const decoded = await offline.decodeAudioData(data)
        const channel = decoded.getChannelData(0)
        singTestBuf = new Float32Array(channel) // 复制一份，避免解码缓冲被回收
        singTestCursor = 0
        console.info(`[sing] 自测模式：${(singTestBuf.length / 16000).toFixed(0)}s 原唱人声`)
      } catch (err) {
        console.warn('[sing] 自测素材解码失败', err)
      }
    }

    // 调试/验证用：?at=<秒> 跳转到指定时间点（截图核对字幕用），?autoplay=1 直接播
    const atParam = Number(bootParams.get('at') ?? NaN)
    const startAt = Number.isFinite(atParam) ? Math.max(0, atParam) : 0
    if (bootParams.has('autoplay')) {
      void clock.resumeAudio()
      track.restart(clock.now())
      if (startAt > 0) track.seek(clock.now(), startAt)
      audio?.play(startAt)
    } else if (startAt > 0) {
      track.seek(clock.now(), startAt)
      console.info(`[debug] 暂停在 ${startAt}s`)
    }
  } catch (err) {
    console.warn('[songpack] 载入失败', err)
  }
}

function fire(id: string, toggle = false): void {
  const clip = ACTIONS[id]
  if (!clip) return
  // 走路在 base 层，会和别的 base 动作抢身体：先收脚再放
  if (walkPhase !== 'off' && clip.layer === 'base') stopWalk()
  // 别的 base 动作把「保持住的转身」顶掉了：转回正面的出发点就失效了
  if (activeTurn && clip.layer === 'base' && id !== activeTurn.clipId) activeTurn = null
  const now = clock.now()

  if (toggle) {
    if (bus.toggle(clip, now) === 'blocked') hud.banner('这个动作还没结束，等一下', 1200)
    return
  }

  if (bus.play(clip, now) === 'blocked') hud.banner('这个动作还没结束，等一下', 1200)
}

// ---------------------------------------------------------------------------
// 走路位移（root motion）
//
// clip 只声明「该以多快的速度往前挪」（`travel`, 米/秒）。真正让画面读成「在走」
// 的是**窗口**在桌面上移动——背景是透明的，在 3D 场景里平移等于没动。
// 流程：先站直（idle.base 的两只脚不在同一水平面上，直接起步会「瘸」）→ 侧身 →
// 推窗口 → 收脚转回来。撞到屏幕边缘就停，不贴边磨。
// ---------------------------------------------------------------------------

const loco = new Locomotion()
/**
 * 走路流程：站直 → 转身 → 走（循环 clip）→ 收脚转回来。
 *
 * 为什么分成这么几步，而不是「按下就开播」：
 * - 先站直：作者摆的 `idle.base` 两只脚不在同一水平面上，直接起步会瘸；
 * - **先转完身再开播**：以前是边转边播，转身那 0.28 s 她在原地踏步而窗口不动；
 * - 收尾时把位移按同一条曲线收到 0：以前是位移先停、姿势还在淡出，
 *   看起来就是「人还在迈步，窗口已经不动了」。
 */
type WalkPhase = 'off' | 'prep' | 'turn' | 'walk' | 'settle'
let walkPhase: WalkPhase = 'off'
/** 当前阶段已经过了多久 */
let walkPhaseT = 0
/** 这趟已经走了多少秒（含循环内） */
let walkElapsed = 0
/** 侧身后的朝向符号。
 *
 * 相机在 +Z 看着角色（`stage.ts`：`camera.position.set(0, 0.95, 2.65)`），
 * 静止时她面朝 +Z；绕 Y 转 **+90°** 把 +Z 转到 +X，也就是屏幕**右**。
 * 走路 clip 前进方向同样是 +Z（源的支撑脚往 −Z 滑）。
 * 所以「往右走」= yaw +90° + 窗口往右推，两者符号一致，取 +1。
 * 第一版按截图判断反了，然后在真机上被指出来——以后只认这条推导。
 */
const WALK_YAW_SIGN = 1
/** 站直要多久（秒） */
const WALK_PREP_SEC = 0.34
/**
 * 走几个周期（一个周期约 1.12 m）。
 *
 * 可选：右键「动作 → 走两步 / 走远一点」，或 URL `?walkcycles=4`。
 * 会记住上次的选择——「走多远」是口味问题，不该每次重新点。
 */
let walkCycles = 2
// 优先级：URL 参数 > 上次的选择 > 默认 2 个周期（夹到 1–8）
{
  const fromUrl = Number(bootParams.get('walkcycles'))
  const fromSave = Number(loadSettings().walkCycles)
  const pick = Number.isFinite(fromUrl) && fromUrl > 0 ? fromUrl : Number.isFinite(fromSave) && fromSave > 0 ? fromSave : 2
  walkCycles = Math.min(8, Math.max(1, Math.round(pick)))
}
/** 位移的淡入 / 淡出时长：和 clip 的 blendIn / blendOut 对齐，两端才同时收敛 */
const WALK_RAMP_IN = 0.25
const WALK_RAMP_OUT = 0.25

let walkDir: -1 | 1 = 1
let walkPrepSeq = 0
/** 这一趟累计推给窗口多少像素（验证用） */
let walkPxTotal = 0

function walkClip(): (typeof ACTIONS)[string] | undefined {
  return ACTIONS['gen.walk']
}

/** 转回正面用的过门时长（秒）：0.4 s 的权重淡出等于「140° 一瞬间甩回来」，太短了 */
const TURN_BACK_SEC = 0.8

/** 当前保持住的转身：clip id + 姿势 id（转回正面时要用它当过门起点） */
let activeTurn: { clipId: string; poseId: string } | null = null
let turnSeq = 0

function startTurn(clipId: string, poseId: string, label: string): void {
  if (walkPhase !== 'off') stopWalk()
  // 已经转去另一侧：先把旧的撤掉，免得到时候两段转身叠加
  if (activeTurn && activeTurn.clipId !== clipId) bus.stop(activeTurn.clipId)
  fire(clipId)
  activeTurn = { clipId, poseId }
  hud.banner(`转身 ${label}（保持）`, 1600)
}

/**
 * 转回正面。
 *
 * 不能只 `bus.stop()`：那只是按 clip 的 `blendOut`（0.4 s）把权重淡掉，
 * 140° 的偏航在 0.4 秒里甩回去——作者的原话是「过渡帧太少了」。
 * 改成生成一段 **0.8 s 的过门**（`buildTransition`，inOut 缓动）：先停掉保持姿势，
 * 同时起过门（起点就是那个转身姿势，所以接得上），再用 0.8 秒走回站姿。
 */
function turnBack(): void {
  if (!activeTurn) {
    hud.banner('现在是正面', 900)
    return
  }
  const from = getPose(activeTurn.poseId)
  const to = getPose('idle.base')
  const clip = buildTransition(
    `gen.turn-back.${++turnSeq}`,
    { bones: from?.bones ?? {}, hipsOffset: from?.hipsOffset ?? undefined },
    { bones: to?.bones ?? {}, hipsOffset: to?.hipsOffset ?? undefined },
    { duration: TURN_BACK_SEC, anticipation: 0 },
  )
  // 起步不要淡入：起点就是当前姿势，淡入反而会先往站姿那边偏一下
  clip.blendIn = 0.02
  bus.stop(activeTurn.clipId)
  bus.play(clip, clock.now())
  activeTurn = null
  hud.banner('转回正面（0.8 s）', 1200)
}

/** 往屏幕上空间大的那边走 */
function pickWalkDir(): -1 | 1 {
  const cx = (window.screenX ?? 0) + (window.outerWidth ?? 0) / 2
  const mid = (window.screen.availWidth ?? 1920) / 2
  return cx > mid ? -1 : 1
}

/**
 * 起步前要「站直」的骨骼：只有腿。
 *
 * 早先是把**所有**骨骼增量归零（= VRM 立正），结果头部会从作者摆的 −10°（微后仰）
 * 被压到 0——起步瞬间先点一下头，看着像断了。作者摆的上身（头/颈/胸/手）本来就是他
 * 想要的站姿，没必要动；起步真正要修正的只是「两只脚不在同一水平面」。
 */
const WALK_STRAIGHTEN_BONES: BoneName[] = [
  'leftUpperLeg',
  'leftLowerLeg',
  'leftFoot',
  'rightUpperLeg',
  'rightLowerLeg',
  'rightFoot',
]

function startWalk(cycles?: number): void {
  if (walkPhase !== 'off') {
    hud.banner('已经在走了', 1000)
    return
  }
  if (cycles && Number.isFinite(cycles)) {
    walkCycles = Math.min(8, Math.max(1, Math.round(cycles)))
    patchSettings({ walkCycles })
  }
  walkDir = pickWalkDir()
  loco.reset()
  loco.setDirection(null)
  walkPxTotal = 0
  walkElapsed = 0
  walkPhaseT = 0
  walkPhase = 'prep'
  // 从作者摆的站姿出发，只把两条腿拉直（其余保持原样）
  const from = getPose('idle.base')
  const fromBones = { ...(from?.bones ?? {}) }
  const toBones = { ...fromBones }
  for (const b of WALK_STRAIGHTEN_BONES) delete toBones[b]
  const clip = buildTransition(
    `gen.walk-prep.${++walkPrepSeq}`,
    { bones: fromBones, hipsOffset: from?.hipsOffset ?? undefined },
    { bones: toBones },
    { duration: WALK_PREP_SEC, anticipation: 0 },
  )
  bus.play(clip, clock.now())
}

function endWalk(): void {
  walkPhase = 'settle'
  walkPhaseT = 0
  bus.stop('gen.walk')
  // 转身**不在这里**做：先让走路姿势淡出、人站定，再转回来（见 updateLocomotion 的 settle）
}

/**
 * 用户碰她（点一下 / 开始拖）→ 立刻收脚。
 *
 * 走路的时候整具身体都在动、窗口还在平移，用户伸手就是想让她停；
 * 「走完这圈再停」体感很差。已经在走就走正常的收尾流程（淡出 → 站定 → 转身），
 * 还在准备/转身阶段就直接收回，不用等她转完。
 */
function stopWalk(): void {
  if (walkPhase === 'off') return
  if (walkPhase === 'walk') {
    endWalk()
    hud.banner('好，停下了', 900)
    return
  }
  walkPhase = 'settle'
  walkPhaseT = 0
  loco.setDirection(null)
  bus.stop('gen.walk')
}

/**
 * 走路时把髋位移按包络收到 0 / 放出来。
 *
 * 为什么必须自己收：髋位移是**独占**的（`ownsHips`），而跑步态的 base 层不产出髋位移，
 * 于是 ParamBus 里「没有下一层可混」→ 直接给满值。结果走路 clip 一上，身体在 1 帧内
 * 掉 5 cm（实测头部世界高度 1390 → 1340 mm），看着就是「卡一下」；收尾时又弹回去。
 * 这里按和 clip 淡入淡出一样的时长把这段位移拉起来 / 收掉。
 */
let walkHipsFade: Vec3 | null = null

function applyWalkHipsRamp(pose: ResolvedPose): void {
  if (walkPhase === 'walk') {
    const k = Math.min(1, walkElapsed / WALK_RAMP_IN)
    if (k < 1) {
      pose.hipsOffset = [pose.hipsOffset[0] * k, pose.hipsOffset[1] * k, pose.hipsOffset[2] * k]
    }
    walkHipsFade = [pose.hipsOffset[0], pose.hipsOffset[1], pose.hipsOffset[2]]
    return
  }
  if (walkPhase === 'settle' && walkHipsFade) {
    // 用**替换**而不是叠加：clip 被 stop 之后还会淡出 0.25 s，这期间 ParamBus 仍在
    // 输出它的髋位移；再叠一份就会先掉 4 cm、等 clip 淡完再弹回来（实测 866 → 827 → 908）。
    const k = Math.max(0, 1 - walkPhaseT / WALK_RAMP_OUT)
    pose.hipsOffset = [walkHipsFade[0] * k, walkHipsFade[1] * k, walkHipsFade[2] * k]
    if (k <= 0) walkHipsFade = null
  }
}
/**
 * 位移的时间包络：两端收到 0，和姿势的淡入淡出同步。
 * 中途恒为 1，所以「一步 = travel × 周期」在中间段是准的。
 */
function walkEnvelope(): number {
  const total = walkCycles * walkCycle()
  const rise = Math.min(1, walkElapsed / WALK_RAMP_IN)
  const fall = Math.min(1, Math.max(0, (total - walkElapsed) / WALK_RAMP_OUT))
  return Math.max(0, Math.min(rise, fall))
}

/** 一个周期多长（秒）：循环 clip 的 duration 是无穷，周期写在生成的文件里 */
function walkCycle(): number {
  return walkClip()?.cycle ?? 1.1167
}

function updateLocomotion(dt: number): void {
  const camera = stage.camera as THREE.PerspectiveCamera
  if (dt <= 0) {
    rig.root.rotation.y = loco.yaw * WALK_YAW_SIGN
    return
  }
  walkPhaseT += dt

  if (walkPhase === 'prep') {
    if (walkPhaseT >= WALK_PREP_SEC) {
      walkPhase = 'turn'
      walkPhaseT = 0
      loco.setDirection(walkDir)
    }
  } else if (walkPhase === 'turn') {
    // 转到位再开播：不然开头那 0.28 s 她在原地踏步
    if (loco.isAligned) {
      walkPhase = 'walk'
      walkPhaseT = 0
      walkElapsed = 0
      if (bus.play(walkClip()!, clock.now()) === 'blocked') {
        endWalk()
      } else {
        hud.banner(`走两步（${walkDir > 0 ? '向右' : '向左'}）`, 1200)
      }
    }
  } else if (walkPhase === 'walk') {
    walkElapsed += dt
    if (walkElapsed >= walkCycles * walkCycle() || loco.isBlocked) endWalk()
  } else if (walkPhase === 'settle') {
    // 先站定（姿势淡出 0.22 s），再转身；转回正面且到时间才算结束
    if (walkPhaseT > 0.22) loco.setDirection(null)
    if (walkPhaseT > 0.55 && loco.isAligned) walkPhase = 'off'
  }

  const walking = walkPhase === 'walk'
  const travel = walking ? (walkClip()?.travel ?? 0) * walkEnvelope() : 0
  const pxPerM = pixelsPerMeter(camera, stageEl.clientHeight || window.innerHeight)
  const out = loco.update(dt, travel, pxPerM)
  rig.root.rotation.y = out.yaw * WALK_YAW_SIGN
  if (out.dxPx !== 0) {
    walkPxTotal += out.dxPx
    void window.pet?.nudgeWindow?.(out.dxPx, 0).then((ok) => {
      if (ok === false) {
        // 撞到工作区边缘：收脚，别贴着边一直磨
        loco.markBlocked()
        hud.banner('走到屏幕边上了', 1200)
      }
    })
  }
}

/** HUD 和混音条一起开关：调音量时人会盯着滑杆，看得到数值才敢拖 */
let uiVisible = false
function toggleUi(): void {
  uiVisible = !uiVisible
  hud.toggle()
  mixer.setVisible(uiVisible)
  seekbar.setVisible(uiVisible)
  patchSettings({ hud: uiVisible })
}

/** 动作幅度：35% → 100% → 0。确认口型时按到 0，全身停住只留嘴。 */
function cycleMotion(): void {
  motionStep = (motionStep + 1) % MOTION_STEPS.length
  motionScale = MOTION_STEPS[motionStep]
  bus.setMotionScale(motionScale)
  hud.banner(`动作幅度 ${Math.round(motionScale * 100)}%`, 1200)
}

function togglePip(): void {
  pipOn = !pipOn
  hud.banner(pipOn ? '嘴部放大：开' : '嘴部放大：关', 1200)
}

/**
 * Q 键轮流试作者第三批的手势。
 *
 * 这六个是**对话/待机**动作，`ROLE` 里标的是 manual，编舞不会自动挑它们，
 * 所以得有个手动入口，不然摆完之后没人看得见。一个键循环比六个键好记，
 * 也不会把 1~0 那排挤满。
 */
const NEW_GESTURES = [
  ['gesture.point', '指向前方'],
  ['pose.lookBack', '回头看'],
  ['pose.clasp', '双手交握'],
  ['pose.intro', '自我介绍'],
  ['gesture.hair', '拨头发'],
  ['pose.profile', '侧对镜头'],
] as const
let gestureCursor = 0
function cycleGesture(): void {
  const [clip, label] = NEW_GESTURES[gestureCursor % NEW_GESTURES.length]
  gestureCursor += 1
  fire(clip)
  hud.banner(`${label}（Q 换下一个）`, 1300)
}

/**
 * A 键：和声循环「关 → 三度 → 五度 → 八度」。
 *
 * 和声只在你唱的时候出声，所以没开麦时要提醒一句——不然按了没反应，
 * 会以为是坏的。
 */
function cycleHarmony(): void {
  if (!harmony) {
    hud.banner('这个环境没有音频输出，和声不可用', 1800)
    return
  }
  const mode = harmony.cycle()
  patchSettings({ harmonyMode: mode })
  if (mode === 'off') {
    hud.banner('和声：关', 1400)
  } else if (!isListening()) {
    hud.banner(`和声：${HARMONY_LABEL[mode]}（${harmony.key}）— 按 G 开麦才出声`, 3200)
  } else {
    hud.banner(`和声：${HARMONY_LABEL[mode]}（${harmony.key}）`, 1400)
  }
}

/** 一键切某条轨的静音（伴唱 = 人声关）。记住上一次的非零音量，再按一次能还原 */
const lastStemVolume: Partial<Record<StemName, number>> = {}
function toggleStem(name: StemName): void {
  if (!audio) return
  const current = audio.stemVolume(name)
  if (current === null) {
    hud.banner(`这个曲包没有${name === 'vocal' ? '分离出人声' : '伴奏'}轨`, 1600)
    return
  }
  const on = current > 0.001
  if (on) lastStemVolume[name] = current
  const next = on ? 0 : (lastStemVolume[name] ?? 1)
  audio.setStemVolume(name, next)
  mixer.setValue(name, next)
  hud.banner(
    name === 'vocal'
      ? next === 0
        ? '伴唱：人声已关'
        : '人声已开'
      : next === 0
        ? '纯人声：伴奏已关'
        : '伴奏已开',
    900,
  )
}

/**
 * 换人声源：原唱（分离轨）↔ 她的翻唱（C2 烘焙成品）。
 *
 * 翻唱是离线烘焙的，和原唱**同一时间轴**（SVC 不改节奏），所以中途换也不用重新对齐。
 * 目前只烘焙了前 90 秒，90 秒之后是静音——换之前会提示一句。
 */
async function setVocalSource(kind: 'original' | 'cover'): Promise<void> {
  if (!audio) return
  const asset = kind === 'cover' ? currentCoverAsset : currentVocalAsset
  if (!asset) {
    hud.banner(kind === 'cover' ? '这个曲包没有她的翻唱' : '这个曲包没有人声轨', 1800)
    return
  }
  if (vocalSource === kind && audio.hasStem('vocal')) return
  try {
    const bytes = await loadAudioAsset(currentPackId, asset)
    const seconds = await audio.loadStem('vocal', bytes)
    vocalSource = kind
    if (track.isPlaying) audio.play(track.time(clock.now()))
    // 翻唱现在也是整首（2026-11-15 整首烘焙），所以不再写死「前 90 秒」；
    // 万一以后又只烤了一部分，这里的秒数就是真的能唱多久
    hud.banner(
      kind === 'cover' ? `人声：她的翻唱（${seconds.toFixed(0)} 秒）` : '人声：原唱',
      1800,
    )
    console.info(`[audio] 人声源 → ${kind}（${asset}，${seconds.toFixed(1)}s）`)
  } catch (err) {
    hud.banner('换人声源失败，看控制台', 2000)
    console.warn('[audio] 换人声源失败', err)
  }
}

function handleCommand(cmd: string): void {
  // 语言切换（右键「语言」/ 命令行 `--lang` 都走这里）：改文案 + 记住 + 重画按钮
  if (cmd.startsWith('lang:')) {
    const next = cmd.slice('lang:'.length)
    const picked = initI18n({ savedLang: next, queryLang: next })
    patchSettings({ lang: picked })
    applyStaticI18n()
    document.title = t('app.title')
    camBtnLabel()
    mixer.setMicLabel(micSession ? t('ui.mic.on') : t('ui.mic.off'))
    hud.banner(t('banner.langChanged', { name: langName(lang()) }), 1200)
    return
  }
  switch (cmd) {
    case 'bounce':
      fire('dance.bounce', true)
      break
    case 'wave':
      fire('dance.wave')
      break
    case 'spin':
      fire('dance.spin')
      break
    case 'nod':
      fire('gesture.nod')
      break
    case 'shake':
      fire('gesture.shake')
      break
    case 'clap':
      fire('gesture.clap')
      break
    case 'walk':
      // 先站直再走（`idle.base` 的两只脚不在同一水平面上，直接起步会「瘸」）
      startWalk()
      break
    case 'walk-far':
      // 走远一点：4 个周期（约 4.5 m），会记住
      startWalk(4)
      break
    case 'turn-220':
      // 转身 220°（= 顺时针 140°）并保持住：把她的朝向拧到那一侧，检查镜头角度
      startTurn('pose.turn220', 'turn.cw140', '顺时针 140°')
      break
    case 'turn-ccw140':
      // 逆时针 140°（终朝向和上面那个相反一侧）
      startTurn('pose.turn140ccw', 'turn.ccw140', '逆时针 140°')
      break
    case 'turn-front':
      turnBack()
      break
    case 'transition-demo': {
      // 程序化过门：从站姿走到「抬手」——看的是「中间那 0.7 秒像不像人」
      const a = getPose('idle.base')
      const b = getPose('arm.up.full.L')
      if (a && b) {
        const clip = buildTransition(
          'gen.transition-demo',
          { bones: a.bones ?? {}, hipsOffset: a.hipsOffset ?? undefined },
          { bones: b.bones ?? {}, hipsOffset: b.hipsOffset ?? undefined },
          { duration: 0.9 },
        )
        bus.play(clip, clock.now())
        hud.banner('过门演示：站姿 → 抬手（0.9 s）', 1600)
      }
      break
    }
    case 'cam':
      toggleCamPreset()
      break
    // 右键菜单「镜头」那几条（`electron/main.cjs` 发过来的 cmd）
    case 'cam-panel':
      camPanel?.toggle()
      break
    case 'cam-front':
    case 'cam-over': {
      const which: CamPreset = cmd === 'cam-over' ? 'over' : 'front'
      camPreset = which
      applyCamPreset()
      patchSettings({ cam: which, camera: undefined })
      hud.banner(`镜头：${CAM_PRESETS[which].label}`, 1200)
      break
    }
    case 'cam-reset':
      camPreset = 'front'
      applyCamPreset()
      patchSettings({ cam: 'front', camera: undefined })
      hud.banner('镜头已复位', 1200)
      break
    case 'peace':
      fire('pose.peace')
      break
    case 'sing':
      fire('pose.sing')
      break
    case 'cheer':
      fire('pose.cheer')
      break
    case 'lean':
      fire('pose.lean')
      break
    case 'reach':
      fire('gesture.reach')
      break
    case 'harmony':
      cycleHarmony()
      break
    // 作者第三批（对话/待机手势）：不进编舞池，靠命令或 Q 键点名触发
    case 'point':
      fire('gesture.point')
      break
    case 'lookback':
      fire('pose.lookBack')
      break
    case 'clasp':
      fire('pose.clasp')
      break
    case 'intro':
      fire('pose.intro')
      break
    case 'hair':
      fire('gesture.hair')
      break
    case 'hair-sweep':
      // 世界坐标手臂动画：手腕轨迹 + 两骨 IK（不是姿势关键帧）
      armSweep.start()
      break
    case 'profile':
      fire('pose.profile')
      break
    case 'say-song':
      // 让她再说一遍「这首什么风格、怎么唱」
      saySong()
      break
    case 'mic':
      // 开/关麦克风（键位 G，混音条上的「跟唱」按钮也走这里）
      void toggleMic()
      break
    case 'editor':
      toggleEditor()
      break
    case 'talk':
      fire('face.talk', true)
      break
    case 'motion':
      cycleMotion()
      break
    case 'zoom':
      togglePip()
      break
    case 'metronome':
      void metronome.toggle()
      break
    case 'hud':
      toggleUi()
      break
    case 'vocal-toggle':
      toggleStem('vocal')
      break
    case 'inst-toggle':
      toggleStem('instrumental')
      break
    case 'import': {
      if (!window.pet) {
        hud.banner('浏览器模式不能导入歌曲，用桌面版', 2200)
        break
      }
      // 没装「做曲包组件」：弹原生说明框（含下载地址和「打开组件目录」按钮）
      if (importAvailable === false) {
        void window.pet.creatorInfo()
        break
      }
      void (async () => {
        const picked = await window.pet?.pickAudio()
        if (!picked) return
        const name = basename(picked).replace(/\.[^.]+$/, '')
        void importer.start(picked, name)
      })()
      break
    }
    case 'play': {
      if (!packLoaded) {
        hud.banner(t('banner.noPack'), 1500)
        break
      }
      const now = clock.now()
      if (track.isPlaying) {
        track.pause(now)
        audio?.pause()
        hud.banner(t('banner.pause'), 900)
      } else {
        void clock.resumeAudio()
        const at = track.time(now)
        track.play(now)
        audio?.play(at)
        hud.banner(t('banner.play'), 900)
      }
      break
    }
    case 'restart':
      if (!packLoaded) {
        hud.banner(t('banner.noPack'), 1500)
        break
      }
      void clock.resumeAudio()
      track.restart(clock.now())
      audio?.play(0)
      hud.banner(t('banner.restart'), 900)
      break
    case 'stop-track':
      track.stop()
      audio?.stop()
      hud.banner(t('banner.stop'), 900)
      break
    case 'lyrics-undo': {
      if (!lyricsLoaded) break
      const undone = lyrics.undo()
      if (undone < 0) {
        hud.banner('没有可撤销的打点', 1400)
        break
      }
      hud.banner(`撤销第 ${undone + 1} 行`, 800)
      saveLyricsSoon()
      break
    }
    case 'mute': {
      if (!audio) break
      if (audio.currentVolume > 0.001) {
        lastVolume = audio.currentVolume
        audio.setVolume(0)
        hud.banner('静音', 800)
      } else {
        audio.setVolume(lastVolume || 0.85)
        hud.banner(`音量 ${Math.round((lastVolume || 0.85) * 100)}%`, 800)
      }
      break
    }
    case 'vol-up':
    case 'vol-down': {
      if (!audio) break
      const step = cmd === 'vol-up' ? 0.1 : -0.1
      const next = Math.min(1, Math.max(0, audio.currentVolume + step))
      audio.setVolume(next)
      if (next > 0.001) lastVolume = next
      patchSettings({ volume: next })
      hud.banner(`音量 ${Math.round(next * 100)}%`, 700)
      break
    }
    case 'reload':
      location.reload()
      break
    case 'lock-on':
      hud.banner('点击穿透：已锁定（Ctrl+Alt+L 解锁）', 1600)
      break
    case 'lock-off':
      hud.banner('点击穿透：自动', 1200)
      break
    case 'tray-ok':
      hud.banner('托盘图标已创建（没看到就点任务栏 ^ 展开溢出区）', 3000)
      break
    case 'tray-fail':
      hud.banner('托盘不可用，已临时显示任务栏图标；右键角色可打开菜单', 5000)
      break
  }
}

window.pet?.onCommand(handleCommand)

// ---------------------------------------------------------------------------
// 输入
// ---------------------------------------------------------------------------

const mouseNdc = new THREE.Vector2(0, 0)
let mouseInside = false
let lastIgnore: boolean | null = null

// 主进程推来的全局光标坐标（窗口外会超出 ±1），让角色一直看向光标
const globalCursor = new THREE.Vector2(0, 0)
let hasGlobalCursor = false
window.pet?.onCursor(({ nx, ny }) => {
  globalCursor.set(nx, ny)
  hasGlobalCursor = true
})

function pushIgnore(ignore: boolean): void {
  if (lastIgnore === ignore) return
  lastIgnore = ignore
  window.pet?.setIgnoreMouse(ignore)
}

window.addEventListener('mousemove', (e) => {
  mouseNdc.set(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1,
  )
  mouseInside = true
})

window.addEventListener('mouseleave', () => {
  mouseInside = false
})

// ---- 拖动窗口 ----
// 无边框 + 点击穿透，用户没有地方抓，所以按住角色本身就能拖。
// 位移在主进程算（读全局光标），避免渲染层坐标系和窗口坐标换算误差。
type DragPhase = 'idle' | 'pending' | 'active'

let dragPhase: DragPhase = 'idle'
let dragOriginX = 0
let dragOriginY = 0
/** 编辑模式下拖动画面旋转视角 */
let orbitDrag = false
let orbitStartX = 0
let orbitStartRad = 0

function endDrag(): void {
  if (orbitDrag) {
    orbitDrag = false
    return
  }
  if (dragPhase === 'active') window.pet?.dragEnd()
  dragPhase = 'idle'
}

window.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  // 面板上的按下不是拖窗口：混音条/导入/镜头面板都得能拖滑杆。
  // 直接按「表单控件」排除，比逐个列面板稳（漏一个面板就会出现
  // 「拖滑杆变成拖窗口」——镜头面板就是这么漏的）
  if (
    (e.target as HTMLElement | null)?.closest?.(
      '.mixer, .import, .cam, .seek, .picker, input, button, select, textarea, [contenteditable]',
    )
  ) {
    return
  }
  // 她在走：一碰就停（在手势分派之前，免得先拖起来再停）
  stopWalk()
  // 编辑模式下拖角色 = 转视角，不是拖窗口
  if (editorOpen) {
    orbitDrag = true
    orbitStartX = e.clientX
    orbitStartRad = stage.getOrbit()
    return
  }
  dragPhase = 'pending'
  dragOriginX = e.clientX
  dragOriginY = e.clientY
})

window.addEventListener('pointermove', (e) => {
  if (orbitDrag) {
    const rad = orbitStartRad + (e.clientX - orbitStartX) * 0.012
    stage.setOrbit(rad)
    poseEditor?.setOrbitDeg((rad * 180) / Math.PI)
    return
  }

  if (dragPhase === 'idle') return

  // 超过 4px 才算拖动，避免「点一下」被当成拖拽
  if (dragPhase === 'pending') {
    if (Math.hypot(e.clientX - dragOriginX, e.clientY - dragOriginY) < 4) return
    dragPhase = 'active'
    window.pet?.dragStart()
  }

  window.pet?.dragMove()
})

window.addEventListener('pointerup', () => endDrag())
window.addEventListener('pointercancel', endDrag)
window.addEventListener('blur', endDrag)

// ---- 右键菜单 ----
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  window.pet?.showMenu()
})

// ---- Ctrl + 滚轮缩放 ----
window.addEventListener(
  'wheel',
  (e) => {
    // 编辑模式下滚轮转视角（不然 380 px 的窗口很难从侧面看）
    if (editorOpen && !e.ctrlKey) {
      e.preventDefault()
      const rad = stage.getOrbit() + e.deltaY * 0.002
      stage.setOrbit(rad)
      poseEditor?.setOrbitDeg((rad * 180) / Math.PI)
      return
    }
    if (!e.ctrlKey) return
    e.preventDefault()
    window.pet?.zoom(e.deltaY < 0 ? 1 : -1)
  },
  { passive: false },
)

window.addEventListener('pointerdown', () => {
  void clock.resumeAudio()
})

window.addEventListener('dragover', (e) => {
  e.preventDefault()
  hud.setDrop(true)
})
window.addEventListener('dragleave', () => hud.setDrop(false))
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  hud.setDrop(false)

  // 一次可以拖好几个文件：音频 + 歌词（.lrc/.txt）。歌词也可以之后在面板里选。
  const files = Array.from(e.dataTransfer?.files ?? [])
  if (files.length === 0) return

  const AUDIO_EXT = /\.(mp3|wav|flac|m4a|aac|ogg|opus)$/
  const LYRICS_EXT = /\.(lrc|txt|json)$/

  const audioFile = files.find((f) => AUDIO_EXT.test(f.name.toLowerCase()))
  const lyricsFile = files.find((f) => LYRICS_EXT.test(f.name.toLowerCase()))

  if (audioFile) {
    const path = window.pet?.getPathForFile(audioFile)
    if (!path) {
      hud.banner('浏览器模式不能导入歌曲，用桌面版', 2600)
      return
    }
    const title = audioFile.name.replace(/\.[^.]+$/, '')
    const lyricsPath = lyricsFile ? window.pet?.getPathForFile(lyricsFile) : ''
    if (lyricsPath) {
      void importer.startWith(path, title, lyricsPath)
    } else {
      importer.start(path, title)
    }
    return
  }

  // 只拖了歌词：如果导入面板正开着，就补进去
  if (lyricsFile && importer.isVisible()) {
    const path = window.pet?.getPathForFile(lyricsFile)
    if (path) importer.setLyrics(path)
    return
  }

  const file = files[0]
  const lower = file.name.toLowerCase()

  if (!lower.endsWith('.vrm')) {
    hud.banner('支持 .vrm 模型，或音频 + 歌词（.lrc/.txt）', 3200)
    return
  }
  try {
    const path = window.pet?.getPathForFile(file)
    if (path) await window.pet?.setConfig({ lastModel: path })
    await loadVrmBuffer(await file.arrayBuffer(), file.name)
  } catch (err) {
    console.error(err)
    hud.banner('载入失败，看控制台')
  }
})

window.addEventListener('keydown', (e) => {
  const now = clock.now()

  // 在输入框里打字时不要执行热键。曲包改名（选曲面板）和导入面板都有输入框：
  // 缺了这条，改名时打一个 s 就把面板关了、打 k 还会给歌词打点。
  const t = e.target as HTMLElement | null
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return

  // 碰过任何一个歌词编辑键，就把焦点行显示出来；按 P/R 回到观演状态
  const k = e.key.toLowerCase()
  if (k === 'arrowup' || k === 'arrowdown' || k === 'k' || k === ',' || k === '.' || k === 'enter' || k === 'delete') {
    lyricsEditing = true
  } else if (k === 'p' || k === 'r') {
    lyricsEditing = false
  }

  // Shift+K：撤销上一次打点
  if (e.key.toLowerCase() === 'k' && e.shiftKey) {
    handleCommand('lyrics-undo')
    return
  }

  // Shift+Delete：从焦点行开始全部清空，用于「从这里重打」
  if (e.key === 'Delete' && e.shiftKey) {
    if (lyricsLoaded) {
      const cleared = lyrics.clearFromFocus()
      hud.banner(`已清除第 ${lyrics.focusIndex + 1} 行起的 ${cleared} 个时间戳`, 1800)
      if (cleared > 0) saveLyricsSoon()
    }
    e.preventDefault()
    return
  }

  // 上下键移动歌词焦点行，可回头重打任意一行
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (lyricsLoaded) {
      lyrics.moveFocus(e.key === 'ArrowUp' ? -1 : 1)
      e.preventDefault()
    }
    return
  }

  switch (e.key.toLowerCase()) {
    case '1':
      handleCommand('bounce')
      break
    case '2':
      handleCommand('wave')
      break
    case '3':
      handleCommand('spin')
      break
    case '4':
      handleCommand('nod')
      break
    case '5':
      handleCommand('shake')
      break
    case '6':
      handleCommand('peace')
      break
    case '7':
      handleCommand('sing')
      break
    case '8':
      handleCommand('cheer')
      break
    case '9':
      handleCommand('lean')
      break
    case '0':
      handleCommand('reach')
      break
    case 'c':
      handleCommand('clap')
      break
    case 'f':
      toggleCamPreset()
      break
    case 'e':
      handleCommand('editor')
      break
    case 't':
      handleCommand('talk')
      break
    case 'w':
      // 和右键菜单走同一条路：先站直再走（并真的把窗口推走）
      startWalk()
      break
    case 'x':
      cycleMotion()
      break
    case 'z':
      togglePip()
      break
    case 'q':
      cycleGesture()
      break
    case 'a':
      cycleHarmony()
      break
    case 'p':
      handleCommand('play')
      break
    case 'r':
      handleCommand('restart')
      break
    case 'k': {
      if (!lyricsLoaded) {
        hud.banner('这个曲包没有歌词', 1400)
        break
      }
      const at = track.time(clock.now())
      const index = lyrics.stampFocus(at)
      if (index < 0) {
        hud.banner('没有可打点的行', 1400)
        break
      }
      hud.banner(`第 ${index + 1} 行 → ${at.toFixed(2)}s`, 800)
      saveLyricsSoon()
      break
    }
    case ',':
      lyricsNudge(e.shiftKey ? -0.01 : -0.05)
      break
    case '.':
      lyricsNudge(e.shiftKey ? 0.01 : 0.05)
      break
    case 'enter':
      lyricsSeekFocus()
      break
    case 'delete': {
      if (!lyricsLoaded) break
      const cleared = lyrics.clearFocus()
      if (cleared < 0) {
        hud.banner('这一行本来就没打点', 1200)
        break
      }
      hud.banner(`清除第 ${cleared + 1} 行的时间`, 900)
      saveLyricsSoon()
      break
    }
    case 'm':
      handleCommand('mute')
      break
    case 'v':
      handleCommand(e.shiftKey ? 'inst-toggle' : 'vocal-toggle')
      break
    case 'i':
      handleCommand('import')
      break
    case 's':
      void openPicker()
      break
    case '[':
      handleCommand('vol-down')
      break
    case ']':
      handleCommand('vol-up')
      break
    case ' ':
      e.preventDefault()
      void metronome.toggle()
      break
    case 'b':
      beat.setBpm(beat.bpm >= 140 ? 84 : beat.bpm + 14, now)
      hud.banner(`BPM ${beat.bpm.toFixed(0)}`)
      break
    case 'l':
      // 锁定状态由主进程统一管理（托盘和全局快捷键也要改它）
      lastIgnore = null
      window.pet?.toggleLock()
      break
    case 'g':
      if (e.shiftKey) void toggleSingTest()
      else void toggleMic()
      break
    case 'y':
      // 人声源：原唱 ↔ 她的翻唱（曲包带 cover.wav 才有）
      void setVocalSource(vocalSource === 'cover' ? 'original' : 'cover')
      break
    case 'n':
      // 拨头发：世界坐标手臂动画（手腕轨迹 + IK）
      handleCommand('hair-sweep')
      break
    case 'h':
      // 走 command 那条路：它会一起管混音条，并把开关记进设置（以前 H 只关 HUD，
      // 混音条还留着、重开也不记得）
      handleCommand('hud')
      break
    case 'o':
      void (async () => {
        const p = await window.pet?.pickModel()
        if (!p) return
        const data = await window.pet?.readFile(p)
        if (data) await loadVrmBuffer(toArrayBuffer(data), basename(p))
      })()
      break
  }
})

// ---------------------------------------------------------------------------
// 视线与命中测试
// ---------------------------------------------------------------------------

const tmp = new THREE.Vector3()
const tmpTarget = new THREE.Vector3()
const bias = new THREE.Vector3(0, 0, 0)
const biasTarget = new THREE.Vector3(0, 0, 0)

function updateLook(dt: number): void {
  // 没有全局光标（浏览器模式）或光标离得太远时，回到中立姿态
  const far = !hasGlobalCursor || Math.hypot(globalCursor.x, globalCursor.y) > 2.8

  if (far) {
    biasTarget.set(0, 0, 0)
    bias.lerp(biasTarget, 1 - Math.exp(-dt * 6))
    bus.setLookBias([bias.x, bias.y, bias.z])
    rig.setLookTarget(null)
    return
  }

  // 越靠近窗口越专注，移远一点就淡化，避免角色一直歪着头看屏幕角落
  const dist = Math.hypot(globalCursor.x, globalCursor.y)
  const atten = clamp(1 - (dist - 1) / 1.8, 0, 1)

  tmpTarget.set(globalCursor.x, globalCursor.y, 0.5).unproject(stage.camera)
  tmpTarget.sub(stage.camera.position).normalize()
  tmpTarget.multiplyScalar(3).add(stage.camera.position)

  rig.setLookTarget(tmpTarget)
  rig.getHeadWorldPosition(tmp)

  const dx = tmpTarget.x - tmp.x
  const dy = tmpTarget.y - tmp.y
  const dz = tmpTarget.z - tmp.z

  const yaw = clamp(Math.atan2(dx, dz), -0.6, 0.6) * atten
  const pitch = clamp(-Math.atan2(dy, Math.hypot(dx, dz)), -0.32, 0.32) * atten

  biasTarget.set(pitch * 0.75, yaw * 0.8, 0)
  bias.lerp(biasTarget, 1 - Math.exp(-dt * 10))
  bus.setLookBias([bias.x, bias.y, bias.z])
}

let boundsDirty = true
let boundsTimer = 0
const screenBox = { x0: 0, y0: 0, x1: 0, y1: 0 }

function refreshScreenBox(): void {
  const box = new THREE.Box3().setFromObject(rig.root)
  if (box.isEmpty()) return
  const w = stageEl.clientWidth || window.innerWidth
  const h = stageEl.clientHeight || window.innerHeight
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity

  for (let i = 0; i < 8; i++) {
    tmp.set(
      i & 1 ? box.max.x : box.min.x,
      i & 2 ? box.max.y : box.min.y,
      i & 4 ? box.max.z : box.min.z,
    )
    tmp.project(stage.camera)
    const px = (tmp.x * 0.5 + 0.5) * w
    const py = (-tmp.y * 0.5 + 0.5) * h
    x0 = Math.min(x0, px)
    x1 = Math.max(x1, px)
    y0 = Math.min(y0, py)
    y1 = Math.max(y1, py)
  }

  screenBox.x0 = x0
  screenBox.y0 = y0
  screenBox.x1 = x1
  screenBox.y1 = y1
  boundsDirty = false
}

/**
 * 指针在窗口里的像素坐标 + 是否在窗口内。
 *
 * **优先用主进程推的全局光标**（`screen.getCursorScreenPoint()`，30 Hz）。
 * 原因：窗口处于「点击穿透」时，HTML 层根本收不到 `mousemove`——而
 * `overUi()` 靠它来判断要不要放行点击，于是形成死锁：窗口永远不变成可点击，
 * 混音条的滑杆也就永远拖不动（用户 2026-11-12：「混音那条看是看到了，
 * 但是我不能调整」）。全局光标不依赖 DOM 事件，绕开了这个循环。
 *
 * 浏览模式（没有 window.pet）没有这条流，退回 mousemove 的结果。
 */
function cursorPx(): { x: number; y: number; inside: boolean } {
  const w = window.innerWidth
  const h = window.innerHeight
  if (hasGlobalCursor) {
    const x = ((globalCursor.x + 1) / 2) * w
    const y = ((1 - globalCursor.y) / 2) * h
    const inside = Math.abs(globalCursor.x) <= 1 && Math.abs(globalCursor.y) <= 1
    return { x, y, inside }
  }
  return {
    x: (mouseNdc.x * 0.5 + 0.5) * w,
    y: (-mouseNdc.y * 0.5 + 0.5) * h,
    inside: mouseInside,
  }
}

function overCharacter(): boolean {
  if (boundsDirty) refreshScreenBox()
  const { x: px, y: py, inside } = cursorPx()
  if (!inside) return false
  const pad = 10
  return (
    px >= screenBox.x0 - pad &&
    px <= screenBox.x1 + pad &&
    py >= screenBox.y0 - pad &&
    py <= screenBox.y1 + pad
  )
}

/**
 * 指针是否落在可交互的 UI 上（混音条 / 导入面板）。
 * 窗口默认点击穿透，只有「角色或这些面板」下面才放行事件，
 * 少了这一条滑杆和按钮都点不动（事件直接穿到桌面）。
 */
function overUi(): boolean {
  const { x, y, inside } = cursorPx()
  if (!inside) return false
  return overUiAt(x, y)
}

/**
 * 「这个点是否落在可交互的 UI 上」。
 *
 * 窗口默认点击穿透，只有「角色或这些面板」下面才放行事件——**少声明一个面板，
 * 那个面板就会整个穿过去点不动**（镜头面板就是这么漏的：滑杆按下去，事件直接
 * 落到桌面，看起来像「拖不动」）。
 */
function overUiAt(x: number, y: number): boolean {
  if (camBtnEl) {
    const r = camBtnEl.getBoundingClientRect()
    if (r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  return (
    seekbar.contains(x, y) ||
    mixer.contains(x, y) ||
    importer.contains(x, y) ||
    picker.contains(x, y) ||
    Boolean(camPanel?.contains(x, y)) ||
    Boolean(poseEditor?.contains(x, y))
  )
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

let last = clock.now()
let fpsAcc = 0
let fpsFrames = 0
let fps = 0
let hudAcc = 0

function tick(): void {
  requestAnimationFrame(tick)

  const now = freeze ? freezeT : clock.now()
  const dt = freeze ? 1 / 60 : Math.min(0.06, Math.max(0.0001, now - last))
  last = now

  metronome.schedule()

  // 时间轴先跑：它推 cue 进参数总线，本帧就能看到结果
  track.update(now)

  if (lyricsLoaded) {
    lyrics.update(track.time(now))
    renderLyricCaption()
  }

  // 口型：张嘴快、闭合慢，读起来更像在唱而不是在抖
  // 听你唱的时候嘴要停（角色在听，不该跟着歌词动）
  const listening = isListening()
  const lipTarget = listening ? 0 : audio?.isPlaying ? audio.level() : 0
  const lipRate = lipTarget > lipLevel ? 28 : 9
  lipLevel += (lipTarget - lipLevel) * (1 - Math.exp(-dt * lipRate))

  // 嘴型来自当前 mora 的元音；暂停/间奏/没有数据时是 null，退回纯包络
  lipVowel =
    !listening && track.isPlaying && audio?.isPlaying ? viseme.at(track.time(now)) : null

  // 调试：钉住嘴型做逐元音对比图。?vowel=a&lip=0.9
  if (VOWEL_PIN !== null && VOWEL_PIN !== '') {
    lipVowel = VOWEL_PIN === 'none' ? null : (VOWEL_PIN as Vowel)
    lipLevel = Number.isFinite(LIP_PIN) ? LIP_PIN : 0.9
  }

  // 跟唱判定：位置每帧更新，麦克风块到达时按这个位置回推
  singAlong.position = track.time(now)
  updateSingMood(dt)
  updateVoicePresence(dt)
  updateOctaveHint(dt)

  // 和声跟**谱面**走（不是麦克风）：没有麦克风延迟，也不受你跑调影响。
  // 参考音高轨是 10 ms 一格，所以和声连颤音都跟着，听感才像同一个人。
  //
  // 但「唱不唱」不能只看谱面：分离残留/气声会让 f0 在没人唱的地方冒出音高
  // （实测 3.1% 的有声帧比中位电平低 18 dB 以上，最长连续 0.92 s），
  // 于是主唱停了、和声还在拖。所以再用**人声活动包络**当闸门，
  // 并且看的是 150 ms 之后的状态——真人合唱在主唱换气前就先收。
  const songTime = track.time(now)
  if (uiVisible) seekbar.setTime(songTime)
  const songPlaying = Boolean(f0Track && track.isPlaying && audio?.isPlaying)
  const vocalActive = GATE_ON && vocalActivity ? vocalActivity.at(songTime + ACTIVITY_LEAD) : true

  // 记一次「唱过」：放完/停下并且听了 15 秒以上，就记进待机哼歌的记忆里
  if (songPlaying && !wasSongPlaying) songPlayStart = now
  if (!songPlaying && wasSongPlaying) {
    const played = now - songPlayStart
    if (played >= 15 && currentPackId) {
      const r = singAlong.report
      rememberSung({
        id: currentPackId,
        title: packTitle,
        at: Date.now(),
        seconds: Math.round(played),
        hit: r?.hitRate ?? Number.NaN,
      })
      console.info(`[hum] 记住《${packTitle}》${Math.round(played)}s`)
    }
    // 唱完给她一句总结：总命中率 + 最差的那 4 秒（用户 2026-11-17 想知道「哪段没唱好」）
    if (isListening()) {
      const s = singAlong.sessionReport()
      // 至少判过 800 帧（≈8 秒的歌）才值得总结——按一下 P 暂停就给个「唱了 3%」很奇怪
      if (s.judged >= 800 && Number.isFinite(s.hitRate)) {
        const pct = Math.round(s.hitRate * 100)
        const clock = (sec: number): string =>
          `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`
        const worst =
          s.worst && s.worst.rate < Math.max(0.9, s.hitRate)
            ? `，${clock(s.worst.from)}–${clock(s.worst.to)} 那段最低（${Math.round(s.worst.rate * 100)}%）`
            : ''
        const verdict = pct >= 85 ? '很稳' : pct >= 70 ? '不错' : pct >= 50 ? '还行' : '再练练'
        speech.show(`这首你唱了 ${pct}%，${verdict}${worst}。`, 12000)
      }
    }
  }
  wasSongPlaying = songPlaying

  // 待机时哼一段：和声合成器唱**同音**（不是三度），音量比平时低
  let humHz = 0
  if (hum) {
    const t = now - hum.startAt
    if (t > hum.dur + 0.5) {
      stopHum(now)
    } else {
      const i = Math.min(hum.phrase.hz.length - 1, Math.max(0, Math.floor(t / 0.01)))
      humHz = hum.phrase.hz[i] || 0
      const fadeIn = Math.min(1, t / 0.3)
      const fadeOut = Math.min(1, Math.max(0, (hum.dur + 0.4 - t) / 0.4))
      harmony?.setLevel(HUM_LEVEL * Math.max(0, Math.min(1, fadeIn * fadeOut)))
    }
  } else if (
    !songPlaying &&
    !isListening() &&
    !humLoading &&
    !uiBusy() &&
    now - lastUserAt > HUM_IDLE_SEC &&
    now > humNextAt
  ) {
    // 首次进入时不要立刻哼：先等 20 秒，真的「闲着」了再哼
    if (humNextAt === 0) humNextAt = now + 20
    else void startHum(now)
  }

  // 逐字换元音：嘴型和声音终于对上了（以前永远唱「あ」）。?vowel=off 关掉做 A/B。
  if (vowelSwap && songPlaying && vocalActive) {
    const vNow = viseme.at(songTime)
    if (vNow) harmony?.setVowel(vNow)
  }
  harmony?.update(
    hum
      ? humHz
      : songPlaying && vocalActive && (scoreTrack ?? f0Track)
        ? harmonyRhythm(scoreAt(scoreTrack ?? f0Track, songTime), now, 60 / Math.max(1, beat.bpm)) *
            driftOf(now)
        : 0,
  )
  // 每个 mora 开头「咬一下字」：循环采样自己没有起音，不咬就是一片长音。
  // 起音片段前面带 100 ms 辅音，所以要**提前** leadSec 触发，元音才落在字上；
  // 音高取**下一个字**的（提前量里循环还在唱上一个音）。
  if (songPlaying && vocalActive) {
    const lead = harmony?.leadSec ?? 0
    const at = songTime + lead
    const moraIdx = viseme.indexAt(at)
    if (moraIdx >= 0 && moraIdx !== lastHarmonyMora) {
      const ahead = harmony?.targetFor(scoreAt(scoreTrack ?? f0Track, at)) ?? 0
      // **这个音还剩多少时间**（用户 2026-11-14：「还是需要继续引入每个音时长的判定」）：
      // 咬字的凹陷/替换/气声都要塞进这个音的剩余时间里，否则就是把音吃掉。
      const note = noteAt(noteSpans, at)
      const noteSec = note ? Math.max(0, note.t + note.d - at) : 0
      // ら行要用「有闭塞」的起音（替换式），は行用气声（噪声），其它 mora 用软起伏 ——
      // 三种做法本来就不同：静音只对辅音有意义，对元音只会变成顿挫。
      // UI 上的「咬字」按钮可以强制其中一种（`?att=` 同义，给调试用）。
      const ch = viseme.chAt(moraIdx)
      const raMora = /^[らりるれろ]/.test(ch)
      const haMora = /^[はひふへほ]/.test(ch)
      // 用户 2026-11-13 自己哼唱发现的规律：は 在**上行**时 [h] 几乎不发音，
      // 下行/同音时才发（上行靠一口气连过去，下行才重新起风）。
      const hzNow = scoreAt(scoreTrack ?? f0Track, (viseme.span(moraIdx)?.t ?? 0) + 0.02)
      const prevSpan = moraIdx > 0 ? viseme.span(moraIdx - 1) : null
      const hzPrev = prevSpan ? scoreAt(scoreTrack ?? f0Track, prevSpan.t + 0.02) : 0
      // 用户 2026-11-14：「音高**连续上升**则无需再发辅音，以 a 为连续即可；下降时不遵循」。
      // 0.3 半音就当作「真的升高了」——升号级进（1→2→3）每一步都会抑制 [h]。
      const rising = hzNow > 0 && hzPrev > 0 && 12 * Math.log2(hzNow / hzPrev) > 0.3
      const kind: ArticulationKind =
        attMode === 'ra'
          ? 'consonant'
          : attMode === 'vowel'
            ? 'vowel'
            : attMode === 'ha'
              ? 'aspirate'
              : raMora
                ? 'consonant'
                : haMora && !rising
                  ? 'aspirate'
                  : 'vowel'
      if (kind === 'aspirate') aspirateCount++
      else if (haMora) aspirateSkipped++
      // 音符短到放不下一个起音（<70 ms 的过门音）：干脆不咬，让循环连续唱过去。
      // 硬咬下去的结果是「哔」一下的顿挫——正是用户说的「不够稳定」。
      //
      // 元音还有第二条：**乐句之内不重新发音**（用户 2026-11-14：
      // 「あ这边其实不超出整个乐句的话是不必重新发音的，正常唱歌时就是如此」）。
      // 真唱一个乐句是一条气连过去的，只有换气/断句之后才重新起音；
      // 以前每个音都咬一次，341 ms 的音上就是每秒 3 次重新起振。
      // ら/は 不受这条限制：它们是**新的辅音**，必须重新咬。
      const gap = prevNoteEnd > 0 ? at - prevNoteEnd : Number.POSITIVE_INFINITY
      const newPhrase = gap > phraseGap
      if (note) prevNoteEnd = note.t + note.d
      if (kind === 'vowel' && note && (noteSec < 0.07 || !newPhrase)) {
        if (!newPhrase) skippedInPhrase++
        else skippedShort++
        lastHarmonyMora = moraIdx
      } else if (harmony?.articulate(ahead, kind, noteSec)) {
        lastHarmonyMora = moraIdx
      }
    }
  } else {
    lastHarmonyMora = -1
  }

  // 自测模式：把原唱人声按实时喂进去（和麦克风走同一条判定链）
  if (singTestBuf) {
    const target = Math.min(singTestBuf.length, Math.floor(track.time(now) * 16000))
    while (singTestCursor + 256 <= target) {
      singAlong.push(singTestBuf.subarray(singTestCursor, singTestCursor + 256))
      singTestCursor += 256
    }
  }

  // 逐字高亮：按 mora 进度扫过当前行
  if (lyricsLoaded) {
    const line = lyrics.currentLine()
    if (line && line.at !== null) {
      const next = lyrics.all[lyrics.currentIndex + 1]?.at ?? null
      const end = next !== null && next > line.at ? next : line.at + 4
      updateSweep(viseme.lineProgress(line.at, end, track.time(now)))
    } else {
      updateSweep(0)
    }
  }

  // 摇摆强度跟随播放状态平滑过渡，避免一按暂停就硬切
  const grooveTarget = track.isPlaying ? 1 : 0
  grooveLevel += (grooveTarget - grooveLevel) * (1 - Math.exp(-dt * 2.5))

  // ?beat=<浮点拍号> 配合 ?freeze 用：把拍子钉死，截图才能对到确定的相位。
  // 没有它的话 beat.state() 里的 offset 取决于启动时刻，截图位置是随机的。
  const beatState = freezeBeat !== null
    ? {
        bpm: beat.bpm,
        beatsPerBar: beat.beatsPerBar,
        beat: freezeBeat,
        bar: Math.floor(freezeBeat / beat.beatsPerBar),
        beatInBar: freezeBeat % beat.beatsPerBar,
        phase: freezeBeat % 1,
      }
    : beat.state(now)
  updateLook(dt)

  const pose = bus.update(now, freeze ? 0.1 : dt, beatState)
  applyWalkHipsRamp(pose)
  lastPose = pose
  rig.apply(pose)
  // 走路位移：先把整具身体转到面朝行进方向，再把**窗口**往前推几像素。
  // 必须在 apply 之后（姿势已经定好）且不参与姿势计算——它是根变换，不是骨骼。
  updateLocomotion(freeze ? 0 : dt)
  // 姿势 → 脚部锁定 → 渲染。锁定必须在 apply 之后、update 之前，
  // 它读的是「动画想把脚放哪儿」，然后把脚踝解回地面上的锚点。
  // dt 夹到 50 ms：切后台再回来时 dt 可能是几百毫秒，别让锁定一步跳死。
  // 没有动作在跑时把脚交还给站姿，否则锁定会一直挂着上一次落地时的偏移。
  // 走路时把脚锁**交还**给动作：脚锁是按世界坐标钉住脚踝的，而走路是靠推窗口
  // 前进——在场景里她其实没动，脚锁会一直把脚踝往回拽，步幅被压掉一半（实测
  // 两脚间距只剩 251 mm、抬脚 165 mm）。走路 clip 自己的脚是踩实的（标定过），
  // 所以这时候不需要锁。
  footLock.update(rig, Math.min(0.05, freeze ? 0.1 : dt), bus.hasAction() && walkPhase !== 'walk')
  // 手臂 IK 在脚之后：它只动右臂三根骨头，和腿互不干扰
  armSweep.update(rig, Math.min(0.12, freeze ? 0.1 : dt))
  rig.update(dt)

  // 嘴部放大：副视口对准头骨坐标系里的嘴（见 MOUTH_DY）
  let pip: { center: THREE.Vector3; height: number } | null = null
  if (pipOn) {
    rig.getHeadWorldPosition(headWorld)
    rig.getHeadWorldQuaternion(headQuat)
    const dy = Number.isFinite(MOUTH_DY_OVERRIDE) ? MOUTH_DY_OVERRIDE : MOUTH_DY
    pipTarget.center.set(0, dy, MOUTH_DZ).applyQuaternion(headQuat).add(headWorld)
    pip = pipTarget
  }
  stage.render(pip)

  // 命中区域每 300ms 重算一次（角色在动，包围盒会变）
  boundsTimer += dt
  if (boundsTimer > 0.3) {
    boundsTimer = 0
    boundsDirty = true
  }

  // 拖动时不要抢鼠标；锁定状态由主进程拦截，这里只报告「是否悬停在可交互区域上」。
  // 注意**不要**再与 `mouseInside`（mousemove 的产物）相与：点击穿透时收不到
  // mousemove，那会把刚修好的「全局光标判定」又废掉。inside 已在两个函数里判过。
  if (dragPhase === 'idle') pushIgnore(!(overCharacter() || overUi()))

  fpsAcc += dt
  fpsFrames += 1
  if (fpsAcc >= 0.5) {
    fps = fpsFrames / fpsAcc
    fpsAcc = 0
    fpsFrames = 0
  }

  hudAcc += dt
  if (hudAcc > 0.2) {
    hudAcc = 0
    hud.update({
      rig: rig.kind,
      fps,
      bpm: beat.bpm,
      bar: beatState.bar,
      beatInBar: beatState.beatInBar,
      actions: bus.activeIds(),
      audio: clock.usingAudio,
      hasAudio: audio?.hasTrack ?? false,
      volume: audio?.currentVolume ?? 0,
      driftMs: audio?.isPlaying ? (track.time(now) - audio.position()) * 1000 : 0,
      lipLevel,
      vowel: lipVowel,
      hasMora: visemeCount > 0,
      motion: motionScale,
      pip: pipOn,
      stems: audio
        ? {
            vocal: audio.stemVolume('vocal'),
            instrumental: audio.stemVolume('instrumental'),
          }
        : undefined,
      sing: (() => {
        const r = singAlong.report
        return {
          state: micSession || singTestBuf ? r.state : 'off',
          hitRate: r.hitRate,
          cents: r.cents,
          judged: r.judged,
          lag: r.lag,
          octave: r.octave,
          missSilent: r.missSilent,
          missOff: r.missOff,
          voice: r.voice,
          level: singAlong.inputLevel,
          gain: singAlong.inputGain,
        }
      })(),
      harmony: harmony
        ? (() => {
            const h = harmony.status()
            return {
              mode: h.mode,
              key: h.key,
              userHz: h.userHz,
              outHz: h.outHz,
              level: h.level,
              attackSec: h.attackSec,
              attackHz: h.attackRootHz,
              duck: h.duck,
              attackOn: h.attackOn,
              bank: h.bank,
              attLabel: ATT_LABEL[attMode],
              gate: Boolean(vocalActivity),
            }
          })()
        : undefined,
      pack: packLoaded
        ? {
            title: packTitle,
            time: track.time(now),
            duration: track.durationSeconds,
            playing: track.isPlaying,
            section: track.section,
          }
        : undefined,
    })
  }
}

frameRig()
boundsDirty = true
requestAnimationFrame(tick)
void bootModel()
void queueBoot()

// `?autowalk=1`：起来两秒后自己走一趟。只给验证用——
// 窗口位移发生在主进程，无头浏览器里验不到，只能起真窗口看它到底有没有动。
if (bootParams.has('autowalk')) {
  window.setTimeout(() => startWalk(), 2000)
}

// ---------------------------------------------------------------------------
// 调试钩子：?dbg=1
//
// 姿势标定靠肉眼猜欧拉角太慢（上臂到底哪个轴是「向前摆」，我猜错了两次），
// 所以把「应用任意姿势」和「读骨骼世界坐标」暴露出来，用脚本量。
// 只在带 ?dbg=1 时挂到 window 上，正式运行不占任何东西。
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 调试钩子（?dbg=1）与姿势编辑器（?editor=1）
//
// 两者都需要「把一组骨骼增量当成临时姿势钉住」。ParamBus 认 id：同一个 id 重复
// play() 只会重置时间、**不会换掉 clip 内容**，所以每次改动都要用新 id。
// ---------------------------------------------------------------------------

let debugPoseSeq = 0
let debugPoseId = ''

function applyDebugPose(bones: Partial<Record<BoneName, Vec3>>, hipsOffset?: Vec3 | null): void {
  if (debugPoseId) bus.stop(debugPoseId)
  debugPoseId = `debug.pose.${++debugPoseSeq}`
  bus.play(
    {
      id: debugPoseId,
      layer: 'upper',
      priority: 99,
      interrupt: 'hard',
      duration: Number.POSITIVE_INFINITY,
      blendIn: 0.01,
      blendOut: 0.01,
      owns: Object.keys(bones) as BoneName[],
      ownsHips: Boolean(hipsOffset),
      sample: () => ({ bones, hipsOffset: hipsOffset ?? undefined }),
    },
    clock.now(),
    { fadeIn: 0.001 },
  )
}

if (bootParams.has('dbg')) {
  const vec = new THREE.Vector3()
  // 两段前臂和脖子也读出来：作者的姿势里手到底指向哪儿、离头多近，
  // 靠肉眼在小窗里判断不可靠，只能量。手指骨这个 VRM 没有映射
  // （`getNormalizedBoneNode` 返回 null），读了也只会是 [0,0,0]，所以不列。
  const sampleBones = (): Record<string, number[]> => {
    const out: Record<string, number[]> = {}
    for (const name of [
      'head',
      'neck',
      'hips',
      'leftUpperArm',
      'leftLowerArm',
      'leftHand',
      'rightUpperArm',
      'rightLowerArm',
      'rightHand',
      'leftUpperLeg',
      'leftLowerLeg',
      'leftFoot',
      'rightUpperLeg',
      'rightLowerLeg',
      'rightFoot',
    ] as const) {
      rig.getBoneWorldPosition(name, vec)
      out[name] = [+vec.x.toFixed(4), +vec.y.toFixed(4), +vec.z.toFixed(4)]
    }
    return out
  }
  // 口型量测：读回当前五个元音表情 + 包络 + 当前 mora 的元音。
  // 「张得够不够」和「形状对不对」在小窗里看不出来，只能采样统计。
  const sampleMouth = (): Record<string, number | string | null> => {
    const t = track.time(clock.now())
    const out: Record<string, number | string | null> = {
      t: +t.toFixed(2),
      level: +lipLevel.toFixed(4),
      vowel: viseme.at(t),
    }
    for (const key of LIP_KEYS) out[key] = +(rig.getExpressionValue?.(key) ?? 0).toFixed(4)
    return out
  }
  const hook = {
    /** 应用姿势库里的某个姿势 */
    pose: (id: string) => {
      const def = getPose(id)
      if (def?.bones) applyDebugPose(def.bones)
    },
    /** 应用一组裸骨骼增量（姿势标定用） */
    poseRaw: (bones: Partial<Record<BoneName, Vec3>>) => applyDebugPose(bones),
    sample: sampleBones,
    /** 当前合成出来的骨骼增量 + 髋位移（验证动作结束后是否回到站姿） */
    bones: () => (lastPose ? { bones: lastPose.bones, hips: lastPose.hipsOffset } : null),
    /** 镜头状态（验证用）：构图距离 / 注视点 / 环绕 / 高度 / 相机世界坐标 */
    camera: () => ({
      dist: +framedDist.toFixed(3),
      look: +framedLook.toFixed(3),
      state: { ...cameraState },
      custom: cameraCustom,
      pos: (stage.camera.position.toArray() as number[]).map((v) => +v.toFixed(3)),
      orbitDeg: +((stage.getOrbit() * 180) / Math.PI).toFixed(1),
      /** 面板开着时，中心的那个点算不算「可交互 UI」（窗口靠它决定要不要穿透） */
      panelHit: camPanel
        ? (() => {
            const r = (document.querySelector('#cam') as HTMLElement | null)?.getBoundingClientRect()
            return r ? overUiAt(r.left + r.width / 2, r.top + r.height / 2) : null
          })()
        : null,
      visible: Boolean(camPanel?.isVisible()),
    }),
    /** 静止朝向表（BVH 重定向的输入，见 tools/dump_rest_dirs.mjs） */
    restDirs: () => rig.restDirections ?? null,
    /** 曲子的情绪（现在只用来「说一句」，不再驱动灯光） */
    mood: () =>
      songMood
        ? {
            word: songMood.word,
            valence: songMood.valence,
            arousal: songMood.arousal,
            key: keyLabel(songMood),
            tags: songMood.tags,
            notes: songMood.notes,
          }
        : null,
    /** 她说的话（验证气泡内容/位置用） */
    speech: () => ({ text: speech.text(), visible: speech.visible() }),
    /** 跟唱的**系统**延迟（秒）与歌手滞后（秒）：HUD 那个「晚 Xms」是后者 */
    latency: () => {
      const r = singAlong.report
      return {
        ...singAlong.timing,
        judged: r.judged,
        tol: singAlong.tolerance,
        state: r.state,
        // 最近 4 s 没跟上的原因：没检到音高 / 音不准（排查「某段命中低」用）
        missSilent: r.missSilent,
        missOff: r.missOff,
        hitRate: Number.isFinite(r.hitRate) ? +r.hitRate.toFixed(2) : null,
        // 整场汇总（唱完那句总结用的数据，也方便手动核对）
        session: (() => {
          const s = singAlong.sessionReport()
          return {
            judged: s.judged,
            hitRate: Number.isFinite(s.hitRate) ? +s.hitRate.toFixed(2) : null,
            worst: s.worst
              ? { from: +s.worst.from.toFixed(0), to: +s.worst.to.toFixed(0), rate: +s.worst.rate.toFixed(2) }
              : null,
          }
        })(),
      }
    },
    /** 麦克风状态（排查「按了没反应」用：到底开没开、采样率、输入电平） */
    mic: () => ({
      on: Boolean(micSession),
      busy: micBusy,
      sampleRate: micSession?.sampleRate ?? 0,
      level: +singAlong.inputLevel.toFixed(3),
      gain: +singAlong.inputGain.toFixed(2),
      rms: +singAlong.inputRms.toFixed(5),
      noise: +singAlong.noise.toFixed(5),
    }),
    saySong: () => saySong(),
    /** P9 脚部锁定的状态 */
    ik: () => footLock.snapshot(),
    /** 开关脚部锁定（量「腿有没有交叉」时对比用） */
    ikEnable: (on: boolean) => {
      footLock.enabled = on
      footLock.reset()
    },
    /** 量测用：把镜头转到指定环绕角（度），不影响选中的机位 */
    orbit: (deg: number) => stage.setOrbit((deg * Math.PI) / 180),
    /**
     * 走路位移的状态（验证用）：`travel` 是 clip 声明的米/秒，
     * `yaw` 是已经转了多少度，`px` 是累计推给窗口的像素。
     */
    walk: () => ({
      travel: walkClip()?.travel ?? 0,
      yawDeg: +((loco.yaw * 180) / Math.PI).toFixed(1),
      dir: walkDir,
      cycles: walkCycles,
      phase: walkPhase,
      elapsed: +walkElapsed.toFixed(2),
      env: +walkEnvelope().toFixed(2),
      blocked: loco.isBlocked,
      px: walkPxTotal,
      pxPerM: +pixelsPerMeter(stage.camera as THREE.PerspectiveCamera, stageEl.clientHeight || window.innerHeight).toFixed(1),
      rooting: +rig.root.rotation.y.toFixed(3),
    }),
    /** 口型：五个元音表情 + 包络 + 当前 mora 的元音 */
    mouth: sampleMouth,
    /** 和声的节奏状态（换音次数 / 当前保持的音高），验证「不再一音一和」用 */
    rhythm: () => ({ changes: hrChanges, hz: +hrHz.toFixed(1), off: hrOff }),
    /** 和声跟唱的当前状态（模式 / 调性 / 你唱的音 / 她算出来的音） */
    harmony: () => harmony?.status() ?? null,
    /** 当前用的是哪套和声音色（全局 / 曲包自带），验证「换歌换音色」用 */
    voice: () => ({
      label: voiceLabel,
      loops: voiceLoopCount,
      bank: harmony?.status().bank ?? 0,
      packId: currentPackId,
    }),
    /** 和声**实际发出来**的基频（自相关量测），用来核对「算的」和「响的」一致 */
    harmonyProbe: () => harmony?.probeF0() ?? 0,
    /** 量测用：把和声钉在某个频率（null = 松开） */
    harmonyTone: (hz: number | null) => harmony?.tone(hz),
    /**
     * 量测用：抓一段和声链的**原始输出**（Int16 的 base64 + 采样率）。
     *
     * 用来判断「接续时不够干净」是素材还是链的问题：拿到链的输出算谐波间噪声、
     * 毛刺（|Δ| 离群）和调制，比单凭耳朵猜靠谱。
     */
    captureHarmony: async (sec = 2) => {
      if (!harmony) return null
      const y = await harmony.captureSamples(sec)
      const i16 = new Int16Array(y.length)
      for (let i = 0; i < y.length; i++) {
        i16[i] = Math.max(-32768, Math.min(32767, Math.round(y[i] * 32767)))
      }
      const bytes = new Uint8Array(i16.buffer)
      let bin = ''
      const CH = 0x8000
      for (let i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode(...bytes.subarray(i, i + CH))
      }
      return { sr: harmony.sampleRate, b64: btoa(bin) }
    },
    /** 量测用：运行时改和声参数（A/B 修「不干净」时一次启动里切多个变体） */
    hset: (o: Record<string, number | boolean>) => {
      if (!harmony) return null
      if (o.porta !== undefined) harmony.setPortamento(Number(o.porta))
      if (o.att !== undefined) harmony.setAttackEnabled(Boolean(o.att))
      if (o.vib !== undefined) harmony.setVibrato(Number(o.vib), Number(o.vibDelay ?? 0.26))
      if (o.vibHz !== undefined) harmony.setVibratoHz(Number(o.vibHz))
      if (o.dbl !== undefined) harmony.setDoubler(Number(o.dbl))
      if (o.dblLp !== undefined) harmony.setDoublerLowpass(Number(o.dblLp))
      if (o.dblLfo !== undefined) harmony.setDoublerLfo(Number(o.dblLfo))
      if (o.breath !== undefined) harmony.setBreath(Number(o.breath))
      if (o.fx !== undefined) harmony.setFx(Boolean(o.fx))
      if (o.drive !== undefined) harmony.setDrive(Number(o.drive))
      if (o.verb !== undefined) harmony.setReverb(Number(o.verb))
      if (o.tilt !== undefined) harmony.setTilt(Number(o.tilt))
      if (o.sigma !== undefined) harmony.setLoopSigma(Number(o.sigma))
      if (typeof o.mode === 'string') harmony.setMode(o.mode as Parameters<typeof harmony.setMode>[0])
      return harmony.status().fx
    },
    /** 音程换算：给定你唱的 Hz，返回她该唱多少 Hz（不经过麦克风） */
    harmonyTarget: (hz: number) => harmony?.targetFor(hz) ?? 0,
    /** 当前播放位置（秒，歌内时间；未载入 = 0） */
    songTime: () => track.time(clock.now()),
    pageId: () => PAGE_ID,
    /** は 的规则验证：发了多少次气声 / 因上行被抑制多少次 / 音符太短跳过多少次 */
    attStats: () => ({
      aspirate: aspirateCount,
      skipped: aspirateSkipped,
      short: skippedShort,
      inPhrase: skippedInPhrase,
    }),
    /** 音符表：t 秒落在哪个音（起点/时长/音高），验证「音长判定」用 */
    note: (t: number) => noteAt(noteSpans, t),
    notes: (from: number, count: number) =>
      noteSpans.filter((n) => n.t + n.d >= from).slice(0, Math.max(0, count)),
    noteCount: () => noteSpans.length,
    /**
     * 直接喂一个「音符还剩多少秒」给咬字，返回实际用的参数。
     *
     * 为什么需要这个：无头浏览器里 AudioContext 起不来（没有用户手势），
     * `songTime()` 永远 0，走不到真实播放那条路。这个钩子绕开播放，
     * 只验证「音符时长 → hold/span/bottom」这一层映射。
     */
    attTest: (noteSec: number, kind: ArticulationKind = 'vowel') => {
      if (!harmony) return null
      if (!(harmony.status().outHz > 0)) harmony.tone(220)
      const ok = harmony.articulate(0, kind, noteSec)
      return { ok, last: harmony.status().lastAtt }
    },
    /** 参考音高轨的状态（没有 = 这个曲包的跟唱/和声是哑的），排查「新歌不生效」用 */
    refPitch: () => {
      if (!f0Track) return null
      const t = track.time(clock.now())
      return {
        frames: f0Track.f0.length,
        duration: +f0Track.duration.toFixed(2),
        voiced: f0Track.f0.reduce((n, hz) => (hz > 0 ? n + 1 : n), 0),
        hz: +f0At(f0Track, t).toFixed(2),
        score: +scoreAt(scoreTrack, t).toFixed(2),
      }
    },
    /** 人声源：原唱 / 她的翻唱，以及当前 vocal 分轨的时长（换源验证用） */
    vocalSource: () => ({
      kind: vocalSource,
      available: Boolean(currentCoverAsset),
      seconds: audio?.stemBuffer('vocal')?.duration ?? 0,
    }),
    /** 世界坐标手臂动画：当前轨迹点 / 启动 / 停止（拨头发用） */
    armSweep: () => {
      const p = armSweep.probe(rig)
      if (!p) return null
      return {
        weight: +p.weight.toFixed(3),
        t: +p.t.toFixed(3),
        pos: p.pos.toArray().map((v) => +v.toFixed(3)),
        pole: p.pole.toArray().map((v) => +v.toFixed(3)),
      }
    },
    armStart: () => armSweep.start(),
    armStop: () => armSweep.stop(),
    /** 触发任意动作（验证用）：__pet.action('pose.intro') */
    action: (id: string) => fire(id),
    /** 把所有在跑的动作停掉（批量复核动作用，等价于连按几次「收」） */
    stopActions: () => {
      for (const id of bus.activeIds()) bus.stop(id)
    },
    /** 走右键菜单那条命令路（`walk` = 先站直再走） */
    command: (cmd: string) => handleCommand(cmd),
    /** 两个姿势之间生成过门并播放（阶段 1 程序化 in-betweening），返回 clip id */
    inbetween: (fromId: string, toId: string, duration = 0.7) => {
      const a = getPose(fromId)
      const b = getPose(toId)
      if (!a || !b) return 'missing'
      const clip = buildTransition(
        'gen.transition',
        { bones: a.bones ?? {}, hipsOffset: a.hipsOffset ?? undefined },
        { bones: b.bones ?? {}, hipsOffset: b.hipsOffset ?? undefined },
        { duration },
      )
      bus.play(clip, clock.now())
      return clip.id
    },
    /** 正在跑的动作（调试：动作播了但画面没动时先看这个） */
    clips: () => bus.activeIds(),
    /**
     * 静息时每根人形骨骼的**世界四元数**。
     *
     * BVH 重定向必须用它：我们引擎给的是「骨骼局部欧拉角」，而这套模型的
     * 局部坐标轴并不与世界对齐（实测左上臂绕局部 X 才是抬起/放下，绕 Z 是前后摆）。
     * 所以离线转换时要拿静息世界朝向做坐标换算，不能假设 T-pose 轴对齐。
     */
    restQuats: () => {
      const out: Record<string, number[]> = {}
      const q = new THREE.Quaternion()
      for (const name of BONE_NAMES) {
        if (typeof rig.getBoneWorldQuaternion !== 'function') break
        rig.getBoneWorldQuaternion(name, q)
        out[name] = [q.x, q.y, q.z, q.w]
      }
      return out
    },
    /** 手臂 IK 的输入量（骨长 / 肩到腕距离），排查「IK 没生效」用 */
    armDebug: () => (rig.armDebug ? rig.armDebug() : null),
    /** 待机哼歌：当前状态 / 记忆列表 / 立刻哼一段（调试用） */
    hum: () =>
      hum
        ? {
            title: hum.title,
            t: +((clock.now() - hum.startAt) / 1000).toFixed(2),
            dur: hum.dur,
            from: hum.phrase.from,
          }
        : null,
    sung: () => sungList(),
    humStart: () => {
      void startHum(clock.now())
    },
    humStop: () => stopHum(clock.now()),
    /** 人声活动包络（0..1 的 RMS）与开/关判定，验证门控用；t 省略 = 当前播放位置 */
    activity: (t?: number) => {
      if (!vocalActivity) return null
      const at = t ?? track.time(clock.now())
      return {
        rms: +vocalActivity.levelAt(at).toFixed(5),
        ref: +vocalActivity.ref.toFixed(5),
        active: vocalActivity.at(at + ACTIVITY_LEAD),
      }
    },
  }
  ;(window as unknown as Record<string, unknown>).__pet = hook
}

/*
 * HUD + 混音条**默认关闭**（用户 2026-11-18 决定）。
 *
 * 以前是默认打开（2026-11-12：「混音滑杆我没看到」），但那块诊断面板会压在她头上，
 * 第一次打开就是一脸 FPS/时钟/动作 id —— 不像发给别人的东西。现在第一眼只有她，
 * 按 `H` 打开（HUD + 混音条 + 键位提示一起出来），打开/关闭状态会记住。
 *
 * `?hud=1` 强制打开（截图/验证用）、`?nohud` 强制关闭。
 * 用户存档里显式存过 `hud: true` 的照旧打开，不用重新按一遍。
 */
const hudBootOn = bootParams.has('hud') ? bootParams.get('hud') !== '0' : savedSettings.hud === true
if (!bootParams.has('nohud') && hudBootOn) {
  toggleUi()
  document.body.classList.remove('show-keys')
}

// ?orbit 是截图核对用的固定视角，它优先；否则用手动调过的构图，再否则用选中的机位
if (Number.isFinite(orbitParam)) stage.setOrbit((orbitParam * Math.PI) / 180)
else if (cameraCustom) {
  applyCameraState(cameraState)
  camBtnLabel()
} else applyCamPreset()

// `?campanel=1`：直接把镜头面板打开（截图/无头核对用）
if (bootParams.has('campanel')) camPanel?.open()

// 姿势编辑器：把自己摆的姿势直接导出成骨骼增量，再交给关键帧串成动作。
// 三种打开方式：`?editor=1`、`E` 键、`Ctrl+Alt+E`（全局）。
let editorOpen = false

function ensureEditor(): PoseEditorApi {
  if (poseEditor) return poseEditor
  const presets: Record<string, Partial<Record<BoneName, Vec3>>> = {}
  for (const id of POSE_IDS) {
    const def = getPose(id)
    if (def?.bones) presets[id] = def.bones
  }
  poseEditor = createPoseEditor(document.body, {
    presets,
    // 没有草稿时先装一个现有姿势当起点，用户在它上面改
    initial: getPose('sing.ballad')?.bones,
    width: EDITOR_WIDTH,
    onApply: (bones, hipsOffset) => applyDebugPose(bones, hipsOffset),
    onOrbit: (deg) => stage.setOrbit((deg * Math.PI) / 180),
    // 桌面版走主进程剪贴板；浏览器模式（无 window.pet）返回 false，
    // 编辑器会退化成「把 JSON 摆进输入框让你手动复制」
    onCopy: (text) => {
      if (window.pet?.copyText) {
        window.pet.copyText(text)
        return true
      }
      void navigator.clipboard?.writeText(text).catch(() => {})
      return Boolean(navigator.clipboard)
    },
  })
  return poseEditor
}

function setEditorOpen(on: boolean): void {
  const editor = ensureEditor()
  editorOpen = on
  editor.setVisible(on)

  // 面板挡住右边，把角色推到左边；关掉后 frameRig() 会重新居中
  cameraPanPx = on ? EDITOR_WIDTH / 2 : 0
  frameRig()

  if (on) {
    // 编辑时停掉待机微动，否则角色一直在轻微晃，角度调不准
    bus.stop('idle.breath')
    bus.stop('idle.sway')
    bus.stop('idle.groove')
    window.pet?.resizeWindow?.(720, 780)
    hud.banner('姿势编辑：点左侧骨骼名 → 拖滑杆 → 「复制 JSON」', 5200)
  } else {
    // 关掉时把临时姿势撤掉，角色回到待机；视角也回正面
    if (debugPoseId) {
      bus.stop(debugPoseId)
      debugPoseId = ''
    }
    stage.setOrbit(0)
    poseEditor?.setOrbitDeg(0)
    // 编辑器把视角改过了，关掉时回到当前机位
    applyCamPreset()
    bus.setNeutral(idlePose)
    bus.play(idlePose, clock.now())
    bus.play(idleBreath, clock.now())
    bus.play(idleSway, clock.now())
    bus.play(grooveClip, clock.now())
    window.pet?.resizeWindow?.(0, 0)
    hud.banner('姿势编辑：关', 1600)
  }
}

function toggleEditor(): void {
  setEditorOpen(!editorOpen)
}

if (editorMode) setEditorOpen(true)

// shot 模式下由主进程驱动演示序列
if (shotMode) {
  hud.banner('截图模式', 1200)
}
