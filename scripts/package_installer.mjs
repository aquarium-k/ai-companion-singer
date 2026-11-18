/**
 * 出 NSIS 安装包。
 *
 * 为什么不能直接 `electron-builder --win nsis`：出包时会先编一个「只生成卸载器」的
 * 小安装器，然后**原地把它跑一遍**（NSIS 的 `WriteUninstaller`）。这一步在 `release/`
 * 里跑一律 exit 2（拷到 %TEMP% 或任何工作区外的目录都 exit 0），所以这里把输出目录
 * 挪到系统临时目录，出完再把安装器和 `.blockmap` 拷回 `release/`。
 *
 * 详见 docs/release.md 八之 5。
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = join(tmpdir(), 'pet-release')
const release = join(root, 'release')

const run = (cmd, args) =>
  new Promise((res, rej) => {
    // 不走 shell：两个命令都是 node 直接跑脚本，不需要它（用了反而会触发
    // DEP0190 的「参数拼接」警告，而且路径带空格时容易出事）。
    const child = spawn(cmd, args, { cwd: root, stdio: 'inherit' })
    child.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} 退出码 ${code}`))))
    child.on('error', rej)
  })

console.log('[installer] 1/3 构建 dist')
await run(process.execPath, [join(root, 'scripts', 'build.mjs')])

console.log(`[installer] 2/3 electron-builder → ${out}`)
rmSync(out, { recursive: true, force: true })
/*
 * electron-builder 偶尔会以非 0 退出（典型：rcedit 写 exe 资源时文件被杀软占着，
 * `Unable to commit changes`，它自己重试几次后放弃），但**安装包往往已经产出了**。
 * 所以这里不直接抛：先看产物在不在，在就继续拷、只是提醒一句（2026-11-18 踩到两次）。
 */
let builderError = null
try {
  await run(process.execPath, [
    join(root, 'node_modules', 'electron-builder', 'cli.js'),
    '--win',
    'nsis',
    `--config.directories.output=${out}`,
  ])
} catch (err) {
  builderError = err
  console.warn(`[installer] electron-builder 报错（先看产物是否已生成）：${err.message}`)
}
const artifacts = existsSync(out)
  ? readdirSync(out).filter((n) => /^.* Setup .*\.exe$/.test(n))
  : []
if (builderError && !artifacts.length) throw builderError

console.log('[installer] 3/3 拷回 release/')
mkdirSync(release, { recursive: true })
const copied = []
for (const name of readdirSync(out)) {
  if (!/\.exe(\.blockmap)?$/.test(name)) continue
  if (!statSync(join(out, name)).isFile()) continue
  copyFileSync(join(out, name), join(release, name))
  copied.push(name)
}
if (!copied.length) {
  console.error('[installer] 没找到产物：', readdirSync(out).join(', '))
  process.exit(1)
}
for (const name of copied) {
  const size = statSync(join(release, name)).size
  console.log(`  release/${name}  ${(size / 1024 / 1024).toFixed(1)} MB`)
}

// 没有代码签名时（见 docs/signing.md），发布页至少给一份 SHA256 让用户自己核对。
const sums = []
for (const name of copied) {
  if (!name.endsWith('.exe')) continue
  const hash = createHash('sha256').update(readFileSync(join(release, name))).digest('hex').toUpperCase()
  sums.push(`${hash}  ${name}`)
}
if (sums.length) {
  writeFileSync(join(release, 'SHA256SUMS.txt'), sums.join('\r\n') + '\r\n', 'utf8')
  console.log('  release/SHA256SUMS.txt')
}
if (!existsSync(join(release, 'win-unpacked'))) {
  console.log('提示：装机用的免安装目录没有更新，需要的话再跑一次 `pnpm run package`')
}
