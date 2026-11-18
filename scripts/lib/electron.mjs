import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import electronPath from 'electron'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PROFILE_DIR = path.join(ROOT, '.tmp', 'electron-profile')
const CRASH_DIR = path.join(ROOT, '.tmp', 'electron-crashes')
const STATE_FILE = path.join(ROOT, '.tmp', 'launcher-state.json')
const PROBE_SCRIPT = path.join(ROOT, 'scripts', 'probe.cjs')
const PROBE_MARK = path.join(ROOT, '.tmp', 'probe.txt')

const require = createRequire(import.meta.url)
let electronVersion = 'unknown'
try {
  electronVersion = require('electron/package.json').version
} catch {
  /* 读不到就算了 */
}

const FINGERPRINT = `${process.platform}-${process.arch}-electron@${electronVersion}`

/**
 * 分阶段降级启动。每一级对应一种真实见过的失败模式。
 */
export const STAGES = [
  { name: '原样启动', flags: [] },
  { name: '关闭 Chromium 沙箱', flags: ['--no-sandbox'] },
  {
    name: '软件渲染',
    flags: ['--no-sandbox', '--disable-gpu', '--enable-unsafe-swiftshader'],
  },
  {
    name: '用户目录重定向到工作区',
    flags: [
      '--no-sandbox',
      `--user-data-dir=${PROFILE_DIR}`,
      `--crash-dumps-dir=${CRASH_DIR}`,
    ],
  },
  {
    name: '用户目录重定向 + 关闭崩溃上报',
    flags: [
      '--no-sandbox',
      '--disable-gpu',
      '--enable-unsafe-swiftshader',
      `--user-data-dir=${PROFILE_DIR}`,
      `--crash-dumps-dir=${CRASH_DIR}`,
      '--disable-breakpad',
      '--disable-crash-reporter',
    ],
  },
]

export function prepareDirs() {
  mkdirSync(PROFILE_DIR, { recursive: true })
  mkdirSync(CRASH_DIR, { recursive: true })
  mkdirSync(path.join(ROOT, '.tmp'), { recursive: true })
}

/**
 * 清理会干扰 Electron 启动的环境变量。
 *
 * - ELECTRON_RUN_AS_NODE=1 会让 electron.exe 退化成普通 Node，
 *   require('electron') 拿到路径字符串，app.commandLine 直接 undefined。
 * - NODE_OPTIONS 里的 --require / --inspect 会被注入到主进程。
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/**
 * 用最小应用测某一级能不能走到 app.whenReady()。
 * 结果写文件而不是读 stdout —— 受限环境里管道可能建不起来。
 */
export function probeStage(stage, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    prepareDirs()
    rmSync(PROBE_MARK, { force: true })

    let child
    try {
      child = spawn(electronPath, [...stage.flags, PROBE_SCRIPT], {
        stdio: 'ignore',
        env: cleanEnv({ PET_PROBE_OUT: PROBE_MARK }),
      })
    } catch (err) {
      resolve({ ok: false, state: `spawn 失败: ${err.message}`, code: null })
      return
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, state: `error: ${err.message}`, code: null })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      let state = '无输出'
      try {
        state = readFileSync(PROBE_MARK, 'utf8').trim() || '空'
      } catch {
        /* ignore */
      }
      resolve({ ok: state === 'ready', state, code })
    })
  })
}

export function rememberStage(index) {
  writeCache({ stage: index, fingerprint: FINGERPRINT, checkedAt: new Date().toISOString() })
}

function readCache() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeCache(data) {
  try {
    prepareDirs()
    writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf8')
  } catch {
    /* ignore */
  }
}

/**
 * 找出并记住可用的启动方式。
 * 探测结果按 平台+架构+Electron 版本 缓存，换版本会自动重测。
 */
export async function resolveStage({ force = false, quiet = false } = {}) {
  const cached = readCache()
  if (!force && cached && cached.fingerprint === FINGERPRINT && STAGES[cached.stage]) {
    if (!quiet) console.log(`[launcher] 沿用上次可用的启动方式：${STAGES[cached.stage].name}`)
    return cached.stage
  }

  if (!quiet) console.log('[launcher] 首次运行，探测可用的启动方式…')

  for (let i = 0; i < STAGES.length; i++) {
    const result = await probeStage(STAGES[i])
    if (result.ok) {
      if (!quiet) console.log(`[launcher] 可用：${STAGES[i].name}`)
      rememberStage(i)
      return i
    }
    if (!quiet) {
      console.log(
        `[launcher]   ✗ ${STAGES[i].name} — ${result.state} (0x${((result.code ?? 0) >>> 0).toString(16)})`,
      )
    }
  }

  if (!quiet) console.warn('[launcher] 没有探测到可用组合，仍尝试最宽松的一组')
  return STAGES.length - 1
}

function compose(prefix, args) {
  const seen = new Set(args)
  const merged = [...args]
  for (const flag of prefix) {
    if (!seen.has(flag)) {
      merged.push(flag)
      seen.add(flag)
    }
  }
  return [...merged, '.']
}

/**
 * 启动应用。先用缓存/探测到的组合；如果它在几秒内就崩了，
 * 再按顺序换后面的组合 —— 只对「启动期崩溃」做降级，运行期崩溃不重试。
 */
export async function runElectron({ args = [], env = {} } = {}) {
  prepareDirs()
  const startStage = await resolveStage()

  return new Promise((resolve) => {
    let stage = startStage

    const attempt = () => {
      const current = STAGES[stage]
      const all = compose(current.flags, args)
      console.log(`[launcher] (${stage + 1}/${STAGES.length} ${current.name}) electron ${all.join(' ')}`)

      const startedAt = Date.now()
      const child = spawn(electronPath, all, { stdio: 'inherit', env: cleanEnv(env) })

      child.on('error', (err) => {
        console.error('[launcher] 启动失败:', err.message)
        resolve(1)
      })

      child.on('close', (code, signal) => {
        if (signal) {
          resolve(1)
          return
        }
        if (code === 0) {
          resolve(0)
          return
        }

        const lived = Date.now() - startedAt
        const startupCrash = lived < 5000

        if (startupCrash && stage < STAGES.length - 1) {
          stage += 1
          console.warn(
            `[launcher] ${lived}ms 内崩溃（0x${(code >>> 0).toString(16)}），换下一组…`,
          )
          attempt()
          return
        }

        console.error(`[launcher] 退出码 ${code}（0x${(code >>> 0).toString(16)}）`)
        resolve(code ?? 1)
      })
    }

    attempt()
  })
}
