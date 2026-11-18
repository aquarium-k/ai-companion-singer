/**
 * 她「说一句话」的气泡（P12）。
 *
 * 为什么单独做一个气泡，而不是复用底部的 `banner` / `lyric`：
 * 那两条都在**角色下方**（字幕 bottom: 92px、提示 bottom: 56px、进度条在最底下），
 * 换歌时字幕、进度条、混音条全都在那儿，再加一句「这首歌怎么唱」就挤成一坨。
 * 气泡放在**头顶上方**，和下面的东西互不干扰。
 *
 * 气泡是 `pointer-events: none` 的：它只是看的，不能让窗口失去点击穿透。
 */
export type SpeechApi = {
  /** 说一句。`ms` 之后自动消失（默认 12 s，约两行字能读完） */
  show: (text: string, ms?: number) => void
  hide: () => void
  visible: () => boolean
  text: () => string
}

export function createSpeech(el: HTMLElement): SpeechApi {
  let timer = 0
  let current = ''

  const hide = (): void => {
    if (timer) window.clearTimeout(timer)
    timer = 0
    el.classList.remove('on')
  }

  /**
   * 气泡默认贴在窗口顶上；但 HUD（左上角，按 H 开）可能有好几行高，
   * 叠上去会把参数挡住（用户 2026-11-16 报的就是“被挡住”）。
   * 所以 HUD 显示时把气泡挪到它下面；只压到 70% 高度，免得顶到下面字幕。
   */
  const place = (): void => {
    const hud = document.getElementById('hud')
    if (hud && hud.classList.contains('on')) {
      const bottom = hud.getBoundingClientRect().bottom + 10
      el.style.top = `${Math.round(Math.min(bottom, window.innerHeight * 0.7))}px`
    } else {
      el.style.top = ''
    }
  }

  return {
    show(text, ms = 12000) {
      if (!text) {
        hide()
        return
      }
      current = text
      el.textContent = text
      place()
      el.classList.add('on')
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = 0
        el.classList.remove('on')
      }, Math.max(1500, ms))
    },
    hide,
    visible: () => el.classList.contains('on'),
    text: () => current,
  }
}
