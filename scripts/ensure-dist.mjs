#!/usr/bin/env node
/**
 * 「按需构建」：dist 比源码旧才构建，构建时把 vite 的输出吞掉，只在失败时吐出来。
 *
 * 为什么要有这个脚本：`run.bat` 以前只在 `dist/index.html` 不存在时才构建，
 * 于是「改了源码、dist 还是旧的」被当成「改了没生效」（用户 2026-11-13 踩过）。
 * 但每次都构建又会让双击后先滚一屏 vite 日志——所以改成**比时间戳**：
 *   新鲜 → 什么都不打印，直接启动；
 *   过期 → 构建，成功后只打一行「dist 已更新（1.9s）」；
 *   失败 → 把 vite 的输出原样打出来，退出码 1（run.bat 就不启动）。
 *
 * 用法:
 *   node scripts/ensure-dist.mjs          # 需要就构建
 *   node scripts/ensure-dist.mjs --force  # 无条件构建
 *   node scripts/ensure-dist.mjs --list   # 只报「新/旧」，不构建
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST_INDEX = path.join(ROOT, 'dist', 'index.html')
const WATCH = ['src', 'public']
const ALSO = ['package.json', 'vite.config.ts', 'tsconfig.json', 'scripts/build.mjs']

const argv = new Set(process.argv.slice(2))

function newestMtime(dir, acc) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      acc = newestMtime(full, acc)
      continue
    }
    try {
      const t = fs.statSync(full).mtimeMs
      if (t > acc) acc = t
    } catch {
      /* 读不到就跳过 */
    }
  }
  return acc
}

let newest = 0
for (const dir of WATCH) newest = Math.max(newest, newestMtime(path.join(ROOT, dir), 0))
for (const file of ALSO) {
  try {
    newest = Math.max(newest, fs.statSync(path.join(ROOT, file)).mtimeMs)
  } catch {
    /* 可选文件 */
  }
}

let distTime = 0
try {
  distTime = fs.statSync(DIST_INDEX).mtimeMs
} catch {
  /* 没有 dist */
}

const stale = argv.has('--force') || !distTime || newest > distTime + 500

if (!stale) {
  if (argv.has('--list')) console.log('dist 已是最新')
  process.exit(0)
}
if (argv.has('--list')) {
  console.log('dist 比源码旧，需要构建')
  process.exit(0)
}

const started = Date.now()
const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')], {
  cwd: ROOT,
  encoding: 'utf8',
  env: process.env,
})
const seconds = ((Date.now() - started) / 1000).toFixed(1)

if (result.status !== 0) {
  console.error('[构建] 失败，vite 输出如下：')
  if (result.stdout) console.error(result.stdout.trim())
  if (result.stderr) console.error(result.stderr.trim())
  process.exit(1)
}

// 构建成功：只报一行（vite 的 chunk 警告没必要每次双击都刷屏）
console.log(`[构建] dist 已更新（${seconds}s）`)
