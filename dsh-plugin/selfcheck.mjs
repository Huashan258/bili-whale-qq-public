/**
 * selfcheck.mjs —— 不启动 DSH 也能验一遍插件本体
 * ============================================================================
 *   node dsh-plugin/selfcheck.mjs
 *
 * 为什么要有它：`dsh --dump-config` 只**组装配置树**，不会跑 `apply()`。
 *    而本插件的风险（R0 volatile ref / R1 异常外冒 / R2 锁 / R3 收摊）全在 apply 里。
 *    这份脚本用**假 ctx** 直接调 apply，把「能不能起来、能不能收干净」验掉。
 *
 * ⭐ 每个场景跑在**独立子进程**里。为什么不能一个进程跑完：
 *    `src/config.mjs` 在**模块求值时**就把 `DATA`（= `process.env.BILI_WHALE_DATA`）算死了，
 *    ESM 缓存之后改不动。一个进程里跑第二个场景，锁会落进第一个场景的目录
 *    ⇒ 看起来像 bug，其实是测试自己的问题。真宿主一个进程也只有一次 apply，
 *    所以「一进程一场景」反而更贴近真实。
 *
 * ⚠️ 它**只验不发包**的路径：dataDir 一律指到临时目录（绝不碰真实 .data）、
 *    qqEnabled=false（不连 OneBot）、webUi=false（不抢 7788）、
 *    replyPatrolMinutes=0（巡检定时器活着但**一轮都不跑**，不打 B站、不调模型）。
 *    ⇒ 真跑起来会不会崩（真连 ws、真巡检）**这份脚本验不到**，必须真重启 DSH 才知道。
 * ============================================================================
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ⭐ 把监督者轮询压到 300ms，这样「开关翻转」能在测试里验（生产是 30s）
process.env.DSH_WHALE_SUPERVISE_MS = '300'
// 生产配置可能启用了独立私信接话。自检只准访问本机探测服务，绝不借真实凭据访问外网。
const localFetch=globalThis.fetch
globalThis.fetch=(input,options)=>{
  const url=new URL(typeof input==='string'?input:input.url??String(input))
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('自检禁止外网请求')
  return localFetch(input,options)
}

const SELF = fileURLToPath(import.meta.url)
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length)

const results = []
const ok = (name, pass, extra = '') => {
  results.push({ name, pass, extra })
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${extra ? ` — ${extra}` : ''}`)
}

/** 收集漏出来的异常 —— 这正是 R1 要验的东西 */
const leaks = []
process.on('unhandledRejection', (e) => leaks.push(`unhandledRejection: ${e?.stack ?? e}`))
process.on('uncaughtException', (e) => leaks.push(`uncaughtException: ${e?.stack ?? e}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function mockCtx() {
  const disposers = []
  const lines = []
  return {
    disposers,
    lines,
    logger: { info: (m) => lines.push(String(m)), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) },
    effect(fn) {
      try {
        const d = fn()
        if (typeof d === 'function') disposers.push(d)
      } catch (e) {
        lines.push(`effect 抛错：${e?.message ?? e}`)
      }
    },
    dispose() {
      for (const d of disposers.splice(0).reverse()) {
        try { d() } catch (e) { lines.push(`dispose 抛错：${e?.message ?? e}`) }
      }
    },
  }
}

/**
 * 把普通配置对象包成 **真宿主那种 volatile ref**（`Object.freeze({get:()=>v})`）。
 * 形状照抄 cosmokit 的 createVolatile —— 2026-10-20 QA 用真 cordis 4.0.5 打印出来的。
 */
function asVolatile(plain) {
  const out = {}
  for (const [k, v] of Object.entries(plain)) {
    let current = v
    out[k] = Object.freeze({ get: () => current })
  }
  return out
}

/** 可写版本的 volatile 配置（好模拟"用户在设置页改开关"） */
function liveVolatile(plain) {
  const store = { ...plain }
  const ref = {}
  for (const k of Object.keys(plain)) ref[k] = Object.freeze({ get: () => store[k] })
  ref.__set = (k, v) => { store[k] = v }
  return ref
}

/** 轮询等某个条件成立，默认最多 5 秒 */
async function until(pred, ms = 5000) {
  for (let i = 0; i < ms / 50; i++) {
    if (pred()) return true
    await sleep(50)
  }
  return pred()
}

/** 场景共用的尾巴：打印日志尾部 + 收摊 + 断言锁已放 + 清临时目录 */
async function tail(ctx, dir, lockFile) {
  const logFile = join(dir, 'dsh-plugin.log')
  if (existsSync(logFile)) {
    const t = readFileSync(logFile, 'utf8').trim().split('\n').slice(-4)
    console.log('    · 日志尾部：')
    for (const l of t) console.log(`      ${l}`)
  }
  ctx.dispose()
  await sleep(200)
  ok('收摊/卸载后锁已放掉（R3）', !existsSync(lockFile))
  rmSync(dir, { recursive: true, force: true })
}

/* ══════════════════════════ 场景 ══════════════════════════ */

/** 导出与 Config（纯读，不跑 apply，不需要独立进程，但跟着跑也无妨） */
async function scenarioExports() {
  const mod = await import('./index.js')
  ok('导出 name', mod.name === 'whale', `name=${JSON.stringify(mod.name)}`)
  ok('导出 inject', Array.isArray(mod.inject), JSON.stringify(mod.inject))
  ok('导出 apply', typeof mod.apply === 'function')

  const wantKeys = ['enabled', 'dry', 'replyPatrolMinutes', 'qqEnabled', 'webUi', 'webUiPort', 'dataDir']
  ok('导出 Config（schemastery 拿到了）', Boolean(mod.Config), mod.Config ? 'ok' : 'z 没解析到，设置页会降级')
  if (mod.Config) {
    // schemastery 3.18：默认值 / extra 元信息挂在 `Config.dict.<key>.meta` 上
    const dict = mod.Config.dict ?? {}
    const meta = (k) => dict[k]?.meta ?? {}
    const missing = wantKeys.filter((k) => !(k in dict))
    ok('Config 字段齐全', missing.length === 0, missing.length ? `缺 ${missing.join(',')}` : Object.keys(dict).join(','))
    const notVolatile = wantKeys.filter((k) => meta(k).volatile !== true)
    // ⚠️ 这条**必要但不充分**：volatile 标记正是 R0 那个 bug 的成因（有标记 ⇒ 真值被包成
    //    `{get()}` ⇒ 不解包就永远读不到）。它全绿**不代表配置能用** ——
    //    真正能验"读得到"的是场景四（volatile ref 形状）。
    ok('每个字段都标了 volatile【必要不充分：真值要 .get()，见场景四】', notVolatile.length === 0, notVolatile.join(','))
    const d = Object.fromEntries(wantKeys.map((k) => [k, meta(k).default]))
    ok('默认 enabled=false', d.enabled === false, JSON.stringify(d.enabled))
    ok('默认 dry=true', d.dry === true, JSON.stringify(d.dry))
    ok('默认 qqEnabled=false', d.qqEnabled === false, JSON.stringify(d.qqEnabled))
    ok('默认 webUi=false', d.webUi === false, JSON.stringify(d.webUi))
    ok('默认 replyPatrolMinutes=5', d.replyPatrolMinutes === 5, JSON.stringify(d.replyPatrolMinutes))
    ok('默认 dataDir 留空（= 项目 .data）', d.dataDir === '', JSON.stringify(d.dataDir))
  }
}

/** 场景一：enabled=false —— 什么都不做，连锁都不碰 */
async function scenarioOff() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-off-'))
  const ctx = mockCtx()
  let threw = null
  try { (await import('./index.js')).apply(ctx, { enabled: false, dataDir: dir }) } catch (e) { threw = e }
  await sleep(300)
  ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')
  ok('不建锁（让位给独立 agent）', !existsSync(join(dir, 'agent.lock')))
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true })
}

/** 场景二：enabled=true（标量配置）—— 抢锁、排定时器；dispose 后锁必须放掉 */
async function scenarioOn() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-on-'))
  const ctx = mockCtx()
  let threw = null
  try {
    (await import('./index.js')).apply(ctx, {
      enabled: true,
      dry: true,
      replyPatrolMinutes: 0,      // 定时器活着但一轮都不跑 ⇒ 不打 B站、不调模型
      qqEnabled: false,
      webUi: false,
      dataDir: dir,
    })
  } catch (e) { threw = e }
  ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')

  const lockFile = join(dir, 'agent.lock')
  await until(() => existsSync(lockFile))
  ok('抢到单实例锁（R2）', existsSync(lockFile), lockFile)
  ok('写了心跳文件', existsSync(join(dir, 'dsh-plugin.json')))
  ok('收摊钩子已挂（R3）', ctx.disposers.length > 0, `${ctx.disposers.length} 个`)
  ok('起了日志文件', existsSync(join(dir, 'dsh-plugin.log')))
  await tail(ctx, dir, lockFile)
}

/**
 * 场景三：config 字段被塞成对象（2026-10-14 事故形状）
 *
 * ⚠️ 2026-10-20 修正：原来这里连 `dataDir` 也塞 `{}`，于是 dataDir 落回 '' ⇒
 *    **真的写进了项目自己的 .data**（真实 `.data/dsh-plugin.log` 里那几十行就是这么来的），
 *    和脚本头「绝不碰真实 .data」自相矛盾。
 *    ⇒ dataDir 必须给**标量的临时目录**，只对"业务开关"那几个字段塞非标量。
 */
async function scenarioBadShape() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-bad-'))
  const ctx = mockCtx()
  let threw = null
  try {
    (await import('./index.js')).apply(ctx, {
      enabled: {}, dry: {}, replyPatrolMinutes: {}, qqEnabled: {}, webUi: {}, webUiPort: {},
      dataDir: dir,          // ← 必须是标量临时目录，否则会写真实 .data
    })
  } catch (e) { threw = e }
  await sleep(300)
  ok('非标量配置不会让 apply 抛异常（R1）', threw === null, threw ? String(threw?.stack ?? threw) : '')
  ok('非标量 enabled 不当真 ⇒ 不启动', !existsSync(join(dir, 'agent.lock')))
  ok('日志写进了临时目录（不是真实 .data）', existsSync(join(dir, 'dsh-plugin.log')), dir)
  ctx.dispose()
  rmSync(dir, { recursive: true, force: true })
}

/**
 * 场景三 B：巡逻定时器**真的跑一跳**（R1 最高危的位置）
 *
 * 为什么要有它：前面所有场景的 patrolTick 都排在 3 分钟之后，测试等不到 ⇒
 * 「定时器回调里抛异常」这条最要命的路一次都没被走过。这里用
 * `DSH_WHALE_PATROL_FIRST_MS` 把第一次巡检压到 50ms，配合 `replyPatrolMinutes: 0`
 * （⇒ `mins > 0` 为假，直接跳过，不打 B站、不调模型），
 * 于是 patrolTick 的 try / catch / finally 重排 整条链路都被走过一遍。
 */
async function scenarioPatrolTick() {
  process.env.DSH_WHALE_PATROL_FIRST_MS = '50'
  const dir = mkdtempSync(join(tmpdir(), 'whale-tick-'))
  const ctx = mockCtx()
  let threw = null
  try {
    (await import('./index.js')).apply(ctx, {
      enabled: true, dry: true, replyPatrolMinutes: 0, qqEnabled: false, webUi: false, dataDir: dir,
    })
  } catch (e) { threw = e }
  ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')

  const lockFile = join(dir, 'agent.lock')
  await until(() => existsSync(lockFile))
  // 等 patrolTick 至少跑两跳（50ms 一跳 + 重排）
  await sleep(600)
  const logText = existsSync(join(dir, 'dsh-plugin.log')) ? readFileSync(join(dir, 'dsh-plugin.log'), 'utf8') : ''
  ok('巡检定时器确实排上了', /评论区巡检已排上/.test(logText))
  ok('定时器整条链路跑过且没把异常漏出来（R1）', !/这一跳出错了|启动失败/.test(logText), logText.split('\n').slice(-2).join(' | '))
  ctx.dispose()
  await sleep(200)
  ok('收摊后锁已放掉（R3）', !existsSync(lockFile))
  rmSync(dir, { recursive: true, force: true })
}

/** 场景四（R0）：volatile ref —— 真宿主传进来的形状，不解包 ⇒ 插件永远启不动 */
async function scenarioVolatile() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-vol-'))
  const ctx = mockCtx()
  let threw = null
  try {
    (await import('./index.js')).apply(ctx, asVolatile({
      enabled: true, dry: true, replyPatrolMinutes: 0, qqEnabled: false, webUi: false, webUiPort: 7788, dataDir: dir,
    }))
  } catch (e) { threw = e }
  ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')

  const lockFile = join(dir, 'agent.lock')
  const got = await until(() => existsSync(lockFile))
  ok('volatile 的 enabled=true 被认出来 ⇒ 抢到锁（R0 回归）', got, got ? lockFile : '没抢到 ⇒ deref() 没生效')
  ok('锁落进的是 volatile 里那个 dataDir（不是真实 .data）', got && dirname(lockFile) === dir, dirname(lockFile))
  const beatFile = join(dir, 'dsh-plugin.json')
  if (existsSync(beatFile)) {
    try {
      const b = JSON.parse(readFileSync(beatFile, 'utf8'))
      ok('心跳里 enabled/dry 是真值不是空对象', b.enabled === true && b.dry === true, JSON.stringify({ enabled: b.enabled, dry: b.dry }))
    } catch (e) { ok('心跳文件可解析', false, String(e)) }
  }
  const logText = existsSync(join(dir, 'dsh-plugin.log')) ? readFileSync(join(dir, 'dsh-plugin.log'), 'utf8') : ''
  const stateLine = logText.split('\n').find((l) => l.includes('状态目录')) ?? '(日志里没有状态目录那行)'
  ok('volatile 的 dataDir 读出了真路径（日志里是临时目录）', stateLine.includes(dir), stateLine.trim())
  await tail(ctx, dir, lockFile)
}

/** 场景五（R0）：设置页改开关 —— volatile 改值不 remount，得靠监督者轮询盯出来 */
async function scenarioFlip() {
  const dir = mkdtempSync(join(tmpdir(), 'whale-flip-'))
  const ctx = mockCtx()
  const live = liveVolatile({
    enabled: false, dry: true, replyPatrolMinutes: 0, qqEnabled: false, webUi: false, webUiPort: 7788, dataDir: dir,
  })
  let threw = null
  try { (await import('./index.js')).apply(ctx, live) } catch (e) { threw = e }
  ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')

  const lockFile = join(dir, 'agent.lock')
  await sleep(400)
  ok('初始 enabled=false ⇒ 没起（没锁）', !existsSync(lockFile))

  // 模拟"用户在设置页打开启用"：就地改 volatile ref，apply **不会**再跑一次
  live.__set('enabled', true)
  const started = await until(() => existsSync(lockFile), 5000)
  ok('enabled 翻到 true ⇒ 监督者把它拉起来了（不用重启 DSH）', started, started ? lockFile : '没起来 ⇒ 开关是哑的')

  live.__set('enabled', false)
  ok('enabled 翻回 false ⇒ 监督者把它收了（锁放掉）', await until(() => !existsSync(lockFile), 5000))

  live.__set('enabled', true)
  const again = await until(() => existsSync(lockFile), 5000)
  ok('能反复启停（第二次打开仍起得来）', again)

  await tail(ctx, dir, lockFile)
}

/**
 * 场景六：**抢不到锁 ⇒ 让位 ⇒ 锁一空出来自己接管**（2026-10-20 QA 抓的真 bug）
 *
 * 为什么这条最重要：它**正是用户当下的路** —— 独立 agent（pid 14724）占着 `agent` 锁，
 * 用户去设置页打开「启用」，走的就是这个分支。
 * 修之前：`startRuntime()` 同步把 `rt.running` 置 true，bootstrap 异步抢锁失败只是 return
 *        ⇒ running 永久卡 true ⇒ 监督者再也不试 ⇒ 锁空出来后插件永远不接管，
 *          用户必须先停 agent 再重启 DSH。而且心跳会写 `enabled:true` + 新时间戳 = **撒谎**。
 *
 * 这里用一个**真的活着的子进程**当"另一个占用者"（`acquireLock` 只认 pid 不同于自己的活进程）。
 */
function yieldViolations(s) {
  const v = []
  if (!s.beat) return ['心跳文件根本没写出来']
  if (!('running' in s.beat)) v.push('心跳里没有 running 字段（分不清"开关开着"和"业务在跑"）')
  if (s.lockHeldByOther) {
    // 让位态：开关是开的（enabled=true），但业务一个都没起（running 必须 false）
    if (s.beat.running !== false) v.push(`让位时心跳 running=${JSON.stringify(s.beat.running)}（必须 false）`)
    if (s.beat.enabled !== true) v.push(`让位时 enabled=${JSON.stringify(s.beat.enabled)}（开关是开的，该保留 true）`)
  } else {
    // 锁在我们手里（接管后）：running 必须 true
    if (s.beat.running !== true) v.push(`接管后心跳 running=${JSON.stringify(s.beat.running)}（必须 true）`)
  }
  if (s.tookOver && s.beat.running !== true) v.push('锁接手了但心跳还说没跑')
  if (s.tookOver === false && !s.lockHeldByOther) v.push('锁空出来了却没接管（rt.running 又卡住了）')
  if (s.lockOverwritten) v.push('把别人的锁覆盖了')
  return v
}

async function scenarioYield() {
  // ① 负向测试先跑：**证明这条回归能 FAIL**。修之前的状态喂进去必须报违例，
  //    否则下面那些 ✓ 只能证明"代码没崩"，不能证明"这个 bug 真被堵住了"。
  const negOld = yieldViolations({ beat: { enabled: true, dry: true }, lockHeldByOther: true, tookOver: false })
  ok('负向：修之前的心跳（无 running 字段）必须被判违例', negOld.length >= 2, negOld.join('；') || '没报违例 ⇒ 这条测试是摆设')
  const negStuck = yieldViolations({ beat: { enabled: true, running: true }, lockHeldByOther: true, tookOver: false })
  ok('负向：running 卡 true 必须被判违例', negStuck.length >= 1, negStuck.join('；') || '没报违例 ⇒ 这条测试是摆设')
  const negNoTakeover = yieldViolations({ beat: { enabled: true, running: false }, lockHeldByOther: false, tookOver: false })
  ok('负向：锁空出来却没接管必须被判违例', negNoTakeover.length >= 1, negNoTakeover.join('；') || '没报违例 ⇒ 这条测试是摆设')
  const negClean = yieldViolations({ beat: { enabled: true, running: false }, lockHeldByOther: true, tookOver: false })
  ok('负向对照：正确状态必须 0 违例（防止校验器自己乱报）', negClean.length === 0, negClean.join('；') || '0 违例')

  const dir = mkdtempSync(join(tmpdir(), 'whale-yield-'))
  const lockFile = join(dir, 'agent.lock')
  const beatFile = join(dir, 'dsh-plugin.json')
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  try {
    await until(() => Boolean(other.pid), 3000)
    writeFileSync(lockFile, JSON.stringify({ pid: other.pid, at: new Date().toISOString(), owner: 'standalone' }))

    const ctx = mockCtx()
    let threw = null
    try {
      (await import('./index.js')).apply(ctx, {
        enabled: true, dry: true, replyPatrolMinutes: 0, qqEnabled: false, webUi: false, dataDir: dir,
      })
    } catch (e) { threw = e }
    ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')

    // 等 bootstrap 跑完抢锁那一步，再**多等几拍监督者**（SUPERVISE_MS=300 ⇒ 这里至少又过 4 跳），
    // 用来验「让位重试不刷屏」—— QA 2026-10-20 实测：以前每跳都打一行「enabled 打开了 —— 启动」，
    // 生产 30 秒一跳 = 2880 行/天，正好淹没用户「开 dry 看一天日志」要看的东西。
    await sleep(2000)
    const readBeat = () => { try { return JSON.parse(readFileSync(beatFile, 'utf8')) } catch { return null } }
    const b1 = readBeat()
    ok('心跳文件写出了 running 字段（不再只说 enabled）', b1 !== null && 'running' in b1, JSON.stringify(b1))
    ok('让位时心跳诚实：enabled=true 但 running=false', b1?.enabled === true && b1?.running === false, JSON.stringify(b1))
    const v1 = yieldViolations({ beat: b1, lockHeldByOther: true, tookOver: false })
    ok('让位态不变式全过（走同一套 yieldViolations）', v1.length === 0, v1.join('；') || '0 违例')
    ok('锁还是别人的（没抢、没覆盖）', JSON.parse(readFileSync(lockFile, 'utf8')).pid === other.pid)

    const logText = () => (existsSync(join(dir, 'dsh-plugin.log')) ? readFileSync(join(dir, 'dsh-plugin.log'), 'utf8') : '')
    const yieldLines = (logText().match(/已有实例在跑/g) ?? []).length
    ok('让位日志有说（且没说成"起来了"）', yieldLines >= 1 && !/起来了。/.test(logText()), `让位日志 ${yieldLines} 条`)
    ok('让位日志没刷屏（节流生效，≤2 条）', yieldLines <= 2, `${yieldLines} 条`)
    const startLines = (logText().match(/enabled 打开了/g) ?? []).length
    ok('让位重试不刷屏：「enabled 打开了 —— 启动」只打了 1 次（这中间过了 ≥5 跳监督者）',
       startLines === 1, `${startLines} 条`)

    // ⭐ 关键：把锁空出来（= 用户停掉了独立 agent）⇒ 插件必须自己接管，不用重启
    rmSync(lockFile, { force: true })
    const took = await until(() => existsSync(lockFile), 6000)
    ok('锁一空出来，监督者自己接管了（不用重启 DSH）', took, took ? '抢到锁' : '没接管 ⇒ rt.running 又卡住了')
    if (took) {
      const holder = JSON.parse(readFileSync(lockFile, 'utf8'))
      ok('锁的 owner 变成了 dsh-plugin', holder.owner === 'dsh-plugin', JSON.stringify(holder))
      const b2 = readBeat()
      ok('接管后心跳 running 变 true', b2?.running === true, JSON.stringify(b2))
      const v2 = yieldViolations({ beat: b2, lockHeldByOther: false, tookOver: true })
      ok('接管态不变式全过（走同一套 yieldViolations）', v2.length === 0, v2.join('；') || '0 违例')
    }
    await tail(ctx, dir, lockFile)
  } finally {
    try { other.kill() } catch { /* 已经没了 */ }
  }
}

/**
 * 场景七：**`webUi=true` 撞上已有控制台 ⇒ 绝不 import**（2026-10-20 QA 抓的雷）
 *
 * 现场：7788 被 pid 8228 的 `src/server.mjs` 占着，`/api/status` 返回 `{"app":"bili-whale-qq"}`。
 * `src/server.mjs:764` 在这种情况下走 **`process.exit(0)`** —— 是**进程退出**，不是异常。
 * ⇒ 插件里 `try { await import('src/server.mjs') } catch {}` **拦不住**，
 *   DSH 宿主会**静默消失**，日志里还留着「WebUI 已挂上」这种假话。
 *
 * 这条场景的断言为什么能证明「宿主没被带走」：
 *   如果 `process.exit(0)` 真的发生了，**整个子进程立刻结束**，
 *   后面那条「起来了」日志断言就不会被打印出来 —— 测试会以「场景炸了/退出码」的形式失败。
 *   所以「日志里有『起来了。』」= 执行真的越过了 WebUI 那一步。
 */
async function scenarioWebUi() {
  const { createServer } = await import('node:http')
  const probe = await import('./lib/webui-probe.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'whale-webui-'))

  /** 起一个假服务，listen(0) 拿系统给的临时端口（不抢 7788） */
  const serve = (payload) => {
    const s = createServer((req, res) => {
      if (req.url === '/api/status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      } else {
        res.writeHead(404)
        res.end('nope')
      }
    })
    return new Promise((r) => s.listen(0, '127.0.0.1', () => r({ server: s, port: s.address().port })))
  }
  const ours = await serve({ app: 'bili-whale-qq' })
  const other = await serve({ app: 'somebody-else' })
  try {
    /* ── ① 判定层（纯函数，正反两面都验） ── */
    ok('判定：端口上是我们自己的控制台 ⇒ 不 import（这条是保命的）',
       probe.decideWebUi('ours').use === false, JSON.stringify(probe.decideWebUi('ours')))
    ok('判定：端口上是别人家的服务 ⇒ 照旧 import', probe.decideWebUi('other').use === true, JSON.stringify(probe.decideWebUi('other')))
    ok('判定：端口空着 ⇒ 照旧 import', probe.decideWebUi('free').use === true, JSON.stringify(probe.decideWebUi('free')))

    /* ── ② 探测层（真 socket，对着真 HTTP 服务） ── */
    ok('探测：认得出自己人（/api/status 的 app 字段）', (await probe.probeConsole(ours.port)) === 'ours', `port=${ours.port}`)
    ok('探测：别人家返回 200 JSON ⇒ other', (await probe.probeConsole(other.port)) === 'other', `port=${other.port}`)
    const throwaway = createServer(() => {})
    await new Promise((r) => throwaway.listen(0, '127.0.0.1', r))
    const freePort = throwaway.address().port
    await new Promise((r) => throwaway.close(r))
    ok('探测：没人听 ⇒ free（连不上不当成"有人占"）', (await probe.probeConsole(freePort)) === 'free', `port=${freePort}`)

    /* 「活着但慢」的控制台 —— QA 2026-10-20 打的 P2 缝：
     * 插件原来用默认 800ms，超时判 other ⇒ 照旧 import ⇒ server.mjs 用 **1200ms** 再探到 ours
     * ⇒ 照样 process.exit(0)。插件现在显式传 1500ms（≥1200），这条断言就是在钉住那个数。 */
    const slow = createServer((req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ app: 'bili-whale-qq' }))
      }, 900)
    })
    await new Promise((r) => slow.listen(0, '127.0.0.1', r))
    const slowPort = slow.address().port
    try {
      ok('探测：900ms 才回的慢控制台，用插件的 1500ms 仍判 ours（P2 缝已堵）',
         (await probe.probeConsole(slowPort, { timeoutMs: 1500 })) === 'ours', `port=${slowPort}`)
      ok('对照：同一端口用默认 800ms 会判 other（这就是那条缝，必须靠调用方传 1500）',
         (await probe.probeConsole(slowPort)) === 'other', '证明 timeoutMs 不是随便填的')
    } finally {
      await new Promise((r) => slow.close(r))
    }

    /* ── ③ 端到端：webUi=true + 端口上蹲着一个"自己人" ── */
    const ctx = mockCtx()
    let threw = null
    try {
      (await import('./index.js')).apply(ctx, {
        enabled: true, dry: true, replyPatrolMinutes: 0, qqEnabled: false,
        webUi: true, webUiPort: ours.port, dataDir: dir,
      })
    } catch (e) { threw = e }
    await sleep(900)

    const logText = () => (existsSync(join(dir, 'dsh-plugin.log')) ? readFileSync(join(dir, 'dsh-plugin.log'), 'utf8') : '')
    ok('apply 不抛异常', threw === null, threw ? String(threw?.stack ?? threw) : '')
    ok('日志里明说「不接管 WebUI」（不是静默跳过）', /不接管\*\* WebUI|不接管 WebUI/.test(logText()), '')
    ok('没有假装挂上（不含「交给 src/server.mjs 接管了」）', !/交给 src\/server\.mjs 接管了/.test(logText()), '')
    /* ⭐ 这一条等价于「宿主没被 process.exit(0) 带走」：那行日志在 WebUI 之后才打印 */
    ok('宿主没被带走：WebUI 之后还打出了「起来了。」', /起来了。/.test(logText()),
       /起来了。/.test(logText()) ? '执行越过了 import 那一步' : '没打出来 ⇒ 可能被 exit 带走了')
    ok('插件其余部分照常（锁拿到了）', existsSync(join(dir, 'agent.lock')))

    /* ── ④ 负向：**不走守卫**直接 import，证明「这条路真的会把进程带走」 ──
     * 不证明这一点，上面那些 ✓ 只说明"我们加了判断"，不说明"不加就真的会死"。
     * 用**孙进程**跑（它会 exit(0) 自杀），BILI_WHALE_DATA 指着临时目录，绝不碰真实 .data。
     * 注：`src/server.mjs` 在这里只会撞 EADDRINUSE ⇒ 走 exit(0)，
     *     **不会**走到 `boot()`，所以不会拉 SnowLuma、不会起 agent。 */
    const negScript = join(dir, 'neg-import.mjs')
    writeFileSync(negScript, [
      `process.env.BILI_WHALE_DATA = ${JSON.stringify(dir)}`,
      `process.env.PORT = ${JSON.stringify(String(ours.port))}`,
      `const url = ${JSON.stringify(pathToFileURL(join(resolve(dirname(SELF), '..'), 'src', 'server.mjs')).href)}`,
      `try { await import(url); console.log('IMPORT-RESOLVED') } catch (e) { console.log('CAUGHT ' + (e?.message ?? e)) }`,
      `await new Promise((r) => setTimeout(r, 1500))`,
      `console.log('SURVIVED')`,
    ].join('\n'), 'utf8')

    const neg = await new Promise((res) => {
      const c = spawn(process.execPath, [negScript], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      c.stdout.on('data', (d) => { out += String(d) })
      c.stderr.on('data', (d) => { out += String(d) })
      c.on('exit', (code, signal) => res({ code, signal, out }))
    })
    ok('负向：不走守卫直接 import ⇒ 进程真的被 process.exit(0) 带走',
       neg.code === 0 && !neg.out.includes('SURVIVED'), `exit=${neg.code} signal=${neg.signal}`)
    ok('负向：try/catch 确实拦不住（接不到 CAUGHT）',
       !neg.out.includes('CAUGHT'), neg.out.trim().split('\n').slice(-2).join(' | ') || '(无输出)')

    await tail(ctx, dir, join(dir, 'agent.lock'))
  } finally {
    await new Promise((r) => ours.server.close(r))
    await new Promise((r) => other.server.close(r))
  }
}

const SCENARIOS = [
  ['exports', '导出与 Config 默认值', scenarioExports],
  ['off', '场景一：enabled=false（装上去的默认态）', scenarioOff],
  ['on', '场景二：enabled=true（临时目录，qq/巡检/webui 全关）', scenarioOn],
  ['bad', '场景三：config 字段是对象（2026-10-14 事故形状）', scenarioBadShape],
  ['tick', '场景三 B：巡检定时器真的跑一跳（R1 定时器回调）', scenarioPatrolTick],
  ['vol', '场景四（R0）：volatile ref —— 真宿主形状', scenarioVolatile],
  ['flip', '场景五（R0）：设置页改开关 —— 不 remount 也能起停', scenarioFlip],
  ['yield', '场景六（R2）：抢不到锁让位 → 锁空出来自己接管', scenarioYield],
  ['webui', '场景七（R1）：webUi 撞上已有控制台 ⇒ 绝不 import（否则 DSH 静默退出）', scenarioWebUi],
]

/* ══════════════════════════ 调度 ══════════════════════════ */

/** 真实 .data 的日志文件（本脚本**绝不该**碰它） */
const REAL_LOG = join(resolve(dirname(SELF), '..'), '.data', 'dsh-plugin.log')
/** 文件大小；**不存在算 0**（这样"场景新建了这个文件"也能被下面那条守卫抓到） */
const sizeOf = (f) => { try { return readFileSync(f).length } catch { return 0 } }
/** 真实 .data 的单实例锁里记的 pid（本脚本不该动它 —— 动了这个用户就没法起独立 agent 了） */
const REAL_LOCK = join(resolve(dirname(SELF), '..'), '.data', 'agent.lock')
const lockPid = () => { try { return String(JSON.parse(readFileSync(REAL_LOCK, 'utf8')).pid ?? '') } catch { return '' } }

async function runOne(name) {
  const found = SCENARIOS.find(([k]) => k === name)
  if (!found) { console.error(`没有场景 ${name}`); process.exit(2) }
  /* ⚠️ 直接 `--only=xxx` 跑（不经 runAll）时没有父进程塞环境变量，
   *    此时**自己就地取一份基线**。不这么写，两条 .data 守卫会拿 '' 去比 ⇒ 假 FAIL
   *    （2026-10-20 负向注入时亲眼见过：`want=(无锁) now=14724`，其实 .data 一个字节没动）。 */
  const baseLog = process.env.DSH_WHALE_REAL_LOG_SIZE ?? String(sizeOf(REAL_LOG))
  const basePid = process.env.DSH_WHALE_REAL_LOCK_PID ?? lockPid()
  await found[2]()
  await sleep(200)

  /* 「没有漏出未捕获异常」这条的**边界**（2026-10-20 修正措辞）：
   *   ① 它只覆盖**本场景这次 apply→dispose 的窗口**（几秒），不是"插件长期跑不会漏"；
   *   ② 本脚本自己装了 process.on('uncaughtException')，这会**挡掉 Node 默认的崩溃行为** ——
   *      真宿主那层是 installFailLoud（未捕获异常 ⇒ exit(1)）。
   *      所以这条的真实含义是：「这个窗口内没有异步异常冒到最外层」，
   *      而不是「宿主不会死」。它 FAIL 时**必须**当事故处理。 */
  ok('本场景窗口内没有异常冒到最外层（R1｜只覆盖这次 apply→dispose，不覆盖长期运行）',
     leaks.length === 0, leaks.join(' | '))

  /* 「绝不碰真实 .data」的可断言守卫：父进程把跑之前的日志大小传进来，
     跑完比对 —— 涨了就说明这个场景污染了真实状态目录（场景三以前就犯过这个错）。 */
  const before = Number(baseLog)
  const after = sizeOf(REAL_LOG)
  ok('没有往真实 .data/dsh-plugin.log 里写一个字', after === before, `before=${before} after=${after}`)
  ok('没有动真实 .data/agent.lock（锁还是原来那个 pid）', lockPid() === String(basePid),
     `want=${basePid || '(无锁)'} now=${lockPid() || '(无锁)'}`)

  const failed = results.filter((r) => !r.pass)
  console.log(`RESULT ${results.length - failed.length}/${results.length}`)
  process.exit(failed.length ? 1 : 0)
}

async function runAll() {
  console.log('\n== dsh-whale 本体自检（每个场景独立子进程）==')
  let pass = 0
  let total = 0
  for (const [key, title] of SCENARIOS) {
    console.log(`\n── ${title} ──`)
    const realBefore = sizeOf(REAL_LOG)
    const realPid = lockPid()
    const child = await new Promise((res) => {
      const c = fork(SELF, [`--only=${key}`], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
          ...process.env,
          DSH_WHALE_REAL_LOG_SIZE: String(realBefore),
          DSH_WHALE_REAL_LOCK_PID: realPid,
        },
      })
      let out = ''
      c.stdout.on('data', (d) => { out += String(d) })
      c.stderr.on('data', (d) => { out += String(d) })
      c.on('exit', (code) => res({ code, out }))
    })
    for (const line of child.out.split('\n')) {
      if (line.startsWith('RESULT ')) continue
      if (line.trim()) console.log(line)
    }
    const m = /RESULT (\d+)\/(\d+)/.exec(child.out)
    if (m) { pass += Number(m[1]); total += Number(m[2]) }
    if (child.code !== 0) console.log(`  ✗ 场景 ${key} 子进程退出码 ${child.code}`)
  }
  console.log(`\n== ${pass}/${total} 通过 ==`)
  console.log('\n⚠️ 这份脚本验不到的：真连 OneBot WS、真跑一轮巡检、真 WebUI —— 那些必须真重启 DSH 才验得了。\n')
  process.exit(pass === total ? 0 : 1)
}

const entry = SCENARIOS.find(([k]) => k === only)
if (entry) runOne(only).catch((e) => { console.error('场景炸了：', e); process.exit(3) })
else runAll().catch((e) => { console.error('selfcheck 自己炸了：', e); process.exit(3) })
