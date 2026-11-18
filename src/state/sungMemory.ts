/**
 * 「唱过的歌」：给待机哼歌用的一小份记忆。
 *
 * 只存几十字节的元信息（哪首、什么时候、唱了多久、命中率），**一个音频字节都不存**——
 * 要哼的时候按曲包现算（`work/f0.json` 就在曲包里）。
 *
 * 存在 localStorage：浏览器和 Electron（file:// 源）都能用，不需要主进程配合。
 */

const KEY = 'pet.sung.v1'
const MAX_ENTRIES = 8

export type SungEntry = {
  /** 曲包 id */
  id: string
  title: string
  /** 记录时刻（ms） */
  at: number
  /** 这次听了多久（秒） */
  seconds: number
  /** 跟唱命中率（0..1，没测到就 NaN） */
  hit: number
  /** 这次哼唱过的次数（用来避免老哼同一首） */
  hums?: number
}

function read(): SungEntry[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter((e) => e && typeof e.id === 'string') : []
  } catch {
    return []
  }
}

function write(list: SungEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_ENTRIES)))
  } catch {
    /* 隐私模式 / 配额满了：当作没记住 */
  }
}

/** 记一次「唱过」：同一首歌只保留最新一条（顺序挪到最后） */
export function rememberSung(entry: SungEntry): void {
  const list = read().filter((e) => e.id !== entry.id)
  list.push({ ...entry, hums: 0 })
  write(list)
}

export function sungList(): SungEntry[] {
  return read()
}

/** 挑一首来哼：优先唱得多、命中率高的，并惩罚已经哼过很多次的 */
export function pickSung(random: () => number = Math.random): SungEntry | null {
  const list = read()
  if (list.length === 0) return null
  const weights = list.map((e) => {
    const dur = Math.min(e.seconds, 240) / 60 // 分钟为单位的权重
    const hitBonus = Number.isFinite(e.hit) ? 0.5 + e.hit : 1
    const humPenalty = 1 / (1 + (e.hums ?? 0) * 0.8)
    return Math.max(0.05, dur * hitBonus * humPenalty)
  })
  const total = weights.reduce((a, b) => a + b, 0)
  let r = random() * total
  for (let i = 0; i < list.length; i++) {
    r -= weights[i]
    if (r <= 0) {
      const entry = list[i]
      entry.hums = (entry.hums ?? 0) + 1
      write(list)
      return entry
    }
  }
  return list[list.length - 1]
}

export function clearSung(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
}
