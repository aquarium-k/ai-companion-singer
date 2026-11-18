/**
 * 极简静态服务器，仅用于本地无头浏览器验证渲染结果。
 * 用法: node scripts/serve.mjs [port]
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const port = Number(process.argv[2] ?? 5199)

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.vrm': 'model/gltf-binary',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
}

http
  .createServer((req, res) => {
    const raw = decodeURIComponent((req.url ?? '/').split('?')[0])
    const target = path.join(root, raw)
    if (!target.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(target, (err, data) => {
      if (err) {
        console.log(`404 ${raw}`)
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': types[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      })
      res.end(data)
    })
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`serving ${root} at http://127.0.0.1:${port}`)
  })
