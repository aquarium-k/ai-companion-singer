/**
 * 选曲面板（B4 的最小可用版 + 删除 + 改名 + 缩略图）。
 *
 * 做四件事：把 `songpacks/index.json` 里登记过的曲包列出来，点一下切过去；
 * 每个曲包右侧的「✏」改名、「✕」删除（**点两下**才真删，第一下变成「删除？」）。
 *
 * 为什么是「重开页面」而不是运行时热切换
 * --------------------------------------
 * 载入一个曲包要连着换掉解码后的音频、编舞轨、歌词、口型、节拍网格，
 * 这些状态都是模块级的单例。`bootSongPacks()` 已经把「从零载入」这条路走顺了，
 * 复用比重写一套 teardown 稳得多。整页重开的代价是几百毫秒，可以接受。
 *
 * 删除/改名为什么不在面板里弹原生对话框：主窗口是置顶透明窗，原生对话框在它上面
 * 会挡住整个角色；两段式按钮和行内输入框在视觉上更轻，也不需要额外 IPC。
 *
 * 缩略图为什么是 blob URL：曲包资源走主进程/曲包加载器（`public/songpacks`），
 * Electron 的 `file://` 页面里 `<img src="songpacks/…">` 只对**打包那一刻**就在
 * `dist` 里的曲包有效，运行时新导入的曲包会 404。所以统一取字节再造 URL。
 */

import type { PackEntry } from '../songpack/types'

export type PickerApi = {
  toggle: (entries: PackEntry[], currentId: string) => void
  /** 删掉一行之后刷新列表（面板开着就一直开着） */
  refresh: (entries: PackEntry[], currentId: string) => void
  close: () => void
  isVisible: () => boolean
  contains: (clientX: number, clientY: number) => boolean
}

type Options = {
  onPick: (id: string) => void
  /** 返回 false = 没删成（正在导入 / 主进程报错），界面保持原样 */
  onDelete?: (id: string) => Promise<boolean> | boolean
  /** 改名（会连带改目录名）。返回 false = 失败，输入框保持打开 */
  onRename?: (id: string, title: string) => Promise<boolean> | boolean
  /** 取缩略图（返回 blob URL）。没有就是没有图 */
  loadThumb?: (entry: PackEntry) => Promise<string | null>
}

/** 第一次点「✕」之后，多久恢复成未确认状态 */
const ARM_MS = 4000

function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** 占位色：同一个曲包永远同一个颜色，换列表顺序也不会变 */
function hueOf(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360
  return h
}

