import { createServer } from 'vite'
import { runElectron } from './lib/electron.mjs'

const server = await createServer({ configFile: 'vite.config.ts' })
await server.listen()

const url = server.resolvedUrls?.local?.[0]
if (!url) {
  console.error('[dev] vite 没有报告本地地址')
  process.exit(1)
}
console.log(`[dev] renderer: ${url}`)

// 关键：把命令行参数原样传给 Electron，
// 否则 `pnpm dev --no-sandbox` 这类参数会被丢在这里，Electron 仍然无参数启动。
const code = await runElectron({
  args: process.argv.slice(2),
  env: { VITE_DEV_SERVER_URL: url },
})

await server.close()
process.exit(code)
