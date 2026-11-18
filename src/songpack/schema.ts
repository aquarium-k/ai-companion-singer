/**
 * 曲包 `pack.json` 的**版本化 schema**：迁移 → 默认值 → 校验。
 *
 * 为什么要有这个（2026-11-17 夜）：`pack.json` 一直是「手改的松散 JSON」——
 * 字段拼错（`beatPerBar`）会被静默忽略，`id` 和目录名不一致会让改名/删除指错人，
 * 少一个 `assets.f0` 会让跟唱和和声直接哑掉而没有任何提示，schema 号也没人维护。
 * 现在把这些变成**可枚举的 issue**：error 拦下，warn 提示。
 *
 * 版本
 * ----
 * **v2（当前）**：字段本身没变，变的是**校验契约**——
 *   - `assets.instrumental` 必填（没有音频就唱不了）；
 *   - `meta.id` 必须等于目录名（目录名就是曲包 id，是磁盘上的身份）；
 *   - 未知字段/未知 asset 键给 warn（拼错能被看见）；
 *   - 缺省值在这里统一补齐（`beatsPerBar=4` / `offset=0` / `loop=false` / `choreography=actions.json`）。
 *   **v1 的包原样可用**：迁移只补默认值，不改字段。
 *
 * 用法
 * ----
 * ```ts
 * const { meta } = migratePack(raw)            // 补默认值、记下从哪个版本迁过来的
 * const issues = validatePackMeta(meta, { dirName: id })
 * if (issues.some((i) => i.level === 'error')) throw new Error(describeIssues(issues))
 * ```
 * 离线批量检查走 `tools/validate_packs.mjs`（Node 直接 import 这个 .ts，靠的是
 * Node 22+ 的类型剥离，不需要编译）。
 */
import type { PackMeta } from './types'

/** 当前写出去/读进来的格式版本 */
export const PACK_SCHEMA = 2
/** 还认得的版本（读旧的照常跑） */
export const SUPPORTED_SCHEMA = [1, 2]

export type IssueLevel = 'error' | 'warn'
export type PackIssue = {
  level: IssueLevel
  /** 机器可读的短码，脚本里按它筛（如 `assets.f0.missing`） */
  code: string
  message: string
}

export type MigrationResult = {
  meta: PackMeta
  /** 原始文件里的版本（没写就是 0） */
  from: number
  /** 迁移做过什么，写日志/给脚本看 */
  notes: string[]
}

const TOP_KEYS = [
  'schema',
  'id',
  'title',
  'artist',
  'bpm',
  'beatsPerBar',
  'duration',
  'loop',
  'offset',
  'choreography',
  'assets',
] as const

const ASSET_KEYS = [
  'instrumental',
  'vocal',
  'chart',
  'lyrics',
  'units',
  'viseme',
  'f0',
  'cover',
  'voices',
  'attackBank',
  'thumb',
] as const

