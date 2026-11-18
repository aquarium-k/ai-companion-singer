import { defineConfig } from 'vite'
import { resolve } from 'node:path'

const root = import.meta.dirname

export default defineConfig({
  root: resolve(root, 'src'),
  // dev 时由 vite 直接服务 public/。
  publicDir: resolve(root, 'public'),
  base: './',
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    target: 'chrome128',
    sourcemap: true,
    /**
     * **不要把 public/ 拷进 dist**（2026-11-17：dist 里多出一份 54 MB 的曲包）。
     *
     * 页面是 `file://`，所有本地资源（voices、曲包 f0.json、缩略图、音频）本来就走
     * 主进程的 `read-asset` / `read-file` 读字节，主进程读的是 `public/`（见
     * `electron/main.cjs` 的 read-asset：先 public、再 dist 兜底）。所以 dist 只需要
     * JS/CSS 产物。dev 模式仍然由 vite 服务 public/，不受影响。
     */
    copyPublicDir: false,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
