/**
 * 曲包导入：启动 tools/pipeline.py、读 job.json、把成品登记进 index.json。
 *
 * 为什么放在主进程
 * ----------------
 * 流水线要跑几分钟，渲染层不能阻塞；而且它要 spawn 子进程、写曲包目录，
 * 这些渲染层都不该直接干。渲染层只做一件事：每秒调 `import:job` 轮询进度。
 *
 * 状态不从这里推给渲染层，是为了让「关掉窗口再打开」也能继续看进度——
 * 只要 job.json 还在，重新打开读一次就够了。
 */

const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

let ctx = null // { root, songpacks, pythonPath }
let child = null
let childLog = null
let current = null // { packId, audioPath }
//: { cmd, prefix } | false（探测过但找不到）。false 是「探测过」，和「没探测过」要区分开
let pythonCache = undefined

const AUDIO_EXTS = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus'])
const CASE_INSENSITIVE = process.platform === 'win32'

function init(context) {
  ctx = context
}

function pipelineEnv(root) {
  return {
    ...process.env,
    // 和 tools/pipeline.py 里的 ENV_DEFAULTS 保持一致；
    // 两边都设是为了直接从命令行跑时也能工作
    PYTHONPATH: path.join(root, '.pylibs'),
    HF_HOME: path.join(root, '.cache', 'huggingface'),
    HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    PET_SANDBOX_FIX: '1',
  }
}

/**
 * 找 Python。打包后的机器上不一定有 PATH 里的 python，
 * 而且 Windows 商店版 `python` 是个空壳（装没装都返回一个会失败的 alias），
 * 所以按「显式配置 → 仓库内 venv → PATH → py 启动器」的顺序逐个试，找到就缓存。
 */
function findPython(root) {
  if (pythonCache !== undefined) return pythonCache
  const candidates = [
    { cmd: ctx?.pythonPath, args: ['--version'] },
    { cmd: process.env.PET_PYTHON, args: ['--version'] },
    { cmd: path.join(root, '.venv', 'Scripts', 'python.exe'), args: ['--version'] },
    { cmd: path.join(root, '.venv', 'bin', 'python'), args: ['--version'] },
    { cmd: 'python', args: ['--version'] },
    { cmd: 'python3', args: ['--version'] },
    // Windows 的 py 启动器是唯一能绕开商店 alias 的通用入口
    { cmd: 'py', args: ['-3', '--version'] },
  ].filter((c) => Boolean(c.cmd))

  for (const candidate of candidates) {
    try {
      execFileSync(candidate.cmd, candidate.args, { stdio: 'ignore', timeout: 10000 })
      // `py -3` 要带上 "-3" 才能真正启动解释器。
      // 缓存**整个对象**：之前缓存的是 candidate.cmd 字符串，
      // 而这里 return 的是对象，于是第二次调用拿到字符串，
      // `[...python.prefix]` 直接抛 TypeError —— 导入点下去没反应就是这个。
      pythonCache = { cmd: candidate.cmd, prefix: candidate.cmd === 'py' ? ['-3'] : [] }
      return pythonCache
    } catch {
      /* 试下一个 */
    }
  }
  pythonCache = false
  return false
}

function slugify(name) {
  const base = name.replace(/\.[^.]+$/, '')
  const slug = base
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `pack-${Date.now()}`
}

function isAudio(filePath) {
  if (typeof filePath !== 'string' || !filePath) return false
  const ext = path.extname(filePath)
  return CASE_INSENSITIVE ? AUDIO_EXTS.has(ext.toLowerCase()) : AUDIO_EXTS.has(ext)
}

function readJob(packId) {
  if (!ctx || !packId) return null
  const file = path.join(ctx.songpacks, packId, 'job.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 标题 → 曲包目录名。重名即同一个曲包，这是断点续跑的基础。 */
function packIdFor(title) {
  return slugify(String(title || '').replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i, ''))
}

/** 这个曲包是不是已经有解析好的歌词（重新导入时可以不用再选） */
function hasLyrics(title) {
  if (!ctx) return false
  const file = path.join(ctx.songpacks, packIdFor(title), 'lyrics.json')
  return fs.existsSync(file)
}

function addToIndex(packId) {
  const indexFile = path.join(ctx.songpacks, 'index.json')
  let index = { schema: 1, packs: [] }
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  } catch {
    /* 没有就新建 */
  }
  const packs = Array.isArray(index.packs) ? index.packs : []
  if (!packs.includes(packId)) {
    packs.push(packId)
    index = { ...index, schema: index.schema ?? 1, packs }
    fs.writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  }
  return packs
}