/** 编辑距离，用来给拼错的键提建议 */
function nearest(name: string, candidates: readonly string[]): string | null {
  let best: string | null = null
  let bestD = Infinity
  for (const c of candidates) {
    const d = distance(name.toLowerCase(), c.toLowerCase())
    if (d < bestD) {
      bestD = d
      best = c
    }
  }
  // 差 3 个字符以内、且名字别太离谱才算「像」
  return best && bestD <= Math.max(2, Math.floor(name.length / 3)) ? best : null
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 相对路径检查：不许绝对路径、不许 `..`、不许反斜杠 */
function pathProblem(v: unknown): string | null {
  if (typeof v !== 'string') return '不是字符串'
  if (!v) return '空字符串'
  if (v.startsWith('/') || /^[a-zA-Z]:/.test(v)) return '不能是绝对路径'
  if (v.includes('..')) return '不能包含 ..'
  if (v.includes('\\')) return '用正斜杠 /'
  return null
}

/**
 * 迁移到当前版本。**不改磁盘**，只返回补好默认值的内存对象。
 * 遇到比程序更新的版本原样返回，交给 `validatePackMeta` 报错。
 */
export function migratePack(raw: unknown): MigrationResult {
  const notes: string[] = []
  if (!isPlainObject(raw)) {
    return { meta: raw as PackMeta, from: 0, notes: ['不是 JSON 对象'] }
  }
  const from = typeof raw.schema === 'number' ? raw.schema : 0
  const meta = { ...raw } as unknown as PackMeta

  if (from === 0) notes.push('缺 schema 字段，按 1 处理')
  if (from > 0 && from < PACK_SCHEMA) notes.push(`从 schema ${from} 迁到 ${PACK_SCHEMA}`)

  // 默认值（v1 → v2 的全部「迁移」就是这些；字段本身没变）
  if (meta.choreography === undefined) {
    meta.choreography = 'actions.json'
    notes.push('choreography 缺省 actions.json')
  }
  if (meta.beatsPerBar === undefined) {
    meta.beatsPerBar = 4
    notes.push('beatsPerBar 缺省 4')
  }
  if (meta.offset === undefined) {
    meta.offset = 0
    notes.push('offset 缺省 0')
  }
  if (meta.loop === undefined) {
    meta.loop = false
    notes.push('loop 缺省 false')
  }
  if (meta.assets === undefined || meta.assets === null) {
    meta.assets = {}
    notes.push('assets 缺省 {}')
  }
  return { meta, from, notes }
}

export type ValidateContext = {
  /** 曲包目录名（= 磁盘上的身份）。给了就校验 id 是否一致 */
  dirName?: string
  /** 判断 assets 里的文件是否存在（离线工具用；运行时拿不到就传 undefined） */
  exists?: (rel: string) => boolean
}

/**
 * 校验 pack.json。**只报「会让运行时出错或让排查变难」的问题**，不追求完备。
 * error = 别加载；warn = 能跑，但少东西/像拼错。
 */
export function validatePackMeta(meta: unknown, ctx: ValidateContext = {}): PackIssue[] {
  const out: PackIssue[] = []
  const err = (code: string, message: string) => out.push({ level: 'error', code, message })
  const warn = (code: string, message: string) => out.push({ level: 'warn', code, message })

  if (!isPlainObject(meta)) {
    err('pack.not-object', 'pack.json 不是一个 JSON 对象')
    return out
  }
  const m = meta as Record<string, unknown>

  // ---- schema
  const schema = m.schema
  if (typeof schema !== 'number' || !Number.isInteger(schema) || schema <= 0) {
    err('schema.missing', `schema 缺失或不是正整数（当前程序写 ${PACK_SCHEMA}）`)
  } else if (!SUPPORTED_SCHEMA.includes(schema)) {
    err(
      'schema.unsupported',
      schema > PACK_SCHEMA
        ? `schema ${schema} 比程序新（程序只认 ${SUPPORTED_SCHEMA.join('/')}），更新程序再打开`
        : `不支持的 schema ${schema}（程序只认 ${SUPPORTED_SCHEMA.join('/')}）`,
    )
  }

  // ---- 未知顶层字段（拼错能被看见）
  for (const k of Object.keys(m)) {
    if ((TOP_KEYS as readonly string[]).includes(k)) continue
    const near = nearest(k, TOP_KEYS)
    warn('key.unknown', `未知字段 "${k}"${near ? `（是不是 "${near}"？）` : '，会被忽略'}`)
  }

  // ---- id / title
  if (typeof m.id !== 'string' || !m.id.trim()) {
    err('id.missing', '缺 id（目录名就是 id）')
  } else if (/[/\\]/.test(m.id) || m.id === '.' || m.id === '..') {
    err('id.invalid', `id 不能含路径分隔符："${m.id}"`)
  } else if (ctx.dirName && m.id !== ctx.dirName) {
    err('id.mismatch', `id "${m.id}" 和目录名 "${ctx.dirName}" 不一致（改名要连带改目录）`)
  }
  if (typeof m.title !== 'string' || !m.title.trim()) {
    err('title.missing', '缺 title')
  }

  // ---- 时长 / 节拍
  const duration = m.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    err('duration.invalid', 'duration 必须是正数（秒）')
  } else if (duration > 3600) {
    warn('duration.long', `duration=${duration}s 超过 1 小时，像是填错了`)
  }
  if (m.bpm !== undefined) {
    const bpm = m.bpm
    if (typeof bpm !== 'number' || !Number.isFinite(bpm) || bpm < 20 || bpm > 300) {
      warn('bpm.invalid', `bpm=${String(bpm)} 不在 20–300，节拍器和编舞会跑偏`)
    }
  } else {
    warn('bpm.missing', '没有 bpm：节拍器、能量曲线会用兜底值')
  }
  if (m.beatsPerBar !== undefined) {
    const b = m.beatsPerBar
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 1 || b > 16) {
      warn('beatsPerBar.invalid', `beatsPerBar=${String(b)} 不在 1–16`)
    }
  }
  if (m.loop !== undefined && typeof m.loop !== 'boolean') {
    warn('loop.invalid', 'loop 应该是 true/false')
  }
  if (m.offset !== undefined) {
    const o = m.offset
    if (typeof o !== 'number' || !Number.isFinite(o) || Math.abs(o) > 60) {
      warn('offset.invalid', `offset=${String(o)} 不合理（秒，通常 ±1 内）`)
    }
  }

  // ---- 编舞文件
  const ch = m.choreography
  if (ch !== undefined) {
    const p = pathProblem(ch)
    if (p) err('choreography.path', `choreography：${p}`)
    else if (!(ch as string).endsWith('.json')) warn('choreography.ext', 'choreography 建议是 .json')
  }

  // ---- assets
  const assets = m.assets
  if (!isPlainObject(assets)) {
    err('assets.invalid', 'assets 必须是对象（可以是 {}）')
    return out
  }
  for (const k of Object.keys(assets)) {
    if ((ASSET_KEYS as readonly string[]).includes(k)) continue
    const near = nearest(k, ASSET_KEYS)
    warn('assets.unknown', `未知 asset "${k}"${near ? `（是不是 "${near}"？）` : '，会被忽略'}`)
  }
  for (const [k, v] of Object.entries(assets)) {
    if (v === null || v === undefined) continue
    if (Array.isArray(v)) {
      if (k === 'voices') {
        if (v.length === 0) warn('assets.voices.empty', 'assets.voices 是空数组')
        for (const item of v) {
          const p = pathProblem(item)
          if (p) err('assets.voices.path', `assets.voices 里的 "${String(item)}"：${p}`)
        }
      } else {
        err('assets.array', `assets.${k} 不该是数组`)
      }
      continue
    }
    const p = pathProblem(v)
    if (p) err(`assets.${k}.path`, `assets.${k}：${p}`)
    if (ctx.exists && typeof v === 'string') {
      if (!ctx.exists(`assets/${k}:${v}`)) {
        // 由调用方解释 key:path 的约定（CLI 里查真实文件）
        err(`assets.${k}.missing`, `assets.${k} 指向的文件不存在：${v}`)
      }
    }
  }

  // ---- 必填 + 关键可选
  if (assets.instrumental === undefined || assets.instrumental === null) {
    err('assets.instrumental.missing', '缺 assets.instrumental：没有伴奏就唱不了')
  }
  if (assets.vocal === undefined || assets.vocal === null) {
    warn('assets.vocal.missing', '没有 assets.vocal：V 键关人声、Y 键换翻唱都没东西可切')
  }
  if (assets.f0 === undefined || assets.f0 === null) {
    warn('assets.f0.missing', '没有 assets.f0：跟唱判定和和声是哑的（整首只有伴奏）')
  }
  if (assets.units === undefined || assets.units === null) {
    warn('assets.units.missing', '没有 assets.units：没有逐字口型和逐字换元音')
  }
  if (assets.lyrics === undefined || assets.lyrics === null) {
    warn('assets.lyrics.missing', '没有 assets.lyrics：字幕不显示')
  }

  return out
}

