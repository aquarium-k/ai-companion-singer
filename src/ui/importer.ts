/**
 * 导入面板（B1）。
 *
 * 流程：选音频 → 选歌词 → 开始 → 轮询进度。
 *
 * 歌词是必需的：自动对齐要拿歌词文本去和 ASR 词做匹配，没有歌词就只能走
 * 「无歌词路径」（`auto_lyrics.py`），那条路的文字准确率只有 39%，还没接进来。
 * 所以面板先把歌词收齐再启动，而不是让流水线跑到第四步才报错。
 *
 * 渲染层只做三件事：把路径交给主进程、每秒轮询 `job.json`、把结果画出来。
 * 真正的活儿（spawn Python、写曲包目录）都在主进程，见 `electron/pipeline.cjs`。
 */

const STAGE_ORDER: ImportStageName[] = ['pack', 'lyrics', 'separate', 'f0', 'align', 'units', 'choreo']
const POLL_MS = 800

const ICON: Record<string, string> = {
  pending: '○',
  running: '●',
  done: '✓',
  failed: '✕',
}

export type ImporterApi = {
  /** 打开面板等用户选歌词 */
  start: (audioPath: string, title: string) => void
  /** 音频和歌词一起拖进来：直接开跑 */
  startWith: (audioPath: string, title: string, lyricsPath: string) => Promise<void>
  /** 面板开着时又拖进来一个歌词文件 */
  setLyrics: (lyricsPath: string) => void
  /**
   * 接回上次没跑完的导入（窗口重开 / 崩溃恢复）。
   * 返回 true 表示真的接上了（面板已经打开、开始轮询）。
   */
  resume: (packId: string) => Promise<boolean>
  /** 屏幕坐标是否落在面板上（点击穿透要用） */
  contains: (clientX: number, clientY: number) => boolean
  isVisible: () => boolean
  close: () => void
}

type Options = {
  banner: (text: string, ms?: number) => void
  /** 导入完成、已写进 index.json；由调用方决定怎么载入 */
  onComplete: (packId: string) => void
}

type Phase = 'idle' | 'pending' | 'running' | 'failed'

