/**
 * 常驻进程：群聊 + 自己挑片分享，一个进程全包。
 *
 *   node src/agent.mjs              正常跑
 *   node src/agent.mjs --dry        只判断不发送（看它想说什么）
 *   node src/agent.mjs --no-share   只聊天，不主动发视频
 *   node src/agent.mjs --no-chat    只做定时分享
 */
import { loadConfig, log, DATA, CONFIG_FILE } from './config.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { ping } from './qq.mjs'
import { hasLLM } from './llm.mjs'
import { createChat } from './chat.mjs'
import { runShare } from './share.mjs'
import { ensureSnowLuma, waitOneBot } from './snowluma.mjs'
import { acquireLock, releaseLock } from './lock.mjs'
import { runPatrol } from './bili-patrol.mjs'
import { runPrivateInbox } from './bili-private.mjs'
import { runBiliMentions,mentionInitialDelay } from './bili-mentions.mjs'
import { loadState } from './config.mjs'

const NODE_MAJOR = Number(process.versions.node.split('.')[0])
if (NODE_MAJOR < 20) {
  console.error(`\n  Node ${process.versions.node} 太旧了，本项目要 >= 20.11（推荐 22/24）。`)
  console.error('  CLion: Settings → Languages & Frameworks → Node.js 换一个解释器\n')
  process.exit(1)
}

const argv = process.argv.slice(2)
const flag = (n) => argv.includes(`--${n}`)
const dry = flag('dry')
const noShare = flag('no-share')
const noChat = flag('no-chat')

function banner(cfg, self) {
  const c = cfg.chat ?? {}
  log('')
  log('  ┌────────────────────────────────────────────┐')
  log('  │  bili-whale-qq · 群聊 + 挑片               │')
  log('  └────────────────────────────────────────────┘')
  log(`  账号      ${self ? `${self.nickname}（${self.user_id}）` : '未连接'}`)
  log(`  群        ${(c.groups?.length ? c.groups : cfg.qq?.groupIds ?? []).join(', ') || '（空）'}`)
  log(`  管理员    ${(c.admins ?? []).join(', ') || '（未设置，私聊只有访客通道）'}`)
  log(`  模型      ${hasLLM(cfg.llm) ? `${cfg.llm.provider} / ${cfg.llm.model}` : '未配置（只能看它想说什么，发不出去）'}`)
  log(`  聊天      ${noChat ? '关' : '开'}   静默 ${JSON.stringify(c.quietHours ?? [])}   冷却 ${c.minGapSec ?? 75}s   上限 ${c.maxPerHour ?? 20}/小时`)
  log(`  分享      ${noShare ? '关' : `开   每 ${cfg.share?.everyMinutes ?? 180} 分钟看一次，每天最多 ${cfg.share?.maxPerDay ?? 2} 条`}`)
  const patrolMin = Number(cfg.share?.replyPatrolMinutes ?? 30)
  log(`  巡检      ${patrolMin > 0 ? `每 ${patrolMin} 分钟看一次评论区，有人接话就回` : '关'}`)
  log(`  模式      ${dry ? '预演（不发送）' : '实发'}`)
  log(`  进程      pid ${process.pid} · ${process.env.AGENT_HOST
    ? `由控制台带起（父 pid ${process.ppid}），控制台关掉就一起停；页面上有启停开关`
    : '这个窗口就是常驻进程，关掉窗口就停'}`)
  log('')
}

function maskKey(k) {
  if (!k) return '(空)'
  return k.length <= 8 ? '••••' : `${k.slice(0, 3)}…${k.slice(-4)}`
}

/** config.json 一变就重新载入，WebUI 点保存后不用重启 agent */
function watchConfig(cfg) {
  let last = 0
  try { last = fs.statSync(CONFIG_FILE).mtimeMs } catch { /* 首次读不到就等下一轮 */ }
  const timer = setInterval(() => {
    let m = 0
    try { m = fs.statSync(CONFIG_FILE).mtimeMs } catch { return }
    if (m === last) return
    last = m
    try {
      Object.assign(cfg, loadConfig())
      log(`  ↻ 配置已热更新 · key ${maskKey(cfg.llm?.apiKey)} · 模型 ${cfg.llm?.provider}/${cfg.llm?.model}`)
    } catch (e) {
      log(`  ⚠ 配置热更新失败，继续用旧的：${e.message}`)
    }
  }, 2000)
  timer.unref?.()
}

