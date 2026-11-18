/**
 * 「她记得上次是什么样」：曲包 / 机位 / 音量 / 混音三轨 / 和声模式 / HUD 开关。
 *
 * 存在 localStorage（浏览器和 Electron 的 file:// 源都能用），不进主进程——
 * 只有 VRM 模型走 `data/config.json`（那个需要文件系统，主进程已经做了）。
 *
 * 读失败一律当「没有」，不要因为隐私模式/配额把启动搞崩。
 */

const KEY = 'pet.settings.v1'

export type MixLevels = { vocal: number; instrumental: number; harmony: number }

/** 镜头微调后的构图（度 / 米）。见 `ui/camPanel.ts` */
export type CameraState = { orbit: number; elev: number; dist: number; look: number }

export type Settings = {
  packId?: string
  /** 两个内置机位（右上角按钮 / F 键循环的那个） */
  cam?: 'front' | 'over'
  /** 手动调过的构图；有它就用它，不再用内置机位 */
  camera?: CameraState
  volume?: number
  mix?: MixLevels
  harmonyMode?: string
  /** 和声咬字方式：auto / vowel / ra / off（混音条上那个胶囊） */
  att?: string
  /** 和声预设名（混音条「音色」按钮；见 audio/preset.ts） */
  harmonyPreset?: string
  hud?: boolean
  /**
   * 走两趟走多少个周期（一次周期 ≈ 1.12 m）。
   * 右键「动作 → 走两步 / 走远一点」会改它，下次开机沿用。
   */
  walkCycles?: number
  /**
   * 界面语言（`src/i18n/`）。没存过就用系统语言；右键「语言」或 `?lang=` 会写进来。
   */
  lang?: 'zh-CN' | 'ja' | 'en-US'
}

let cache: Settings | null = null
let saveTimer: number | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(KEY)
    cache = raw ? (JSON.parse(raw) as Settings) : {}
  } catch {
    cache = {}
  }
  return cache ?? {}
}

export function patchSettings(patch: Partial<Settings>): void {
  const next = { ...loadSettings(), ...patch }
  cache = next
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  // 拖滑杆会每帧触发，攒 400 ms 再写
  saveTimer = window.setTimeout(() => {
    saveTimer = null
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* 隐私模式 / 配额满了：当没记住 */
    }
  }, 400)
}

/** 个别场景需要立刻落盘（比如切换曲包后马上会被重载） */
export function flushSettings(): void {
  if (saveTimer !== null) {
    window.clearTimeout(saveTimer)
    saveTimer = null
  }
  try {
    if (cache) localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
}
