const { contextBridge, ipcRenderer, webUtils } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  setIgnoreMouse: (ignore) => ipcRenderer.send('set-ignore-mouse', Boolean(ignore)),
  getPaths: () => ipcRenderer.invoke('get-paths'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (patch) => ipcRenderer.invoke('set-config', patch),
  listModels: () => ipcRenderer.invoke('list-models'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  readAsset: (relPath) => ipcRenderer.invoke('read-asset', relPath),
  writeFile: (filePath, text) => ipcRenderer.invoke('write-file', filePath, text),
  pickModel: () => ipcRenderer.invoke('pick-model'),
  quit: () => ipcRenderer.send('quit'),

  // 导入歌曲（B1）
  pickAudio: () => ipcRenderer.invoke('import:pick-audio'),
  pickLyrics: () => ipcRenderer.invoke('import:pick-lyrics'),
  searchLyrics: (query, duration) => ipcRenderer.invoke('import:search-lyrics', { query, duration }),
  fetchLyrics: (song) => ipcRenderer.invoke('import:fetch-lyrics', song),
  startImport: (options) => ipcRenderer.invoke('import:start', options),
  importJob: (packId) => ipcRenderer.invoke('import:job', packId),
  hasLyrics: (title) => ipcRenderer.invoke('import:has-lyrics', title),
  cancelImport: () => ipcRenderer.invoke('import:cancel'),
  importStatus: () => ipcRenderer.invoke('import:status'),
  addToIndex: (packId) => ipcRenderer.invoke('import:index', packId),
  deletePack: (packId) => ipcRenderer.invoke('packs:delete', packId),
  renamePack: (packId, title) => ipcRenderer.invoke('packs:rename', packId, title),

  toggleLock: () => ipcRenderer.send('toggle-lock'),
  getLocked: () => ipcRenderer.invoke('get-locked'),

  // 窗口操作
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  zoom: (delta) => ipcRenderer.send('zoom', delta),
  copyText: (text) => ipcRenderer.send('copy-text', text),
  resizeWindow: (width, height) => ipcRenderer.send('resize-window', width, height),
  showMenu: () => ipcRenderer.send('show-menu'),
  resetPosition: () => ipcRenderer.send('reset-position'),
  /** 走路位移：按像素推窗口；返回 false = 撞到屏幕边缘被夹住 */
  nudgeWindow: (dx, dy) => ipcRenderer.invoke('nudge-window', dx, dy),

  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },

  onCommand: (cb) => {
    ipcRenderer.on('cmd', (_event, cmd) => cb(cmd))
  },

  /** 全局光标位置，归一化到窗口坐标（窗口外会超出 ±1） */
  onCursor: (cb) => {
    ipcRenderer.on('cursor', (_event, point) => cb(point))
  },
})
