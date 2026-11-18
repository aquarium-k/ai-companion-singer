/**
 * 读静态资源（`voices/*.wav`、`songpacks/<id>/work/f0.json` …）。
 *
 * 为什么不直接用 `fetch`：Electron 用 `loadFile()` 打开页面时是 `file://` 页面，
 * Chromium **不允许 file:// 页面 fetch 本地文件**（脚本和图片能加载，fetch 不行）。
 * 于是 `pnpm dev`（http）一切正常，`run.bat` 启动时：
 *   - 和声采样载入失败 → 退回振荡器（听起来完全不是她的声音）
 *   - 起音片段载入失败 → HUD 显示「起音 无（退回凹陷）」
 * （用户 2026-11-13 报的就是这个现象。）
 *
 * 所以 Electron 里统一走主进程 `read-asset`（读 `dist/` 下的字节），浏览器里退回 fetch。
 */

type PetLike = {
  readAsset?: (relPath: string) => Promise<Uint8Array | null>
}

function pet(): PetLike | undefined {
  return (window as unknown as { pet?: PetLike }).pet
}

export async function fetchAssetBytes(rel: string): Promise<ArrayBuffer> {
  const api = pet()
  if (api?.readAsset) {
    try {
      const bytes = await api.readAsset(rel)
      if (bytes && bytes.byteLength > 0) {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
      }
    } catch {
      /* 主进程读不到就退回 fetch（dev 下 fetch 是可用的） */
    }
  }
  const res = await fetch(rel)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${rel}`)
  return res.arrayBuffer()
}

export async function fetchAssetJson<T>(rel: string): Promise<T> {
  const bytes = await fetchAssetBytes(rel)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
