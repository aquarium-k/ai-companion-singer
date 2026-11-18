const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  dialog,
  screen,
  nativeImage,
  session,
  shell,
  globalShortcut,
  clipboard,
} = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const pipeline = require('./pipeline.cjs')
const { m, setLang, pickLang } = require('./i18n.cjs')

// Windows 上托盘图标和通知都需要一个明确的应用标识，
// 没设置时某些环境下托盘项会注册成功但不可见。
app.setAppUserModelId('com.aicompanion.singer')

// 桌宠没有用户手势，音频必须允许自动播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

const ROOT = path.join(__dirname, '..')
const IS_DEV = Boolean(process.env.VITE_DEV_SERVER_URL)
const SHOT = process.argv.includes('--shot')

/**
 * 往渲染进程塞 URL 参数，例如 `--query duck=1` 或 `--query "duck=0.3&vib=0"`。
 *
 * `win.loadFile()` 支持 query，但之前只传了 `shot=1`——于是 `?vib=`/`?duck=` 这些
 * 调参开关在 Electron 里根本用不上，只能改代码重编译。用命令行参数补上，
 * 方便「听一耳朵再定」。
 */
const EXTRA_QUERY = (() => {
  const arg = process.argv.find((a) => a.startsWith('--query='))
  const raw = arg ? arg.slice('--query='.length) : process.env.PET_QUERY || ''
  const out = {}
  try {
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v
  } catch {
    /* 参数写错了就当没有 */
  }
  return out
})()

/**
 * 可写数据目录。
 *
 * 开发时就在仓库里的 `data/`；**打包之后 ROOT 在 app.asar 里是只读的**，
 * 写 config.json / main.log 会直接抛 EROFS，所以换到系统的 userData
 * （%APPDATA%/<app>/data）。`PET_DATA_DIR` 可以覆盖，便于做便携版或在
 * 多份安装之间共用配置。
 */
const DIR_DATA = (() => {
  const override = process.env.PET_DATA_DIR
  if (override) return path.resolve(override)
  if (!app.isPackaged) return path.join(ROOT, 'data')
  try {
    return path.join(app.getPath('userData'), 'data')
  } catch {
    return path.join(ROOT, 'data')
  }
})()
const DIR_MODELS = app.isPackaged ? path.join(app.getPath('userData'), 'models') : path.join(ROOT, 'models')
/**
 * 打包自带的模型目录。
 *
 * **不在 asar 里**：`extraResources` 把它放在 `resources/models/`（asar 旁边），
 * 所以打包后不能再用 `path.join(ROOT, 'models')` —— ROOT 是 `.../resources/app.asar`，
 * 拼出来是 `app.asar/models`，不存在。2026-11-18 打包验证时踩到：`listModels()` 返回空，
 * 界面掉回占位角色（HUD「角色 primitive」），而 `?model=` 走 fetch 在 file:// 下也不通。
 */
const DIR_MODELS_BUNDLED = app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(ROOT, 'models')

/**
 * 导入流水线的入口脚本。
 *
 * **安装包不带 `tools/`**（它要 Python 3.12 + `.pylibs` 276 MB + SVC 权重 2.5 GB，
 * 见 docs/release.md 三）。所以打包版里这个文件不存在，`import:start` 必须提前拦掉——
 * 以前直接 spawn，用户看到的是 `ENOTDIR, not a directory`（2026-11-18 在打包版实测到）。
 */
const PIPELINE_SCRIPT = path.join(ROOT, 'tools', 'pipeline.py')
const DIR_SHOTS = path.join(ROOT, 'shots')

/**
 * 曲包目录。
 *
 * 打包后必须搬到 userData：`app.asar` 是只读的，而「导入歌曲」要往里写
 * （`pack.json`、`stems/`、`work/`），写在 asar 里直接 EROFS。
 * 首次运行建目录 + 空 `index.json`，否则选曲面板会因为读不到索引而空白且没有提示。
 * `PET_SONGPACKS_DIR` 可覆盖（便携版/多套曲库共用）。
 */
const DIR_SONGPACKS = (() => {
  const override = process.env.PET_SONGPACKS_DIR
  if (override) return path.resolve(override)
  const dir = app.isPackaged ? path.join(app.getPath('userData'), 'songpacks') : path.join(ROOT, 'public', 'songpacks')
  try {
    fs.mkdirSync(dir, { recursive: true })
    const index = path.join(dir, 'index.json')
    if (!fs.existsSync(index)) {
      fs.writeFileSync(index, `${JSON.stringify({ schema: 1, packs: [] }, null, 2)}\n`, 'utf8')
    }
  } catch {
    /* 目录建不出来就让后面的读取报错，不要在这里崩 */
  }
  return dir
})()
const CONFIG_PATH = path.join(DIR_DATA, 'config.json')
const LOG_PATH = path.join(DIR_DATA, 'main.log')

pipeline.init({ root: ROOT, songpacks: DIR_SONGPACKS, pythonPath: readConfig().pythonPath })
// 菜单语言：环境变量 PET_LANG > 存档 lang > 系统语言（渲染层用同一套优先级，见 src/i18n）
let menuLang = setLang(pickLang({ saved: readConfig().lang, system: app.getLocale() }))

/** 当前菜单语言（右键菜单的 radio 用） */
function currentMenuLang() {
  return menuLang
}

/**
 * 切语言：改菜单文案 + 写存档 + 通知渲染层。
 *
 * 原生菜单是**每次右键重建**的，所以这里只要改 `menuLang`，下次右键就是新语言；
 * 托盘菜单是常驻的，要重建一次（`buildTrayMenu()` 已在 createTray 里定义）。
 */
