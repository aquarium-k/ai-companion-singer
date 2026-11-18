/**
 * 把**真模型**的「静止朝向表」导出来，给 `bvh_to_clip.mjs` 当重定向基准。
 *
 * 为什么要它：归一化人形骨骼的静止旋转全是单位四元数，所以「这根骨头朝哪」从
 * 归一化层级里读不出来，只能在原始骨骼树上量（骨头 → 第一个骨骼子节点）。
 * 之前这套方向是**硬编码**的，脚那条写成了 `(0,−1,0)`——脚踝不是朝下、是朝前，
 * 结果整段走路的脚掌被多转了约 90°（实测脚踝 delta X 在 −59…−98°）。
 *
 * 用法（先 build + 起静态服务器）：
 *   node .tmp/serve.mjs 8791 dist
 *   node tools/dump_rest_dirs.mjs http://127.0.0.1:8791 tools/motion/text.rest.json
 * 然后：
 *   node tools/bvh_to_clip.mjs --bvh tools/motion/walk.bvh --trim 1 \
 *     --rest-dirs tools/motion/text.rest.json \
 *     --hips-cal tools/motion/walk.hips.json --id gen.walk --name 走路 \
 *     --out src/actions/gen/walk.ts
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const base = process.argv[2] ?? 'http://127.0.0.1:8791'
const outFile = process.argv[3] ?? 'tools/motion/model.rest.json'
const port = 10120 + Math.floor(Math.random() * 20)
const profileDir = path.join(os.tmpdir(), `rest-${port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const child = spawn(EDGE, ['--headless=new', '--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader', '--no-first-run', '--disable-extensions', '--mute-audio', '--hide-scrollbars', '--window-size=460,700', '--user-data-dir=' + profileDir, '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' })

/** 无头浏览器一次要占 ~90 MB 临时配置，跑完必须删掉，否则几十次就把 C 盘吃满 */
function cleanupProfile() {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 删不掉就算了，别让清理失败盖住真正的错误 */
  }
}

let ws
try {
  for (let i = 0; i < 150; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) break } catch {} await sleep(120) }
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = new WebSocket(created.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
  const send = (method, params = {}) => new Promise((resolve, reject) => { const mid = ++id; pending.set(mid, { resolve, reject }); ws.send(JSON.stringify({ id: mid, method, params })) })
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable'); await send('Page.enable')
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return `EXC ${r.exceptionDetails.exception?.description ?? ''}`
    return r.result.value
  }

  await send('Page.navigate', { url: `${base}/?dbg=1&nohud=1&idle=0&model=..%2Fmodels%2Ftext.vrm` })
  for (let i = 0; i < 300; i++) { await sleep(110); if (await ev(`typeof window.__pet === 'object'`)) break }
  await sleep(2000)
  const dirs = await ev(`window.__pet.restDirs()`)
  if (!dirs || typeof dirs !== 'object' || !dirs.leftUpperLeg) throw new Error(`读不到静止朝向：${JSON.stringify(dirs).slice(0, 120)}`)
  const keys = Object.keys(dirs)
  console.log(`量到 ${keys.length} 根骨骼的静止朝向`)
  for (const k of ['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftUpperArm', 'leftLowerArm', 'head', 'neck']) {
    if (dirs[k]) console.log(`  ${k.padEnd(14)} [${dirs[k].map((v) => v.toFixed(3)).join(', ')}]`)
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ model: 'text.vrm', dirs }, null, 1))
  console.log(`→ ${outFile}`)
} catch (e) { console.error('ERR', e.message) } finally { try { ws?.close() } catch {} child.kill(); await sleep(300); cleanupProfile(); process.exit(0) }
