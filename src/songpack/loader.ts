import type { ActionTrack, Lyrics, PackEntry, PackMeta, SongPack } from './types'
import type { F0Doc } from './f0'
import {
  SUPPORTED_SCHEMA,
  describeIssues,
  hasErrors,
  migratePack,
  validateActionTrack,
  validateIndex,
  validatePackMeta,
} from './schema'

type Mode = 'fs' | 'http'

let mode: Mode = 'http'
let fsRoot = ''
let httpRoot = './songpacks'

/**
 * 初始化曲包读取。
 * Electron 下走文件系统（主进程读文件），浏览器下走 fetch，
 * 这样无头截图验证和真实运行都能用同一套代码。
 */
export async function initSongPackLoader(): Promise<void> {
  if (window.pet) {
    const paths = await window.pet.getPaths()
    mode = 'fs'
    fsRoot = paths.songpacks
  } else {
    mode = 'http'
    // 相对 dist/index.html 解析，file:// 和 http:// 都适用
    httpRoot = new URL('./songpacks', location.href).toString().replace(/\/+$/, '')
  }
}

async function readText(rel: string): Promise<string> {
  const clean = rel.replace(/^\/+/, '')

  if (mode === 'fs') {
    const full = `${fsRoot}/${clean}`
    const data = await window.pet?.readFile(full)
    if (!data) throw new Error(`读不到文件: ${full}`)
    return new TextDecoder().decode(data)
  }

  const url = `${httpRoot}/${clean}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.text()
}

async function readJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readText(rel)) as T
}

async function readBinary(rel: string): Promise<ArrayBuffer> {
  const clean = rel.replace(/^\/+/, '')

  if (mode === 'fs') {
    const full = `${fsRoot}/${clean}`
    const data = await window.pet?.readFile(full)
    if (!data) throw new Error(`读不到文件: ${full}`)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }

  const url = `${httpRoot}/${clean}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.arrayBuffer()
}

/** 载入曲包里的音频分轨，返回可直接喂给 decodeAudioData 的 ArrayBuffer */
export async function loadAudioAsset(packId: string, assetPath: string): Promise<ArrayBuffer> {
  return readBinary(`${packId}/${assetPath}`)
}

type PackIndex = {
  schema: number
  packs: string[]
}

/** 列出可用曲包。索引是 songpacks/index.json，加新曲包时手动登记。 */
export async function listSongPacks(): Promise<PackEntry[]> {
  let index: PackIndex
  try {
    index = await readJson<PackIndex>('index.json')
  } catch (err) {
    console.warn('[songpack] 读不到索引', err)
    return []
  }

  // 索引本身的问题（登记了不存在的目录）只提示，不拦——真加载时会再报
  for (const issue of validateIndex(index as unknown, index.packs ?? [])) {
    if (issue.code === 'index.ghost') console.warn(`[songpack] ${issue.message}`)
  }

  const entries: PackEntry[] = []
  for (const id of index.packs ?? []) {
    try {
      const raw = await readJson<unknown>(`${id}/pack.json`)
      const { meta, notes } = migratePack(raw)
      const issues = validatePackMeta(meta, { dirName: id })
      if (hasErrors(issues)) {
        // 有 error 的曲包不上列表：点进去也唱不了，还会把面板搞乱
        console.error(`[songpack] 曲包 ${id} 校验失败：${describeIssues(issues)}`)
        continue
      }
      const warns = issues.filter((i) => i.level === 'warn')
      if (warns.length) {
        console.info(`[songpack] ${id}：${warns.map((w) => w.message).join('；')}`)
      }
      if (notes.length) console.info(`[songpack] ${id} 迁移：${notes.join('；')}`)
      entries.push({
        id,
        title: meta.title ?? id,
        dir: id,
        bpm: meta.bpm,
        duration: meta.duration,
        thumb: meta.assets?.thumb ?? null,
      })
    } catch (err) {
      console.warn(`[songpack] 曲包 ${id} 的 pack.json 读取失败`, err)
    }
  }
  return entries
}

/**
 * 载入曲包：先迁移（补默认值）再校验；有 error 就抛出可读的句子。
 *
 * 抛而不是静默降级，是因为「少一个 assets.f0」这种问题不会崩，只会让跟唱和
 * 和声安安静静地不工作——用户会以为是功能坏了，实际上是包没做完。
 */
export async function loadSongPack(id: string): Promise<SongPack> {
  const raw = await readJson<unknown>(`${id}/pack.json`)
  const { meta, notes } = migratePack(raw)
  const issues = validatePackMeta(meta, { dirName: id })
  if (notes.length) console.info(`[songpack] ${id} 迁移：${notes.join('；')}`)
  const warns = issues.filter((i) => i.level === 'warn')
  if (warns.length) console.info(`[songpack] ${id}：${warns.map((w) => w.message).join('；')}`)
  if (hasErrors(issues)) throw new Error(describeIssues(issues))

  const choreography = meta.choreography ?? 'actions.json'
  const track = await readJson<ActionTrack>(`${id}/${choreography}`)
  return { meta, track }
}

export async function loadLyrics(packId: string, assetPath: string): Promise<Lyrics> {
  return readJson<Lyrics>(`${packId}/${assetPath}`)
}

/** 参考音高（work/f0.json），跟着唱判定用 */
export async function loadF0(packId: string, assetPath: string): Promise<F0Doc> {
  return readJson<F0Doc>(`${packId}/${assetPath}`)
}

/** 文件系统模式下把曲包内相对路径解析成绝对路径（打点后回写要用） */
export function absolutePath(rel: string): string | null {
  if (mode !== 'fs') return null
  return `${fsRoot}/${rel.replace(/^\/+/, '')}`
}

export function isFileSystemMode(): boolean {
  return mode === 'fs'
}

/**
 * 结构校验。返回问题列表，空数组表示通过。
 * 只做「会让运行时出错」的检查，不追求完备的 schema 验证。
 */
export function validateSongPack(pack: SongPack, knownClips: Set<string>): string[] {
  const issues: string[] = []

  if (!SUPPORTED_SCHEMA.includes(pack.meta.schema)) {
    issues.push(`不支持的 schema: ${pack.meta.schema}（当前只认 ${SUPPORTED_SCHEMA.join('/')}）`)
  }
  if (!pack.meta.id) issues.push('缺少 meta.id')
  if (!pack.meta.title) issues.push('缺少 meta.title')
  if (!Number.isFinite(pack.meta.duration) || pack.meta.duration <= 0) {
    issues.push('meta.duration 必须是正数')
  }
  // actions.json 顶层的 duration 会覆盖 pack.json 的，两份不一致时以后者为准
  const trackDuration = pack.track.duration
  if (
    Number.isFinite(trackDuration) &&
    Number.isFinite(pack.meta.duration) &&
    Math.abs((trackDuration as number) - pack.meta.duration) > 0.5
  ) {
    issues.push(
      `duration 不一致：actions.json=${trackDuration} 会覆盖 pack.json=${pack.meta.duration}，` +
        '总时长取前者，请把两份改成一致',
    )
  }

  const duration = pack.track.duration ?? pack.meta.duration ?? 0
  // 时间轴本身的问题走 schema.ts 那套（离线工具用的是同一份）
  for (const issue of validateActionTrack(pack.track, duration, knownClips)) {
    issues.push(issue.message)
  }

  return issues
}