export function createPicker(root: HTMLElement, opts: Options): PickerApi {
  const listEl = root.querySelector<HTMLElement>('#pack-list')!
  const emptyEl = root.querySelector<HTMLElement>('#pack-empty')!

  let rows: PackEntry[] = []
  let current = ''
  /** 正在等第二次点击确认的曲包 id（空 = 没有） */
  let armed = ''
  let armTimer = 0
  let deleting = false
  /** 正在改名的曲包 id（空 = 没有） */
  let editing = ''
  let renaming = false
  /** id → 缩略图 blob URL */
  const thumbs = new Map<string, string>()

  function isVisible(): boolean {
    return root.classList.contains('on')
  }

  function close(): void {
    root.classList.remove('on')
    disarm()
    editing = ''
  }

  function disarm(): void {
    if (armTimer) window.clearTimeout(armTimer)
    armTimer = 0
    armed = ''
  }

  function render(): void {
    if (rows.length === 0) {
      listEl.innerHTML = ''
      emptyEl.style.display = ''
      return
    }
    emptyEl.style.display = 'none'
    listEl.innerHTML = rows
      .map((entry) => {
        const meta = [
          entry.bpm ? `${Number(entry.bpm).toFixed(1)} BPM` : '',
          entry.duration ? clock(entry.duration) : '',
        ]
          .filter(Boolean)
          .join(' · ')
        const isCurrent = entry.id === current
        const confirming = entry.id === armed
        const isEditing = entry.id === editing
        const thumb = thumbs.get(entry.id)
        const art = thumb
          ? `<span class="pack-thumb"><img src="${escapeHtml(thumb)}" alt=""></span>`
          : `<span class="pack-thumb empty" style="--h:${hueOf(entry.id)}">` +
            `${escapeHtml(entry.title.slice(0, 1))}</span>`
        const nameEl = isEditing
          ? `<input class="pack-edit" data-id="${escapeHtml(entry.id)}" type="text" ` +
            `maxlength="60" value="${escapeHtml(entry.title)}" spellcheck="false">`
          : `<span class="pack-name">${escapeHtml(entry.title)}</span>`
        return (
          `<div class="pack-row${isCurrent ? ' current' : ''}${isEditing ? ' editing' : ''}" ` +
          `data-id="${escapeHtml(entry.id)}">` +
          `<button class="pack-pick" data-id="${escapeHtml(entry.id)}" type="button">` +
          art +
          `<span class="pack-text">${nameEl}` +
          `<span class="pack-meta">${isCurrent ? '当前 · ' : ''}${escapeHtml(meta)}</span>` +
          `</span></button>` +
          `<button class="pack-ren" data-id="${escapeHtml(entry.id)}" ` +
          `type="button" title="改名（会同时改目录名）">✎</button>` +
          `<button class="pack-del${confirming ? ' armed' : ''}" data-id="${escapeHtml(entry.id)}" ` +
          `type="button" title="${confirming ? '再点一次确认删除（曲包目录会被删掉）' : '删除这个曲包'}">` +
          `${confirming ? '删除？' : '✕'}</button>` +
          `</div>`
        )
      })
      .join('')
    if (editing) {
      const input = listEl.querySelector<HTMLInputElement>(`.pack-edit[data-id="${cssEscape(editing)}"]`)
      input?.focus()
      input?.select()
    }
    void hydrateThumbs()
  }

  function cssEscape(text: string): string {
    return text.replace(/["\\]/g, '\\$&')
  }

  /** 补上还没有的缩略图。失败就当没有图，占位块照常显示 */
  async function hydrateThumbs(): Promise<void> {
    if (!opts.loadThumb) return
    for (const entry of rows) {
      if (!entry.thumb || thumbs.has(entry.id)) continue
      try {
        const url = await opts.loadThumb(entry)
        if (!url) continue
        thumbs.set(entry.id, url)
        const img = listEl.querySelector<HTMLImageElement>(
          `.pack-row[data-id="${cssEscape(entry.id)}"] .pack-thumb img`,
        )
        if (img) img.src = url
        else if (isVisible()) render()
      } catch {
        /* 没有图就没有图 */
      }
    }
  }

  function forgetThumbs(): void {
    const alive = new Set(rows.map((r) => r.id))
    for (const [id, url] of thumbs) {
      if (alive.has(id)) continue
      try {
        URL.revokeObjectURL(url)
      } catch {
        /* ignore */
      }
      thumbs.delete(id)
    }
  }

  async function handleDelete(id: string): Promise<void> {
    if (deleting || !id) return
    if (armed !== id) {
      armed = id
      editing = ''
      render()
      if (armTimer) window.clearTimeout(armTimer)
      armTimer = window.setTimeout(() => {
        armed = ''
        armTimer = 0
        render()
      }, ARM_MS)
      return
    }
    // 第二次点击：真删
    disarm()
    deleting = true
    try {
      await opts.onDelete?.(id)
    } finally {
      deleting = false
    }
    // 删成功时调用方会 refresh()（列表短了一行）；失败就重画，把「删除？」收回去
    render()
  }

  async function commitRename(id: string, value: string): Promise<void> {
    const title = value.trim()
    const entry = rows.find((r) => r.id === id)
    if (!title || !entry || title === entry.title) {
      editing = ''
      render()
      return
    }
    renaming = true
    try {
      const ok = await opts.onRename?.(id, title)
      if (ok !== false) editing = ''
    } finally {
      renaming = false
    }
    render()
  }

  listEl.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('.pack-edit')) return
    if (target?.closest('.pack-del')) {
      const id = target.closest<HTMLElement>('.pack-del')?.dataset.id
      if (id) void handleDelete(id)
      return
    }
    if (target?.closest('.pack-ren')) {
      const id = target.closest<HTMLElement>('.pack-ren')?.dataset.id
      if (!id) return
      disarm()
      editing = editing === id ? '' : id
      render()
      return
    }
    const pick = target?.closest<HTMLElement>('.pack-pick')
    if (!pick) return
    const id = pick.dataset.id
    if (!id) return
    if (editing) {
      editing = ''
      render()
      return
    }
    close()
    opts.onPick(id)
  })

  // 改名输入框的键全部由这里接管：Enter 提交 / Esc 取消，其它键照常输入。
  // 必须在**捕获阶段**处理：别的模块（主循环的热键）也挂在 window 上，
  // 不在这里拦掉的话，在输入框里打一个 s 就会被当成「开关选曲面板」。
  window.addEventListener(
    'keydown',
    (event) => {
      if (!isVisible()) return
      const edit = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.pack-edit')
      if (edit) {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          if (!renaming) void commitRename(edit.dataset.id ?? '', edit.value)
        } else if (event.key === 'Escape') {
          event.preventDefault()
          editing = ''
          render()
        }
        return
      }
      const k = event.key.toLowerCase()
      if (k === 'escape' || k === 's') {
        close()
        event.preventDefault()
        event.stopPropagation()
      }
    },
    true,
  )
  listEl.addEventListener(
    'focusout',
    (event) => {
      const input = (event.target as HTMLElement | null)?.closest<HTMLInputElement>('.pack-edit')
      if (!input) return
      // 点「✏」或别的行时 click 会先到；只用微任务让位一下，别把正在提交的输入框关掉
      window.setTimeout(() => {
        if (!document.body.contains(input) || editing === '') return
        if (document.activeElement === input) return
        editing = ''
        render()
      }, 60)
    },
    true,
  )

  // Esc / S 关闭。捕获阶段 + stopPropagation：这是面板自己的开关，
  // 不能让主循环的热键再处理一遍（否则 S 会被「关掉」和「打开」各执行一次，
  // 看着像没反应）；上面那个监听器已经接管了输入框内的按键。

  return {
    toggle(entries, currentId) {
      if (isVisible()) {
        close()
        return
      }
      rows = entries
      current = currentId
      disarm()
      editing = ''
      forgetThumbs()
      render()
      root.classList.add('on')
    },
    refresh(entries, currentId) {
      rows = entries
      current = currentId
      forgetThumbs()
      if (isVisible()) render()
    },
    close,
    isVisible,
    contains(clientX, clientY) {
      if (!isVisible()) return false
      const rect = root.getBoundingClientRect()
      return (
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      )
    },
  }
}
