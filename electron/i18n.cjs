/**
 * 主进程的文案（原生右键菜单 / 托盘）。
 *
 * 为什么不和渲染层共用一份：打包后渲染层的字典已经内联进 `app.asar/dist`，
 * 主进程要同步读它就得在 asar 里解析 JS，不划算。菜单文案就这么几十条，重复一份更简单。
 * **改了渲染层的 key 不用管这里；改菜单就改这里。**
 */
const MENU = {
  'zh-CN': {
    action: '动作',
    wave: '挥手', spin: '转圈', nod: '点头', shake: '摇头', sing: '唱歌', cheer: '欢呼',
    lean: '凑近', reach: '伸手', peace: '比耶', clap: '鼓掌', hair: '拨头发', intro: '自我介绍',
    walk: '走两步（BVH 动作，会走开一段）', walkFar: '走远一点（约 4.5 m，会记住）',
    turnCcw: '转身 140°（逆时针，保持）', turnCw: '转身 220°（顺时针 140°，保持）',
    turnFront: '转回正面（0.8 s 过门）', transition: '过门演示（站姿 → 抬手）',
    talk: '开合嘴（假口型）', metronome: '节拍器',
    camera: '镜头', camFront: '正面', camOver: '右上方', camPanel: '调整…', camReset: '复位',
    size: '大小', sizeS: '小', sizeM: '中', sizeL: '大', sizeXl: '超大',
    saySong: '这首歌怎么唱（让她说一句）', mic: '跟唱：开 / 关麦克风（G）', import: '导入歌曲…',
    showHide: '显示 / 隐藏', lock: '锁定点击穿透', resetPos: '重置到右下角',
    loadVrm: '载入 VRM…', reload: '重新载入', quit: '退出', taskbar: '任务栏图标设置…',
    lang: '语言 (Language)',
  },
  ja: {
    action: 'アクション',
    wave: '手を振る', spin: '回る', nod: 'うなずく', shake: '首を振る', sing: '歌う', cheer: '喜ぶ',
    lean: '近づく', reach: '手を伸ばす', peace: 'ピース', clap: '拍手', hair: '髪を直す', intro: '自己紹介',
    walk: '二歩歩く（BVH、少し移動）', walkFar: '遠くまで歩く（約 4.5 m、記憶）',
    turnCcw: '140° 反時計回り（保持）', turnCw: '220° 時計回り（保持）',
    turnFront: '正面に戻る（0.8 s）', transition: 'トランジションのデモ（立ち姿 → 手を上げる）',
    talk: '口パク（ダミー）', metronome: 'メトロノーム',
    camera: 'カメラ', camFront: '正面', camOver: '右上', camPanel: '調整…', camReset: 'リセット',
    size: 'サイズ', sizeS: '小', sizeM: '中', sizeL: '大', sizeXl: '特大',
    saySong: 'この曲の歌い方（ひとこと）', mic: '一緒に歌う：マイクのオン/オフ（G）', import: '曲を取り込む…',
    showHide: '表示 / 非表示', lock: 'クリック透過を固定', resetPos: '右下に戻す',
    loadVrm: 'VRM を読み込む…', reload: '再読み込み', quit: '終了', taskbar: 'タスクバーアイコンの設定…',
    lang: '言語 (Language)',
  },
  'en-US': {
    action: 'Actions',
    wave: 'Wave', spin: 'Spin', nod: 'Nod', shake: 'Shake head', sing: 'Sing', cheer: 'Cheer',
    lean: 'Lean in', reach: 'Reach out', peace: 'Peace sign', clap: 'Clap', hair: 'Fix hair', intro: 'Introduce herself',
    walk: 'Walk two steps (BVH, moves a bit)', walkFar: 'Walk farther (≈4.5 m, remembered)',
    turnCcw: 'Turn 140° CCW (hold)', turnCw: 'Turn 220° CW (hold)',
    turnFront: 'Back to front (0.8 s)', transition: 'Transition demo (stand → raise arm)',
    talk: 'Flap mouth (dummy)', metronome: 'Metronome',
    camera: 'Camera', camFront: 'Front', camOver: 'Upper right', camPanel: 'Adjust…', camReset: 'Reset',
    size: 'Size', sizeS: 'Small', sizeM: 'Medium', sizeL: 'Large', sizeXl: 'Extra large',
    saySong: 'How to sing this song (one line)', mic: 'Sing along: toggle microphone (G)', import: 'Import a song…',
    showHide: 'Show / hide', lock: 'Lock click-through', resetPos: 'Reset to bottom right',
    loadVrm: 'Load VRM…', reload: 'Reload', quit: 'Quit', taskbar: 'Taskbar icon settings…',
    lang: 'Language',
  },
}

const SUPPORTED = Object.keys(MENU)

/** 把 app.getLocale() 之类的值归一 */
function normalize(raw) {
  const s = String(raw || '').toLowerCase()
  if (s.startsWith('zh')) return 'zh-CN'
  if (s.startsWith('ja')) return 'ja'
  if (s.startsWith('en')) return 'en-US'
  return null
}

/** 当前菜单语言（`PET_LANG` 可强开，用于截图/验证） */
function pickLang({ saved, system } = {}) {
  const forced = normalize(process.env.PET_LANG)
  if (forced) return forced
  return normalize(saved) ?? normalize(system) ?? 'zh-CN'
}

let current = 'zh-CN'

function setLang(l) {
  const n = normalize(l)
  if (n) current = n
  return current
}

/** 取一条菜单文案；缺了回落中文 */
function m(key) {
  return MENU[current][key] ?? MENU['zh-CN'][key] ?? key
}

module.exports = { m, setLang, pickLang, normalize, SUPPORTED }