/**
 * 编舞时间轴（`actions.json`）的校验。
 *
 * 和 `pack.json` 分开，是因为它的「未知动作」检查需要运行时那份 clip 名单
 * （离线工具拿不到就传 `null`，只查时间轴本身）。
 */
export function validateActionTrack(
  track: unknown,
  duration: number,
  knownClips: Set<string> | null,
): PackIssue[] {
  const out: PackIssue[] = []
  const err = (code: string, message: string) => out.push({ level: 'error', code, message })
  if (!isPlainObject(track)) {
    err('track.not-object', 'actions.json 不是对象')
    return out
  }
  const cues = track.cues
  if (!Array.isArray(cues)) {
    err('track.cues', 'actions.json 缺 cues 数组')
    return out
  }
  if (cues.length === 0) err('track.empty', 'actions.json 里没有任何 cue')
  for (const cue of cues) {
    if (!isPlainObject(cue)) {
      err('cue.not-object', `cue 不是对象：${JSON.stringify(cue)}`)
      continue
    }
    const at = cue.at
    const clip = typeof cue.clip === 'string' ? cue.clip : ''
    if (typeof at !== 'number' || !Number.isFinite(at)) {
      err('cue.at', `cue 的 at 不是数字：${JSON.stringify(cue)}`)
      continue
    }
    if (at < 0) err('cue.negative', `cue 在负数时间：${clip} @${at}`)
    if (duration > 0 && at > duration + 0.001) {
      err('cue.beyond', `cue 超出总时长：${clip} @${at} > ${duration}`)
    }
    if (!clip) err('cue.clip', `cue 缺 clip：${JSON.stringify(cue)}`)
    else if (knownClips && !knownClips.has(clip)) err('cue.unknown-clip', `未知动作：${clip} @${at}s`)
  }
  return out
}

