#!/usr/bin/env node
/**
 * 离线校验所有曲包：`pack.json` 的 schema、`actions.json` 的时间轴、`index.json` 的一致性、
 * 以及 assets 里登记的文件在不在盘上。
 *
 * 用法：
 *   node tools/validate_packs.mjs                 # 查 public/songpacks
 *   node tools/validate_packs.mjs --dir <路径>     # 查别的目录
 *   node tools/validate_packs.mjs --strict        # 把 warn 也算失败
 *
 * 说明：这里直接 `import '../src/songpack/schema.ts'`（Node 22+ 的类型剥离），
 * 所以**校验逻辑和应用里是同一份**，不会两边跑偏。
 */
import fs from 'node:fs'
import path from 'node:path'

import {
  migratePack,
  validateActionTrack,
  validateIndex,
  validatePackMeta,
} from '../src/songpack/schema.ts'

const args = process.argv.slice(2)
const dirArg = args.indexOf('--dir')
const strict = args.includes('--strict')
const ROOT = path.resolve(import.meta.dirname, '..')
const BASE = dirArg >= 0 ? path.resolve(args[dirArg + 1]) : path.join(ROOT, 'public/songpacks')

const red = (s) => `\x1b[31m${s}\x1b[0m`
const yellow = (s) => `\x1b[33m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

let errors = 0
let warns = 0

/** 读 JSON 文本：顺手去掉 UTF-8 BOM（Windows 编辑器爱加，`JSON.parse` 会直接报错） */
function readJsonText(file) {
  const buf = fs.readFileSync(file)
  let text = buf.toString('utf8')
  let hadBom = false
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1)
    hadBom = true
  }
  return { text, hadBom }
}

/** 读一个 JSON 文件；带 BOM 时记一条 warn */
function loadJson(file, label) {
  const { text, hadBom } = readJsonText(file)
  if (hadBom) {
    console.log(`  ${yellow('warn ')} ${dim('[json.bom]')} ${label} 带 BOM（已忽略，建议存成无 BOM）`)
    warns++
  }
  return JSON.parse(text)
}

function report(name, issues) {
  const e = issues.filter((i) => i.level === 'error')
  const w = issues.filter((i) => i.level === 'warn')
  errors += e.length
  warns += w.length
  if (!e.length && !w.length) {
    console.log(`  ${green('✓')} ${name}`)
    return
  }
  console.log(`  ${e.length ? red('✗') : yellow('!')} ${name}`)
  for (const i of e) console.log(`      ${red('error')} ${dim(`[${i.code}]`)} ${i.message}`)
  for (const i of w) console.log(`      ${yellow('warn ')} ${dim(`[${i.code}]`)} ${i.message}`)
}

if (!fs.existsSync(BASE)) {
  console.error(`目录不存在：${BASE}`)
  process.exit(2)
}

const dirNames = fs
  .readdirSync(BASE, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

console.log(`校验 ${BASE}\n目录 ${dirNames.length} 个`)

// ---- index.json
let indexRaw = null
try {
  indexRaw = loadJson(path.join(BASE, 'index.json'), 'index.json')
} catch (e) {
  console.log(`  ${red('✗')} index.json 读不到：${e.message}`)
  errors++
}
if (indexRaw) {
  console.log('\nindex.json：')
  report('index.json', validateIndex(indexRaw, dirNames))
}

// ---- 每个曲包
for (const id of dirNames) {
  const dir = path.join(BASE, id)
  console.log(`\n${id}`)
  const packPath = path.join(dir, 'pack.json')
  if (!fs.existsSync(packPath)) {
    console.log(`  ${red('✗')} 缺 pack.json`)
    errors++
    continue
  }
  let raw
  try {
    raw = loadJson(packPath, 'pack.json')
  } catch (e) {
    console.log(`  ${red('✗')} pack.json 不是合法 JSON：${e.message}`)
    errors++
    continue
  }

  const { meta, from, notes } = migratePack(raw)
  if (from && from !== meta.schema) console.log(`  ${dim(`schema ${from} → ${meta.schema}`)}`)
  for (const n of notes) console.log(`  ${dim(`迁移：${n}`)}`)

  // assets 存在性：只查单文件（voices 数组在下面单独展开）
  const exists = (spec) => {
    const cut = spec.indexOf(':')
    const key = spec.slice(0, cut)
    const rel = spec.slice(cut + 1)
    if (key === 'voices') return true
    return fs.existsSync(path.join(dir, rel))
  }
  report('pack.json', validatePackMeta(meta, { dirName: id, exists }))

  const voices = meta.assets?.voices
  if (Array.isArray(voices)) {
    for (const v of voices) {
      if (!fs.existsSync(path.join(dir, String(v)))) {
        console.log(`  ${red('error')} ${dim('[assets.voices.missing]')} 文件不存在：${v}`)
        errors++
      }
    }
  }

  // ---- actions.json
  const chore = meta.choreography ?? 'actions.json'
  const trackPath = path.join(dir, chore)
  if (!fs.existsSync(trackPath)) {
    console.log(`  ${red('error')} ${dim('[track.missing]')} 编舞文件不存在：${chore}`)
    errors++
    continue
  }
  let track
  try {
    track = loadJson(trackPath, chore)
  } catch (e) {
    console.log(`  ${red('error')} ${dim('[track.json]')} ${chore} 不是合法 JSON：${e.message}`)
    errors++
    continue
  }
  const duration = track?.duration ?? meta.duration ?? 0
  if (
    Number.isFinite(track?.duration) &&
    Number.isFinite(meta.duration) &&
    Math.abs(track.duration - meta.duration) > 0.5
  ) {
    console.log(
      `  ${yellow('warn ')} ${dim('[track.duration]')} actions.json=${track.duration}s 与 pack.json=${meta.duration}s 不一致（运行时以 actions 为准）`,
    )
    warns++
  }
  // 未知动作检查需要应用里的 clip 名单，离线拿不到 → 传 null
  report(chore, validateActionTrack(track, duration, null))
}

console.log(
  `\n${errors ? red(`${errors} 个 error`) : green('0 个 error')}，${warns ? yellow(`${warns} 条 warn`) : '0 条 warn'}`,
)
process.exit(errors || (strict && warns) ? 1 : 0)
