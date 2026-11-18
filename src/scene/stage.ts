import * as THREE from 'three'

export type PiPTarget = {
  /** 要放大的世界坐标（嘴部中心） */
  center: THREE.Vector3
  /** 副视口覆盖的世界高度，米。越小放大倍数越高 */
  height: number
}

export type Stage = {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  resize: () => void
  /** 告诉场景「角色应该占多大画面」：距离和注视高度。主程序按包围盒算好后调这里 */
  setFraming: (dist: number, lookY: number) => void
  /** 水平平移取景（像素）：姿势编辑器的面板挡住右边时把角色推到左边 */
  setPan: (pixels: number) => void
  /** 环绕角度（弧度）：0 = 正面，π/2 = 从角色左侧看，π = 背面 */
  setOrbit: (radians: number) => void
  getOrbit: () => number
  /** 机位高度（米，相对注视点）：0 = 平视，正数 = 俯视 */
  setElevation: (meters: number) => void
  getElevation: () => number
  render: (pip?: PiPTarget | null) => void
  dispose: () => void
}

/** 副视口的边长（CSS 像素）和到目标的距离（米） */
const PIP_SIZE = 148
const PIP_DIST = 0.32
const PIP_MARGIN = 8

/** 用一张径向渐变贴图做接触阴影，比 shadowMap 便宜且和透明背景兼容 */
function contactShadowTexture(): THREE.CanvasTexture {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const grd = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2)
  grd.addColorStop(0, 'rgba(0,0,0,0.45)')
  grd.addColorStop(0.5, 'rgba(0,0,0,0.16)')
  grd.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grd
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function createStage(container: HTMLElement): Stage {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.95
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60)
  camera.position.set(0, 0.95, 2.65)
  camera.lookAt(0, 0.78, 0)

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb9a8c9, 0.85)
  hemi.position.set(0, 3, 0)
  scene.add(hemi)

  const key = new THREE.DirectionalLight(0xfff4ec, 1.5)
  key.position.set(1.4, 2.8, 2.4)
  scene.add(key)

  const rim = new THREE.DirectionalLight(0x9fd0ff, 0.7)
  rim.position.set(-1.8, 1.6, -1.6)
  scene.add(rim)

  const fill = new THREE.AmbientLight(0xffffff, 0.28)
  scene.add(fill)

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.05, 1.05),
    new THREE.MeshBasicMaterial({
      map: contactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.9,
    }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = 0.002
  scene.add(shadow)

  const resize = (): void => {
    const w = container.clientWidth || window.innerWidth
    const h = container.clientHeight || window.innerHeight
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  window.addEventListener('resize', resize)

  // 副视口用的相机：站在嘴正前方 PIP_DIST 处，视场按目标高度反算
  const pipCam = new THREE.PerspectiveCamera(24, 1, 0.01, 60)
  const pipCenter = new THREE.Vector3()

  // 副视口的边框。透明窗口里没有背景，光看画面分不出边界在哪。
  const pipFrame = document.createElement('div')
  pipFrame.style.cssText =
    `position:fixed;right:${PIP_MARGIN}px;bottom:${PIP_MARGIN}px;` +
    `width:${PIP_SIZE}px;height:${PIP_SIZE}px;border:1px solid rgba(255,255,255,.4);` +
    'border-radius:10px;pointer-events:none;display:none;z-index:5'
  container.appendChild(pipFrame)

  const renderPiP = (target: PiPTarget): void => {
    const w = renderer.domElement.clientWidth
    const h = renderer.domElement.clientHeight
    const x = w - PIP_SIZE - PIP_MARGIN
    const y = PIP_MARGIN

    pipCenter.copy(target.center)
    // 正对镜头（主相机在 +Z 侧、略微俯视）。角色转身时这里不跟，
    // 是调试用的取景，不追求一直能看见脸。
    pipCam.position.set(pipCenter.x, pipCenter.y + PIP_DIST * 0.06, pipCenter.z + PIP_DIST)
    pipCam.lookAt(pipCenter)
    pipCam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(target.height / 2 / PIP_DIST))
    pipCam.aspect = 1
    pipCam.updateProjectionMatrix()

    renderer.setScissorTest(true)
    renderer.setViewport(x, y, PIP_SIZE, PIP_SIZE)
    renderer.setScissor(x, y, PIP_SIZE, PIP_SIZE)
    // 只清这一块，别把主画面擦掉；alpha 也清，副视口外是透明的
    renderer.autoClear = false
    renderer.clear(true, true, true)
    renderer.render(scene, pipCam)
    renderer.autoClear = true
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, w, h)
  }

  const render = (pip?: PiPTarget | null): void => {
    renderer.render(scene, camera)
    pipFrame.style.display = pip ? 'block' : 'none'
    if (pip) renderPiP(pip)
  }

  /**
   * 相机状态：构图（距离、注视高度）+ 平移 + 环绕角度。
   *
   * 之前这里是直接写 `camera.position.set(...)`，一旦主程序重新构图（`frameRig`）
   * 或者加了编辑器平移，后面那个就会把前面的覆盖掉。改成「状态 + 一次重算」，
   * 三个来源各管各的，互不打架。
   */
  let viewDist = 2.65
  let viewLookY = 0.78
  let panPx = 0
  let orbitRad = 0
  /** 机位比注视点高多少（米）。第二个机位靠它做「从右上方看」 */
  let viewElev = 0

  const applyCamera = (): void => {
    const h = renderer.domElement.clientHeight || 1
    const worldPerPx = (2 * viewDist * Math.tan((camera.fov * Math.PI) / 360)) / h
    const lookX = panPx * worldPerPx
    // 以注视点为中心、半径 viewDist 在水平圆上取位置，再抬到 viewElev 的高度，
    // 然后始终看向它——环视、俯视、平移三者互不干扰
    camera.position.set(
      lookX + Math.sin(orbitRad) * viewDist,
      viewLookY + viewElev,
      Math.cos(orbitRad) * viewDist,
    )
    camera.lookAt(lookX, viewLookY, 0)
  }

  const setFraming = (dist: number, lookY: number): void => {
    viewDist = dist
    viewLookY = lookY
    applyCamera()
  }

  const setPan = (pixels: number): void => {
    panPx = pixels
    applyCamera()
  }

  const setOrbit = (radians: number): void => {
    orbitRad = radians
    applyCamera()
  }

  const getOrbit = (): number => orbitRad

  const setElevation = (meters: number): void => {
    viewElev = meters
    applyCamera()
  }

  const getElevation = (): number => viewElev

  const dispose = (): void => {
    window.removeEventListener('resize', resize)
    scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    })
    renderer.dispose()
    renderer.domElement.remove()
    pipFrame.remove()
  }

  return {
    renderer,
    scene,
    camera,
    resize,
    setFraming,
    setPan,
    setOrbit,
    getOrbit,
    setElevation,
    getElevation,
    render,
    dispose,
  }
}
