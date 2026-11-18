/**
 * 混音条：人声 / 伴奏 / 和声三条音量。
 *
 * 放在右下角，跟着 HUD（H）一起显示，不做常驻——桌宠是透明浮窗，
 * 常驻控件会一直压在桌面上。
 *
 * 注意窗口是「点击穿透」的：只有指针落在角色或这个面板上时，
 * 主进程才会把窗口切成可点击（见 main.ts 的 pushIgnore）。
 * 所以 contains() 是必需的，否则滑杆根本拖不动。
 */

export type MixChannel = 'vocal' | 'instrumental' | 'harmony'

/** 和声默认音量：它只是陪衬，压过人声就抢戏了（用户 2026-11-12 定 16%） */
export const HARMONY_DEFAULT = 0.16

export type MixerApi = {
  setValue: (channel: MixChannel, value: number) => void
  value: (channel: MixChannel) => number
  /** 曲包里没有这一轨（和声 = 没载入音色）时置灰 */
  setAvailable: (channel: MixChannel, available: boolean) => void
  setVisible: (on: boolean) => void
  onChange: (cb: (channel: MixChannel, value: number) => void) => void
  /** 咬字方式按钮：显示当前模式，点一下由调用方决定切到哪个 */
  setAttLabel: (text: string) => void
  onAttClick: (cb: () => void) => void
  /** 音色预设按钮 */
  setPresetLabel: (text: string) => void
  onPresetClick: (cb: () => void) => void
  /** 跟唱（麦克风）按钮：显示 关 / 开 / … */
  setMicLabel: (text: string) => void
  onMicClick: (cb: () => void) => void
  /** 屏幕坐标是否落在面板上（用于点击穿透判定） */
  contains: (clientX: number, clientY: number) => boolean
}

type Row = {
  root: HTMLElement
  slider: HTMLInputElement
  label: HTMLElement
}

function rowElements(root: HTMLElement, channel: MixChannel): Row {
  const row = root.querySelector<HTMLElement>(`[data-channel="${channel}"]`)
  const slider = root.querySelector<HTMLInputElement>(`#mix-${channel}`)
  const label = root.querySelector<HTMLElement>(`#mix-${channel}-val`)
  if (!row || !slider || !label) throw new Error(`混音条缺少 ${channel} 的 DOM`)
  return { root: row, slider, label }
}

export function createMixer(root: HTMLElement): MixerApi {
  const rows: Record<MixChannel, Row> = {
    vocal: rowElements(root, 'vocal'),
    instrumental: rowElements(root, 'instrumental'),
    harmony: rowElements(root, 'harmony'),
  }
  // 咬字方式按钮：可有可无（老 DOM 里没有就不显示），所以不放进 rows
  const attBtn = root.querySelector<HTMLButtonElement>('#att-btn')
  const attListeners: Array<() => void> = []
  // 音色预设按钮（和咬字按钮同样的模式：可选 DOM）
  const presetBtn = root.querySelector<HTMLButtonElement>('#preset-btn')
  const presetListeners: Array<() => void> = []
  // 跟唱（麦克风）按钮
  const micBtn = root.querySelector<HTMLButtonElement>('#mic-btn')
  const micListeners: Array<() => void> = []
  if (micBtn) {
    micBtn.addEventListener('click', () => {
      for (const cb of micListeners) cb()
    })
    micBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
  }
  if (presetBtn) {
    presetBtn.addEventListener('click', () => {
      for (const cb of presetListeners) cb()
    })
    presetBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
  }
  if (attBtn) {
    attBtn.addEventListener('click', () => {
      for (const cb of attListeners) cb()
    })
    // 别把点击冒泡给窗口拖拽/穿透逻辑
    attBtn.addEventListener('pointerdown', (e) => e.stopPropagation())
  }

  const listeners: Array<(channel: MixChannel, value: number) => void> = []
  const values: Record<MixChannel, number> = {
    vocal: 1,
    instrumental: 1,
    harmony: HARMONY_DEFAULT,
  }

  const emit = (channel: MixChannel, value: number): void => {
    for (const cb of listeners) cb(channel, value)
  }

  for (const channel of Object.keys(rows) as MixChannel[]) {
    const row = rows[channel]
    row.slider.addEventListener('input', () => {
      const v = Number(row.slider.value) / 100
      values[channel] = v
      row.label.textContent = String(Math.round(v * 100))
      emit(channel, v)
    })
    // 拖滑杆时别把事件冒泡给窗口拖拽逻辑
    row.root.addEventListener('pointerdown', (e) => e.stopPropagation())
  }

  return {
    setValue(channel, value) {
      const v = Math.min(1, Math.max(0, value))
      values[channel] = v
      const row = rows[channel]
      row.slider.value = String(Math.round(v * 100))
      row.label.textContent = String(Math.round(v * 100))
    },

    value(channel) {
      return values[channel]
    },

    setAvailable(channel, available) {
      const row = rows[channel]
      row.root.classList.toggle('off', !available)
      row.slider.disabled = !available
    },

    setVisible(on) {
      root.classList.toggle('on', on)
      root.style.display = on ? '' : 'none'
    },

    onChange(cb) {
      listeners.push(cb)
    },

    setAttLabel(text) {
      if (attBtn) attBtn.textContent = text
    },

    onAttClick(cb) {
      attListeners.push(cb)
    },

    setPresetLabel(text) {
      if (presetBtn) presetBtn.textContent = text
    },

    onPresetClick(cb) {
      presetListeners.push(cb)
    },

    setMicLabel(text) {
      if (micBtn) micBtn.textContent = text
    },

    onMicClick(cb) {
      micListeners.push(cb)
    },

    contains(clientX, clientY) {
      if (!root.classList.contains('on')) return false
      const rect = root.getBoundingClientRect()
      return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
    },
  }
}
