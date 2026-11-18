import type { BoneName, Vec3 } from '../core/types'
import { BONE_NAMES } from '../core/types'

/**
 * 姿势编辑器（`E` 键 / `Ctrl+Alt+E` / `?editor=1`）。
 *
 * 目的：让用户**自己把角色摆成想要的姿势**，然后导出一串骨骼增量给我，
 * 我再把姿势串成关键帧。这样就不用靠「一句话 → 我猜 → 你看不对 → 再猜」。
 *
 * 面板从上到下：预设 / 复制粘贴 / 视角 / 骨骼列表 / 选中骨骼的滑杆。
 * 数值含义和 `poses.ts` 完全一致：**相对静息姿态的增量**，不是绝对朝向。
 *
 * 几个不显然的设计：
 * - **草稿自动存 localStorage**：摆到一半关掉编辑器或重启应用都还在
 *   （姿势是一点点调出来的，丢失一次就白干）；
 * - **撤销栈**记的是「每次改动前的快照」，Ctrl+Z 或按钮都能回退；
 * - **数值可以直接输入**：滑杆只有 0.01 的步长，想精确到 1.15 只能靠输入框；
 * - **髋位移单独一项**：姿势里有 hipsOffset，但骨骼列表是按骨骼名组织的，
 *   没有它导出就会把下蹲/重心移动丢掉。
 */

type Bones = Partial<Record<BoneName, Vec3>>

/** 伪骨骼：不参与骨骼旋转，表示髋部位移（米） */
const HIPS_OFFSET_KEY = '@hipsOffset' as const
type Selection = BoneName | typeof HIPS_OFFSET_KEY

const HIPS_OFFSET_RANGE = 0.2

export type PoseEditorApi = {
  toggle: () => void
  setVisible: (on: boolean) => void
  /** 编辑器开着的时候不该有「待机行为」（她要哼歌/走动的判定要看这个） */
  isVisible: () => boolean
  contains: (x: number, y: number) => boolean
  getBones: () => Bones
  /** 拖动画布改角度时，把滑杆同步过来（度） */
  setOrbitDeg: (deg: number) => void
}

type Options = {
  /** 现有的姿势库 id → 骨骼，用作起点 */
  presets: Record<string, Bones>
  /** 没有草稿时用的起始姿势 */
  initial?: Bones
  /** 每次改动都回调，参数是当前全套骨骼增量 */
  onApply: (bones: Bones, hipsOffset: Vec3 | null) => void
  /** 视角旋转（度，0 = 正面）。拖动角色、拖滑杆、点预设按钮都会走这里 */
  onOrbit?: (deg: number) => void
  /**
   * 写剪贴板。返回 true 表示已经写进系统剪贴板（桌面版走主进程），
   * 返回 false 表示只能回退成「在输入框里全选，让你手动复制」。
   */
  onCopy?: (text: string) => boolean
  /** 面板宽度（像素），主程序拿它来平移相机 */
  width: number
  /** 草稿存储的 key（localStorage） */
  draftKey?: string
}