/** 把 issue 列表压成一句能进 banner / 日志的话 */
export function describeIssues(issues: PackIssue[], max = 3): string {
  const errors = issues.filter((i) => i.level === 'error')
  const warns = issues.filter((i) => i.level === 'warn')
  const head = errors.length
    ? `曲包有问题：${errors
        .slice(0, max)
        .map((i) => i.message)
        .join('；')}${errors.length > max ? `（还有 ${errors.length - max} 条）` : ''}`
    : ''
  const tail = warns.length ? `⚠ ${warns.length} 条提醒` : ''
  return [head, tail].filter(Boolean).join('  ')
}

/** 便捷判断 */
export function hasErrors(issues: PackIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}

/**
 * 索引 `index.json` 与磁盘目录的一致性。
 * 索引是「加曲包要手动登记」的名单，长期没人维护就会指向不存在的目录、
 * 或者新曲包压根没登记（选曲面板里看不到）。
 */
export function validateIndex(
  indexRaw: unknown,
  dirNames: string[],
): PackIssue[] {
  const out: PackIssue[] = []
  if (!isPlainObject(indexRaw)) {
    out.push({ level: 'error', code: 'index.not-object', message: 'index.json 不是对象' })
    return out
  }
  const packs = indexRaw.packs
  if (!Array.isArray(packs)) {
    out.push({ level: 'error', code: 'index.packs', message: 'index.json 缺 packs 数组' })
    return out
  }
  const listed = new Set(packs.map(String))
  for (const id of listed) {
    if (!dirNames.includes(id)) {
      out.push({
        level: 'error',
        code: 'index.ghost',
        message: `index.json 里登记了不存在的目录：${id}`,
      })
    }
  }
  for (const dir of dirNames) {
    if (!listed.has(dir)) {
      out.push({
        level: 'warn',
        code: 'index.unlisted',
        message: `目录 ${dir} 没登记进 index.json（选曲面板里看不到）`,
      })
    }
  }
  return out
}
