import { HARMONY_LABEL, type HarmonyMode } from '../audio/harmony'

export type HudPackInfo = {
  title: string
  time: number
  duration: number
  playing: boolean
  section: string
}

export type HudData = {
  rig: string
  fps: number
  bpm: number
  bar: number
  beatInBar: number
  actions: string[]
  /** 主时钟当前是否挂在音频时钟上 */
  audio: boolean
  /** 是否载入了伴奏 */
  hasAudio: boolean
  volume: number
  /** 编舞时间与音频位置之差（毫秒），用来观察长曲漂移 */
  driftMs: number
  /** 口型包络，0..1 */
  lipLevel: number
  /** 当前 mora 的元音（a/i/u/e/o/n/''），null = 没有 mora 数据或落在空隙里 */
  vowel?: string | null
  /** 这个曲包到底有没有 mora 数据（和「当前落在空隙里」区分开） */
  hasMora?: boolean
  /** 分轨音量，null = 曲包里没有这一轨 */
  stems?: { vocal: number | null; instrumental: number | null }
  /** 跟着唱：off=没开麦，idle=这一拍不用唱，hit/miss=判定 */
  sing?: {
    state: string
    hitRate: number
    cents: number
    judged: number
    lag: number
    octave: number | null
    /** 最近 4 s「没跟上」的原因：检不到音高 / 音不准 */
    missSilent?: number
    missOff?: number
    level: number
    gain: number
    voice?: { lowHz: number; highHz: number; medianHz: number; n: number } | null
  }
  /** 动作幅度（1 = 原样）。调试口型时会被压小 */
  motion?: number
  /** 和声跟唱：关 / 三度 / 五度 / 八度，以及当前算出来的两个音高 */
  harmony?: {
    mode: string
    key: string
    userHz: number
    outHz: number
    level: number
    attackSec?: number
    attackHz?: number
    duck?: number
    attackOn?: boolean
    /** 起音片段库里有几段（v2：ら 按音高分低/高区各一段） */
    bank?: number
    /** 当前咬字方式：自动 / あ / ら / 关 */
    attLabel?: string
    /** 有没有用人声活动包络做门控 */
    gate?: boolean
  }
  /** 嘴部放大副视口开着没有 */
  pip?: boolean
  pack?: HudPackInfo
}

export type HudApi = {
  toggle: () => void
  update: (data: HudData) => void
  banner: (text: string, ms?: number) => void
  setDrop: (on: boolean) => void
}

function clock(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = Math.floor(s % 60)
  return `${m}:${String(rest).padStart(2, '0')}`
}

