/**
 * 镜头微调面板（右键菜单「镜头 → 调整…」，或点右上角机位按钮后按 `?` 同款命令）。
 *
 * 为什么单独做面板、不把参数塞进原生右键菜单：
 * 原生菜单只能点选项，改不了连续量。而「环绕多少度 / 机位多高 / 距离多远」是连续的，
 * 只能靠滑杆。菜单负责**入口**（正面 / 右上方 / 调整… / 复位），滑杆负责数值。
 *
 * 四个量都直接落到 `stage` 的构图状态（`setOrbit` / `setElevation` / `setFraming`），
 * 不做自己的相机数学——否则又会回到「两处代码改同一个相机、互相覆盖」那个老问题。
 */

export type CameraState = {
  /** 环绕角（度）：0 = 正面，负 = 转向角色右手边 */
  orbit: number
  /** 机位比注视点高多少（米） */
  elev: number
  /** 相机到注视点的水平距离（米） */
  dist: number
  /** 注视点高度（米） */
  look: number
}

export const CAMERA_DEFAULT: CameraState = { orbit: 0, elev: 0, dist: 2.65, look: 0.78 }

export type CamPanelApi = {
  open: () => void
  close: () => void
  toggle: () => void
  isVisible: () => boolean
  /** 指针是不是落在面板上（窗口默认点击穿透，不声明就会被穿过去） */
  contains: (x: number, y: number) => boolean
  /** 外部改了机位（预设/编辑器/URL 参数）之后同步滑杆 */
  sync: (state: CameraState) => void
  /** 读当前滑杆的值 */
  value: () => CameraState
}

type Options = {
  /** 滑杆动一次就回调（调用方负责落到 stage 并持久化） */
  onChange: (state: CameraState) => void
  onPreset: (which: 'front' | 'over') => void
  /** 关闭时回调（调用方把「用户还在调镜头」的状态收掉） */
  onClose?: () => void
}

function fmt(state: CameraState): Record<'orbit' | 'elev' | 'dist' | 'look', string> {
  return {
    orbit: `${Math.round(state.orbit)}°`,
    elev: `${state.elev.toFixed(2)} m`,
    dist: `${state.dist.toFixed(2)} m`,
    look: `${state.look.toFixed(2)} m`,
  }
}

export function createCamPanel(root: HTMLElement, opts: Options): CamPanelApi {
  const orbit = root.querySelector<HTMLInputElement>('#cam-orbit')!
  const elev = root.querySelector<HTMLInputElement>('#cam-elev')!
  const dist = root.querySelector<HTMLInputElement>('#cam-dist')!
  const look = root.querySelector<HTMLInputElement>('#cam-look')!
  const vals = {
    orbit: root.querySelector<HTMLElement>('#cam-orbit-v')!,
    elev: root.querySelector<HTMLElement>('#cam-elev-v')!,
    dist: root.querySelector<HTMLElement>('#cam-dist-v')!,
    look: root.querySelector<HTMLElement>('#cam-look-v')!,
  }

  function read(): CameraState {
    return {
      orbit: Number(orbit.value),
      elev: Number(elev.value) / 100,
      dist: Number(dist.value) / 100,
      look: Number(look.value) / 100,
    }
  }

  function paint(state: CameraState): void {
    const text = fmt(state)
    vals.orbit.textContent = text.orbit
    vals.elev.textContent = text.elev
    vals.dist.textContent = text.dist
    vals.look.textContent = text.look
  }

  function sync(state: CameraState): void {
    orbit.value = String(Math.round(state.orbit))
    elev.value = String(Math.round(state.elev * 100))
    dist.value = String(Math.round(state.dist * 100))
    look.value = String(Math.round(state.look * 100))
    paint(state)
  }

  function emit(): void {
    const state = read()
    paint(state)
    opts.onChange(state)
  }

  for (const el of [orbit, elev, dist, look]) {
    el.addEventListener('input', emit)
  }

  root.querySelector('#cam-reset-front')?.addEventListener('click', () => opts.onPreset('front'))
  root.querySelector('#cam-reset-over')?.addEventListener('click', () => opts.onPreset('over'))
  root.querySelector('#cam-close')?.addEventListener('click', () => api.close())

  // Esc 关闭：捕获阶段 + stopPropagation，否则会被主循环的 Esc 处理一起吃掉
  window.addEventListener(
    'keydown',
    (event) => {
      if (!api.isVisible()) return
      if (event.key === 'Escape') {
        api.close()
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )

  const api: CamPanelApi = {
    open() {
      root.classList.add('on')
      paint(read())
    },
    close() {
      root.classList.remove('on')
      opts.onClose?.()
    },
    toggle() {
      if (api.isVisible()) api.close()
      else api.open()
    },
    isVisible: () => root.classList.contains('on'),
    /** 指针是不是落在这个面板上（窗口默认点击穿透，不声明就会被穿过去） */
    contains: (x: number, y: number) => {
      if (!root.classList.contains('on')) return false
      const r = root.getBoundingClientRect()
      return r.width > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom
    },
    sync,
    value: read,
  }

  sync(CAMERA_DEFAULT)
  return api
}