/** 原子写 job.json（和 pipeline.py 里 write_job 相同的做法） */
function writeJobFile(packId, job) {
  const file = path.join(ctx.songpacks, packId, 'job.json')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 删掉一个曲包：目录 + `index.json` 里的登记。
 *
 * 为什么直接删而不是进回收站：曲包是几百 MB 的派生数据，原音频还在，随时能重导一遍；
 * 而 `shell.trashItem` 在某些文件系统/权限下会失败，失败后还得回退到删除，
 * 不如把「确认」放在界面里做（点两下才真删），逻辑保持一条路。
 *
 * 三重防护：id 必须是 songpacks 的**直接子目录**（挡住 `..`、绝对路径、带分隔符的名字），
 * 正在导入的那个包不许删，删完立刻同步 index.json（否则界面上还列着它）。
 */
function removePack(packId) {
  if (!ctx) return { ok: false, error: '主进程还没初始化' }
  const id = String(packId ?? '')
  if (!id || id === '.' || id === '..' || /[\\/:*?"<>|]/.test(id)) {
    return { ok: false, error: '曲包 id 不合法' }
  }
  const dir = path.resolve(ctx.songpacks, id)
  if (path.dirname(dir) !== path.resolve(ctx.songpacks)) {
    return { ok: false, error: '不在曲包目录里' }
  }
  if (!fs.existsSync(dir)) return { ok: false, error: '曲包不存在' }
  const running = currentJob()
  if (busy() && running?.packId === id) {
    return { ok: false, error: '这个曲包正在导入，先取消再删' }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    return { ok: false, error: `删除失败：${err.message}` }
  }

  const indexFile = path.join(ctx.songpacks, 'index.json')
  let index = { schema: 1, packs: [] }
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  } catch {
    /* 没有就新建 */
  }
  const packs = (Array.isArray(index.packs) ? index.packs : []).filter((p) => p !== id)
  fs.writeFileSync(
    indexFile,
    `${JSON.stringify({ ...index, schema: index.schema ?? 1, packs }, null, 2)}\n`,
    'utf8',
  )
  return { ok: true, packs }
}

/**
 * 改曲包名字（B8 的后半）。
 *
 * 三件事要一起改，只改界面等于骗人：
 *   ① 目录名（`songpacks/<id>`）——id 就是目录名，改标题不改目录会让
 *      「下次再导入同一首歌」找不到原来的断点；
 *   ② `index.json` 里的登记（保持原来的顺序，别把列表顺序搅乱）；
 *   ③ `pack.json` 的 `id` / `title`，还有 `job.json` 里的（有就改，没有算正常）。
 *
 * 不做「只改标题不改目录」的分支：目录名和标题一旦能不一致，用户就再也不知道
 * 磁盘上那堆目录谁是谁了。想留原目录就别改（新旧 id 相同 = 只更新文本）。
 */
function renamePack(packId, title) {
  if (!ctx) return { ok: false, error: '主进程还没初始化' }
  const id = String(packId ?? '')
  if (!id || id === '.' || id === '..' || /[\\/:*?"<>|]/.test(id)) {
    return { ok: false, error: '曲包 id 不合法' }
  }
  const clean = String(title ?? '').trim()
  if (!clean) return { ok: false, error: '名字不能为空' }
  if (clean.length > 60) return { ok: false, error: '名字太长（最多 60 个字）' }

  const oldDir = path.resolve(ctx.songpacks, id)
  if (path.dirname(oldDir) !== path.resolve(ctx.songpacks)) {
    return { ok: false, error: '不在曲包目录里' }
  }
  if (!fs.existsSync(oldDir)) return { ok: false, error: '曲包不存在' }
  const running = currentJob()
  if (busy() && running?.packId === id) {
    return { ok: false, error: '这个曲包正在导入，先取消再改名' }
  }

  const nextId = packIdFor(clean)
  const nextDir = path.resolve(ctx.songpacks, nextId)
  // slugify 之后可能撞目录名：另一个曲包已经叫这个了
  if (nextId !== id && fs.existsSync(nextDir)) {
    return { ok: false, error: `已经有叫「${nextId}」的曲包了` }
  }
  // 标题也不许撞：目录名不同但显示名一样，列表里就是两行一模一样的字，谁也分不出
  const indexFile0 = path.join(ctx.songpacks, 'index.json')
  let existing = []
  try {
    existing = JSON.parse(fs.readFileSync(indexFile0, 'utf8')).packs ?? []
  } catch {
    /* 没有索引就无从撞名 */
  }
  for (const other of existing) {
    if (other === id || other === nextId) continue
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(ctx.songpacks, other, 'pack.json'), 'utf8'))
      if (String(doc.title ?? '').trim() === clean) {
        return { ok: false, error: `已经有叫「${clean}」的曲包了` }
      }
    } catch {
      /* 读不出来的曲包不参与撞名判断 */
    }
  }

  // ① 目录
  if (nextId !== id) {
    try {
      fs.renameSync(oldDir, nextDir)
    } catch (err) {
      return { ok: false, error: `改目录失败：${err.message}` }
    }
  }

  // ② index.json（原地替换，保持顺序）
  const indexFile = path.join(ctx.songpacks, 'index.json')
  let index = { schema: 1, packs: [] }
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'))
  } catch {
    /* 没有就新建 */
  }
  const list = Array.isArray(index.packs) ? index.packs : []
  const replaced = list.includes(id) ? list.map((p) => (p === id ? nextId : p)) : [...list, nextId]
  const packs = replaced.filter((p, i) => replaced.indexOf(p) === i)
  fs.writeFileSync(
    indexFile,
    `${JSON.stringify({ ...index, schema: index.schema ?? 1, packs }, null, 2)}\n`,
    'utf8',
  )

  // ③ pack.json / job.json
  for (const name of ['pack.json', 'job.json']) {
    const file = path.join(nextDir, name)
    if (!fs.existsSync(file)) continue
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      doc.id = nextId
      doc.title = clean
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
    } catch {
      /* 改不动就算了：跑不起来的曲包本来就读不出来 */
    }
  }

  return { ok: true, id: nextId, title: clean, packs }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/** 子进程一步都没跑起来时，把日志尾巴写进 job.json，面板才有的看 */