function switchLang(next) {
  menuLang = setLang(next)
  try {
    writeConfig({ lang: menuLang })
  } catch {
    /* 写不了就算了，下次启动回系统语言 */
  }
  if (tray) {
    try {
      tray.setContextMenu(buildTrayMenu())
    } catch {
      /* 托盘还没建好 */
    }
  }
  win?.webContents.send('cmd', `lang:${menuLang}`)
}

// electron.exe 是 GUI 子系统程序，主进程的 console.log 在 Windows 终端里看不到，
// 所以关键状态同时写文件。
function logToFile(...args) {
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')
  try {
    fs.mkdirSync(DIR_DATA, { recursive: true })
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${text}\n`, 'utf8')
  } catch {
    /* ignore */
  }
  console.log(text)
}

const DEFAULT_SIZE = { width: 480, height: 680 }
const SIZE_PRESETS = [
  { label: m('sizeS'), width: 380, height: 520 },
  { label: m('sizeM'), width: 480, height: 680 },
  { label: m('sizeL'), width: 580, height: 790 },
  { label: m('sizeXl'), width: 700, height: 950 },
]

let win = null
let tray = null
let locked = false
let cursorTimer = null
let boundsTimer = null
let dragState = null
let lastLoggedSize = null

/**
 * 窗口的「权威尺寸」。
 *
 * 不能每次拖拽都从 getBounds() 重新读：125% 缩放下 DIP↔物理像素取整，
 * 读回来的值可能比设进去的大 1px，下一次拖拽把这个值当基准，误差就滚起来了。
 * 所以尺寸只由显式操作（预设 / 缩放 / 重置 / 启动恢复）修改，
 * 拖拽全程只用这个值，永远不回头读。
 */
let canonicalSize = null

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  try {
    fs.mkdirSync(DIR_DATA, { recursive: true })
    const next = { ...readConfig(), ...(patch || {}) }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
    return next
  } catch (err) {
    logToFile('[config] 写入失败', String(err))
    return readConfig()
  }
}

// ---------------------------------------------------------------------------
// 窗口位置与尺寸
// ---------------------------------------------------------------------------

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay()
  return {
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    x: workArea.x + workArea.width - DEFAULT_SIZE.width - 24,
    y: workArea.y + workArea.height - DEFAULT_SIZE.height - 12,
  }
}

/** 保证窗口至少有一部分落在某个显示器的工作区里，否则拉回主屏右下角 */
function clampToDisplay(bounds) {
  const displays = screen.getAllDisplays()
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2

  for (const d of displays) {
    const wa = d.workArea
    if (cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height) {
      return bounds
    }
  }

  const fallback = defaultBounds()
  return {
    ...bounds,
    x: fallback.x,
    y: fallback.y,
    width: Math.min(bounds.width, 1200),
    height: Math.min(bounds.height, 1200),
  }
}

function loadBounds() {
  const saved = readConfig().window
  if (
    saved &&
    Number.isFinite(saved.x) &&
    Number.isFinite(saved.y) &&
    Number.isFinite(saved.width) &&
    Number.isFinite(saved.height)
  ) {
    return clampToDisplay(saved)
  }
  return defaultBounds()
}

// setBounds 触发的 resized 事件是异步的，所以用时间戳而不是布尔标记来判断归属
let lastProgrammaticAt = 0

function applyBounds(bounds) {
  if (!win || win.isDestroyed()) return
  lastProgrammaticAt = Date.now()
  win.setBounds({
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  })
}

function setCanonicalSize(width, height) {
  canonicalSize = { width: Math.round(width), height: Math.round(height) }
}

function currentSize() {
  if (canonicalSize) return canonicalSize
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    setCanonicalSize(b.width, b.height)
    return canonicalSize
  }
  return { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height }
}

function wasProgrammatic() {
  return Date.now() - lastProgrammaticAt < 150
}

function saveBoundsSoon() {
  clearTimeout(boundsTimer)
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const size = currentSize()

    // 存权威尺寸，不存 getBounds() 的取整结果，避免把误差写进配置
    writeConfig({ window: { x: b.x, y: b.y, width: size.width, height: size.height } })

    if (
      lastLoggedSize &&
      (Math.abs(size.width - lastLoggedSize.width) > 2 ||
        Math.abs(size.height - lastLoggedSize.height) > 2)
    ) {
      logToFile(`[window] size ${lastLoggedSize.width}x${lastLoggedSize.height} -> ${size.width}x${size.height}`)
    }
    lastLoggedSize = { width: size.width, height: size.height }
  }, 400)
}

/** 别让窗口被放大到超出当前显示器的工作区 */
function clampSize(width, height) {
  let area = screen.getPrimaryDisplay().workArea
  if (win && !win.isDestroyed()) {
    area = screen.getDisplayMatching(win.getBounds()).workArea
  }
  return {
    width: Math.round(Math.max(300, Math.min(width, area.width - 32))),
    height: Math.round(Math.max(400, Math.min(height, area.height - 32))),
  }
}

function applySize(width, height) {
  if (!win || win.isDestroyed()) return
  const size = clampSize(width, height)
  setCanonicalSize(size.width, size.height)

  const b = win.getBounds()
  // 锚定右下角，缩放时角色不会跑出鼠标位置
  applyBounds({
    x: b.x + b.width - size.width,
    y: b.y + b.height - size.height,
    width: size.width,
    height: size.height,
  })
  saveBoundsSoon()
}

function resetPosition() {
  if (!win || win.isDestroyed()) return
  const b = defaultBounds()
  setCanonicalSize(b.width, b.height)
  applyBounds(b)
  saveBoundsSoon()
}

function zoomWindow(delta) {
  if (!win || win.isDestroyed()) return
  const b = win.getBounds()
  const ratio = b.height / b.width
  const factor = delta > 0 ? 1.08 : 1 / 1.08
  const size = clampSize(Math.round(b.width * factor), Math.round(b.width * factor * ratio))
  applySize(size.width, size.height)
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow() {
  const bounds = loadBounds()
  setCanonicalSize(bounds.width, bounds.height)

  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    // 先出现在任务栏上：即使托盘创建失败，启动瞬间也有入口。
    // 托盘确认可用之后再收起来。
    skipTaskbar: false,
    alwaysOnTop: true,
    focusable: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })

  // 任务栏/窗口图标：同样优先 png（ICO 走 nativeImage 解不出来，见 createTray 的注释）
  const iconForWindow = [path.join(__dirname, 'icon.png'), path.join(__dirname, 'icon.ico')].find((p) =>
    fs.existsSync(p),
  )
  if (iconForWindow) {
    try {
      win.setIcon(iconForWindow)
    } catch {
      /* 设不了就沿用默认图标 */
    }
  }

  const query = { ...(SHOT ? { shot: '1' } : {}), ...EXTRA_QUERY }
  const hasQuery = Object.keys(query).length > 0

  if (IS_DEV) {
    const url = process.env.VITE_DEV_SERVER_URL
    const qs = new URLSearchParams(query).toString()
    win.loadURL(SHOT || qs ? `${url}?${qs || 'shot=1'}` : url)
  } else {
    win.loadFile(path.join(ROOT, 'dist', 'index.html'), hasQuery ? { query } : undefined)
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 移动过程中如果尺寸被系统改了，立刻按拖拽开始时钉住的宽高纠回来
  win.on('moved', () => {
    if (dragState && !wasProgrammatic() && win && !win.isDestroyed()) {
      const b = win.getBounds()
      if (b.width !== dragState.width || b.height !== dragState.height) {
        logToFile(`[drag] 移动中尺寸漂移 ${b.width}x${b.height} -> 纠正回 ${dragState.width}x${dragState.height}`)
        applyBounds({
          x: b.x,
          y: b.y,
          width: dragState.width,
          height: dragState.height,
        })
      }
    }
    saveBoundsSoon()
  })

  win.on('resized', () => {
    if (!wasProgrammatic() && win && !win.isDestroyed()) {
      const b = win.getBounds()
      const size = currentSize()
      logToFile(`[window] 非代码触发的大小变化 ${b.width}x${b.height} -> 纠正回 ${size.width}x${size.height}`)
      applyBounds({ x: b.x, y: b.y, width: size.width, height: size.height })
    }
    saveBoundsSoon()
  })
  win.on('closed', () => {
    win = null
  })

  if (SHOT) {
    win.webContents.once('did-finish-load', () => {
      void runShotSequence()
    })
  }
}

function send(cmd) {
  if (win && !win.isDestroyed()) win.webContents.send('cmd', cmd)
}

// ---------------------------------------------------------------------------
// 全局光标追踪
// ---------------------------------------------------------------------------

function startCursorTracking() {
  stopCursorTracking()
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    const point = screen.getCursorScreenPoint()
    const bounds = win.getBounds()
    if (bounds.width <= 0 || bounds.height <= 0) return

    const nx = ((point.x - bounds.x) / bounds.width) * 2 - 1
    const ny = -(((point.y - bounds.y) / bounds.height) * 2 - 1)
    win.webContents.send('cursor', { nx, ny })
  }, 33)
}

function stopCursorTracking() {
  if (cursorTimer) {
    clearInterval(cursorTimer)
    cursorTimer = null
  }
}

// ---------------------------------------------------------------------------
// 全局快捷键
// ---------------------------------------------------------------------------

const SHORTCUTS = [
  ['Control+Alt+1', 'bounce'],
  ['Control+Alt+2', 'wave'],
  ['Control+Alt+3', 'spin'],
  ['Control+Alt+4', 'nod'],
  ['Control+Alt+5', 'shake'],
  ['Control+Alt+6', 'peace'],
  ['Control+Alt+7', 'sing'],
  ['Control+Alt+8', 'cheer'],
  ['Control+Alt+9', 'lean'],
  ['Control+Alt+C', 'clap'],
  ['Control+Alt+F', 'cam'],
  ['Control+Alt+E', 'editor'],
  ['Control+Alt+T', 'talk'],
  ['Control+Alt+X', 'motion'],
  ['Control+Alt+Z', 'zoom'],
  ['Control+Alt+P', 'play'],
  ['Control+Alt+R', 'restart'],
  ['Control+Alt+0', 'metronome'],
  ['Control+Alt+H', 'hud'],
  ['Control+Alt+L', 'lock'],
  ['Control+Alt+Q', 'quit'],
]

function registerShortcuts() {
  for (const [accelerator, cmd] of SHORTCUTS) {
    try {
      const ok = globalShortcut.register(accelerator, () => {
        if (cmd === 'lock') setLocked(!locked)
        else if (cmd === 'quit') app.quit()
        else send(cmd)
      })
      if (!ok) logToFile(`[shortcut] ${accelerator} 注册失败（可能被其他程序占用）`)
    } catch (err) {
      logToFile(`[shortcut] ${accelerator} 注册异常`, String(err))
    }
  }
}

function unregisterShortcuts() {
  try {
    globalShortcut.unregisterAll()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// 点击穿透
// ---------------------------------------------------------------------------

function setLocked(next) {
  locked = Boolean(next)
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(locked, { forward: true })
  }
  if (tray) tray.setContextMenu(buildTrayMenu())
  send(locked ? 'lock-on' : 'lock-off')
}

// ---------------------------------------------------------------------------
// 截图序列（无人值守验证用）
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function capture(name) {
  if (!win || win.isDestroyed()) return
  const image = await win.webContents.capturePage()
  fs.mkdirSync(DIR_SHOTS, { recursive: true })
  const file = path.join(DIR_SHOTS, `${name}.png`)
  fs.writeFileSync(file, image.toPNG())
  logToFile('[shot]', file)
}

async function runShotSequence() {
  try {
    await delay(1600)
    await capture('a-idle')
    send('bounce')
    await delay(900)
    await capture('b-bounce')
    send('wave')
    await delay(520)
    await capture('c-wave')
    send('peace')
    await delay(450)
    await capture('d-peace')
  } catch (err) {
    logToFile('[shot] failed', String(err))
  } finally {
    app.quit()
  }
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

/**
 * 右键菜单里的动作列表。
 *
 * 名字以**实际播放的动画**为准，不是以内部 id 为准：
 * 以前第一项写「弹跳」，但 `bounce` 放的是 `dance.bounce`——那一支是左右**摇摆**，
 * 用户一眼就看出对不上（2026-11-13：「最上面那个字是弹跳但实际上是摇摆」）。
 * 现在文案和 `src/index.html` 的按键提示一致：1 摇摆 / 2 挥手 / 3 转圈 …
 *
 * id 和键位对应关系：
 *   bounce=1  wave=2  spin=3  nod=4  shake=5  sing=7  cheer=8  lean=9  reach=0
 *   clap=C    hair=N  peace（无键位）
 */
function menuActionItems() {
  return [
    { label: m('bounce'), click: () => send('bounce') },
    { label: m('wave'), click: () => send('wave') },
    { label: m('spin'), click: () => send('spin') },
    { label: m('nod'), click: () => send('nod') },
    { label: m('shake'), click: () => send('shake') },
    { type: 'separator' },
    { label: m('sing'), click: () => send('sing') },
    { label: m('cheer'), click: () => send('cheer') },
    { label: m('lean'), click: () => send('lean') },
    { label: m('reach'), click: () => send('reach') },
    { label: m('peace'), click: () => send('peace') },
    { label: m('clap'), click: () => send('clap') },
    { type: 'separator' },
    { label: m('hair'), click: () => send('hair') },
    { label: m('intro'), click: () => send('intro') },
    { type: 'separator' },
    // 2026-11-15：BVH 重定向 / 程序化过门的入口（以前只能从控制台调 __pet.action）
    { label: m('walk'), click: () => send('walk') },
    { label: m('walkFar'), click: () => send('walk-far') },
    { type: 'separator' },
    // 检查镜头角度用：把她拧到 140° 并保持（两侧都留）
    { label: m('turnCcw'), click: () => send('turn-ccw140') },
    { label: m('turnCw'), click: () => send('turn-220') },
    { label: m('turnFront'), click: () => send('turn-front') },
    { label: m('transition'), click: () => send('transition-demo') },
    { type: 'separator' },
    { label: m('talk'), click: () => send('talk') },
    { label: m('metronome'), click: () => send('metronome') },
  ]
}

/**
 * 右键菜单里的「动作」一项：八个动作收进子菜单。
 *
 * 以前是平铺的——右键一点弹出十几行，找「比耶」要扫一遍（用户 2026-11-13：
 * 「精简成一个动作按钮，像上面的大小那样点上去才显示更多」）。
 */
function actionMenuItem() {
  return { label: m('action'), submenu: menuActionItems() }
}

function sizeItems() {
  return SIZE_PRESETS.map((p) => ({
    label: p.label,
    click: () => applySize(p.width, p.height),
  }))
}

function commonTailItems() {
  return [
    { type: 'separator' },
    {
      label: m('loadVrm'),
      click: async () => {
        const file = await pickModel()
        if (file) send('reload')
      },
    },
    { label: m('reload'), click: () => send('reload') },
    { type: 'separator' },
    { label: m('quit'), click: () => app.quit() },
  ]
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: m('showHide'), click: () => (win?.isVisible() ? win.hide() : win?.show()) },
    {
      label: m('lock'),
      type: 'checkbox',
      checked: locked,
      click: (item) => setLocked(item.checked),
    },
    { label: m('size'), submenu: sizeItems() },
    actionMenuItem(),
    { label: m('resetPos'), click: resetPosition },
    { label: m('taskbar'), click: () => shell.openExternal('ms-settings:taskbar') },
    { type: 'separator' },
    ...commonTailItems(),
  ])
}

function createTray() {
  const icoPath = path.join(__dirname, 'icon.ico')
  const pngPath = path.join(__dirname, 'icon.png')
  /*
   * PNG 优先：Electron 的 nativeImage 只保证 PNG/JPEG 能解码，**ICO 不行**——
   * 打包后日志里每次都是 `[tray] 路径创建失败 icon.ico: Failed to load image`，
   * 然后退回 png 才成功（2026-11-18 看 release 的 main.log 才发现）。
   * ico 仍然留在列表里兜底（也用于 exe 图标/任务栏）。
   */
  const candidates = [pngPath, icoPath].filter((p) => fs.existsSync(p))

  if (candidates.length === 0) {
    logToFile('[tray] 找不到 icon.ico / icon.png，跳过托盘')
    send('tray-fail')
    return
  }

  // 优先用「文件路径」构造：Windows 下 Electron 会自己做 ICO 帧选择和 DPI 适配。
  // 传 NativeImage 时如果尺寸/alpha 不巧，会得到一个「创建成功但看不见」的托盘项。
  for (const file of candidates) {
    try {
      tray = new Tray(file)
      logToFile(`[tray] 用路径创建成功: ${path.basename(file)}`)
      break
    } catch (err) {
      logToFile(`[tray] 路径创建失败 ${path.basename(file)}: ${String(err)}`)
    }
  }

  if (!tray) {
    for (const file of candidates) {
      const image = nativeImage.createFromPath(file)
      if (image.isEmpty()) {
        logToFile(`[tray] NativeImage 解码为空: ${path.basename(file)}`)
        continue
      }
      for (const size of [16, 32, 0]) {
        const candidate = size === 0 ? image : image.resize({ width: size, height: size })
        if (candidate.isEmpty()) continue
        try {
          tray = new Tray(candidate)
          logToFile(`[tray] 用 NativeImage 创建成功: ${path.basename(file)} @${size || '原尺寸'}`)
          break
        } catch (err) {
          logToFile(`[tray] NativeImage 创建失败 @${size || '原尺寸'}: ${String(err)}`)
        }
      }
      if (tray) break
    }
  }

  if (!tray) {
    logToFile('[tray] 所有方式都失败')
    send('tray-fail')
    return
  }

  tray.setToolTip(m('lang') === 'Language' ? 'AI Companion Singer' : m('lang') === '言語 (Language)' ? 'AI 伴唱デスクトップペット' : 'AI 伴唱桌宠')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => (win?.isVisible() ? win.hide() : win?.show()))
}

function reportTray() {
  if (!tray) {
    send('tray-fail')
    return
  }

  // getBounds 能反映 Windows 有没有真的给它分配通知区的位置
  const bounds = tray.getBounds()
  logToFile(`[tray] getBounds = ${bounds.width}x${bounds.height} @ ${bounds.x},${bounds.y}`)

  if (bounds.width === 0 || bounds.height === 0) {
    logToFile('[tray] 警告：系统没有分配托盘位置')
    logToFile('[tray] 常见原因：Windows「选择哪些图标显示在任务栏上」里被关掉，或安全软件接管了通知区')
    logToFile('[tray] 保留任务栏入口')
    // 任务栏按钮从创建时就在，这里不用再加
    send('tray-fail')
    return
  }

  // 托盘可用，把任务栏按钮收起来，回归"干净的桌宠"
  if (win && !win.isDestroyed()) {
    try {
      win.setSkipTaskbar(true)
      logToFile('[tray] 托盘可用，隐藏任务栏按钮')
    } catch {
      /* ignore */
    }
  }

  send('tray-ok')
}

/** 有些环境下第一次注册拿不到位置，销毁重建一次往往就好了 */
function ensureTrayVisible() {
  createTray()
  setTimeout(() => {
    if (!tray) {
      reportTray()
      return
    }
    const b = tray.getBounds()
    if (b.width > 0 && b.height > 0) {
      reportTray()
      return
    }

    logToFile('[tray] 第一次没拿到位置，销毁后重建一次')
    try {
      tray.destroy()
    } catch {
      /* ignore */
    }
    tray = null
    setTimeout(() => {
      createTray()
      setTimeout(reportTray, 600)
    }, 250)
  }, 800)
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

function showContextMenu() {
  if (!win || win.isDestroyed()) return
  const menu = Menu.buildFromTemplate([
    { label: m('size'), submenu: sizeItems() },
    {
      label: m('camera'),
      submenu: [
        // 预设只是入口；连续量（环绕/高度/距离/注视）在面板里调
        { label: m('camFront'), click: () => win?.webContents.send('cmd', 'cam-front') },
        { label: m('camOver'), click: () => win?.webContents.send('cmd', 'cam-over') },
        { type: 'separator' },
        { label: m('camPanel'), click: () => win?.webContents.send('cmd', 'cam-panel') },
        { label: m('camReset'), click: () => win?.webContents.send('cmd', 'cam-reset') },
      ],
    },
    actionMenuItem(),
    { label: m('resetPos'), click: resetPosition },
    { label: m('saySong'), click: () => win?.webContents.send('cmd', 'say-song') },
    { label: m('mic'), click: () => win?.webContents.send('cmd', 'mic') },
    { label: m('import'), click: () => win?.webContents.send('cmd', 'import') },
    {
      // 语言：菜单文案是启动时定的，这里切换后要**重建菜单**才看得到变化；
      // 渲染层的界面会立刻变（走 `cmd lang:xx`）。
      label: m('lang'),
      submenu: [
        { label: '简体中文', type: 'radio', checked: currentMenuLang() === 'zh-CN', click: () => switchLang('zh-CN') },
        { label: '日本語', type: 'radio', checked: currentMenuLang() === 'ja', click: () => switchLang('ja') },
        { label: 'English', type: 'radio', checked: currentMenuLang() === 'en-US', click: () => switchLang('en-US') },
      ],
    },
    { label: m('taskbar'), click: () => shell.openExternal('ms-settings:taskbar') },
    { type: 'separator' },
    {
      label: m('lock'),
      type: 'checkbox',
      checked: locked,
      click: (item) => setLocked(item.checked),
    },
    { label: m('showHide'), click: () => (win?.isVisible() ? win.hide() : win?.show()) },
    ...commonTailItems(),
  ])
  menu.popup({ window: win })
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

async function pickModel() {
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择 VRM 模型',
    properties: ['openFile'],
    filters: [{ name: 'VRM 模型', extensions: ['vrm'] }],
  })
  const file = result.filePaths?.[0]
  if (!file || result.canceled) return null
  writeConfig({ lastModel: file })
  return file
}

ipcMain.on('set-ignore-mouse', (_event, ignore) => {
  if (!win || win.isDestroyed()) return
  if (locked) {
    win.setIgnoreMouseEvents(true, { forward: true })
    return
  }
  win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
})

ipcMain.on('toggle-lock', () => setLocked(!locked))
ipcMain.handle('get-locked', () => locked)

ipcMain.on('show-menu', showContextMenu)
ipcMain.on('reset-position', resetPosition)
ipcMain.on('zoom', (_event, delta) => {
  // 拖拽过程中不响应缩放，避免两个操作互相干扰
  if (dragState) return
  logToFile(`[zoom] delta=${delta}`)
  zoomWindow(Number(delta) || 0)
})

// 姿势编辑器导出的 JSON 走主进程剪贴板。
// 渲染层的 navigator.clipboard.writeText 要求文档处于聚焦状态，而桌宠窗口
// 平时是点击穿透、不抢焦点的 —— 用它会静默失败（用户看到「已复制」但剪贴板是空的）。
ipcMain.on('copy-text', (_event, text) => {
  try {
    clipboard.writeText(String(text ?? ''))
    logToFile(`[copy-text] ${String(text ?? '').length} 字符`)
  } catch (err) {
    logToFile('[copy-text] 失败', String(err))
  }
})

// 姿势编辑器要更大的画布：打开时放大，关掉时 (0,0) 回到原来的尺寸
let editorPrevSize = null
ipcMain.on('resize-window', (_event, width, height) => {
  if (!win || win.isDestroyed()) return
  const w = Math.round(Number(width) || 0)
  const h = Math.round(Number(height) || 0)

  if (w <= 0 || h <= 0) {
    // 恢复：回到进编辑器之前的尺寸
    if (editorPrevSize) {
      applySize(editorPrevSize.width, editorPrevSize.height)
      editorPrevSize = null
      logToFile('[resize-window] 恢复')
    }
    return
  }

  if (!editorPrevSize) editorPrevSize = { ...currentSize() }
  applySize(w, h)
  logToFile(`[resize-window] ${w}x${h}`)
})

ipcMain.on('drag-start', () => {
  if (!win || win.isDestroyed()) return
  nudgeX = null // 用户接手了：走路的目标位置作废，下次重新对齐
  const b = win.getBounds()
  const size = currentSize()
  dragState = {
    cursor: screen.getCursorScreenPoint(),
    x: b.x,
    y: b.y,
    width: size.width,
    height: size.height,
  }
  logToFile(`[drag] start @ ${size.width}x${size.height}`)
})

ipcMain.on('drag-move', () => {
  if (!win || win.isDestroyed() || !dragState) return
  const point = screen.getCursorScreenPoint()
  const dx = point.x - dragState.cursor.x
  const dy = point.y - dragState.cursor.y

  // 关键：不能用 setPosition。
  // 无边框透明窗口在 Windows 上移动时，系统会按 DPI 重新换算一次尺寸，
  // 每拖一次就涨 2%，几十次之后角色就变成巨人了。
  // 每次都用 setBounds 把拖拽开始时的宽高原样写回去。
  applyBounds({
    x: dragState.x + dx,
    y: dragState.y + dy,
    width: dragState.width,
    height: dragState.height,
  })
})

/**
 * 走路用的「目标 x」。
 *
 * 为什么不能每帧 `win.getBounds().x + dx`：`setBounds` 是**异步**的，
 * 系统还没落到新位置时 getBounds 读回来的是旧值，于是每一帧都在「旧值 + 2px」上重算，
 * 中间那些位移就被吃掉了（实测要 666 px 只走了 574 px，差 14%——脚会打滑）。
 * 所以自己在主进程里累计目标位置，只在用户拖拽/换尺寸时重新对齐。
 */
let nudgeX = null

ipcMain.handle('nudge-window', (_event, dx, dy) => {
  if (!win || win.isDestroyed()) return false
  const b = win.getBounds()
  // 用户手动拖过窗口（或窗口被外部挪动）：目标位置跟实际对不上，重新对齐
  if (nudgeX === null || Math.abs(b.x - nudgeX) > 32) nudgeX = b.x
  const { workArea } = screen.getDisplayMatching(b)
  const wantX = nudgeX + Math.round(dx)
  const x = Math.max(workArea.x, Math.min(wantX, workArea.x + workArea.width - b.width))
  nudgeX = x
  const size = currentSize()
  // y 只按 dy 平移、**不做边界夹取**：走路时 dy 恒为 0，夹一下就会把窗口顶到工作区边缘，
  // 而且会被下面 `x === wantX` 的判定误当成「撞到边了」。
  applyBounds({ x, y: b.y + Math.round(dy), width: size.width, height: size.height })
  saveBoundsSoon()
  // 走到边上了：让渲染层收脚，别贴着边一直磨
  return x === wantX
})

ipcMain.on('drag-end', () => {
  if (!dragState) return
  const pinned = dragState
  dragState = null

  // 松手后再校一次：Windows 有时在拖拽收尾时做最后一次 DPI 换算，
  // 每次多出 1~2px，几十次之后就能看出来。
  setTimeout(() => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    if (b.width !== pinned.width || b.height !== pinned.height) {
      logToFile(`[drag] 收尾修正 ${b.width}x${b.height} -> ${pinned.width}x${pinned.height}`)
      applyBounds({ x: b.x, y: b.y, width: pinned.width, height: pinned.height })
    }
    saveBoundsSoon()
  }, 90)

  saveBoundsSoon()
})

ipcMain.handle('get-paths', () => ({
  root: ROOT,
  songpacks: DIR_SONGPACKS,
  models: DIR_MODELS,
}))

ipcMain.handle('get-config', () => readConfig())
ipcMain.handle('set-config', (_event, patch) => writeConfig(patch))

ipcMain.handle('list-models', () => {
  // 打包后自带的模型在 resources/models（asar 旁边），用户导入的在 userData/models，两边都要列
  const dirs = [DIR_MODELS]
  const bundled = DIR_MODELS_BUNDLED
  if (path.resolve(bundled) !== path.resolve(DIR_MODELS)) dirs.push(bundled)
  const out = []
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.vrm')) continue
        const full = path.join(dir, f)
        if (!out.includes(full)) out.push(full)
      }
    } catch {
      /* 这个目录不可用就跳过 */
    }
  }
  return out
})

/**
 * 读本地静态资源（`voices/*.wav`、`songpacks/*\/work/f0.json`、缩略图 …）。
 *
 * 为什么要这个 IPC：Electron 用 `loadFile()` 打开页面时是 `file://` 页面，
 * **`fetch()` 读本地文件会被 Chromium 直接拒绝**（脚本、图片能加载，fetch 不行）。
 * 结果就是：`pnpm dev`（http）一切正常，`run.bat` 启动时和声没有任何采样、
 * 起音片段也加载不到——HUD 显示「起音 无（退回凹陷）」（用户 2026-11-13 报）。
 * 所以本地资源统一走主进程读字节。
 *
 * 2026-11-17：**先读 `public/`，再退回 `dist/`**。原因是构建不再把 public 拷进 dist
 * （那会多出 54 MB 曲包），而曲包和采样本来就住在 public/。retain dist 兜底是为了
 * 兼容「dist 里还有旧产物」的现场。
 */
ipcMain.handle('read-asset', (_event, relPath) => {
  try {
    if (typeof relPath !== 'string' || !relPath) return null
    const clean = path.normalize(relPath).replace(/^([/\\]+|\.\.([/\\]|$))+/, '')
    // 曲包相关的资源（`songpacks/<id>/voices/*.wav`、缩略图）住在可写目录里，
    // 打包后和 asar 不是同一个地方，要单独映射。
    const bases = clean.startsWith(`songpacks${path.sep}`) || clean === 'songpacks'
      ? [DIR_SONGPACKS]
      : [path.join(ROOT, 'public'), path.join(ROOT, 'dist')]
    for (const base of bases) {
      const baseDir = path.resolve(base)
      const full = path.resolve(baseDir, clean.startsWith('songpacks') ? clean.slice('songpacks'.length + 1) : clean)
      // 保险：解析后必须仍在 base 里
      if (!full.startsWith(baseDir + path.sep) && full !== baseDir) continue
      try {
        const stat = fs.statSync(full)
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024) continue
        return fs.readFileSync(full)
      } catch {
        /* 这个根下没有，试下一个 */
      }
    }
    return null
  } catch {
    return null
  }
})

ipcMain.handle('read-file', (_event, filePath) => {
  try {
    if (typeof filePath !== 'string' || !filePath) return null
    const resolved = path.resolve(filePath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile() || stat.size > 200 * 1024 * 1024) return null
    return fs.readFileSync(resolved)
  } catch {
    return null
  }
})

ipcMain.handle('write-file', (_event, filePath, text) => {
  try {
    if (typeof filePath !== 'string' || typeof text !== 'string') return false
    const resolved = path.resolve(filePath)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, text, 'utf8')
    logToFile(`[write] ${resolved}`)
    return true
  } catch (err) {
    logToFile('[write] 失败', String(err))
    return false
  }
})

