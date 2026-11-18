export {}

declare global {
  interface Window {
    pet?: {
      setIgnoreMouse(ignore: boolean): void
      getPaths(): Promise<{ root: string; songpacks: string; models: string }>
      getConfig(): Promise<{
        lastModel?: string
        window?: WindowBounds
        /** 上一次导入的任务（窗口重开时用来接回进度） */
        lastJob?: { packId: string; audioPath: string } | null
        pythonPath?: string
      }>
      setConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>>
      listModels(): Promise<string[]>
      readFile(path: string): Promise<Uint8Array | null>
      /**
       * 读 dist 目录下的静态资源（相对路径，如 `voices/harmony.wav`）。
       * Electron 的 file:// 页面不能用 fetch 读本地文件，声音资源走这里。
       */
      readAsset?(relPath: string): Promise<Uint8Array | null>
      writeFile(path: string, text: string): Promise<boolean>
      pickModel(): Promise<string | null>
      quit(): void

      // 导入歌曲（B1）
      pickAudio(): Promise<string | null>
      pickLyrics(): Promise<string | null>
      searchLyrics(
        query: string,
        duration?: number,
      ): Promise<{ ok: boolean; candidates?: LyricCandidate[]; error?: string }>
      fetchLyrics(song: { id: number; name: string; artists?: string }): Promise<{
        ok: boolean
        path?: string
        lines?: number
        name?: string
        artists?: string
        error?: string
      }>
      startImport(options: ImportOptions): Promise<ImportStartResult>
      importJob(packId: string): Promise<ImportJob | null>
      hasLyrics(title: string): Promise<boolean>
      cancelImport(): Promise<{ ok: boolean; error?: string }>
      importStatus(): Promise<{
        busy: boolean
        python: string | null
        current: { packId: string; audioPath: string; title: string; job: ImportJob | null } | null
        /** 这个版本能不能导入（打包版要看有没有装 creator pack） */
        available: boolean
        /** 做曲包组件该放哪（没有组件时提示用户用） */
        creatorDir: string
      }>
      addToIndex(packId: string): Promise<string[]>
      /** 做曲包组件：弹原生说明框（装了就直接打开目录） */
      creatorInfo(): Promise<void>
      /** 做曲包组件：打开组件目录 */
      openCreatorDir(): Promise<{ ok: boolean; dir?: string; error?: string }>
      /** 删除曲包（目录 + index.json 登记）；`ok:false` 时 `error` 是要显示的原因 */
      deletePack(packId: string): Promise<{ ok: boolean; packs?: string[]; error?: string }>
      /**
       * 改曲包名字。目录名 = 曲包 id，所以这会**连带改目录**，
       * 返回的 `id` 是新 id，界面要按它重开。
       */
      renamePack(
        packId: string,
        title: string,
      ): Promise<{ ok: boolean; id?: string; title?: string; packs?: string[]; error?: string }>

      toggleLock(): void
      getLocked(): Promise<boolean>

      dragStart(): void
      dragMove(): void
      dragEnd(): void
      zoom(delta: number): void
      /** 写系统剪贴板（渲染层的 navigator.clipboard 在非聚焦窗口里会失败） */
      copyText(text: string): void
      /** 姿势编辑器要更大的画布 */
      resizeWindow(width: number, height: number): void
      showMenu(): void
      resetPosition(): void
      /** 走路：按像素推窗口。false = 撞到屏幕边缘被夹住（渲染层据此收脚） */
      nudgeWindow?(dx: number, dy: number): Promise<boolean>

      getPathForFile(file: File): string
      onCommand(cb: (cmd: string) => void): void
      onCursor(cb: (point: { nx: number; ny: number }) => void): void
    }
  }

  interface WindowBounds {
    x: number
    y: number
    width: number
    height: number
  }

  /** 流水线阶段，顺序和 tools/pipeline.py 的 STAGES 一致 */
  type ImportStageName = 'pack' | 'lyrics' | 'separate' | 'f0' | 'align' | 'units' | 'choreo'

  interface ImportStage {
    title: string
    state: 'pending' | 'running' | 'done' | 'failed'
    seconds: number | null
    message: string | null
  }

  interface ImportJob {
    schema: number
    id: string
    title: string
    audio: string
    bpm: number | null
    /** running / done / failed / idle */
    state: string
    stage: ImportStageName | null
    progress: number
    error: string | null
    stages: Record<string, ImportStage>
  }

  interface ImportOptions {
    audioPath: string
    /** 用户的歌词文件：.lrc / .txt / .json */
    lyricsPath?: string
    title?: string
    bpm?: number
    /** 只跑这一步（重试用） */
    only?: ImportStageName
    /** 从这一步往后跑 */
    fromStage?: ImportStageName
  }

  interface ImportStartResult {
    ok: boolean
    packId?: string
    title?: string
    log?: string
    error?: string
  }

  interface LyricCandidate {
    id: number
    name: string
    artists: string
    album: string
    duration: number
  }
}
