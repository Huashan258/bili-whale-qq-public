/**
 * 控制台（WebUI）托管聊天进程。
 *
 * 以前要起两个东西：控制台 + 群聊 agent，少起一个就「连上了但没人回话」。
 * 现在控制台在启动后自己把 agent 拉起来当子进程，页面上有开关和实时输出。
 * 好处：只要常驻一个进程（ClIion 里就是 WebUI 那个 Tab），agent 跟着它活；
 * 控制台关掉时子进程一起收，不会留下孤儿再撞锁。
 *
 * 判断「已经有人在跑」不看文件锁，看 .data/agent.json 的心跳——
 * 别的地方（终端 / launcher）起的 agent 心跳是新的，这边就不抢。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { lockHolder } from './lock.mjs'

const TAIL_MAX = 400
const HB_FRESH_MS = 20_000     // 心跳 20s 内算活着
const CRASH_WINDOW_MS = 60_000 // 崩 3 次就别再拉了
const CRASH_MAX = 3
const MIN_LIFE_MS = 8_000      // 活不过 8 秒 = 启动即失败，不再自动重试

function readHeartbeat(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'))
    const age = Date.now() - new Date(s.heartbeat).getTime()
    if (!Number.isFinite(age) || age > HB_FRESH_MS) return null
    return { pid: s.pid, age: Math.round(age / 100) / 10 }
  } catch {
    return null
  }
}

export function createAgentHost({ cwd, entry = 'src/agent.mjs', heartbeatFile, onLine, onEvent } = {}) {
  let child = null
  let pid = null
  let lastPid = null   // 最近一次归我管的 pid：刚停掉的自己，别再当成"别处起的"
  let since = null
  let tail = []
  let manualStop = false
  let crashes = []
  let lastExit = null
  let auto = true

  const push = (line) => {
    tail.push(line)
    if (tail.length > TAIL_MAX) tail.splice(0, tail.length - TAIL_MAX)
  }
  // stderr 的行前面加个 ⨯，页面上一眼能挑出来
  const emit = (text, stream = 'out') => {
    for (const raw of String(text).split('\n')) {
      const line = raw.replace(/\r$/, '')
      if (!line.trim()) continue
      const shown = stream === 'err' ? `⨯ ${line}` : line
      push(shown)
      onLine?.(shown, stream)
    }
  }

  /** 别处起的、活着的 agent（不是我这个控制台拉起来的） */
  const external = () => {
    if (!heartbeatFile) return null
    const hb = readHeartbeat(heartbeatFile)
    if (!hb) return null
    if (child && String(hb.pid) === String(pid)) return null
    // 心跳文件要过 20 秒才凉，刚被我停掉的那个 pid 还在里面，别把自家尾巴当外人
    if (String(hb.pid) === String(lastPid)) return null
    return hb
  }

  function start({ reason = 'manual' } = {}) {
    if (child) return { ok: true, started: false, why: 'already', pid }
    const ext = external()
    if (ext) {
      return { ok: false, started: false, why: 'external', pid: ext.pid }
    }

    manualStop = false
    lastExit = null
    crashes = []

    const c = spawn(process.execPath, [entry], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, AGENT_HOST: '1' },
      windowsHide: true,
    })
    child = c
    pid = c.pid
    since = Date.now()
    c.stdout?.on('data', (b) => emit(b.toString('utf8'), 'out'))
    c.stderr?.on('data', (b) => emit(b.toString('utf8'), 'err'))

    c.on('error', (e) => {
      emit(`[agent] 起不来：${e.message}`, 'err')
      child = null
      pid = null
      lastExit = { code: null, signal: null, why: e.message }
      onEvent?.({ type: 'error', message: e.message })
    })

    c.on('exit', (code, signal) => {
      const life = since ? Date.now() - since : null
      child = null
      lastPid = pid
      if (!manualStop) {
        const why = signal ? `被信号 ${signal} 结束` : `退出码 ${code}`
        lastExit = { code, signal, life, why }
        emit(`[agent] 已退出（${why}${life == null ? '' : `，存活 ${(life / 1000).toFixed(1)}s`}）`, 'err')
      }
      pid = null
      since = null
      onEvent?.({ type: 'exit', code, signal, life })

      if (manualStop) return
      // 活不过 8 秒说明是启动就失败（撞锁、端口占用、配置错），再拉也没用，把原因留给页面
      if (life < MIN_LIFE_MS) {
        emit('[agent] 启动后马上就退出了，多半是已经有别的 agent 在跑，或 OneBot 没连上。看上面几行。', 'err')
        return
      }

      // 3 秒后再决定，那时候别处接管的进程已经拿稳锁、心跳也写上了
      setTimeout(() => {
        if (manualStop || child) return

        const ext = external()
        if (ext) {
          emit(`[agent] 别处已经接管了（pid ${ext.pid}），控制台不再抢。想交回来：先停那边，再点这里的「启动」`, 'err')
          return
        }
        const holder = lockHolder('agent')
        if (holder && String(holder.pid) !== String(lastPid)) {
          emit(`[agent] 锁被 pid ${holder.pid} 拿走了（多半是别处接管的），不再抢。`, 'err')
          return
        }

        crashes = crashes.filter((t) => Date.now() - t < CRASH_WINDOW_MS)
        crashes.push(Date.now())
        if (crashes.length > CRASH_MAX) {
          emit(`[agent] 一分钟内崩了 ${crashes.length} 次，先停手。修好上面报的错再点启动。`, 'err')
          return
        }
        emit(`[agent] 3 秒后自动重启（第 ${crashes.length} 次）`, 'err')
        start({ reason: 'auto' })
      }, 3000)
    })

    push(`[agent] 已启动 pid=${c.pid}（${reason === 'auto' ? '自动重启' : reason === 'boot' ? '控制台带起' : '手动'}）`)
    return { ok: true, started: true, pid: c.pid, reason }
  }

  function stop() {
    manualStop = true
    if (!child) return { ok: true, stopped: false }
    const p = pid
    const born = since
    child.kill()
    child = null
    lastPid = p
    pid = null
    since = null
    // exit 事件里 since 已经没了，先把存活时间补记上，免得显示成天文数字
    lastExit = { code: null, signal: 'SIGTERM', life: born ? Date.now() - born : null, why: '手动停止' }
    push(`[agent] 已停止 pid=${p}`)
    return { ok: true, stopped: true, pid: p }
  }

  function status() {
    const ext = external()
    return {
      running: Boolean(child),
      pid,
      since: since ? new Date(since).toISOString() : null,
      external: ext ? { pid: ext.pid, ageSec: ext.age } : null,
      auto,
      lastExit,
      tail,
    }
  }

  /** 控制台自己要退出时，把子进程一起收掉，别留下孤儿 */
  function dispose() {
    manualStop = true
    try { child?.kill() } catch {}
  }

  function setAuto(v) {
    auto = Boolean(v)
    return auto
  }

  return { start, stop, status, dispose, setAuto, get auto() { return auto } }
}

export { readHeartbeat, HB_FRESH_MS }
