/**
 * Electron 启动诊断。
 *
 * 逐级测试启动参数，报告每一级能否走到 app.whenReady()，并给出手动指定用的命令。
 *
 * 注意：不要叫 `doctor`，`pnpm doctor` 是 pnpm 的内置命令，会把它盖掉。
 *
 * 用法: pnpm diagnose
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import electronPath from 'electron'
import { STAGES, prepareDirs, probeStage, rememberStage } from './lib/electron.mjs'

const root = path.resolve(import.meta.dirname, '..')

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `.write-test-${process.pid}`)
    fs.writeFileSync(file, 'ok')
    fs.unlinkSync(file)
    return true
  } catch {
    return false
  }
}

prepareDirs()

console.log('=== 环境 ===')
console.log(`electron     ${electronPath}`)
console.log(`node         ${process.version}`)
console.log(`platform     ${process.platform} ${os.release()}`)
console.log(`session      ${process.env.SESSIONNAME ?? '-'}`)
console.log(`APPDATA      可写: ${writable(process.env.APPDATA ?? '')}`)
console.log(`LOCALAPPDATA 可写: ${writable(process.env.LOCALAPPDATA ?? '')}`)
console.log(`工作区       可写: ${writable(path.join(root, '.tmp'))}`)
console.log(`ELECTRON_RUN_AS_NODE = ${process.env.ELECTRON_RUN_AS_NODE ?? '(未设置)'}`)
console.log('')

console.log('=== 启动测试 ===')
const results = []

for (const [i, stage] of STAGES.entries()) {
  process.stdout.write(`[${i}] ${stage.name} … `)
  const result = await probeStage(stage)
  console.log(
    result.ok
      ? '✅ 成功'
      : `❌ ${result.state} (exit ${result.code} / 0x${((result.code ?? 0) >>> 0).toString(16)})`,
  )
  results.push({ ...stage, ...result })
}

console.log('')
const winner = results.find((r) => r.ok)

if (winner) {
  const index = results.indexOf(winner)
  console.log(`✅ 可用：${winner.name}`)
  console.log(`   ${winner.flags.join(' ') || '(无参数)'}`)
  console.log('')
  rememberStage(index)
  console.log('已写入缓存，下次 `pnpm dev` 会直接使用这一组。')
  console.log('需要重新探测时删掉 .tmp/launcher-state.json 即可。')
} else {
  console.log('❌ 全部失败。说明当前会话无法创建 Chromium 窗口进程。')
  console.log('')
  console.log('下一步：')
  console.log('  1. 双击项目根目录的 run.bat（绕开当前 shell 的环境继承）')
  console.log('  2. 如果 run.bat 能起来，说明是当前终端环境的限制')
  console.log('  3. 如果 run.bat 也起不来，检查杀毒软件 / 组策略是否拦 Chromium 子进程')
}
