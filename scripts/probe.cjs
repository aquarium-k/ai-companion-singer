/**
 * 最小 Electron 应用，只为 `pnpm doctor` 探活用。
 * 结果写文件而不是打 stdout —— 受限沙箱下管道可能被拒绝。
 */
const { app } = require('electron')
const fs = require('node:fs')

const out = process.env.PET_PROBE_OUT

function mark(value) {
  if (!out) return
  try {
    fs.writeFileSync(out, value, 'utf8')
  } catch {
    /* ignore */
  }
}

mark('boot')

app.whenReady().then(() => {
  mark('ready')
  setTimeout(() => app.quit(), 150)
})