function failQueuedJob(packId, startedAt, reason, code) {
  const job = readJob(packId)
  // 只有还停在我们写的 queued 才能动它：pipeline.py 一旦写盘就不可能是 queued
  if (!job || job.state !== 'queued' || job.started !== startedAt) return
  let tail = ''
  try {
    const text = fs.readFileSync(childLog, 'utf8')
    tail = text.split('\n').filter(Boolean).slice(-12).join('\n')
  } catch {
    /* ignore */
  }
  writeJobFile(packId, {
    ...job,
    state: 'failed',
    error: `${reason}${code == null ? '' : `（退出码 ${code}）`}\n${tail}`.trim(),
    updated: stamp(),
  })
}

/** 启动一次导入。`fromStage` 用来做「重试这一步」。 */
function start({ audioPath, lyricsPath, title, bpm, fromStage, only }) {
  if (!ctx) return { ok: false, error: '主进程还没初始化' }
  if (!isAudio(audioPath)) return { ok: false, error: '不是音频文件' }
  if (!fs.existsSync(audioPath)) return { ok: false, error: '文件不存在' }
  if (child && !child.killed) return { ok: false, error: '已经有任务在跑' }

  const python = findPython(ctx.root)
  if (!python) return { ok: false, error: '找不到 Python（设 PET_PYTHON 或装到 PATH）' }

  const raw = title || path.basename(audioPath)
  // 只剥音频扩展名，别用通用的「去掉最后一个点之后」——
  // 像 "Mr.Children" 这种名字会被吃掉半截
  const name = raw.replace(/\.(mp3|wav|flac|m4a|aac|ogg|opus)$/i, '')
  const packId = slugify(name)
  const packDir = path.join(ctx.songpacks, packId)
  fs.mkdirSync(packDir, { recursive: true })

  const args = [
    '-u', // 日志实时落盘：不缓冲的话跑几分钟 data/pipeline-*.log 一直是 0 字节
    path.join(ctx.root, 'tools', 'pipeline.py'),
    '--pack-dir', packDir,
    '--audio', audioPath,
    '--title', name,
  ]
  if (lyricsPath) args.push('--lyrics-src', lyricsPath)
  if (bpm) args.push('--bpm', String(bpm))
  if (only) args.push('--only', only)
  else if (fromStage) args.push('--from', fromStage)

  childLog = path.join(ctx.root, 'data', `pipeline-${packId}.log`)
  fs.mkdirSync(path.dirname(childLog), { recursive: true })
  // 直接把子进程的 stdout/stderr 接到文件描述符上，不经过管道：
  // 一是主进程不用搬运几十 KB 的日志，二是沙箱/受限环境里 pipe 会 EPERM。
  let fd
  try {
    fd = fs.openSync(childLog, 'w')
  } catch (err) {
    return { ok: false, error: `打不开日志：${err.message}` }
  }

  // 先把 job.json 写成 queued：pipeline.py 至少要几百毫秒才能启动并接管它，
  // 这期间面板轮询会读到**上一次**的 job.json（比如上次是 done），
  // 于是刚点「开始」就显示「导入完成」。写 queued 同时保住 stages，
  // 断点续跑的信息不会丢（pipeline.py 只认 stages[*].state）。
  const previousJob = readJob(packId) || {}
  const queuedAt = stamp()
  try {
    writeJobFile(packId, {
      ...previousJob,
      schema: 1,
      id: packId,
      title: name,
      audio: audioPath,
      lyrics_src: lyricsPath || previousJob.lyrics_src || null,
      state: 'queued',
      stage: null,
      error: null,
      started: queuedAt,
      updated: queuedAt,
      stages: previousJob.stages || {},
    })
  } catch (err) {
    console.warn('[import] 写 queued 状态失败', err)
  }

  try {
    child = spawn(python.cmd, [...python.prefix, ...args], {
      cwd: ctx.root,
      env: pipelineEnv(ctx.root),
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    })
  } catch (err) {
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
    failQueuedJob(packId, queuedAt, `启动 Python 失败：${err.message}`)
    return { ok: false, error: `启动 Python 失败：${err.message}` }
  }

  child.on('exit', (code) => {
    try {
      fs.writeSync(fd, `\n[exit] ${code}\n`)
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
    child = null
    failQueuedJob(packId, queuedAt, 'Python 没跑完就退出了', code)
  })
  child.on('error', (err) => {
    try {
      fs.writeSync(fd, `\n[spawn error] ${err.message}\n`)
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
    child = null
    failQueuedJob(packId, queuedAt, `spawn 失败：${err.message}`)
  })

  current = { packId, audioPath, lyricsPath, title: name }
  return { ok: true, packId, title: name, log: childLog }
}

function cancel() {
  if (!child) return { ok: false, error: '没有在跑的任务' }
  try {
    child.kill()
  } catch {
    /* ignore */
  }
  child = null
  return { ok: true }
}

function busy() {
  return Boolean(child && !child.killed)
}

/** 给状态接口用：返回解释器命令字符串，找不到就是 null */
function pythonInfo(root) {
  const found = findPython(root)
  if (!found) return null
  return [found.cmd, ...found.prefix].join(' ')
}

/** 给「同步跑个小工具」用（搜歌词这类几秒钟的操作） */
function pythonArgv(root) {
  return findPython(root)
}

function envFor(root) {
  return pipelineEnv(root)
}

function currentJob() {
  return current ? { ...current, job: readJob(current.packId) } : null
}

module.exports = {
  init,
  isAudio,
  readJob,
  hasLyrics,
  packIdFor,
  addToIndex,
  removePack,
  renamePack,
  start,
  cancel,
  busy,
  currentJob,
  pythonInfo,
  pythonArgv,
  envFor,
  AUDIO_EXTS,
}
