/**
 * 曲目进度条：拖动 / 点击定位到某一时刻。
 *
 * 为什么不直接用 `<input type=range>` 的原生行为边拖边 seek：
 * 一次拖动会触发几十个 `input` 事件，每个都重排音频源，听感是「滋啦」一片。
 * 所以拖动时只更新左边的预览时间，**松手（pointerup / change）才真正 seek**。
 */

export type SeekBarApi = {
  setDuration: (seconds: number) => void
  setTime: (seconds: number) => void
  setVisible: (on: boolean) => void
  isDragging: () => boolean
  /** 屏幕坐标是否落在进度条上（点击穿透判定用） */
  contains: (clientX: number, clientY: number) => boolean
}

type Options = {
  onSeek: (seconds: number) => void
}

function clockText(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function createSeekBar(root: HTMLElement, opts: Options): SeekBarApi {
  const range = root.querySelector<HTMLInputElement>('#seek-range')!
  const nowEl = root.querySelector<HTMLElement>('#seek-now')!
  const totalEl = root.querySelector<HTMLElement>('#seek-total')!

  let duration = 0
  let dragging = false

  const valueOf = (): number => (Number(range.value) / 1000) * duration

  const commit = (): void => {
    if (duration <= 0) return
    opts.onSeek(Math.max(0, Math.min(duration, valueOf())))
  }

  range.addEventListener('pointerdown', () => {
    dragging = true
  })
  range.addEventListener('input', () => {
    if (duration <= 0) return
    // 只更新预览：真正的跳转在松手时做
    nowEl.textContent = clockText(valueOf())
  })
  range.addEventListener('change', () => {
    dragging = false
    commit()
  })
  // 指针可能在窗口外松开（桌宠窗口很小），所以全局兜一层
  window.addEventListener('pointerup', () => {
    if (!dragging) return
    dragging = false
    commit()
  })

  return {
    setDuration(seconds) {
      duration = Math.max(0, seconds || 0)
      totalEl.textContent = clockText(duration)
    },

    setTime(seconds) {
      if (dragging) return
      const t = Math.max(0, Math.min(duration, seconds || 0))
      range.value = String(duration > 0 ? Math.round((t / duration) * 1000) : 0)
      nowEl.textContent = clockText(t)
    },

    setVisible(on) {
      root.classList.toggle('on', on)
      root.style.display = on ? '' : 'none'
    },

    isDragging: () => dragging,

    contains(clientX, clientY) {
      if (!root.classList.contains('on')) return false
      const rect = root.getBoundingClientRect()
      return (
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      )
    },
  }
}
