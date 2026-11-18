/**
 * 髋位移标定：在**真模型**上量「这只脚离地多少」，反推髋该放在哪。
 *
 * 为什么要标定：BVH→VRM 的重定向是**纯旋转**的，源骨架的腿长比例、静止朝向、
 * 髋宽、有没有单独的髋关节骨，都和 VRM 不一样。所以「源里腿弯了多少」推不出
 * 「VRM 上脚离地多少」——实测差 4 cm 左右（整段浮在地面上方），而这个偏差
 * 不是常数，跟姿势有关。与其猜，不如量：
 *
 *   对每个 t 读一次 leftFoot/rightFoot/hips 的世界 Y（关掉 IK，读纯动画），
 *   legReach = 脚 Y − 髋 Y（和被写进去的髋位移无关），
 *   髋要放到  restAnkleY − legReach  最低那只脚才正好踩在地上。
 *
 * 用法（先 build + 起一个静态服务器）：
 *   node .tmp/serve.mjs 8791 dist
 *   node tools/calibrate_hips.mjs http://127.0.0.1:8791 gen.walk 2 tools/motion/walk.hips.json 67
 * 然后把表交给生成器：
 *   node tools/bvh_to_clip.mjs --bvh tools/motion/walk.bvh --trim 1 \
 *     --hips-cal tools/motion/walk.hips.json --id gen.walk --name 走路 \
 *     --out src/actions/gen/walk.ts
 *
 * 最后一步必须用真实模型（text.vrm）：占位角色的腿长是编出来的，量出来没用。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const base = process.argv[2] ?? 'http://127.0.0.1:8791'
const clip = process.argv[3] ?? 'gen.walk'
const step = Number(process.argv[4] ?? 2)
const outFile = process.argv[5] ?? 'tools/motion/hips.json'
const port = 9990 + Math.floor(Math.random() * 20)
const profileDir = path.join(os.tmpdir(), `cal-${port}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 无头浏览器一次要占 ~90 MB 临时配置，跑完删掉（否则几十次就把 C 盘吃满） */
function cleanupProfile() {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* 删不掉无所谓 */
  }
}
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
    '--window-size=460,700',
    '--user-data-dir=' + profileDir,
    '--remote-debugging-port=' + port,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let ws
try {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (r.ok) break
    } catch {}
    await sleep(120)
  }
  const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  ws = new WebSocket(created.webSocketDebuggerUrl)
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
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  await new Promise((r) => (ws.onopen = r))
  await send('Runtime.enable')
  await send('Page.enable')
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) return `EXC ${r.exceptionDetails.exception?.description ?? ''}`
    return r.result.value
  }
  const load = async (q) => {
    await send('Page.navigate', { url: `${base}/?${q}` })
    for (let i = 0; i < 300; i++) {
      await sleep(110)
      if (await ev(`typeof window.__pet === 'object'`)) break
    }
    await sleep(1300)
  }

  const readPose = (t) =>
    ev(`(() => { const p = window.__pet.sample()
      return { t: ${t}, hipsY: p.hips[1], lf: p.leftFoot[1], rf: p.rightFoot[1],
               lz: p.leftFoot[2], rz: p.rightFoot[2] } })()`)

  /**
   * 读一次「稳定后」的姿势。
   *
   * 页面刚起来那一两秒里，启动流程还会插一段问候动作（髋会蹲下去半米），
   * 直接读会读到那一段，量出来的髋位移差 40 cm。所以要求连续两次读数一致。
   */
  const stable = async (t) => {
    let prev = null
    for (let k = 0; k < 12; k++) {
      const s = await readPose(t)
      if (!s || typeof s.hipsY !== 'number' || typeof s.lf !== 'number') {
        prev = null
        await sleep(240)
        continue
      }
      if (prev && Math.abs(s.hipsY - prev.hipsY) < 0.002 && Math.abs(s.lf - prev.lf) < 0.002) return s
      prev = s
      await sleep(240)
    }
    return prev
  }

  const common = 'dbg=1&nohud=1&idle=0&ik=0&model=..%2Fmodels%2Ftext.vrm'
  await load(common)
  const rest = await stable(0)
  const hipsRestY = rest.hipsY
  const restAnkleY = Math.min(rest.lf, rest.rf)
  console.log(`站姿基准：髋 ${(hipsRestY * 1000).toFixed(1)} mm，踝 ${(restAnkleY * 1000).toFixed(1)} mm`)

  const lastFrame = Number(process.argv[6] ?? 68)
  const frameDt = 1 / 60
  const samples = []
  for (let i = 0; i <= lastFrame; i += step) {
    const t = (i * frameDt).toFixed(4)
    await load(`${common}&freeze=${clip}&t=${t}`)
    const s = await stable(t)
    const low = Math.min(s.lf, s.rf)
    const lowZ = s.lf <= s.rf ? s.lz : s.rz
    const reach = low - s.hipsY
    samples.push({ t: +s.t, legReach: reach, lowZ, lz: s.lz, rz: s.rz })
    if (i % 8 === 0 || i >= lastFrame - 4) {
      console.log(
        `f${String(i).padStart(2)} 髋 ${(s.hipsY * 1000).toFixed(1)} 最低踝 ${(low * 1000).toFixed(1)}` +
          ` legReach ${(reach * 1000).toFixed(1)} → 需要髋位移 ${(((restAnkleY - reach) - hipsRestY) * 1000).toFixed(1)}`,
      )
    }
  }
  fs.writeFileSync(
    outFile,
    JSON.stringify({ clip, hipsRestY, restAnkleY, frameDt, step, samples }, null, 1),
  )
  const needs = samples.map((s) => restAnkleY - s.legReach - hipsRestY)
  console.log(
    `\n需要髋位移 ${(Math.min(...needs) * 1000).toFixed(1)} … ${(Math.max(...needs) * 1000).toFixed(1)} mm（幅度 ${((Math.max(...needs) - Math.min(...needs)) * 1000).toFixed(1)}）→ ${outFile}`,
  )
  // 顺带量一下「一步迈多远」：最低那只脚的 z 从最前退到最后 = 一步
  // 顺带量「一步迈多远」：**单只脚**在整个周期里 z 从最前到最后的行程 = 一步
  const span = (k) => Math.max(...samples.map((s) => s[k])) - Math.min(...samples.map((s) => s[k]))
  const stepM = (span('lz') + span('rz')) / 2
  const cycleSec = lastFrame * frameDt
  console.log(
    `一步 ${stepM.toFixed(2)} m（单脚 z 行程 左 ${span('lz').toFixed(2)} / 右 ${span('rz').toFixed(2)}），` +
      `周期 ${cycleSec.toFixed(2)} s → 位移速度 ${((2 * stepM) / cycleSec).toFixed(2)} m/s`,
  )
} catch (e) {
  console.error('ERR', e.message)
} finally {
  try {
    ws?.close()
  } catch {}
  child.kill()
  await sleep(300)
  cleanupProfile()
  process.exit(0)
}
