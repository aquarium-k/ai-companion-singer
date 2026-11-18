/**
 * 麦克风采集。
 *
 * 三个决定：
 *
 * 1. **AudioContext 直接建在 16 kHz**。浏览器的音频图谱可以做采样率转换，
 *    工作线程拿到的就是 16 kHz 的块，不需要自己重采样——YIN 的帧参数
 *    （512 点窗、160 点帧移）也就和离线验证过的配置完全一致。
 *
 * 2. **开回声消除**。角色自己会放伴奏，麦克风必然收到；Chromium 的 AEC3
 *    会拿本进程播出去的声音当参考，正好把伴奏抵消。这是跟着唱能不能用的关键，
 *    但效果只能在真机上验证。降噪关掉（它会削掉气声和辅音），自动增益开着
 *    （手机/笔记本麦克风电平差异太大）。
 *
 * 3. **不用 AnalyserNode 轮询**。`requestAnimationFrame` 的节拍和音频块不同步，
 *    会重复或漏样；AudioWorklet 按渲染量子（128 样本）推数据，时间轴是干净的。
 *    worklet 代码用 Blob URL 内联，免得给打包器加一条资源路径。
 */

export type MicSession = {
  /** 实际使用的采样率（正常情况下就是 16000） */
  sampleRate: number
  stop(): void
}

/** 攒够多少样本推一次（256 @16k = 16 ms，比 128 省一半消息又不至于太迟） */
const BATCH = 256

const WORKLET_SRC = `
class MicTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(${BATCH})
    this.n = 0
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i]
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice(0))
        this.n = 0
      }
    }
    return true
  }
}
registerProcessor('mic-tap', MicTap)
`

export async function startMic(onBlock: (block: Float32Array) => void): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('这个环境没有 getUserMedia（需要安全上下文或权限）')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  })

  // 采样率必须在这里指定；指定失败时浏览器会给默认值，交给调用方判断
  const ctx = new AudioContext({ sampleRate: 16000 })
  try {
    await ctx.resume()
  } catch {
    /* 已经运行 */
  }

  const src = ctx.createMediaStreamSource(stream)
  const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }

  const node = new AudioWorkletNode(ctx, 'mic-tap')
  node.port.onmessage = (ev: MessageEvent<Float32Array>) => onBlock(ev.data)
  src.connect(node)

  // worklet 没有输出就不参与渲染（Chrome 会直接不跑它），
  // 所以接一条增益为 0 的线到 destination：被拉取，但不出声。
  const mute = ctx.createGain()
  mute.gain.value = 0
  node.connect(mute)
  mute.connect(ctx.destination)

  let stopped = false
  return {
    sampleRate: ctx.sampleRate,
    stop() {
      if (stopped) return
      stopped = true
      node.port.onmessage = null
      try {
        node.disconnect()
        mute.disconnect()
        src.disconnect()
      } catch {
        /* 已经断开 */
      }
      for (const track of stream.getTracks()) track.stop()
      void ctx.close()
    },
  }
}
