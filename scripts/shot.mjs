/**
 * 用 CDP 控制无头 Edge 截图。
 *
 * 相比 `--screenshot --virtual-time-budget`，这里用真实时间等待，
 * 并顺带把页面控制台和未捕获异常打印出来 —— 模型加载失败时能立刻看到原因。
 *
 * 用法: node scripts/shot.mjs <url> <out.png> [waitMs] [width] [height]
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const [url, out, waitArg, widthArg, heightArg] = process.argv.slice(2)
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [waitMs] [width] [height]')
  process.exit(1)
}

const waitMs = Number(waitArg ?? 6000)
const width = Number(widthArg ?? 520)
const height = Number(heightArg ?? 720)
const port = 9400 + Math.floor(Math.random() * 300)
const profile = path.join(root, '.tmp', `profile-${port}`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true })

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--disable-extensions',
    '--mute-audio',
    '--hide-scrollbars',
    // 无头环境没有用户手势，放开自动播放策略，否则 AudioContext 一直挂起
    '--autoplay-policy=no-user-gesture-required',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws
let exitCode = 0

try {
  let version = null
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        version = await res.json()
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(120)
  }
  if (!version) throw new Error('devtools 端口未就绪')

  const created = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()

  ws = new WebSocket(created.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? [])
        .map((a) => a.value ?? a.description ?? a.type)
        .join(' ')
      console.log(`[console:${msg.params.type}] ${text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log(`[exception] ${d.exception?.description ?? d.text}`)
      exitCode = 2
    }
    if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      console.log(`[log:${e.level}] ${e.text}`)
    }
  }

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Page.enable')
  await send('Page.navigate', { url })

  await sleep(waitMs)

  const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true })
  const file = path.resolve(root, out)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log(`[shot] ${file}`)
} catch (err) {
  console.error('[shot] failed:', err.message)
  exitCode = 1
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  child.kill()
  await sleep(300)
  process.exit(exitCode)
}
