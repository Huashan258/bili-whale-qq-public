/**
 * 把 SnowLuma 拉起来 —— 让「跑本项目」等于「SnowLuma 也在跑」。
 *
 * 为什么需要这个文件：
 *   SnowLuma 的 SQLite 原生模块要求 Node >= 24，而系统 PATH 里的 node
 *   可能是 22（WorkBuddy 管理版等）。用错版本不会崩，只是数据库迁移失败、
 *   OneBot 的 3000/3001 永远不起，表现就像「SnowLuma 没启动」。
 *   所以这里固定用 SnowLuma 目录自带的 node.exe。
 *
 *   还有一个坑：SnowLuma 的 hookAutoLoad 默认 false。QQ 一旦重启（换了进程），
 *   旧的注入就断了，而 SnowLuma 不会自己再注入 —— 于是 5099 的 WebUI 好好的，
 *   3000/3001 却永远不监听。所以这里既会打开 hookAutoLoad，也会在
 *   「5099 活着但 3000 没起来」时主动重启 SnowLuma，让它重新注入 QQ。
 *
 *   node src/snowluma.mjs        手动拉起（已经在跑就直接返回）
 *   node src/snowluma.mjs --restart  强制重启 SnowLuma（QQ 重启后连不上时用）
 */
import { spawn, execFileSync } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

export const SL_DIR = process.env.SNOWLUMA_DIR || path.resolve(ROOT, '..', 'snowluma')
export const SL_PORT = Number(process.env.SNOWLUMA_PORT || 5099)
const LAUNCH_DATA = process.env.BILI_WHALE_DATA ? path.resolve(process.env.BILI_WHALE_DATA) : path.join(ROOT,'.data')
const LOG = path.join(LAUNCH_DATA, 'snowluma-launch.log')

function note(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true })
    fs.appendFileSync(LOG, line)
  } catch {}
  return line
}

/** 端口上有没有人在 listen */
export function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (v) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
  })
}