async function main() {
  const cfg = loadConfig()
  cfg.chat ??= {}
  cfg.share ??= {}

  // 单实例：OneBot 会把同一条消息推给所有 WS 客户端，
  // 两个 agent 同时跑 = 同一条消息被回两遍。以前"以为没在跑、又起一个"就这么翻车的。
  const lockName = dry ? 'agent-dry' : 'agent'
  // 控制台（WebUI）会把本进程当子进程带起来，记下来，别人撞到这个锁时好说话
  const lockOwner = process.env.AGENT_HOST ? 'webui' : 'standalone'
  const take = () => acquireLock(lockName, { owner: lockOwner })
  let lock = take()
  // 想换成自己终端里跑时，不用先去任务管理器找 pid
  if (!lock.ok && flag('replace')) {
    log(`  接管：停掉旧实例 pid ${lock.pid}…`)
    try { process.kill(lock.pid) } catch (e) { log(`  （停不掉 ${lock.pid}：${e.message}）`) }
    await new Promise((r) => setTimeout(r, 800))
    lock = take()
  }
  if (!lock.ok && !flag('force')) {
    // 控制台已经带起了一个：这不是错误，正常退出，别让启动器报红
    if (lock.owner === 'webui' && lockOwner === 'standalone') {
      log('')
      log(`  控制台已经带起了一个群聊进程（pid ${lock.pid}），这个实例就不起了。`)
      log('  它的输出打在控制台那个窗口里，浏览器里「群聊 → 进程输出」也能看。')
      log('  想让这边接管：点页面上的「停止」，或 node src/agent.mjs --replace')
      log('')
      process.exit(0)
    }
    log('')
    log(`  已经有一个${dry ? '预演' : ''} agent 在跑了（pid ${lock.pid}${lock.since ? `，起于 ${new Date(lock.since).toLocaleTimeString()}` : ''}）。`)
    log('  两个一起连 OneBot，同一条消息会被回两次。')
    log('  想换到这个窗口跑：npm run agent -- --replace')
    log('  确认要再起一个：node src/agent.mjs --force')
    log('')
    process.exit(1)
  }
  if (!lock.ok) log(`  ⚠ 已有 pid ${lock.pid} 在跑，--force 强行再起（同一条消息可能被回两次）`)
  process.on('exit', () => releaseLock(lock.file))
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      log(`\n  收到 ${sig}，退出（pid ${process.pid}）`)
      process.exit(0)
    })
  }

  // 改完 config.json（WebUI 保存 / npm run setkey）2 秒内自动生效，不用重启
  watchConfig(cfg)

  let self = null
  if (!dry) {
    // 先确保 SnowLuma 在跑 —— 用错 Node 版本时它不会崩，只是 3000 永远不通
    const sl = await ensureSnowLuma()
    if (!sl.ok) {
      log(`  ⚠ SnowLuma：${sl.reason}`)
      log('    QQ 重启过的话 hook 注入会失效，SnowLuma 自己不会恢复。')
      log('    修：确认 QQ 登录着，然后 npm run snowluma -- --restart')
    } else if (sl.started) {
      log(`  SnowLuma 已自动拉起（node ${sl.version}），OneBot 3000/3001 就绪`)
    }

    // 注入 QQ 有几秒延迟，DNS/端口也偶尔抽风，重试而不是一撞就退
    let info = null
    let lastErr = null
    for (let i = 1; i <= 6; i++) {
      try {
        info = await ping(cfg)
        break
      } catch (e) {
        lastErr = e
        if (i < 6) {
          log(`  第 ${i} 次连不上 OneBot（${e.message}），3 秒后重试…`)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    }
    if (!info) {
      log(`\n连不上 QQ：${lastErr?.message ?? '未知错误'}\n`)
      log('排查顺序：')
      log(`  1. SnowLuma 在不在跑 —— 打开 http://127.0.0.1:${sl.port}`)
      log('  2. 它的日志里有没有 [Hook] pipe connected（没有就是 QQ 没注入）')
      log('  3. 有没有 database migration failed / SQLITE_READONLY（用错 Node 版本，要用 24）')
      log(`  4. OneBot HTTP ${cfg.qq?.onebotHttp} 是否 listening`)
      log('  5. token 对不对（SnowLuma 重启后 token 可能变）')
      log('')
      log('  不想发消息，只想看它想说什么：node src/agent.mjs --dry')
      process.exit(1)
    }
    self = info
  }
  banner(cfg, self)

  if (!hasLLM(cfg.llm)) {
    log('  ⚠ 没配模型。填 config.json 的 llm.apiKey（DeepSeek 的 key），或先加 --dry 看判断逻辑。\n')
  }

  // 心跳：控制台靠这个文件判断进程还活着，两个进程之间不搞 IPC。
  // 顺带把 runtime 的实时统计（用了多少 token、拦了多少条）带出去，
  // 这样控制台不用连 agent 也能显示用量。
  fs.mkdirSync(DATA, { recursive: true })
  const hbFile = path.join(DATA, 'agent.json')
  const startedAt = new Date().toISOString()
  let liveStats = () => ({})
  const beat = () => {
    try {
      let extra = {}
      try { extra = liveStats() ?? {} } catch { /* 统计不该影响心跳 */ }
      fs.writeFileSync(hbFile, JSON.stringify({
        pid: process.pid, startedAt, heartbeat: Date.now(),
        dry, chat: !noChat, share: !noShare,
        groups: extra.groups, maxPerHour: extra.maxPerHour, shield: extra.shield,
        replyEveryMessage:extra.replyEveryMessage,queuedMessages:extra.queuedMessages,outputRate:extra.outputRate,catchUp:extra.catchUp,
        diagnostics:extra.diagnostics,connection:extra.connection,
        mood:extra.mood,
        replyFormat:extra.replyFormat,
      }))
    } catch { /* 写不进去就算了，不影响聊天 */ }
  }
  beat()
  setInterval(beat, 15_000).unref?.()

  const say = dry
    ? async (_cfg, gid, msg) => {
        const text = (Array.isArray(msg) ? msg : [msg])
          .map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`))
          .join('')
        log(`  [预演→${gid}] ${text}`)
      }
    : undefined

  const chat = createChat(cfg, {
    ...(say ? { say } : {}),
    onVideoRequest: async (target, opts = {}) => {
      log(`  ${opts.private ? '管理员' : '群友'}点播，开始挑片……`)
      return runShare(cfg, { dry, ...(opts.private ? { privateTo: target } : { groupId: target }) })
    },
  })
  if (self) chat.selfId(self.user_id)
  if (!noChat) chat.start()

  // 心跳里带实时统计（token 用量、拦截计数），控制台靠它显示
  liveStats = () => chat.status()
  beat()

  if (!noShare) {
    const every = Math.max(5, cfg.share?.everyMinutes ?? 180) * 60_000
    const first = Math.max(1, cfg.share?.firstDelayMinutes ?? 8) * 60_000

    const tick = async () => {
      const h = new Date().getHours()
      const q = cfg.chat?.quietHours
      const quiet = Array.isArray(q) && q.length === 2 && (q[0] <= q[1] ? h >= q[0] && h < q[1] : h >= q[0] || h < q[1])
      if (quiet) {
        log(`  [${new Date().toLocaleTimeString()}] 静默时段，跳过分享`)
      } else {
        log(`  [${new Date().toLocaleTimeString()}] 看看有没有值得发的片……`)
        try {
          const r = await runShare(cfg, { dry })
          if (!r.sent) log(`    · ${r.dry ? '预演：' + r.text : r.why}`)
        } catch (e) {
          log(`    · 失败：${e.message}`)
        }
      }
      // 加 ±10% 抖动，别像整点报时
      setTimeout(tick, every * (0.9 + Math.random() * 0.2))
    }
    setTimeout(tick, first)
  }

  // B 站评论区巡检：有人在我们发的评论底下说话就接一句（主人优先）。
  // 不受 --no-share 影响——分享关了不代表评论区里没人等它回话。
  // 间隔每轮现读配置（watchConfig 会热更新整个 share 对象），设成 0 就只是跳过、定时器还活着。
  {
    // B 站风控码（跟 src/bili-patrol.mjs 里的 RISK 同一套）：撞上就说明打太急了
    const patrolRisk = value => !/12002.*(?:关闭|closed|disabled)|评论区.*关闭/i.test(String(value)) && /-412|-352|12002|12015|HTTP (?:403|412|429)|非 JSON|Unexpected token.*</i.test(String(value))
    let patrolCooldownMs = 0
    let patrolBackoff = 1     // 1 = 正常；撞风控按 2 倍往上退，最多 8 倍
    const patrolTick = async () => {
      const mins = Number(cfg.share?.replyPatrolMinutes ?? 30)
      if (mins > 0||cfg.biliInbox?.enabled||cfg.biliInbox?.mentionsEnabled!==false) {
        const h = new Date().getHours()
        const q = cfg.chat?.quietHours
        const quiet = Array.isArray(q) && q.length === 2 && (q[0] <= q[1] ? h >= q[0] && h < q[1] : h >= q[0] || h < q[1])
        if (quiet) {
          log(`  [${new Date().toLocaleTimeString()}] 静默时段，跳过评论区巡检`)
        } else {
          try {
            const mentions=await runBiliMentions(cfg,{dry});if(cfg.biliInbox?.mentionsEnabled!==false)log(`B站@提醒：${mentions.why||'检查完成'}`)
            const r = mins>0?await runPatrol(cfg, loadState(), { dry }):{sent:0,why:'评论巡检已关闭'}
            if (r.sent) log(`  [${new Date().toLocaleTimeString()}] 评论区巡检回了 ${r.sent} 条`)
            else if (r.planned?.length) r.planned.forEach((p) => log(`  [预演·巡检] ${p}`))
            else if (r.why) log(`  [${new Date().toLocaleTimeString()}] 评论区巡检：${r.why}`)
            if(!r.retryAfterMs)try{const dm=await runPrivateInbox(cfg,{dry});if(cfg.biliInbox?.enabled)log(`B站私信：${dm.why||'巡检完成'}`)}catch(e){log(`B站私信：${e.message}`)}
            // ⭐ 撞风控就退避：30 秒一轮一天要打几万次请求，B 站 412 是迟早的事。
            //   优先使用持久化冷却时间，至少 15 分钟；成功一轮再恢复正常间隔。
            patrolCooldownMs = Number(r?.retryAfterMs) || 0
            if (patrolRisk(String(r?.why ?? ''))) { patrolBackoff = Math.min(8, patrolBackoff * 2); patrolCooldownMs = Math.max(15 * 60_000, patrolCooldownMs) }
            else patrolBackoff = 1
          } catch (e) {
            log(`  · 评论区巡检失败：${e.message}`)
            if (patrolRisk(String(e?.message ?? ''))) { patrolBackoff = Math.min(8, patrolBackoff * 2); patrolCooldownMs = Math.max(15 * 60_000, Number(e?.retryAfterMs) || 0) }
          }
        }
      }
      // 加 ±10% 抖动，别跟分享撞在同一个点上打 B 站接口。
      // 用户强制五分钟下限，抖动只能延长间隔。
      const base = Math.max(5, mins || Number(cfg.biliInbox?.pollMinutes)||30) * 60_000
      if (patrolCooldownMs > 0 || patrolBackoff > 1) log(`  [巡检] 撞到风控，间隔临时退到 ${(Math.max(patrolCooldownMs, base * patrolBackoff) / 60_000).toFixed(1)} 分钟，恢复后自动降回`)
      setTimeout(patrolTick, Math.max(patrolCooldownMs, base * patrolBackoff * (1 + Math.random() * 0.1)))
    }
    // 首次检查也至少等待五分钟，避免启动后立刻集中访问。
    const firstPatrol = Math.max(5, Number(cfg.share?.replyPatrolFirstDelayMinutes ?? 5)) * 60_000
    setTimeout(patrolTick, mentionInitialDelay(cfg,{defaultMs:firstPatrol}))
  }

  const t = () => new Date().toLocaleTimeString()
  log(`  ${t()} 起来了。Ctrl+C 停。\n`)

  const stop = () => {
    log('\n  收工。')
    chat.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/** 进程要是莫名其妙没了，至少留一份现场：控制台 + .data/agent-error.log */
function dumpCrash(e) {
  const line = `\n[${new Date().toISOString()}] ${e?.stack ?? e}\n`
  try {
    fs.mkdirSync(DATA, { recursive: true })
    fs.appendFileSync(path.join(DATA, 'agent-error.log'), line)
  } catch {}
  process.stderr.write(line)
}

process.on('unhandledRejection', dumpCrash)
process.on('uncaughtException', (e) => { dumpCrash(e); process.exit(1) })

main().catch((e) => {
  dumpCrash(e)
  process.exit(1)
})