ipcMain.handle('pick-model', () => pickModel())

// ---------------------------------------------------------------------------
// 导入歌曲（B1）：主进程负责 spawn 流水线，渲染层只轮询 job.json
// ---------------------------------------------------------------------------

async function pickAudio() {
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择要导入的歌曲',
    properties: ['openFile'],
    filters: [
      { name: '音频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus'] },
    ],
  })
  const file = result.filePaths?.[0]
  if (!file || result.canceled) return null
  return file
}

ipcMain.handle('import:pick-audio', () => pickAudio())

async function pickLyrics() {
  const result = await dialog.showOpenDialog(win ?? undefined, {
    title: '选择歌词文件',
    properties: ['openFile'],
    filters: [
      { name: '歌词', extensions: ['lrc', 'txt', 'json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  })
  const file = result.filePaths?.[0]
  if (!file || result.canceled) return null
  return file
}

ipcMain.handle('import:pick-lyrics', () => pickLyrics())

// ---- 歌词自动化：按标题搜网易云，或者按 id 直接抓 ----
// 走「工具写 JSON 文件 + 主进程读文件」而不是管道：
// 管道在受限环境里会 EPERM，而且这里只需要一个结果文件。
// 但**不能用 spawnSync**：它会冻住整个主进程（窗口拖不动、进度也不刷新），
// 而且 `py -3` 会再拉起一个 python.exe，spawnSync 的 timeout 在 Windows 上
// 杀不干净这种孙进程。所以用异步 spawn + 自己数超时。

function runTool(extraArgs, timeout = 45000) {
  return new Promise((resolve) => {
    const python = pipeline.pythonArgv(ROOT)
    if (!python) {
      resolve({ ok: false, error: '找不到 Python' })
      return
    }
    const logFile = path.join(DIR_DATA, 'fetch_lyrics.log')
    let fd
    try {
      fd = fs.openSync(logFile, 'w')
    } catch (err) {
      resolve({ ok: false, error: `打不开日志：${err.message}` })
      return
    }

    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      try {
        fs.closeSync(fd)
      } catch {
        /* ignore */
      }
      resolve(result)
    }
    const tail = () => {
      try {
        return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join(' ')
      } catch {
        return ''
      }
    }

    let child
    try {
      child = spawn(
        python.cmd,
        [...python.prefix, '-u', path.join(ROOT, 'tools', 'fetch_lyrics.py'), ...extraArgs],
        { cwd: ROOT, env: pipeline.envFor(ROOT), windowsHide: true, stdio: ['ignore', fd, fd] },
      )
    } catch (err) {
      finish({ ok: false, error: `启动失败：${err.message}` })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `fetch_lyrics 超时（${timeout / 1000}s）` })
    }, timeout)

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: `启动失败：${err.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) finish({ ok: true })
      else finish({ ok: false, error: `fetch_lyrics 退出码 ${code}${tail() ? `：${tail()}` : ''}` })
    })
  })
}

ipcMain.handle('import:search-lyrics', async (_event, { query, duration }) => {
  if (!query) return { ok: false, error: '没有搜索关键词' }
  const outFile = path.join(DIR_DATA, 'lyric-search.json')
  try {
    fs.rmSync(outFile, { force: true })
  } catch {
    /* ignore */
  }
  const args = ['--query', query, '--list', '--json-out', outFile]
  if (duration) args.push('--duration', String(duration))
  const run = await runTool(args)
  if (!run.ok) return run
  try {
    return { ok: true, candidates: JSON.parse(fs.readFileSync(outFile, 'utf8')) }
  } catch (err) {
    return { ok: false, error: `读不到搜索结果：${err.message}` }
  }
})

ipcMain.handle('import:fetch-lyrics', async (_event, song) => {
  const songId = song?.songId ?? song?.id
  if (!songId) return { ok: false, error: '没有歌曲 id' }
  const name = song?.name || 'lyrics'
  const slug = String(name).replace(/[^\p{L}\p{N}]+/gu, '-').slice(0, 60)
  // 目录要自己建：fetch_lyrics 只会写文件，父目录不存在就整段失败
  const lyricsDir = path.join(DIR_DATA, 'lyrics')
  fs.mkdirSync(lyricsDir, { recursive: true })
  const outFile = path.join(lyricsDir, `${slug}-${songId}.lrc`)
  const metaFile = path.join(lyricsDir, `${slug}-${songId}.json`)
  const run = await runTool(['--song-id', String(songId), '--out', outFile, '--json-out', metaFile])
  if (!run.ok) return run
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'))
    logToFile('[import] 歌词', meta)
    return {
      ok: true,
      path: outFile,
      lines: meta.lines,
      name,
      artists: song?.artists ?? '',
    }
  } catch (err) {
    return { ok: false, error: `读不到歌词信息：${err.message}` }
  }
})

ipcMain.handle('import:start', (_event, options) => {
  // 打包版没有 tools/：给一句人话，别把 ENOTDIR 抛给渲染进程
  if (!fs.existsSync(PIPELINE_SCRIPT)) {
    logToFile('[import] 拒绝启动：没有 tools/pipeline.py（这个版本不带导入组件）')
    return {
      ok: false,
      error:
        '这个版本不含「导入歌曲」组件：安装包只带播放 / 跟唱 / 和声。要做曲包请用开发版（见使用说明第 7 节）。',
    }
  }
  const result = pipeline.start(options || {})
  logToFile('[import] start', result)
  if (result.ok && options?.audioPath) {
    writeConfig({ lastJob: { packId: result.packId, audioPath: options.audioPath } })
  }
  return result
})

ipcMain.handle('import:job', (_event, packId) => pipeline.readJob(packId))
ipcMain.handle('import:has-lyrics', (_event, title) => pipeline.hasLyrics(title))
ipcMain.handle('import:cancel', () => pipeline.cancel())
ipcMain.handle('import:status', () => ({
  busy: pipeline.busy(),
  python: pipeline.pythonInfo(ROOT),
  current: pipeline.currentJob(),
  // 渲染层据此把「导入」入口降级成一句说明（打包版永远是 false）
  available: fs.existsSync(PIPELINE_SCRIPT),
}))
ipcMain.handle('import:index', (_event, packId) => pipeline.addToIndex(packId))

// B4/B8 删除曲包：目录 + index.json 一起清。真正的防护在 pipeline.removePack 里。
ipcMain.handle('packs:delete', (_event, packId) => {
  const result = pipeline.removePack(packId)
  logToFile('[packs] delete', { packId, ok: result.ok, error: result.error })
  if (result.ok) {
    // 删的正好是「上次导入」那个：清掉 lastJob，否则重开时会去接一个已经不存在的任务
    const last = readConfig().lastJob
    if (last && last.packId === packId) writeConfig({ lastJob: null })
  }
  return result
})

ipcMain.handle('packs:rename', (_event, packId, title) => {
  const result = pipeline.renamePack(packId, title)
  logToFile('[packs] rename', { packId, title, ok: result.ok, id: result.id, error: result.error })
  if (result.ok) {
    const last = readConfig().lastJob
    if (last && last.packId === packId) writeConfig({ lastJob: { ...last, packId: result.id } })
  }
  return result
})

ipcMain.on('quit', () => app.quit())

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    win.show()
    win.focus()
    // 再点一次 run.bat 的人，几乎都是「我改了东西，想用新的那份」。单实例锁会让
    // 新进程立刻退出，旧窗口如果什么都不做就会一直跑旧代码（用户 2026-11-13：
    // 「runbat 和声没更新」「菜单没修好」）。
    //   - 非 dev（run.bat / 打包）：**整个应用重启**——这样主进程的改动
    //     （比如右键菜单）也能生效，不只是渲染层；
    //   - dev：只重载渲染层（dev server 本来就是最新的；重启会丢掉 dev server 连接）。
    if (IS_DEV) {
      win.webContents.send('cmd', 'reload')
      logToFile('[boot] 第二个实例：dev 模式，重载渲染层')
    } else {
      logToFile('[boot] 第二个实例：重启应用以加载最新构建')
      app.relaunch()
      app.exit(0)
    }
  })

  app.whenReady().then(() => {
    fs.mkdirSync(DIR_MODELS, { recursive: true })
    logToFile(`[boot] electron ${process.versions.electron} / ${process.versions.chrome}`)

    // 麦克风权限：只放行 audio，其余一律拒绝。
    // 不装这个 handler 时 Electron 默认全放行，写清楚是给以后收紧留位置。
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = permission === 'media' || permission === 'audioCapture'
      if (!allowed) logToFile(`[perm] deny ${permission}`)
      callback(allowed)
    })

    createWindow()
    startCursorTracking()
    if (!SHOT) registerShortcuts()
    // 少量延后即可：任务栏入口已经在创建时就位，
    // 托盘只是"确认可用后收掉任务栏按钮"，不必让用户等太久。
    if (!SHOT) setTimeout(ensureTrayVisible, 400)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  app.on('will-quit', () => {
    if (win && !win.isDestroyed()) writeConfig({ window: win.getBounds() })
    stopCursorTracking()
    unregisterShortcuts()
    tray?.destroy()
    tray = null
  })
}