/** 找一个 >= 24 的 node。优先 SnowLuma 自带的，其次 PATH 里的。 */
function pickNode(dir = SL_DIR) {
  const candidates = [path.join(dir, 'node.exe'), process.execPath]
  for (const exe of candidates) {
    try {
      if (!fs.existsSync(exe)) continue
      const v = execFileSync(exe, ['-v'], { encoding: 'utf8', timeout: 5000 }).trim()
      const major = Number(v.replace(/^v/, '').split('.')[0])
      if (major >= 24) return { exe, version: v }
      note(`skip ${exe} (${v} < 24)`)
    } catch (e) {
      note(`probe ${exe} failed: ${e.message}`)
    }
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 谁在监听这个端口（Windows: netstat -ano） */
export function portPid(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000 })
    const re = new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'g')
    let m
    while ((m = re.exec(out))) {
      const pid = Number(m[1])
      if (pid > 0) return pid
    }
  } catch {}
  return null
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 8000 })
    return true
  } catch {
    return false
  }
}
function isSnowLumaProcess(pid,dir) {
  if(process.platform!=='win32')return false
  try {
    const exe=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Get-Process -Id ${Number(pid)} -ErrorAction Stop).Path`],{encoding:'utf8',timeout:8000,windowsHide:true}).trim()
    return path.resolve(exe).toLowerCase()===path.resolve(dir,'node.exe').toLowerCase()
  } catch{return false}
}

/**
 * SnowLuma 的 hookAutoLoad 默认 false —— 意味着它不会主动注入 QQ。
 * QQ 一重启，注入就断了，3000/3001 再也不起来。
 * 这里直接把它改成 true（只改这一个字段，其它配置原样保留）。
 */
export function ensureHookAutoLoad(dir = SL_DIR) {
  const file = path.join(dir, 'config', 'runtime.json')
  try {
    if (!fs.existsSync(file)) return { changed: false, why: 'runtime.json 不存在（首次启动会自己生成）' }
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw)
    if (j.hookAutoLoad === true) return { changed: false, why: 'already-true' }
    j.hookAutoLoad = true
    fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n')
    note('runtime.json: hookAutoLoad false -> true')
    return { changed: true, why: 'turned-on' }
  } catch (e) {
    note(`ensureHookAutoLoad failed: ${e.message}`)
    return { changed: false, why: e.message }
  }
}

/**
 * 保证 SnowLuma 在跑。
 * @returns {{ok:boolean, started:boolean, reason:string, port:number, version?:string}}
 */
export async function oneBotReady({port=SL_PORT,httpPort=3000,wsPort=3001} = {}) {
  return (await Promise.all([portOpen(port),portOpen(httpPort),portOpen(wsPort)])).every(Boolean)
}

export async function ensureSnowLuma({ dir = SL_DIR, port = SL_PORT, httpPort = 3000, wsPort = 3001, waitMs = 45000 } = {}) {
  ensureHookAutoLoad(dir)
  const oneBot = httpPort
  const botReady=async()=>(await Promise.all([portOpen(oneBot),portOpen(wsPort)])).every(Boolean)
  const webUp = await portOpen(port)
  const botUp = await botReady()

  if (webUp && botUp) {
    return { ok: true, started: false, reason: 'already-running', port }
  }

  // WebUI 活着但 OneBot 没起来：QQ 重启过、注入断了，SnowLuma 自己不会恢复。
  // 先给它一点时间（可能正在注入），等不到就重启，让它重新注入。
  if (webUp && !botUp) {
    ensureHookAutoLoad(dir)
    note(`webui :${port} up but onebot :${oneBot} down, waiting for injection...`)
    const soft = Date.now() + 12_000
    while (Date.now() < soft) {
      await sleep(700)
      if (await botReady()) {
        note('onebot came up on its own')
        return { ok: true, started: false, reason: 'already-running', port }
      }
    }

    const pid = portPid(port)
    if(pid && !isSnowLumaProcess(pid,dir))return {ok:false,started:false,reason:`:${port} 的进程不是 SnowLuma 自带 Node，不自动停止`,port}
    if (!pid || !killPid(pid)) {
      return {
        ok: false,
        started: false,
        reason: `WebUI 在 :${port}，但 OneBot :${oneBot} 没起来，也停不掉旧进程（pid ${pid ?? '?'}）`,
        port,
      }
    }
    note(`killed stale snowluma pid=${pid} (onebot never came up)`)
    let freed = false
    for (let i = 0; i < 12; i++) {
      await sleep(400)
      if (!(await portOpen(port))) { freed = true; break }
    }
    if (!freed) {
      return { ok: false, started: false, reason: `重启 SnowLuma 失败：:${port} 还占着`, port }
    }
  }

  const entry = path.join(dir, 'index.mjs')
  if (!fs.existsSync(entry)) {
    note(`entry missing: ${entry}`)
    return { ok: false, started: false, reason: `找不到 ${entry}`, port }
  }

  // 并发锁：WebUI 和 Agent 同时启动时，只能有一个去 spawn，另一个等端口
  const lock = path.join(LAUNCH_DATA, 'snowluma.lock')
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  let me = false
  try {
    const st = fs.statSync(lock)
    if (Date.now() - st.mtimeMs > 90000) fs.rmSync(lock, { force: true }) // 陈旧锁
  } catch {}
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' })
    me = true
  } catch {
    me = false
  }

  if (!me) {
    note('lock held by another process, waiting for port')
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      await sleep(700)
      if (await oneBotReady({port,httpPort,wsPort})) return { ok: true, started: false, reason: 'already-running', port }
    }
    return { ok: false, started: false, reason: '另一个进程正在拉起 SnowLuma，但端口没等到', port }
  }

  const node = pickNode(dir)
  if (!node) {
    fs.rmSync(lock, { force: true })
    return { ok: false, started: false, reason: '没有 Node >= 24，无法启动 SnowLuma', port }
  }

  ensureHookAutoLoad(dir)
  note(`spawn ${node.exe} (${node.version}) in ${dir}`)
  let outputFd
  try {
    outputFd=fs.openSync(path.join(LAUNCH_DATA,'snowluma-process.log'),'a')
    const env={...process.env}
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(node.exe, ['index.mjs'], {
      cwd: dir,
      detached: true,
      stdio: ['ignore',outputFd,outputFd],
      windowsHide: true,
      env,
    })
    child.on('error', (e) => note(`spawn error: ${e.message}`))
    child.on('exit',(code,signal)=>note(`SnowLuma exited pid=${child.pid}, code=${code}, signal=${signal || '-'}`))
    child.unref()
  } catch (e) {
    note(`spawn throw: ${e.message}`)
    fs.rmSync(lock, { force: true })
    return { ok: false, started: false, reason: `启动失败：${e.message}`, port }
  } finally {if(outputFd!==undefined)fs.closeSync(outputFd)}

  // 先等 WebUI，再等 OneBot —— 以前只等 WebUI 就报成功，
  // 结果「起来了」但 3000 没监听，agent 连上去就超时。
  const deadline = Date.now() + waitMs
  let webSeen = false
  while (Date.now() < deadline) {
    await sleep(700)
    if (!webSeen && (await portOpen(port))) {
      webSeen = true
      note(`webui :${port} up, waiting for onebot :${oneBot}`)
    }
    if (webSeen && (await botReady())) {
      fs.rmSync(lock, { force: true })
      note(`ready: webui :${port}, onebot :${oneBot}`)
      return { ok: true, started: true, reason: 'started', port, version: node.version }
    }
  }
  fs.rmSync(lock, { force: true })
  if (webSeen) {
    return {
      ok: false,
      started: true,
      reason: `WebUI 起来了，但 OneBot :${oneBot} 一直没监听（QQ 没登录，或 hook 没注入）`,
      port,
      version: node.version,
    }
  }
  return { ok: false, started: true, reason: `等了 ${Math.round(waitMs / 1000)}s，${port} 还没起来`, port }
}

/** 等 OneBot 的 HTTP 端口就绪（注入 QQ 需要几秒） */
export async function waitOneBot(port = 3000, waitMs = 30000) {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await sleep(700)
  }
  return false
}

/** CLI 入口 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--restart')) {
    const pid = portPid(SL_PORT)
    if (pid) {
      console.log(`  停掉旧 SnowLuma（pid ${pid}）…`)
      killPid(pid)
      for (let i = 0; i < 12; i++) {
        await sleep(400)
        if (!(await portOpen(SL_PORT))) break
      }
    }
  }
  const r = await ensureSnowLuma()
  if (r.reason === 'already-running') {
    console.log(`  SnowLuma 已经在跑： http://127.0.0.1:${r.port}  ·  OneBot 3000/3001 都通`)
  } else if (r.ok) {
    console.log(`  SnowLuma 起来了： http://127.0.0.1:${r.port}  （node ${r.version}）`)
    console.log('  WebUI 已开、QQ 已注入、OneBot HTTP 3000 / WS 3001 在听')
  } else {
    console.error(`  ✗ ${r.reason}`)
    console.error(`  先看看 QQ 是不是登录着；还不行就手动双击 ${path.join(SL_DIR, 'launcher.bat')}`)
    process.exit(1)
  }
}