/** Hz → 音名（C4 / A#3），音域那一行用 */
function noteName(hz: number): string {
  const n = Math.round(69 + 12 * Math.log2(hz / 440))
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
  return `${names[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}

export function createHud(
  hudEl: HTMLElement,
  bannerEl: HTMLElement,
  dropEl: HTMLElement,
): HudApi {
  let visible = false
  let bannerTimer = 0

  return {
    toggle() {
      visible = !visible
      hudEl.classList.toggle('on', visible)
      document.body.classList.toggle('show-keys', visible)
    },

    update(data) {
      if (!visible) return

      const lines = [
        `角色  ${data.rig}`,
        `FPS   ${data.fps.toFixed(0)}`,
        `BPM   ${data.bpm.toFixed(0)}  ${data.bar + 1}.${data.beatInBar + 1}`,
        `时钟  ${data.audio ? 'audio' : 'perf'}`,
        data.hasAudio
          ? `音频  ${Math.round(data.volume * 100)}%  drift ${data.driftMs >= 0 ? '+' : ''}${data.driftMs.toFixed(0)}ms  lip ${Math.round(data.lipLevel * 100)}%`
          : '音频  （无伴奏，仅编舞）',
        `口型  ${
          data.vowel === '' 
            ? 'っ 闭口'
            : data.vowel ?? (data.hasMora ? '—（空隙）' : '（无 mora 数据）')
        }`,
      ]

      if (data.stems) {
        const pct = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`)
        const harm = data.harmony ? `  和声 ${Math.round(data.harmony.level * 100)}%` : ''
        lines.push(
          `混音  人声 ${pct(data.stems.vocal)}  伴奏 ${pct(data.stems.instrumental)}${harm}`,
        )
      }

      if (data.sing) {
        const s = data.sing
        const rate = Number.isNaN(s.hitRate) ? '—' : `${Math.round(s.hitRate * 100)}%`
        const cents = Number.isNaN(s.cents) ? '—' : `${s.cents >= 0 ? '+' : ''}${s.cents.toFixed(0)}`
        const tag = s.state === 'off' ? '麦克风关'
          : s.state === 'idle' ? '（这一拍没词）'
          : s.state === 'quiet' ? '（没听见你唱）'
          : s.state === 'noref' ? '（这帧没参考音高，不判）'
          : s.state === 'hit' ? '✓ 跟上'
          // 「没跟上」分开两种：没检到你的音高（气声/太轻），还是检到了但音不准
          : (s.missSilent ?? 0) > (s.missOff ?? 0) ? '✗ 没检到音高' : '✗ 音不准'
        const oct =
          s.octave === null ? '—' : s.octave < 0 ? '低八度' : s.octave > 0 ? '高八度' : '同度'
        lines.push(
          // 「晚」= 你比谱面唱晚了多少（歌手滞后，已补偿），不是系统延迟。
          // 这一行是 pre 不换行的，所以帧数这类细节交给 __pet.latency()，别把行挤爆。
          `跟唱  ${tag}  4s 命中 ${rate}  偏差 ${cents}音分  ${oct}  输入 ${Math.round(s.level * 100)}% ×${s.gain.toFixed(1)}  晚 ${Math.round(s.lag * 1000)}ms（已补偿）`,
        )

        if (s.voice) {
          lines.push(
            `音域  ${noteName(s.voice.lowHz)}–${noteName(s.voice.highHz)}  ` +
              `中位 ${noteName(s.voice.medianHz)}  (${s.voice.n} 帧)`,
          )
        }
      }

      if (data.harmony) {
        const h = data.harmony
        const label = HARMONY_LABEL[h.mode as HarmonyMode] ?? h.mode
        const pair =
          h.userHz > 0 && h.outHz > 0
            ? `谱 ${h.userHz}Hz → 她 ${noteName(h.outHz)} ${h.outHz}Hz`
            : h.mode === 'off'
              ? '（按 A 开）'
              : '（这一拍没在唱）'
        lines.push(`和声  ${label}（${h.key}）  ${pair}`)
        // 起音片段状态：让人能一眼确认「现在放的是哪一段」——
        // 换了素材却听起来没变，第一个要排除的就是加载了旧文件。
        // v2 起是**替换式**：ら行播瞬态片段（循环让位），其它 mora 只做软起伏。
        const desc =
          h.attLabel === 'ら'
            ? '全咬辅音'
            : h.attLabel === 'は'
              ? '全咬气声'
              : h.attLabel === 'あ'
                ? '只做软起伏'
                : '按假名（ら/は）'
        const att =
          h.attackOn === false
            ? '咬字 关（只跟音高）'
            : h.attackSec && h.attackSec > 0
              ? `咬字 ${h.attLabel ?? '自动'}（${desc}）  片段库 ${h.bank ?? 1} 段（ら ${(h.attackSec * 1000).toFixed(0)}ms/${Math.round(h.attackHz ?? 0)}Hz）`
              : '咬字 只有软起伏（无片段）'
        lines.push(`      ${att}${h.gate ? '  人声门控' : ''}`)
      }

      if (data.pack) {
        const p = data.pack
        lines.push(`曲目  ${p.title}`)
        lines.push(
          `进度  ${clock(p.time)} / ${clock(p.duration)}  ${p.playing ? '▶' : '⏸'}`,
        )
        lines.push(`段落  ${p.section || '-'}`)
      } else {
        lines.push('曲目  （未载入）')
      }

      lines.push(`动作  ${data.actions.join(' ') || '-'}`)
      const dbg: string[] = []
      if (data.motion !== undefined) dbg.push(`幅度 ${Math.round(data.motion * 100)}%`)
      if (data.pip) dbg.push('嘴部放大 开')
      if (dbg.length) lines.push(`调试  ${dbg.join('  ')}`)
      hudEl.textContent = lines.join('\n')
    },

    banner(text, ms = 2200) {
      bannerEl.textContent = text
      bannerEl.classList.add('on')
      window.clearTimeout(bannerTimer)
      bannerTimer = window.setTimeout(() => bannerEl.classList.remove('on'), ms)
    },

    setDrop(on) {
      dropEl.classList.toggle('on', on)
    },
  }
}
