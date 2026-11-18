/**
 * 构建包装器。
 *
 * 把 TEMP/TMP 指到工程内的 .tmp 目录：esbuild 的临时目录如果在系统 Temp 里
 * 被安全策略限制，会在收尾删除临时文件时报 "Access is denied" 并中断构建。
 * 固定到工作区里可以避免这类环境问题，也让构建产物更可预测。
 */
import { build } from 'vite'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const tmp = resolve(root, '.tmp')

mkdirSync(tmp, { recursive: true })
process.env.TEMP = tmp
process.env.TMP = tmp

await build({ configFile: resolve(root, 'vite.config.ts') })