export function createImporter(root: HTMLElement, opts: Options): ImporterApi {
  const titleEl = root.querySelector<HTMLElement>('#import-title')!
  const bpmEl = root.querySelector<HTMLElement>('#import-bpm')!
  const sourceEl = root.querySelector<HTMLElement>('#import-source')!
  const lyricsEl = root.querySelector<HTMLElement>('#import-lyrics')!
  const pickLyricsBtn = root.querySelector<HTMLButtonElement>('#import-pick-lyrics')!
  const autoBtn = root.querySelector<HTMLButtonElement>('#import-auto')!
  const candidatesEl = root.querySelector<HTMLElement>('#import-candidates')!
  const rowsEl = root.querySelector<HTMLElement>('#import-rows')!
  const errorEl = root.querySelector<HTMLElement>('#import-error')!
  const startBtn = root.querySelector<HTMLButtonElement>('#import-start')!
  const retryBtn = root.querySelector<HTMLButtonElement>('#import-retry')!
  const cancelBtn = root.querySelector<HTMLButtonElement>('#import-cancel')!

  let phase: Phase = 'idle'
  let packId = ''
  let audioPath = ''
  let lyricsPath = ''
  /** 曲包里已经有 lyrics.json（上次导入过），不用再选 */
  let reuseLyrics = false
  let title = ''
  let timer = 0

  function setVisible(on: boolean): void {
    root.classList.toggle('on', on)
    root.style.display = on ? '' : 'none'
    if (!on) phase = 'idle'
  }

  function isVisible(): boolean {
    return root.classList.contains('on')
  }

  function stopPolling(): void {
    window.clearTimeout(timer)
    timer = 0
  }

  function basename(p: string): string {
    return p.split(/[\\/]/).pop() ?? p
  }

  /** txt 没有时间轴，align 要跑 ASR（1–2 分钟）；提前说一声，别让人以为卡住了 */
  function noteLyricsKind(filePath: string): void {
    if (/\.txt$/i.test(filePath)) {
      opts.banner('这份歌词没有时间轴：导入时会跑 ASR 补轴，多花 1–2 分钟', 3600)
    }
  }

  function renderPhase(): void {
    sourceEl.style.display = phase === 'pending' ? '' : 'none'
    candidatesEl.style.display = phase === 'pending' ? '' : 'none'
    startBtn.style.display = phase === 'pending' ? '' : 'none'
    startBtn.disabled = !lyricsPath && !reuseLyrics
    retryBtn.style.display = phase === 'failed' ? '' : 'none'
    cancelBtn.style.display = phase === 'running' ? '' : phase === 'pending' ? '' : 'none'
  }

  function renderStages(job: ImportJob): void {
    const parts: string[] = []
    for (const name of STAGE_ORDER) {
      const stage = job.stages?.[name]
      if (!stage) continue
      const state = stage.state ?? 'pending'
      const seconds = stage.seconds ? `${stage.seconds.toFixed(1)}s` : ''
      parts.push(
        `<div class="import-row ${state}">` +
          `<span class="import-icon">${ICON[state] ?? '○'}</span>` +
          `<span class="import-name">${name}</span>` +
          `<span class="import-label">${escapeHtml(stage.title ?? name)}</span>` +
          `<span class="import-time">${seconds}</span>` +
          `</div>`,
      )
    }
    rowsEl.innerHTML = parts.join('')
  }

  function renderJob(job: ImportJob): void {
    titleEl.textContent = job.title || title || job.id
    bpmEl.textContent = job.bpm ? `${Number(job.bpm).toFixed(1)} BPM` : ''
    renderStages(job)

    const failed =
      job.state === 'failed' || Object.values(job.stages ?? {}).some((s) => s.state === 'failed')
    errorEl.classList.toggle('on', failed)
    errorEl.textContent = failed ? (job.error ?? '').slice(0, 600) : ''
    if (failed) phase = 'failed'
    renderPhase()
  }

  async function poll(): Promise<void> {
    if (!packId || !isVisible()) return
    let job: ImportJob | null | undefined
    try {
      job = await window.pet?.importJob(packId)
    } catch (err) {
      fail(`读进度失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!job) {
      timer = window.setTimeout(() => void poll(), POLL_MS)
      return
    }

    renderJob(job)

    if (job.state === 'done') {
      stopPolling()
      await window.pet?.addToIndex(packId)
      opts.banner(`导入完成：${job.title || packId}`, 2000)
      setVisible(false)
      opts.onComplete(packId)
      return
    }

    if (job.state === 'failed') {
      stopPolling()
      opts.banner('导入失败，看面板里的错误', 2600)
      return
    }

    timer = window.setTimeout(() => void poll(), POLL_MS)
  }

  function openPending(nextAudio: string, nextTitle: string): void {
    audioPath = nextAudio
    title = nextTitle
    phase = 'pending'
    packId = ''
    lyricsPath = ''
    reuseLyrics = false
    errorEl.classList.remove('on')
    errorEl.textContent = ''
    rowsEl.innerHTML = ''
    candidatesEl.innerHTML = ''
    bpmEl.textContent = ''
    titleEl.textContent = title
    lyricsEl.textContent = '未选择'
    lyricsEl.classList.add('warn')
    setVisible(true)
    renderPhase()

    // 同一个曲包重导（比如上次 align 失败）时，不再让用户重选歌词
    void window.pet?.hasLyrics(title).then((exists) => {
      if (!exists || phase !== 'pending') return
      reuseLyrics = true
      lyricsEl.textContent = '沿用已有歌词'
      lyricsEl.classList.remove('warn')
      renderPhase()
    })
  }

  function fail(message: string): void {
    phase = 'failed'
    errorEl.classList.add('on')
    errorEl.textContent = message
    renderPhase()
  }

  /**
   * IPC 的 invoke 是会 reject 的（主进程抛异常时）。之前没接住，
   * 面板就停在「running」转一辈子，连个错误都没有——这正是「等五分钟没反应」的现场。
   */
  async function call<T>(fn: () => Promise<T> | undefined, what: string): Promise<T | undefined> {
    try {
      return await fn()
    } catch (err) {
      fail(`${what}失败：${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  async function begin(): Promise<void> {
    if (!lyricsPath && !reuseLyrics) return
    phase = 'running'
    stopPolling()
    rowsEl.innerHTML = ''
    errorEl.classList.remove('on')
    errorEl.textContent = ''
    renderPhase()

    const result = await call(
      () => window.pet?.startImport({ audioPath, title, lyricsPath: lyricsPath || undefined }),
      '启动导入',
    )
    if (!result?.ok) {
      if (result) fail(result.error ?? '启动失败')
      return
    }
    packId = result.packId ?? ''
    timer = window.setTimeout(() => void poll(), 300)
  }

  pickLyricsBtn.addEventListener('click', async () => {
    const picked = await window.pet?.pickLyrics()
    if (!picked) return
    lyricsPath = picked
    reuseLyrics = false
    lyricsEl.textContent = basename(picked)
    lyricsEl.classList.remove('warn')
    candidatesEl.innerHTML = ''
    noteLyricsKind(picked)
    renderPhase()
  })

  /**
   * 自动找歌词：先搜候选，再由用户点选。
   * 不做「自动选第一条」——同名翻唱、伴奏版本太多，选错了要重新走一遍流水线。
   */
  autoBtn.addEventListener('click', async () => {
    if (!window.pet) return
    autoBtn.disabled = true
    candidatesEl.innerHTML = '<div class="import-cand-hint">搜索中…</div>'
    try {
      const result = await call(() => window.pet?.searchLyrics(title), '搜索歌词')
      if (!result) return
      if (!result.ok) {
        candidatesEl.innerHTML = `<div class="import-cand-hint error">${escapeHtml(result.error ?? '搜索失败')}</div>`
        return
      }
      const list = result.candidates ?? []
      if (list.length === 0) {
        candidatesEl.innerHTML = '<div class="import-cand-hint">没搜到，换个文件名或手动选歌词</div>'
        return
      }
      candidatesEl.innerHTML = list
        .slice(0, 6)
        .map(
          (item) =>
            `<button class="import-cand" data-id="${item.id}" data-name="${escapeHtml(item.name)}" data-artists="${escapeHtml(item.artists)}">` +
            `<span class="cand-name">${escapeHtml(item.name)}</span>` +
            `<span class="cand-meta">${escapeHtml(item.artists)} · ${Math.round(item.duration)}s</span>` +
            `</button>`,
        )
        .join('')
    } finally {
      autoBtn.disabled = false
    }
  })

  candidatesEl.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>('.import-cand')
    if (!button) return
    const id = Number(button.dataset.id)
    if (!id) return
    candidatesEl.innerHTML = '<div class="import-cand-hint">下载歌词…</div>'
    const result = await call(
      () =>
        window.pet?.fetchLyrics({
          id,
          name: button.dataset.name ?? '',
          artists: button.dataset.artists ?? '',
        }),
      '下载歌词',
    )
    if (!result) return
    if (!result.ok || !result.path) {
      candidatesEl.innerHTML = `<div class="import-cand-hint error">${escapeHtml(result.error ?? '下载失败')}</div>`
      return
    }
    lyricsPath = result.path
    reuseLyrics = false
    lyricsEl.textContent = `${result.name ?? basename(result.path)}（${result.lines ?? 0} 行）`
    lyricsEl.classList.remove('warn')
    candidatesEl.innerHTML = ''
    opts.banner(`歌词：${result.name ?? ''} ${result.artists ?? ''}`, 2200)
    renderPhase()
  })

  startBtn.addEventListener('click', () => void begin())

  retryBtn.addEventListener('click', async () => {
    const job = await call(() => window.pet?.importJob(packId), '读进度')
    if (!job) return
    const failedStage = STAGE_ORDER.find((name) => job.stages?.[name]?.state === 'failed')
    if (!failedStage) return
    opts.banner(`重试 ${failedStage}…`, 1200)
    const result = await call(
      () =>
        window.pet?.startImport({
          audioPath,
          title,
          lyricsPath: lyricsPath || undefined,
          only: failedStage,
        }),
      '重试',
    )
    if (!result) return
    if (!result.ok) {
      errorEl.textContent = result.error ?? '重试失败'
      return
    }
    phase = 'running'
    renderPhase()
    stopPolling()
    timer = window.setTimeout(() => void poll(), 300)
  })

  cancelBtn.addEventListener('click', async () => {
    await window.pet?.cancelImport()
    stopPolling()
    setVisible(false)
    opts.banner('已取消导入', 1200)
  })

  // BPM 可以在导入前手改：自动检测在快歌/三连音上可能给成两倍速
  bpmEl.addEventListener('click', () => {
    if (phase !== 'running') return
    const current = Number(bpmEl.textContent?.replace(/[^\d.]/g, '') ?? '') || 0
    const input = window.prompt('BPM（改完会从 pack 阶段重跑）', String(current || 120))
    if (!input) return
    const next = Number(input)
    if (!Number.isFinite(next) || next < 40 || next > 240) {
      opts.banner('BPM 要在 40–240 之间', 1800)
      return
    }
    void (async () => {
      // 只重跑 choreo：pack.json 里的 bpm 由流水线自己改，没必要重跑分离和 ASR
      const result = await call(
        () =>
          window.pet?.startImport({
            audioPath,
            title,
            lyricsPath: lyricsPath || undefined,
            bpm: next,
            only: 'choreo',
          }),
        '改 BPM',
      )
      if (!result) return
      if (!result.ok) {
        opts.banner(result.error ?? '改 BPM 失败', 2000)
        return
      }
      packId = result.packId ?? packId
      bpmEl.textContent = `${next.toFixed(1)} BPM`
      stopPolling()
      timer = window.setTimeout(() => void poll(), 400)
    })()
  })

  setVisible(false)

  return {
    start: openPending,

    async startWith(nextAudio, nextTitle, nextLyrics) {
      lyricsPath = nextLyrics
      openPending(nextAudio, nextTitle)
      await begin()
    },

    setLyrics(nextLyrics) {
      lyricsPath = nextLyrics
      lyricsEl.textContent = basename(nextLyrics)
      lyricsEl.classList.remove('warn')
      noteLyricsKind(nextLyrics)
      renderPhase()
    },

    async resume(nextPackId) {
      if (!nextPackId) return false
      let job: ImportJob | null | undefined
      try {
        job = await window.pet?.importJob(nextPackId)
      } catch {
        return false
      }
      if (!job) return false
      // 跑完的、失败的都不要跳出来打扰：前者已经登记进曲包，后者等用户自己按 R 重试
      if (job.state === 'done' || job.state === 'failed') return false
      packId = nextPackId
      title = job.title ?? ''
      audioPath = job.audio ?? ''
      lyricsPath = ''
      reuseLyrics = true
      phase = 'running'
      errorEl.classList.remove('on')
      errorEl.textContent = ''
      setVisible(true)
      renderJob(job)
      stopPolling()
      timer = window.setTimeout(() => void poll(), 400)
      return true
    },

    isVisible,
    contains(clientX, clientY) {
      if (!isVisible()) return false
      const rect = root.getBoundingClientRect()
      return (
        clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
      )
    },
    close() {
      stopPolling()
      setVisible(false)
    },
  }
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}