const GROUPS: { title: string; bones: BoneName[] }[] = [
  { title: '躯干', bones: ['hips', 'spine', 'chest', 'upperChest', 'neck', 'head'] },
  { title: '左臂', bones: ['leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand'] },
  { title: '右臂', bones: ['rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand'] },
  { title: '左腿', bones: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'] },
  { title: '右腿', bones: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'] },
  {
    title: '左手',
    bones: ['leftThumbProximal', 'leftIndexProximal', 'leftMiddleProximal', 'leftRingProximal', 'leftLittleProximal'],
  },
  {
    title: '右手',
    bones: ['rightThumbProximal', 'rightIndexProximal', 'rightMiddleProximal', 'rightRingProximal', 'rightLittleProximal'],
  },
]

const LABEL: Record<string, string> = {
  hips: '髋', spine: '脊椎', chest: '胸', upperChest: '上胸', neck: '脖子', head: '头',
  leftShoulder: '左肩', leftUpperArm: '左上臂', leftLowerArm: '左前臂', leftHand: '左手',
  rightShoulder: '右肩', rightUpperArm: '右上臂', rightLowerArm: '右前臂', rightHand: '右手',
  leftUpperLeg: '左大腿', leftLowerLeg: '左小腿', leftFoot: '左脚',
  rightUpperLeg: '右大腿', rightLowerLeg: '右小腿', rightFoot: '右脚',
  leftThumbProximal: '左拇指', leftIndexProximal: '左食指', leftMiddleProximal: '左中指',
  leftRingProximal: '左无名', leftLittleProximal: '左小指',
  rightThumbProximal: '右拇指', rightIndexProximal: '右食指', rightMiddleProximal: '右中指',
  rightRingProximal: '右无名', rightLittleProximal: '右小指',
  [HIPS_OFFSET_KEY]: '髋位移（米）',
}

const AXES = ['x', 'y', 'z'] as const

/** 左右互换的骨骼名（镜像用） */
function swapSide(name: string): string {
  if (name.startsWith('left')) return `right${name.slice(4)}`
  if (name.startsWith('right')) return `left${name.slice(5)}`
  return name
}

export function createPoseEditor(container: HTMLElement, opts: Options): PoseEditorApi {
  const state: Bones = {}
  let hipsOffset: Vec3 | null = null
  let selected: Selection = 'leftUpperArm'
  let visible = true
  const draftKey = opts.draftKey ?? 'poseEditor.draft'
  const undoStack: string[] = []
  const UNDO_MAX = 40

  const root = document.createElement('div')
  root.style.cssText =
    `position:fixed;right:0;top:0;width:${opts.width}px;height:100%;z-index:40;` +
    'background:rgba(16,14,20,.95);color:#e8e4ee;font:11px/1.4 system-ui,sans-serif;' +
    'display:flex;flex-direction:column;box-shadow:-6px 0 16px rgba(0,0,0,.35)'
  container.appendChild(root)

  // ---------------------------------------------------------------------------
  // 头部
  // ---------------------------------------------------------------------------
  const head = document.createElement('div')
  head.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 8px 4px;flex:0 0 auto'
  const title = document.createElement('span')
  title.textContent = '姿势编辑'
  title.style.cssText = 'font-weight:600;letter-spacing:.5px'
  head.appendChild(title)
  const closeBtn = document.createElement('button')
  closeBtn.textContent = '×'
  closeBtn.style.cssText = 'margin-left:auto;background:none;border:0;color:#bbb;font-size:16px;cursor:pointer'
  closeBtn.onclick = () => api.setVisible(false)
  head.appendChild(closeBtn)
  root.appendChild(head)

  // ---------------------------------------------------------------------------
  // 预设
  // ---------------------------------------------------------------------------
  const presetRow = document.createElement('div')
  presetRow.style.cssText = 'display:flex;gap:4px;padding:0 8px 4px;flex:0 0 auto'
  const preset = document.createElement('select')
  preset.style.cssText =
    'flex:1;min-width:0;background:#241f2c;color:#ddd;border:1px solid #3a3346;border-radius:4px;font-size:11px;padding:2px'
  const blankOpt = document.createElement('option')
  blankOpt.value = ''
  blankOpt.textContent = '从预设…'
  preset.appendChild(blankOpt)
  for (const id of Object.keys(opts.presets).sort()) {
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = id
    preset.appendChild(opt)
  }
  preset.onchange = () => {
    const id = preset.value
    if (!id) return
    pushUndo()
    loadBones(opts.presets[id] ?? {}, null)
    preset.value = ''
  }
  presetRow.appendChild(preset)
  root.appendChild(presetRow)

  // ---------------------------------------------------------------------------
  // 复制 / 粘贴 / 撤销 / 镜像 / 清空
  // ---------------------------------------------------------------------------
  const actionRow = document.createElement('div')
  actionRow.style.cssText = 'display:flex;gap:4px;padding:0 8px 4px;flex:0 0 auto'

  const copyBtn = smallButton('复制')
  copyBtn.onclick = () => {
    const json = serialize()
    console.log('[pose]', json)
    const ok = opts.onCopy?.(json) ?? false
    if (ok) {
      flash(copyBtn, '已复制')
      return
    }
    // 系统剪贴板用不了（浏览器模式 / 非聚焦窗口）：把 JSON 摆到输入框里全选，
    // 用户按 Ctrl+C 就行 —— 总比嘴上说「已复制」而剪贴板是空的强
    pasteArea.value = json
    pastePanel.style.display = 'flex'
    pasteArea.focus()
    pasteArea.select()
    flash(copyBtn, '手动复制')
  }

  const pasteBtn = smallButton('粘贴')
  const pastePanel = document.createElement('div')
  let pasteArea: HTMLTextAreaElement
  pasteBtn.onclick = () => {
    pastePanel.style.display = pastePanel.style.display === 'none' ? 'flex' : 'none'
    if (pastePanel.style.display === 'flex') {
      if (pasteArea) pasteArea.focus()
    }
  }

  const undoBtn = smallButton('撤销')
  undoBtn.onclick = () => undo()

  const mirrorBtn = smallButton('镜像')
  mirrorBtn.onclick = () => {
    pushUndo()
    const next: Bones = {}
    for (const key of Object.keys(state) as BoneName[]) {
      const v = state[key]
      if (!v) continue
      next[swapSide(key) as BoneName] = [v[0], -v[1], -v[2]]
    }
    for (const key of Object.keys(state) as BoneName[]) delete state[key]
    for (const key of Object.keys(next) as BoneName[]) state[key] = next[key]
    if (hipsOffset) hipsOffset = [-hipsOffset[0], hipsOffset[1], hipsOffset[2]]
    commit()
  }

  const clearBtn = smallButton('清空')
  clearBtn.onclick = () => {
    pushUndo()
    for (const key of Object.keys(state) as BoneName[]) delete state[key]
    hipsOffset = null
    commit()
  }

  for (const b of [copyBtn, pasteBtn, undoBtn, mirrorBtn, clearBtn]) actionRow.appendChild(b)
  root.appendChild(actionRow)

  // 粘贴面板（默认收起）
  pastePanel.style.cssText = 'display:none;flex-direction:column;gap:4px;padding:0 8px 4px;flex:0 0 auto'
  pasteArea = document.createElement('textarea')
  pasteArea.placeholder = '把 JSON 粘在这里，然后点「应用」'
  pasteArea.style.cssText =
    'width:100%;height:52px;background:#1d1926;color:#ddd;border:1px solid #3a3346;' +
    'border-radius:4px;font:10px/1.35 ui-monospace,monospace;padding:4px;resize:vertical'
  pastePanel.appendChild(pasteArea)
  const pasteApplyRow = document.createElement('div')
  pasteApplyRow.style.cssText = 'display:flex;gap:4px'
  const applyBtn = smallButton('应用')
  applyBtn.onclick = () => {
    const parsed = parsePaste(pasteArea.value)
    if (!parsed) {
      flash(applyBtn, '格式不对')
      return
    }
    pushUndo()
    loadBones(parsed.bones, parsed.hipsOffset)
    pastePanel.style.display = 'none'
    flash(applyBtn, '已应用')
  }
  const cancelBtn = smallButton('取消')
  cancelBtn.onclick = () => {
    pastePanel.style.display = 'none'
  }
  pasteApplyRow.appendChild(applyBtn)
  pasteApplyRow.appendChild(cancelBtn)
  pastePanel.appendChild(pasteApplyRow)
  root.appendChild(pastePanel)

  // ---------------------------------------------------------------------------
  // 视角
  // ---------------------------------------------------------------------------
  const viewRow = document.createElement('div')
  viewRow.style.cssText = 'display:flex;align-items:center;gap:4px;padding:0 8px 4px;flex:0 0 auto'
  const viewTag = document.createElement('span')
  viewTag.textContent = '视角'
  viewTag.style.cssText = 'color:#8b83a0'
  viewRow.appendChild(viewTag)
  const viewSlider = document.createElement('input')
  viewSlider.type = 'range'
  viewSlider.min = '0'
  viewSlider.max = '360'
  viewSlider.step = '1'
  viewSlider.value = '0'
  viewSlider.style.cssText = 'flex:1;min-width:0;accent-color:#7fb6ff'
  viewRow.appendChild(viewSlider)
  const viewVal = document.createElement('span')
  viewVal.textContent = '0°'
  viewVal.style.cssText = 'width:32px;text-align:right;color:#9ecbff;font-variant-numeric:tabular-nums'
  viewRow.appendChild(viewVal)
  root.appendChild(viewRow)

  const viewBtns = document.createElement('div')
  viewBtns.style.cssText = 'display:flex;gap:4px;padding:0 8px 6px;flex:0 0 auto'
  for (const [label, deg] of [['正', 0], ['侧', 90], ['背', 180], ['侧后', 270]] as const) {
    const b = smallButton(label)
    b.onclick = () => setOrbitDeg(deg)
    viewBtns.appendChild(b)
  }
  root.appendChild(viewBtns)

  // ---------------------------------------------------------------------------
  // 骨骼列表
  // ---------------------------------------------------------------------------
  const list = document.createElement('div')
  list.style.cssText = 'flex:1 1 auto;overflow-y:auto;padding:0 6px 6px'
  root.appendChild(list)

  // ---------------------------------------------------------------------------
  // 选中项的滑杆
  // ---------------------------------------------------------------------------
  const detail = document.createElement('div')
  detail.style.cssText = 'flex:0 0 auto;border-top:1px solid #322b3e;padding:6px 8px 10px;background:#131018'
  root.appendChild(detail)

  const detailName = document.createElement('div')
  detailName.style.cssText = 'font-weight:600;margin-bottom:4px;color:#cbb8f0'
  detail.appendChild(detailName)

  const sliders: HTMLInputElement[] = []
  const numbers: HTMLInputElement[] = []
  for (const axis of AXES) {
    const line = document.createElement('div')
    line.style.cssText = 'display:flex;align-items:center;gap:5px;margin:2px 0'

    const tag = document.createElement('span')
    tag.textContent = axis.toUpperCase()
    tag.style.cssText = 'width:10px;color:#8b83a0'
    line.appendChild(tag)

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = String(-3.2)
    slider.max = String(3.2)
    slider.step = '0.01'
    slider.value = '0'
    slider.style.cssText = 'flex:1;min-width:0;accent-color:#b78bfa'
    line.appendChild(slider)

    const num = document.createElement('input')
    num.type = 'number'
    num.step = '0.01'
    num.value = '0'
    num.style.cssText =
      'width:54px;background:#1d1926;color:#9ee6c8;border:1px solid #3a3346;border-radius:3px;' +
      'font:10px ui-monospace,monospace;padding:1px 3px;text-align:right'
    line.appendChild(num)

    sliders.push(slider)
    numbers.push(num)
    detail.appendChild(line)
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------
  function smallButton(text: string): HTMLButtonElement {
    const b = document.createElement('button')
    b.textContent = text
    b.style.cssText =
      'flex:1;background:#2a2334;border:1px solid #3d3450;color:#ddd;border-radius:4px;' +
      'font-size:11px;padding:3px 0;cursor:pointer'
    return b
  }

  function flash(button: HTMLButtonElement, text: string): void {
    const old = button.textContent ?? ''
    button.textContent = text
    window.setTimeout(() => (button.textContent = old), 900)
  }

  function serialize(): string {
    const out: Record<string, unknown> = { ...state }
    if (hipsOffset) out.hipsOffset = hipsOffset
    return JSON.stringify(out)
  }

  function parsePaste(text: string): { bones: Bones; hipsOffset: Vec3 | null } | null {
    let data: unknown
    try {
      data = JSON.parse(text)
    } catch {
      return null
    }
    if (!data || typeof data !== 'object') return null
    const bones: Bones = {}
    let offset: Vec3 | null = null
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(value) || value.length < 3) continue
      const v: Vec3 = [Number(value[0]), Number(value[1]), Number(value[2])]
      if (v.some((n) => !Number.isFinite(n))) continue
      if (key === 'hipsOffset') offset = v
      else if ((BONE_NAMES as readonly string[]).includes(key)) bones[key as BoneName] = v
    }
    return { bones, hipsOffset: offset }
  }

  function pushUndo(): void {
    undoStack.push(JSON.stringify({ bones: state, hipsOffset }))
    if (undoStack.length > UNDO_MAX) undoStack.shift()
  }

  function undo(): void {
    const prev = undoStack.pop()
    if (!prev) {
      flash(undoBtn, '没有可撤销')
      return
    }
    const parsed = JSON.parse(prev) as { bones: Bones; hipsOffset: Vec3 | null }
    for (const key of Object.keys(state) as BoneName[]) delete state[key]
    for (const key of Object.keys(parsed.bones) as BoneName[]) state[key] = parsed.bones[key] as Vec3
    hipsOffset = parsed.hipsOffset
    commit()
  }

  function current(): Vec3 {
    if (selected === HIPS_OFFSET_KEY) return hipsOffset ?? [0, 0, 0]
    return state[selected] ?? [0, 0, 0]
  }

  function axisRange(): number {
    return selected === HIPS_OFFSET_KEY ? HIPS_OFFSET_RANGE : 3.2
  }

  function setAxis(index: number, rawValue: number): void {
    if (!Number.isFinite(rawValue)) return
    const value = Math.max(-axisRange(), Math.min(axisRange(), rawValue))
    const v = current().slice() as Vec3
    v[index] = Math.round(value * 1000) / 1000
    writeValue(v)
    commit()
  }

  function writeValue(v: Vec3): void {
    if (selected === HIPS_OFFSET_KEY) {
      hipsOffset = v
      return
    }
    if (v[0] === 0 && v[1] === 0 && v[2] === 0) delete state[selected]
    else state[selected] = v
  }

  /** 改动后统一走这里：落盘草稿、应用、刷新界面 */
  function commit(): void {
    saveDraft()
    opts.onApply(state, hipsOffset)
    renderDetail()
    renderList()
  }

  function saveDraft(): void {
    try {
      localStorage.setItem(draftKey, serialize())
    } catch {
      /* 隐私模式写不进去就算了 */
    }
  }

  function loadDraft(): { bones: Bones; hipsOffset: Vec3 | null } | null {
    try {
      const raw = localStorage.getItem(draftKey)
      return raw ? parsePaste(raw) : null
    } catch {
      return null
    }
  }

  function renderDetail(): void {
    detailName.textContent = LABEL[selected] ?? selected
    const v = current()
    const range = axisRange()
    for (let i = 0; i < 3; i++) {
      sliders[i].min = String(-range)
      sliders[i].max = String(range)
      sliders[i].step = selected === HIPS_OFFSET_KEY ? '0.005' : '0.01'
      if (document.activeElement !== sliders[i]) sliders[i].value = String(v[i])
      if (document.activeElement !== numbers[i]) numbers[i].value = String(Number(v[i].toFixed(3)))
    }
  }

  function renderList(): void {
    list.textContent = ''

    // 髋位移单独一项，放在躯干前面
    const offsetRow = document.createElement('div')
    offsetRow.textContent = hipsOffset ? `髋位移 ${hipsOffset.map((n) => n.toFixed(2)).join(', ')}` : '髋位移'
    offsetRow.style.cssText =
      'padding:3px 6px;border-radius:3px;cursor:pointer;margin-bottom:2px;' +
      (selected === HIPS_OFFSET_KEY
        ? 'background:#3a2f52;color:#fff;'
        : hipsOffset
          ? 'color:#c9b6ff;font-style:italic;'
          : 'color:#8d8599;')
    offsetRow.onclick = () => {
      selected = HIPS_OFFSET_KEY
      renderList()
      renderDetail()
    }
    list.appendChild(offsetRow)

    for (const group of GROUPS) {
      const box = document.createElement('details')
      box.open = group.bones.includes(selected as BoneName) || group.title === '左臂' || group.title === '右臂'
      const sum = document.createElement('summary')
      sum.textContent = group.title
      sum.style.cssText = 'cursor:pointer;color:#9a91ad;padding:3px 2px;font-size:10.5px;letter-spacing:.5px'
      box.appendChild(sum)

      for (const bone of group.bones) {
        const row = document.createElement('div')
        const touched = Boolean(state[bone])
        row.textContent = LABEL[bone] ?? bone
        row.style.cssText =
          'padding:2px 6px;border-radius:3px;cursor:pointer;' +
          (bone === selected ? 'background:#3a2f52;color:#fff;' : touched ? 'color:#c9b6ff;' : 'color:#8d8599') +
          (touched && bone !== selected ? 'font-style:italic;' : '')
        row.onclick = () => {
          selected = bone
          renderList()
          renderDetail()
        }
        box.appendChild(row)
      }
      list.appendChild(box)
    }
  }

  function loadBones(bones: Bones, offset: Vec3 | null): void {
    for (const key of Object.keys(state) as BoneName[]) delete state[key]
    for (const key of Object.keys(bones) as BoneName[]) {
      const v = bones[key]
      if (v) state[key] = [v[0], v[1], v[2]]
    }
    hipsOffset = offset ? [offset[0], offset[1], offset[2]] : null
    const first = Object.keys(bones)[0] as BoneName | undefined
    if (first && BONE_NAMES.includes(first)) selected = first
    commit()
  }

  function setOrbitDeg(deg: number): void {
    const d = Math.round(((deg % 360) + 360) % 360)
    viewSlider.value = String(d)
    viewVal.textContent = `${d}°`
    opts.onOrbit?.(d)
  }

  // ---------------------------------------------------------------------------
  // 事件绑定
  // ---------------------------------------------------------------------------
  sliders.forEach((slider, i) => {
    slider.oninput = () => setAxis(i, Number(slider.value))
  })
  numbers.forEach((num, i) => {
    num.onchange = () => setAxis(i, Number(num.value))
    // 回车直接生效，不用点别处
    num.onkeydown = (event) => {
      if ((event as KeyboardEvent).key === 'Enter') num.blur()
    }
  })
  viewSlider.oninput = () => setOrbitDeg(Number(viewSlider.value))

  window.addEventListener('keydown', (event) => {
    if (!visible) return
    const typing = (event.target as HTMLElement | null)?.tagName
    if (typing === 'INPUT' || typing === 'TEXTAREA') return
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      undo()
    }
  })

  root.addEventListener('pointerdown', (event) => event.stopPropagation())

  // 启动：优先恢复上次没调完的草稿，没有才用初始姿势
  const draft = loadDraft()
  if (draft) {
    for (const key of Object.keys(draft.bones) as BoneName[]) state[key] = draft.bones[key] as Vec3
    hipsOffset = draft.hipsOffset
    const first = Object.keys(draft.bones)[0] as BoneName | undefined
    if (first) selected = first
    opts.onApply(state, hipsOffset)
  } else if (opts.initial) {
    for (const key of Object.keys(opts.initial) as BoneName[]) {
      const v = opts.initial[key]
      if (v) state[key] = [v[0], v[1], v[2]]
    }
    opts.onApply(state, null)
  }
  renderList()
  renderDetail()

  const api: PoseEditorApi = {
    toggle() {
      api.setVisible(!visible)
    },
    setVisible(on: boolean) {
      visible = on
      root.style.display = on ? 'flex' : 'none'
    },
    isVisible: () => visible,
    contains(x: number, y: number) {
      if (!visible) return false
      const rect = root.getBoundingClientRect()
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
    },
    getBones: () => state,
    setOrbitDeg,
  }

  return api
}
