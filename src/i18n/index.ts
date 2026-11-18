/**
 * 多语言：界面文案（渲染层）。
 *
 * 设计
 * ----
 * - 词典是 `src/i18n/*.json`（打 progress 时由 vite 内联，**同步可用**，不用等 fetch）。
 *   加一种语言 = 加一个 json + 在 `DICTS` 里登记一行；缺的 key 自动回落中文。
 * - 语言优先级：`?lang=xx` > 存档里的 `lang` > 系统语言（`app.getLocale()`）> `zh-CN`。
 * - 静态 HTML 文案用 `data-i18n="key"` / `data-i18n-title="key"` 标在元素上，
 *   `applyStaticI18n()` 一次性填好；动态文案用 `t('key', {vars})`。
 * - 主进程（原生右键菜单）的文案在 `electron/i18n.cjs`，**不共用这份**——
 *   主进程读不到打包后的 src/，字典重复一份是刻意的。
 *
 * 还没覆盖的：HUD 的逐行诊断文字、`packs/import` 面板里的部分细节、动作/姿势编辑器。
 * 用 `python tools/list_ui_strings.py` 可以把源码里剩下的中文列出来（缺哪翻哪）。
 */
import zhCN from './zh-CN.json'
import ja from './ja.json'
import enUS from './en-US.json'

export type Lang = 'zh-CN' | 'ja' | 'en-US'

export const LANGS: Lang[] = ['zh-CN', 'ja', 'en-US']

const DICTS: Record<Lang, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  ja: ja as Record<string, string>,
  'en-US': enUS as Record<string, string>,
}

const FALLBACK: Lang = 'zh-CN'

let current: Lang = FALLBACK

/** 把各种写法归一：zh / zh-CN / zh-Hans-CN / ja-JP / en / en-GB … */
export function normalizeLang(raw: string | null | undefined): Lang | null {
  if (!raw) return null
  const s = raw.toLowerCase()
  if (s.startsWith('zh')) return 'zh-CN'
  if (s.startsWith('ja')) return 'ja'
  if (s.startsWith('en')) return 'en-US'
  return null
}

/**
 * 选语言。`system` 来自主进程的 `app.getLocale()`。
 * 返回最终生效的语言（调用方可以把它写回存档）。
 */
export function initI18n(opts: { queryLang?: string | null; savedLang?: string | null; system?: string | null }): Lang {
  const picked =
    normalizeLang(opts.queryLang) ?? normalizeLang(opts.savedLang) ?? normalizeLang(opts.system) ?? FALLBACK
  current = picked
  return current
}

export function lang(): Lang {
  return current
}

/** 语言显示名（用该语言自己的写法，方便下拉里认） */
export function langName(l: Lang): string {
  return DICTS[l]['lang.name'] ?? l
}

/** 取一条文案；缺失时回落中文，再缺就返回 key 本身（方便发现漏翻） */
export function t(key: string, vars?: Record<string, string | number>): string {
  const raw = DICTS[current][key] ?? DICTS[FALLBACK][key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`))
}

/** 把 root 里带 data-i18n / data-i18n-title 的元素填好 */
export function applyStaticI18n(root: ParentNode = document): void {
  root.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n as string)
  })
  root.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle as string)
  })
  document.documentElement.lang = current
}
