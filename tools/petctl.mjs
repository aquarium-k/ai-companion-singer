#!/usr/bin/env node
/**
 * `petctl` —— 从命令行/脚本操纵这个桌宠（通过 Chrome DevTools Protocol 调 `window.__pet.*`）。
 *
 * 用途：让 agent / 自动化脚本控制角色，而不用改应用代码。
 * 前提：应用要用调试端口启动。日常不用，只有给外部控制时才需要：
 *
 *   pnpm dev 之后，或对打包版：
 *   "伴唱桌宠.exe" --remote-debugging-port=9340
 *
 * 用法：
 *   node tools/petctl.mjs --list                    # 列出所有可用钩子
 *   node tools/petctl.mjs action pose.wave          # 播一个动作
 *   node tools/petctl.mjs command play              # 走右键菜单那条命令路
 *   node tools/petctl.mjs harmony                   # 打印和声状态
 *   node tools/petctl.mjs harmonyTone 415           # 把和声钉在 415 Hz（null 松开）
 *   node tools/petctl.mjs mic                       # 麦克风状态
 *   node tools/petctl.mjs --port 9341 command restart
 *   node tools/petctl.mjs --json action dance.spin  # 只打印 JSON 结果
 *
 * 完整钩子清单与语义见 `docs/agent-control.md`。
 */
import fs from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const portArg = argv.indexOf('--port')
const port = portArg >= 0 ? Number(argv[portArg + 1]) : Number(process.env.PET_CDP_PORT ?? 9340)
const asJson = argv.includes('--json')
const wantList = argv.includes('--list') || argv.length === 0
const rest = argv.filter((a, i) => !a.startsWith('--') && !(portArg >= 0 && i === portArg + 1))

/** 连上正在运行的应用 */
async function connect() {
  let page
  for (let i = 0; i < 20 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!page) await new Promise((r) => setTimeout(r, 250))
  }
  if (!page) {
    fail(
      `连不上 127.0.0.1:${port} —— 应用需要用调试端口启动：\n` +
        `  "伴唱桌宠.exe" --remote-debugging-port=${port}\n` +
        `  （开发时：node scripts/dev.mjs 之后同样加这个参数，或直接改 scripts/dev.mjs）`,
    )
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
    }
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('调试端口握手失败'))
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  await send('Runtime.enable')
  return {
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result?.value
    },
    close: () => ws.close(),
  }
}

function fail(msg) {
  console.error(msg)
  process.exit(1)
}

/** 命令行参数按 JSON 解析，失败就当字符串 */
function parseArg(raw) {
  if (raw === 'null') return null
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw)
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw)
    } catch {
      return raw
    }
  }
  return raw
}

const client = await connect()
try {
  if (wantList) {
    const names = await client.eval('Object.keys(window.__pet)')
    if (asJson) {
      console.log(JSON.stringify(names, null, 1))
    } else {
      console.log(`共 ${names.length} 个钩子（按字母序）：`)
      for (const n of names.sort()) {
        const arity = await client.eval(`window.__pet[${JSON.stringify(n)}]?.length ?? 0`)
        console.log(`  ${n}(${arity ? '…' : ''})`)
      }
      console.log('\n详见 docs/agent-control.md')
    }
  } else {
    const [hook, ...args] = rest
    if (!hook) fail('用法：node tools/petctl.mjs <钩子> [参数…]   （--list 看钩子清单）')
    const exists = await client.eval(`typeof window.__pet[${JSON.stringify(hook)}] === 'function'`)
    if (!exists) fail(`没有这个钩子：${hook}（--list 看清单）`)
    const call = `window.__pet[${JSON.stringify(hook)}](${args.map((a) => JSON.stringify(parseArg(a))).join(',')})`
    const value = await client.eval(call)
    if (asJson) {
      console.log(JSON.stringify(value ?? null, null, 1))
    } else if (value && typeof value === 'object') {
      console.log(JSON.stringify(value, null, 1))
    } else {
      console.log(String(value))
    }
  }
} finally {
  client.close()
}
