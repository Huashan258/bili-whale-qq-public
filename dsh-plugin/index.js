// TRPG character names, log memory gate, editor and dedicated settings, 2026-10-28.
/**
 * dsh-whale —— bili-whale-qq 的 DSH 插件胶水层（host 半端）
 * ============================================================================
 * 它做什么：把 `C:/apps/bili-whale-qq` 的巡检 + QQ 群聊挂进 **DSH 宿主进程**，
 *   省掉那个一直开着的 `node src/agent.mjs` 窗口。
 *
 * 它不做什么：**一行业务代码都不写**。`src/` 下的模块原样 `import` 进来用，
 *   `index.js` 只负责四件事 —— 读配置、定时器、单实例锁、收摊。
 *
 * ── 三条命根子（踩过 / 差点踩到的坑，改这个文件前先读）─────────────────────
 *
 * R1 · 异常绝不能外冒。
 *     插件跑在 **DSH 宿主进程里**，一个没人接的异常会把整个 DSH 带走
 *     （bili-scroll 记的 2026-10-14 事故：setInterval 回调里抛 TypeError，
 *      DSH 当场 `fatal uncaught exception`）。这里的异常面比 bili-scroll 还大：
 *     ws 长连接 + 定时器 + 网络请求 + 消息处理。
 *     ⇒ 定时器回调、每一个 await 点，全部 try/catch。**这一轮没跑成**可以，
 *       异常冒出去不行。
 *
 * R2 · 多实例互斥。
 *     OneBot 是「一条消息推给所有 WS 客户端」。两个写者 = 同一条群消息回两遍
 *     （看起来像机器人抽风），也会两边同时写 state.json / chat.log。
 *     ⇒ 启动时先抢 `src/lock.mjs` 的 **同一把锁**（名字就是 `agent`，跟独立进程共用），
 *       抢不到就**整个插件让位**，一行业务都不起。
 *     ⇒ 状态目录**必须**还是 `C:/apps/bili-whale-qq/.data` ——
 *       `chat.mjs` 的 `restoreHistory()` 读那里的 `chat.log`，换了目录历史就断了。
 *
 * R3 · 卸载清理。
 *     `ctx.effect()` 里 clearInterval + 关 ws + 放锁。DSH 退出 / 插件重载后
 *     不留僵尸定时器、不留锁（留了锁，独立 agent 就再也起不来）。
 *
 * R0 · 配置是 **volatile ref**，不是标量。（2026-10-20 QA 用真 cordis 4.0.5 实测出来的）
 *     `Config` 里每个字段都 `.extra('volatile', true)` ⇒ schemastery 把值包成
 *     cosmokit 的 `createVolatile()`：`Object.freeze({ get: () => v })`，
 *     `JSON.stringify` 出来是 `{}`，真值要 `.get()`。
 *     而且 volatile 字段改值 **不 remount**（loader 只做 `fiber._config = …` + `_commitVolatile()`，
 *     就地改 ref，apply 不会再跑一次）⇒ 只能靠轮询盯。
 *     详见 `deref()` 和 `supervise()`。
 *
 * 还有一条：**绝不去 `process.on('uncaughtException')` 上抢宿主的处理函数** ——
 *   那个钩子是宿主的，我们抢了就等于替 DSH 决定“出错要不要死”。
 *   本插件的做法是把所有自己的入口都包住，让宿主那层永远收不到我们的异常。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync,readdirSync,unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {randomUUID} from 'node:crypto'
import { loadHostDeps } from './lib/hostdeps.mjs'
import { UI_FIELDS, readUiCfg, readUiCfgRaw, uiFileOf, writeUiCfg } from './lib/uicfg.mjs'
import { createWebUiHost } from './lib/webui-host.mjs'

// ⭐ 顶层 await：schemastery 从宿主树里取（拿不到就 z=null，插件照常加载）。
//    桌面版 profile 是 `autoInstallPeers: false`，裸 import 会整条插件不激活 —— 详见 lib/hostdeps.mjs。
const hostDeps = await loadHostDeps()
const z = hostDeps.z

/** 命名空间。**必须等于 cordis.patch.yml 里那条 entry 的 id**（whale）。 */
export const name = 'whale'

/** 只依赖宿主的 settings（Config 的 volatile 字段要靠它落到设置页） */
export const inject = ['settings', 'webServer']

/**
 * 🔴 每个字段都要 `.extra('volatile', true)`：DSH 的 settings.update() 只认 volatile 字段，
 *    没有这个标记写设置时会抛 “Plugin entry … has no volatile fields”。
 *    schemastery 拿不到时这里会是 undefined —— 插件照常加载，只是设置页降级。
 *
 * 🔴 默认值一律取“最怂”的一档：enabled=false（装上去不动）、dry=true（只预演不真发）、
 *    qqEnabled=false（不连 OneBot）、webUi=false（不抢 7788）。
 */
export const Config = !z ? undefined : z.object({
  /** 总开关。默认关 —— 装上先不动，用户在设置页自己开 */
  enabled: z.boolean().default(false).extra('volatile', true),
  /** 预演：只判断、只打日志，一个字都不发出去。默认开 */
  dry: z.boolean().default(true).extra('volatile', true),
  /** B站评论区巡检间隔（分钟）。0 = 不巡检（定时器还活着，改回数字就恢复） */
  replyPatrolMinutes: z.number().default(5).extra('volatile', true),
  /** QQ 群聊（连 OneBot WS）。默认关 —— 连上了就是真的在群里 */
  diceEnabled: z.boolean().default(false).extra('volatile', true),
  qqEnabled: z.boolean().default(false).extra('volatile', true),
  /** WebUI（7788）。默认关 —— 端口是独占的，不该由插件默认抢 */
  webUi: z.boolean().default(false).extra('volatile', true),
  /** WebUI 端口。只有 webUi=true 时才用得上 */
  webUiPort: z.number().default(7788).extra('volatile', true),
  /** 刷B站：每天谷时自动跑一轮（从 dsh-bili-scroll 移植过来的那一轮） */
  scrollEnabled: z.boolean().default(false).extra('volatile', true),
  /** 刷B站的候检间隔（分钟）。到点会看一眼「今天跑过没 + 是不是谷时」，谷时才真跑 */
  scrollMinutes: z.number().default(6).extra('volatile', true),
  /** 刷B站：搜索关键词（逗号分隔）。留空 = 只用热门/排行榜 + 关注的 UP 主 */
  scrollKeywords: z.string().default('').extra('volatile', true),
  /** 刷B站：一天最多发几条评论。负数 = 沿用 config.json 现值 */
  scrollPerDay: z.number().default(-1).extra('volatile', true),
  /** 刷B站：评论里 @ 谁。留空 = 沿用 config.json 现值 */
  scrollMention: z.string().default('').extra('volatile', true),
  /** 刷B站：视频偏好——一段话说清楚「我喜欢看什么样的」，会喂给判断模型。留空 = 沿用 config.json */
  scrollPreferences: z.string().default('').extra('volatile', true),
  /** 刷B站：偏好的题材 tag（逗号分隔）。既当搜索关键词，也告诉模型我喜欢哪些。留空 = 沿用 */
  scrollTags: z.string().default('').extra('volatile', true),
  /** 刷B站：每天最多看几个视频候选。负数 = 沿用 config.json 现值 */
  scrollMaxVideos: z.number().default(-1).extra('volatile', true),
  /** 状态目录。留空 = 项目自己的 .data（**别改**，chat.log 历史在那儿） */
  dataDir: z.string().default('').extra('volatile', true),

  /**
   * ── 群聊「内容」设置 ──
   *
   * ⭐ 这一组跟上面的开关不是一回事：开关改的是插件自己的行为，这一组会**写回
   *    项目根 config.json 的 chat 段**（src/chat.mjs 从那儿读），然后自动重启 runtime 生效。
   *
   * ⭐ 一律「留空 = 不动」：空串 / 负数表示"沿用 config.json 里现在的值"，
   *    这样插件不会在你没碰过的字段上自作主张（也避免长文本被设置页截坏）。
   */
  /** 群昵称（它自称什么）。留空 = 不改 */
  nick: z.string().default('').extra('volatile', true),
  /** 人设／性格（长文本）。留空 = 不改；要改就把整段粘进来 */
  persona: z.string().default('').extra('volatile', true),
  /** 禁忌话题：绝对不能提的。留空 = 不改（想清空就填一个空格外的占位，如 "-"） */
  taboo: z.string().default('').extra('volatile', true),
  /** 唤醒别名，逗号分隔：青娥,小鱼,大肥鱼。留空 = 不改 */
  aliases: z.string().default('').extra('volatile', true),
  /** 只在这些群里说话，逗号分隔群号。留空 = 不改 */
  groups: z.string().default('').extra('volatile', true),
  /** 管理员 QQ，逗号分隔。留空 = 不改 */
  admins: z.string().default('').extra('volatile', true),
  /** 静默时段（不接话），两个整点，逗号分隔：1,2 或 23,6。留空 = 不改 */
  quietHours: z.string().default('').extra('volatile', true),
  /** 接话概率 0~1。1 = 每句都接（很吵）；-1 = 不改 */
  speakChance: z.number().default(-1).extra('volatile', true),
  /** 两次发言之间的冷却秒数。-1 = 不改 */
  minGapSec: z.number().default(-1).extra('volatile', true),
  /** 每小时最多说几句。0 = 不限；-1 = 不改 */
  maxPerHour: z.number().default(-1).extra('volatile', true),

  /* ── 模型与记忆（写回 config.json 的 chat 段）──
   * ⭐ 温度必须能自己调：日常闲聊要活泼（1.5+），写长文要稳（0.9）。
   *    一个值两头兼顾不了 —— 1.7 写 500 字会崩成乱码，0.9 闲聊又太正经。 */
  /** 闲聊温度 0~2。-1 = 不改（写死 1.7 那种是自找乱码） */
  temperature: z.number().default(-1).extra('volatile', true),
  /** 长文（读后感/锐评/点名字数）时的温度 0~2。-1 = 不改 */
  longFormTemperature: z.number().default(-1).extra('volatile', true),
  /** 长文单次输出上限（token）。-1 = 不改；400+100 字至少 2000 */
  longFormMaxOutputTokens: z.number().default(-1).extra('volatile', true),
  /** 聊天记忆条数：0/1 = 只带当前这句（等于不记忆）；-1 = 不改 */
  contextMessages: z.number().default(-1).extra('volatile', true),
  /** 重启后恢复几条历史：0 = 不恢复；-1 = 不改 */
  historyRestore: z.number().default(-1).extra('volatile', true),
  /** 扣字用的参考字数（0 = 不校验）。-1 = 不改。暂未参与逻辑，留位 */
  replyCharsHint: z.number().default(-1).extra('volatile', true),
})

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(PLUGIN_DIR, '..')
const SRC_DIR = join(PROJECT_ROOT, 'src')

const DEFAULTS = {
  enabled: false,
  dry: true,
  replyPatrolMinutes: 5,
  qqEnabled: false,
  diceEnabled: false,
  webUi: false,
  webUiPort: 7788,
  scrollEnabled: false,
  scrollMinutes: 6,
  scrollKeywords: '',
  scrollPerDay: -1,
  scrollMention: '',
  scrollPreferences: '',
  scrollTags: '',
  scrollMaxVideos: -1,
  dataDir: '',
  nick: '',
  persona: '',
  taboo: '',
  aliases: '',
  groups: '',
  admins: '',
  quietHours: '',
  speakChance: -1,
  minGapSec: -1,
  maxPerHour: -1,
  temperature: -1,
  longFormTemperature: -1,
  longFormMaxOutputTokens: -1,
  contextMessages: -1,
  historyRestore: -1,
  replyCharsHint: -1,
}

/**
 * config.json 里也有一份同名配置的字段 → 路径映射。
 *
 * ⚠️ 为什么需要这层：cordis 的 volatile 字段**写不回去**，用户在 DSH 设置页里改不到；
 *    而 `replyPatrolMinutes` 这类「行为参数」用户更习惯直接改 config.json（独立 agent
 *    就是读那份）。两边各写一半就会出现鬼打墙 —— config.json 明明写着 0.5（30 秒），
 *    插件却还按 cordis 默认的 30 分钟跑，日志里那句「每 30 分钟」就是铁证。
 *
 * 优先级（低 → 高）：DEFAULTS < config.json < cordis 显式设过的值 < whale-ui.json。
 * 「cordis 显式设过」的判据 = 值不等于 DEFAULTS（volatile 解包后没设过就是默认值）。
 */
const FILE_CFG_MAP = [
  ['diceEnabled', ['chat','dice','enabled']],
  ['replyPatrolMinutes', ['share', 'replyPatrolMinutes']],
]

/** 读 config.json 里映射到插件 cfg 的那几个键（带 mtime 缓存，2 秒内不重复解析） */
const fileCfgCache = { mtime: -1, val: {} }
function readFileCfg(file) {
  let m = 0
  try { m = statSync(file).mtimeMs } catch { return {} }
  if (m === fileCfgCache.mtime) return fileCfgCache.val
  const val = {}
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    for (const [k, path] of FILE_CFG_MAP) {
      let cur = j
      for (const seg of path) cur = cur?.[seg]
      if (cur !== undefined && cur !== null) val[k] = cur
    }
  } catch { /* 文件正在被写/坏了 —— 这轮先当没有 */ }
  fileCfgCache.mtime = m
  fileCfgCache.val = val
  return val
}

/**
 * R0 · volatile ref 解包。
 *
 * ⚠️ 2026-10-20 QA 实测（真 cordis 4.0.5 + 真 loader + 真 schemastery 3.18.5）：
 *   `apply(ctx, config)` 里**每个**字段都是 `Object.freeze({ get: () => v })`，
 *   `typeof v === 'object'`、`JSON.stringify(v) === '{}'`。
 *   真值必须 `.get()` 才拿得到 —— 不解包的话下面所有 `typeof v === 'boolean'` 判断
 *   全部为假 ⇒ **每个字段都静默落回默认值 ⇒ `enabled` 永远 false，插件启不动**，
 *   而且设置页每一个开关看起来都是哑的。
 *
 *   ⚠️ 关于「为什么不用 cosmokit 的 `isVolatile()`」（QA 2026-10-20 追问过）：
 *     `isVolatile` 判的是 `Symbol.for('cosmokit.volatile.write')`，**全局 Symbol 注册表是跨 ESM
 *     副本共享的**，所以严格说不是"拿不到"，而是"要多从宿主树解析一个包、多一条启动期失败路径"。
 *     这里选鸭子判定是一次**权衡**，不是无奈：
 *       ① 我们 Config 只有 boolean / number / string，没有任何对象/数组字段
 *          ⇒ `{get}` 形状只可能是 volatile ref，不会误判；
 *       ② **失败方向是安全的** —— 就算真误判，下面 `normalize()` 的 typeof 校验还会兜一层，
 *          结果只会退化成默认值，不会抛。
 */
const deref = (v) => (v && typeof v === 'object' && typeof v.get === 'function') ? v.get() : v

/**
 * ⚠️ 2026-10-14 事故（bili-scroll 那边第一次挂上就炸了整个 DSH）：
 *   `config` 的字段值**不保证是标量**。对象是“真值”，`if (!cfg.enabled)` 这类守卫会
 *   全部失效，一路走到 `.filter(...)` 抛 TypeError —— 而那通常发生在**定时器回调里**，
 *   没人接 ⇒ 整个宿主进程被带走 ✗✗。
 * ⇒ 逐字段按默认值的类型挑一遍，拿不准就用默认值。
 */
function normalize(src, base) {
  const out = { ...base }
  for (const k of Object.keys(base)) {
    const v = deref(src?.[k])
    if (v === undefined || v === null) continue
    if (Array.isArray(base[k])) { if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string') }
    else if (typeof base[k] === 'number') { const n = Number(v); if (Number.isFinite(n)) out[k] = n }
    else if (typeof base[k] === 'boolean') { if (typeof v === 'boolean') out[k] = v }
    else if (typeof base[k] === 'string') { if (typeof v === 'string') out[k] = v }
  }
  return out
}

/**
 * 「结构性」配置的指纹 —— 变了就要整个重启 runtime。
 * ⚠️ 故意**不含 dataDir**：它是进程级的（BILI_WHALE_DATA + src/config.mjs 模块求值），
 *    改了得重载插件/重启 DSH 才生效，重启 runtime 没用，只会白折腾。
 */
const sigOf = (c) => JSON.stringify([
  c.enabled, c.dry, c.replyPatrolMinutes, c.qqEnabled, c.webUi, c.webUiPort,
  c.scrollEnabled, c.scrollMinutes,
  /* ⭐ 内容设置也算「结构性」：改了必须重挂 runtime，src 那边才会重新 loadConfig() */
  c.nick, c.persona, c.taboo, c.aliases, c.groups, c.admins, c.quietHours,
  c.speakChance, c.minGapSec, c.maxPerHour,
])

/**
 * 设置页字段 → config.json 的 `chat` 段键名。
 * ⚠️ 值一律「留空 = 不动」：string 空串 / number 负数都跳过，
 *    免得插件在用户没碰过的字段上反客为主，把 config.json 里手写的长文本冲掉。
 */
const CHAT_FIELDS = [
  ['diceEnabled','dice.enabled'],
  ['nick', 'nick'],
  ['persona', 'persona'],
  ['taboo', 'taboo'],
  ['aliases', 'aliases'],
  ['groups', 'groups'],
  ['admins', 'admins'],
  ['quietHours', 'quietHours'],
  ['speakChance', 'speakChance'],
  ['minGapSec', 'minGapSec'],
  ['maxPerHour', 'maxPerHour'],
  /* 模型与记忆 —— 右列支持点号路径（比如 shield.xxx 表示写进 chat.shield 里那层） */
  ['temperature', 'temperature'],
  ['longFormTemperature', 'longFormTemperature'],
  ['longFormMaxOutputTokens', 'shield.longFormMaxOutputTokens'],
  ['contextMessages', 'contextMessages'],
  ['historyRestore', 'historyRestore'],
]

/** 按点号路径往对象里塞值（'shield.a.b' → obj.shield.a.b = v），中间层缺就建空对象 */
function setPath(obj, path, val) {
  const parts = String(path).split('.').filter(Boolean)
  let cur = obj
  for (const p of parts.slice(0, -1)) {
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = val
}

/** 逗号/空格分隔串 → 数组（quietHours 再转数字，跟 src 的口径一致） */
const LIST_FIELDS = { aliases: 'str', groups: 'str', admins: 'str', quietHours: 'num' }

/**
 * 把设置页的内容设置写回项目根 config.json。
 *
 * ⚠️ 必须在 `import src/config.mjs` **之前**跑吗？—— 不用，但必须在 `createChat()` 之前：
 *    src/chat.mjs 是在那时 `loadConfig()` 的，写晚了这一轮读到的还是旧值。
 *    放在 bootstrap ③ 之前最稳（既早，又能拿到 log）。
 *
 * @returns {boolean} 是否真的改动了文件（没改就别惊动日志）
 */
function applyChatOverrides(cfg, log) {
  const patch = {}
  for (const [cfgKey, chatKey] of CHAT_FIELDS) {
    const v = deref(cfg?.[cfgKey])
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'number' && v < 0) continue          // 哨兵：不改
    if (typeof v === 'string' && !v.trim()) continue
    patch[chatKey] = v
  }
  for (const k of Object.keys(LIST_FIELDS)) {
    if (typeof patch[k] !== 'string') continue
    const parts = String(patch[k]).split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    if (!parts.length) { delete patch[k]; continue }
    patch[k] = LIST_FIELDS[k] === 'num'
      ? parts.map(Number).filter((n) => Number.isFinite(n))
      : parts
  }
  if (!Object.keys(patch).length) return false

  const file = join(PROJECT_ROOT, 'config.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    raw.chat = (raw.chat && typeof raw.chat === 'object') ? raw.chat : {}
    const before = JSON.stringify(raw.chat)
    // ⚠️ 不能简单的 `{...raw.chat, ...patch}`：longFormMaxOutputTokens 要落进 chat.shield，
    //    直接铺开会变成 chat.longFormMaxOutputTokens（src 那边读不到，改了等于没改）。
    for (const [key, val] of Object.entries(patch)) setPath(raw.chat, key, val)
    const after = JSON.stringify(raw.chat)
    if (after === before) return false
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
    log(`群聊设置已写回 config.json（${Object.keys(patch).join(' / ')}）`)
    return true
  } catch (e) {
    log(`群聊设置写回失败（忽略，沿用 config.json 现值）：${e?.message ?? e}`)
    return false
  }
}

/**
 * 把设置页的「刷B站」设置写回 config.json 的 **scroll 段**（不是 chat 段）。
 *
 * 跟 `applyChatOverrides` 完全同一个路子：留空 / 负数 = 不动，
 * 免得插件在用户没碰过的字段上反客为主。
 *
 * @returns {boolean} 是否真的改动了文件
 */
function applyScrollOverrides(cfg, log) {
  const patch = {}
  const kw = deref(cfg?.scrollKeywords)
  if (typeof kw === 'string' && kw.trim()) {
    const parts = kw.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
    if (parts.length) patch.keywords = parts
  }
  const pd = Number(deref(cfg?.scrollPerDay))
  if (Number.isFinite(pd) && pd >= 0) patch.perDay = Math.round(pd)
  const mn = deref(cfg?.scrollMention)
  if (typeof mn === 'string' && mn.trim()) patch.mentionName = mn.trim()
  // 视频偏好（一段话）+ 题材 tag（逗号分隔）—— 都喂给判断模型，让它照着「我」的口味挑
  const pref = deref(cfg?.scrollPreferences)
  if (typeof pref === 'string' && pref.trim()) patch.preferences = pref.trim()
  const tg = deref(cfg?.scrollTags)
  if (typeof tg === 'string' && tg.trim()) {
    const tp = tg.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
    if (tp.length) patch.tags = tp
  }
  const mv = Number(deref(cfg?.scrollMaxVideos))
  if (Number.isFinite(mv) && mv >= 0) patch.maxCandidates = Math.round(mv)
  if (!Object.keys(patch).length) return false

  const file = join(PROJECT_ROOT, 'config.json')
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    const before = JSON.stringify(raw.scroll ?? {})
    raw.scroll = { ...(raw.scroll ?? {}), ...patch }
    const after = JSON.stringify(raw.scroll)
    if (after === before) return false
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')
    log(`刷B站设置已写回 config.json（${Object.keys(patch).join(' / ')}）`)
    return true
  } catch (e) {
    log(`刷B站设置写回失败（忽略，沿用 config.json 现值）：${e?.message ?? e}`)
    return false
  }
}

/** 静默时段（跟 src/agent.mjs 同一套口径，支持跨零点） */
function inQuietHours(quiet) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const [from, to] = quiet
  const h = new Date().getHours()
  return from <= to ? (h >= from && h < to) : (h >= from || h < to)
}

/** 消息段 → 纯文本（只给预演日志用，跟 src/chat.mjs 的 segsToText 同口径） */
function segsToText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const out = []
  for (const s of message) {
    if (!s || typeof s !== 'object') continue
    if (s.type === 'text') out.push(String(s.data?.text ?? ''))
    else if (s.type === 'at') out.push(`@${s.data?.qq === 'all' ? '全体成员' : s.data?.qq ?? '某人'}`)
  }
  return out.join('').trim()
}

/** 把 '../../src/foo.mjs' 变成能 import 的 file:// URL（Windows 盘符必须这么转） */
const srcUrl = (rel) => pathToFileURL(join(SRC_DIR, rel)).href

/**
 * 监督者轮询间隔。
 * ⚠️ `enabled` 是 volatile ⇒ 改它**不会 remount**，apply 不会再跑
 *    （真 cordis 实测：改完 `apply` 调用次数仍是 1）。所以只能靠这里轮询盯。
 * 测试缝：设 `DSH_WHALE_SUPERVISE_MS` 可以把它压短（selfcheck 用 300ms）。
 */
const SUPERVISE_MS = Math.max(200, Number(process.env.DSH_WHALE_SUPERVISE_MS) || 30_000)

export function apply(ctx, config) {
  /**
   * ── 配置（每次读都要现解包 volatile ref）─────────────────
   *
   * ⭐ UI 覆盖层：设置页（client.js）写的东西落在 `.data/whale-ui.json`，
   *    跟 cordis 那份配置**叠加**用（覆盖层优先）。
   *
   *    为什么不直接写 DSH 的 volatile 设置：cordis 的 volatile 字段**写不回去**
   *    （2026-10-20 实测：设置页改了，插件读到的还是旧值）—— 跟 bili-scroll
   *    「靠家目录 config.json 兜底读配置」是同一个路子，详见 lib/uicfg.mjs 顶部。
   */
  const initialDataDir=deref(config?.dataDir)
  const UI_FILE = typeof initialDataDir==='string' && initialDataDir.trim() ? join(resolve(initialDataDir),'whale-ui.json') : uiFileOf(PROJECT_ROOT)
  const CFG_JSON = join(PROJECT_ROOT, 'config.json')
  const readCfg = () => {
    const base = normalize(config, { ...DEFAULTS })
    const file = readFileCfg(CFG_JSON)
    for (const k of Object.keys(file)) {
      // cordis 那边等于默认值 ⇒ 用户没在 DSH 设置里设过 ⇒ 听 config.json 的
      if (base[k] === DEFAULTS[k]) base[k] = file[k]
    }
    return { ...base, ...readUiCfg(UI_FILE) }
  }
  const first = readCfg()

  /* ── 状态目录 ───────────────────────────────────────────
   * 留空 = 项目自己的 .data。这是**硬要求**：chat.mjs 的 restoreHistory() 读
   * 那里的 chat.log，指到别处历史就断了（用户会看到“重启后它不接话”）。
   * ⚠️ 只用**第一次**读到的值：BILI_WHALE_DATA 是进程级的，src/config.mjs
   *    模块求值一次就定死了，后面改 dataDir 也不会生效（会在 supervise 里提醒）。 */
  const dataDir = first.dataDir ? resolve(String(first.dataDir)) : join(PROJECT_ROOT, '.data')

  /* ── 日志：一份进文件（排查用），一份进宿主 logger（用户能在 DSH 里看到）── */
  const logFile = join(dataDir, 'dsh-plugin.log')
  const log = (msg) => {
    const line = `${new Date().toISOString()}  ${msg}`
    try {
      mkdirSync(dataDir, { recursive: true })
      appendFileSync(logFile, line + '\n', 'utf8')
    } catch { /* 日志写不进去也不致命 */ }
    try { ctx.logger?.info?.(`[whale] ${msg}`) } catch { /* 没有 logger 就算了 */ }
  }

  for (const n of hostDeps.notes) log(n)

  /* ── 运行时状态（收摊时统一清）──────────────────────────── */
  const rt = {
    timers: new Set(),        // setTimeout / setInterval 都放这儿（Node 里两者同一个 Timeout 对象）
    chat: null,               // createChat 的返回值（stop() 里关 ws）
    snowLumaWatch:null,
    localVoiceWatch:null,
    lockFile: '',             // 抢到的锁文件路径（放锁要用）
    releaseLock: null,        // src/lock.mjs 的 releaseLock（延迟 import，先留空）
    gen: 0,                   // 启动代号：停一次 +1，在飞的 bootstrap 靠它对不上就自己退场
    running: false,           // runtime 是否起来了
    activeSig: '',            // 起来时那份配置的指纹
    shutdown: false,          // 插件正在被卸载，不再重启
    warnedDataDir: false,
    lastYieldLog: 0,          // 让位日志节流：监督者每 30 秒重试一次，日志每 10 分钟才说一次
    wasEnabled: false,        // 上一轮观察到的 enabled（用来区分「开关翻转」和「让位重试」）
    startedAt: new Date().toISOString(),
  }
  let supervisor = null
  const webUiHost=createWebUiHost({root:PROJECT_ROOT,dataDir,logger:log})

  /**
   * 停 runtime（**幂等**，可以反复调）。
   * ⚠️ `rt.gen++` 是关键：在飞的 bootstrap 每一步 await 之后都会比对代号，
   *    对不上就知道自己已经过期，不再往下排定时器/写状态。
   */
  const stopRuntime = () => {
    rt.gen++
    rt.running = false
    rt.activeSig = ''
    for (const t of rt.timers) {
      try { clearTimeout(t) } catch { /* 已经清了 */ }
      try { clearInterval(t) } catch { /* 已经清了 */ }
    }
    rt.timers.clear()
    rt.snowLumaWatch?.stop()
    rt.snowLumaWatch=null
    rt.localVoiceWatch?.stop()
    rt.localVoiceWatch=null
    try { rt.chat?.stop() } catch (e) { log(`关群聊失败（忽略）：${e?.message ?? e}`) }
    rt.chat = null
    if (rt.lockFile && rt.releaseLock) {
      try { rt.releaseLock(rt.lockFile) } catch (e) { log(`放锁失败（忽略）：${e?.message ?? e}`) }
      rt.lockFile = ''
    }
  }

  const startRuntime = (cfg) => {
    rt.gen++
    const gen = rt.gen
    rt.running = true
    rt.activeSig = sigOf(cfg)
    bootstrap(cfg, { dataDir, log, rt, gen, beat }).catch((e) => {
      if (rt.gen === gen) log(`启动失败（已兜住，不影响宿主）：${e?.stack ?? e}`)
    })
  }

  /**
   * R3 · 收摊（插件卸载 / DSH 退出）。`rt.shutdown` 一旦置上就不再重启。
   * @returns {void}
   */
  const cleanup = () => {
    if (rt.shutdown) return
    rt.shutdown = true
    log('收摊：清定时器 / 关 WebSocket / 放锁')
    try { if (supervisor) clearInterval(supervisor) } catch { /* 已经清了 */ }
    supervisor = null
    webUiHost.stop()
    stopRuntime()
  }

  /**
   * 心跳文件 —— 让人能确认“插件到底在不在跑”。
   *
   * ⚠️ 2026-10-20 QA 抓到的：**永远写，并且必须写 `running` 的真值**。
   *    以前只在「起来了」的分支里写，结果抢不到锁（独立 agent 占着）时，
   *    文件里是 `enabled:true` + **当下时间戳**，看着完全像在跑，其实一条业务都没起
   *    —— 比"留着最后一次内容"更糟，它是**正在撒谎**。
   *    ⇒ `running` 由 `rt.running` 现读；抢锁成功/失败的两个分支都会各自补写一次。
   */
  const beatFile = join(dataDir, 'dsh-plugin.json')
  const beat = (cfg) => {
    try {
      writeFileSync(beatFile, JSON.stringify({
        pid: process.pid,
        host: 'dsh-plugin',
        startedAt: rt.startedAt,
        heartbeat: Date.now(),
        // ⭐ 这两个是两回事：enabled = 开关打开了；running = 业务真起来了（锁抢到了）
        enabled: Boolean(cfg.enabled),
        running: Boolean(rt.running),
        dry: cfg.dry,
        qq: cfg.qqEnabled,
        patrolMinutes: cfg.replyPatrolMinutes,
      }, null, 2))
    } catch { /* 写不进去就算了 */ }
  }

  /**
   * 监督者：volatile 字段改值**不 remount**（真 cordis 实测 apply 只跑一次），
   * 所以「用户在设置页打开开关」这件事只能靠这里盯出来。
   */
  const supervise = () => {
    try {
      if (rt.shutdown) return
      const next = readCfg()
      webUiHost.configure({enabled:next.enabled && next.webUi,port:next.webUiPort})

      if (next.dataDir && resolve(String(next.dataDir)) !== dataDir && !rt.warnedDataDir) {
        rt.warnedDataDir = true
        log(`⚠️ dataDir 改成了 ${next.dataDir}，但它只在插件加载时生效（进程级 BILI_WHALE_DATA）` +
            ` —— 要生效得重载插件或重启 DSH。当前仍用 ${dataDir}`)
      }

      const want = Boolean(next.enabled)
      /* 上一轮观察到的是不是"开着"。用来区分「用户把开关打开了」和「让位后每跳重试」。 */
      const turnedOn = want && rt.wasEnabled !== true
      rt.wasEnabled = want

      if (!want && rt.running) {
        log('enabled 关了 —— 收摊（定时器 / WS / 锁全放掉）')
        stopRuntime()
      } else if (want && !rt.running) {
        // ⚠️ 这一支**包括"上一轮抢锁失败让位了"** —— running 被 bootstrap 置回 false，
        //    所以锁一空出来，最多 30 秒（或收到 volatile-update 立刻）就会自己接管。
        //
        // 🔴 2026-10-20 QA 实测：让位期间这一支**每一跳**都会走到，以前每次都打一行
        //    「enabled 打开了 —— 启动」—— 开关根本没动，那是在重试。
        //    30 秒一跳 = **2880 行/天**，正好淹没用户「开 dry 看一天日志」要看的东西，
        //    字面上还会让人以为它在反复重启。
        //    ⇒ 只在**开关真的翻转**（上一轮是关的）时说话；重试路径闭嘴，
        //      真原因由 bootstrap 里那条「已有实例在跑…让位」负责（它已按 10 分钟节流）。
        if (turnedOn) log('enabled 打开了 —— 启动')
        startRuntime(next)
      } else if (want && rt.running && sigOf(next) !== rt.activeSig) {
        log('配置变了 —— 重启 runtime（开关 / 间隔 / QQ / WebUI / 群聊内容这些改了要重挂才生效）')
        stopRuntime()
        startRuntime(next)
      }
      // ⭐ 无条件写 —— 跑着、让位着、关着，文件里都必须是**当下**的真话
      beat(next)
    } catch (e) {
      // 监督者自己绝不能炸（R1）
      try { log(`监督者这一跳出错了（已兜住）：${e?.stack ?? e}`) } catch { /* 连日志都写不了就算了 */ }
    }
  }

  // 不管后面成不成，钩子先挂上 —— 挂不上（宿主不支持 effect）也只是收摊降级，
  // 绝不能让这一行把 apply 搞挂。
  try {
    ctx.effect(() => () => cleanup(), 'whale: 收摊（定时器 / WS / 单实例锁）')
  } catch (e) {
    log(`⚠️ 收摊钩子没挂上（${e?.message ?? e}）—— 插件重载时可能留下定时器和锁`)
  }

  if (!existsSync(SRC_DIR)) {
    log(`找不到业务代码目录：${SRC_DIR}。插件只做胶水，src/ 必须在项目里。`)
    return
  }

  /* 监督者定时器：不进 rt.timers（那个是 runtime 的，stopRuntime 会清；
     监督者必须活到 cleanup，否则关了再开就没人盯了） */
  try {
    supervisor = setInterval(supervise, SUPERVISE_MS)
    supervisor.unref?.()
  } catch (e) {
    log(`监督者没起来（${e?.message ?? e}）—— 开关改了不会自动生效，得重载插件`)
  }

  /**
   * ⭐ 快路径：订阅 loader 的 volatile 提交事件 —— 设置页一改**立刻**生效，不用等 30 秒。
   *
   * `cordis-plugin-loader` 的 `_commitVolatile()` 在就地改完 ref 之后会
   * `fiber.ctx.emit(self, 'loader/volatile-update', paths)`，而 dispatch 的 filter 只放行
   * 「注册在同一个 fiber 上」的监听者 —— `apply(ctx)` 这个 ctx 就是那个 fiber 的 ctx，
   * 所以收得到（QA 用真 loader 实测确认过）。
   * 这个 emit 本身被 loader 的 try/catch 包着（`cordis-plugin-loader/lib/index.js:428-430`），
   * 所以就算我们抛了也伤不到宿主 —— 但 R1 的规矩照旧：这里再包一层。
   *
   * ⚠️ 监听器里**只调一次 `supervise()`**（它本身幂等、有 gen 保护），别在这儿 setInterval/递归。
   * ⚠️ 30 秒轮询**保留当兜底**：万一宿主版本没有这个事件，或事件名改了，开关还是能生效。
   * 监听器挂在 fiber 的 ctx 上，插件卸载时 cordis 会一起收掉，不用手动摘。
   */
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('loader/volatile-update', () => {
        try { supervise() } catch (e) { log(`volatile-update 处理出错（已兜住）：${e?.message ?? e}`) }
      })
    }
  } catch (e) {
    log(`订阅 loader/volatile-update 失败（不影响功能，退回 30 秒轮询）：${e?.message ?? e}`)
  }

  /* ── 设置页后端 `/api/whale/*`（client.js 用）─────────────────────────
   * 挂不上没关系（比如宿主没给 webServer），聊天和巡检照跑，只是设置页打不开。 */
  const sendJson = (res, code, obj) => {
    try {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    } catch { /* 客户端断了就算了 */ }
  }
  const readBody = (req) => new Promise((resolve) => {
    let data = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) { finish(''); req.destroy() }   // 别让人灌爆
    })
    req.on('end', () => finish(data))
    req.on('error', () => finish(''))
  })

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/whale',
      handler: async (req, res) => {
        try {
          const path = new URL(req.url, 'http://127.0.0.1').pathname

          if (req.method === 'GET' && path === '/api/whale/mascot') {
            const mascot=readFileSync(join(PROJECT_ROOT,'public','assets','whale','portrait.svg'))
            res.writeHead(200, {'content-type':'image/svg+xml','cache-control':'public, max-age=86400'})
            return res.end(mascot)
          }

          if (req.method === 'GET' && path === '/api/whale/config') {
            return sendJson(res, 200, {
              ok: true,
              config: readCfg(),          // 叠加后的生效值
              ui: readUiCfgRaw(UI_FILE),  // 设置页填过的（含空值，好让界面回显）
              fields: UI_FIELDS,
            })
          }

          if(req.method==='POST'&&path==='/api/whale/voice/preview'){
            if(rt.voicePreviewBusy)return sendJson(res,409,{error:'DSH已有语音试听正在生成'})
            if(!rt.chat?.previewVoice)return sendJson(res,503,{error:'DSH语音通道尚未就绪'})
            rt.voicePreviewBusy=true
            try{
              let body;try{body=JSON.parse(await readBody(req))}catch{throw Error('试听请求格式错误')}
              rt.refreshVoiceConfig?.()
              const audio=await rt.chat.previewVoice(body.text,{parameters:body.parameters}),id=randomUUID(),dir=join(dataDir,'voice-preview')
              mkdirSync(dir,{recursive:true});writeFileSync(join(dir,id+'.wav'),audio.bytes,{flag:'wx'})
              const old=readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.wav$/.test(f)).map(f=>({f,time:statSync(join(dir,f)).mtimeMs})).sort((a,b)=>b.time-a.time)
              for(const entry of old.slice(5))unlinkSync(join(dir,entry.f))
              return sendJson(res,200,{ok:true,url:'/api/voice/preview?id='+id,provider:audio.provider,characters:audio.characters,bytes:audio.bytes.length,loudness:audio.loudness??null,senderRevision:audio.senderRevision,source:'dsh'})
            }finally{rt.voicePreviewBusy=false}
          }

          if (req.method === 'POST' && path === '/api/whale/config') {
            const body = await readBody(req)
            let patch = {}
            try { patch = JSON.parse(body || '{}') } catch { patch = {} }
            const next = writeUiCfg(UI_FILE, patch)
            log(`设置页更新：${Object.keys(patch).join(' / ') || '(空)'}`)

            /* ⭐ 先**立刻**落回 config.json，再谈重挂。
             *
             * 为什么不能只靠 supervise()：`sigOf()` 里只算「结构性」字段（开关/间隔/人设…），
             *    刷B站的 tags / preferences / 温度这些**不在签名里** ⇒ 改了不触发重挂
             *    ⇒ `applyScrollOverrides()` 永远不会跑 ⇒ 设置页填了题材却一点没生效。
             *    （2026-10-20 用户报的「题材在 webUI 改不了」就是这个。）
             * 现在保存即落盘，src 那边本来就每次现读 config.json（chat 是 Proxy、scroll 走
             *    refreshCfg），所以立刻生效，连重挂都不需要。 */
            try {
              const merged = readCfg()
              applyChatOverrides(merged, log)
              applyScrollOverrides(merged, log)
            } catch (e) { log(`设置页写回 config.json 失败（已兜住）：${e?.message ?? e}`) }

            /* 监督者：签名变了当场重挂 runtime（开关这类才需要），不用等 30 秒 */
            try { supervise() } catch (e) { log(`设置页改完重挂失败（已兜住）：${e?.message ?? e}`) }
            return sendJson(res, 200, { ok: true, ui: next })
          }

          if (req.method === 'GET' && path === '/api/whale/status') {
            let bili=null
            if(rt.running)try {
              const {biliPolicy,BILI_LIMITS}=await import(srcUrl('bili-policy.mjs'))
              const policy=await biliPolicy.status()
              bili={limits:BILI_LIMITS,videos:policy.watch.length,shares:policy.share.length,requests:policy.requests.length,cooldownUntil:policy.cooldownUntil??0,nextWatchAt:Number.isFinite(policy.nextWatchAt)?policy.nextWatchAt:0,nextShareAt:Number.isFinite(policy.nextShareAt)?policy.nextShareAt:0}
            } catch { /* 状态读取异常不影响插件 */ }
            let tail = ''
            try { tail = readFileSync(join(dataDir, 'dsh-plugin.log'), 'utf8').slice(-2500) } catch { /* 没日志就算了 */ }
            return sendJson(res, 200, {
              ok: true,
              pid: process.pid,
              startedAt: rt.startedAt,
              enabled: readCfg().enabled,
              running: Boolean(rt.running),
              qq: readCfg().qqEnabled,
              dry: readCfg().dry,
              chat: rt.chat?.status?.() ?? null,
              webUi:webUiHost.status(),
              snowLuma:rt.snowLumaWatch?.status() ?? null,
              localVoice:rt.localVoiceWatch?.status() ?? null,
              patrol:rt.patrol ?? null,
              privateInbox:rt.privateInbox ?? null,
              mentions:rt.mentions ?? null,
              biliMentionsVersion:2,
              biliMessagingVersion:2,
              biliCommandVersion:1,
              biliVideoPrivateVersion:1,
              biliIdentityVersion:1,
              biliThreadPriorityVersion:1,
              bili,
              logFile: join(dataDir, 'dsh-plugin.log'),
              logTail: tail,
            })
          }

          return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'whale: /api/whale 路由')
  } catch (e) {
    log(`HTTP 路由没挂上（设置页用不了，聊天和巡检照跑）：${e?.message ?? e}`)
  }

  if (!first.enabled) {
    log(`未启用（enabled=false）。设置页 → 插件 whale → 打开「启用」即可，不用重启 DSH` +
        `（最多等 ${Math.round(SUPERVISE_MS / 1000)} 秒被监督者发现）。状态目录 ${dataDir}`)
    return
  }

  /* 第一次不用等轮询周期，直接起 */
  supervise()
}

/**
 * 真正的启动流程。每一步都可能失败（文件不在、端口不通、锁被占），
 * **全部**包在 try/catch 里，失败就“这一轮/这一项没起来”，绝不外冒。
 *
 * @param {{enabled:boolean, dry:boolean, replyPatrolMinutes:number, qqEnabled:boolean,
 *          webUi:boolean, webUiPort:number, dataDir:string}} cfg 已 normalize 过的插件配置
 * @param {{dataDir:string, log:(m:string)=>void, rt:object, gen:number, beat:(cfg:object)=>void}} env
 * @returns {Promise<void>}
 */
async function bootstrap(cfg, env) {
  const { dataDir, log, rt, gen, beat } = env
  /** 在飞的这次启动是不是还算数（被 stopRuntime / cleanup 作废就退场） */
  const alive = () => rt.gen === gen && !rt.shutdown

  /**
   * ① 数据目录 —— **必须在 import 任何 src/* 之前**定下来。
   *    src/config.mjs 在模块求值时就算好了 `DATA`（`process.env.BILI_WHALE_DATA`），
   *    ESM 缓存之后就改不动了。晚一步 ⇒ 状态写去别处、历史断掉。
   */
  process.env.BILI_WHALE_DATA = dataDir
  mkdirSync(dataDir, { recursive: true })
  log(`状态目录 ${dataDir}（BILI_WHALE_DATA 已指向这里，跟独立 agent 共用同一份状态）`)

  /**
   * ② R2 · 单实例锁。锁名就是 `agent` —— 和 `node src/agent.mjs` **同一把**，
   *    所以独立进程还活着时，插件会自己让位；反过来也一样。
   */
  const lockMod = await import(srcUrl('lock.mjs'))
  if (!alive()) return
  rt.releaseLock = lockMod.releaseLock
  const lock = lockMod.acquireLock('agent', { owner: 'dsh-plugin' })
  if (!lock.ok) {
    /**
     * 🔴 让位。**必须把 rt.running 置回 false**（2026-10-20 QA 实测抓出来的）：
     *    `startRuntime()` 是同步把 running 置 true 的，真正的胜负要等这里异步抢锁才知道。
     *    以前这里直接 `return` ⇒ running 永久卡在 true ⇒ 监督者看到「want && running」就跳过
     *    ⇒ **锁空出来以后插件再也不会自己接管**，用户必须先停 agent 再重启 DSH 才行
     *    —— 跟"不用重启 DSH"的卖点正好相反。
     *    （这正是用户当下的路：独立 agent pid 14724 正占着锁。）
     *
     * 日志节流：每 10 分钟最多说一次。监督者 30 秒重试一次，不节流会刷屏。
     */
    if (rt.gen === gen) {
      rt.running = false
      rt.activeSig = ''
      const now = Date.now()
      if (now - rt.lastYieldLog > 10 * 60_000) {
        rt.lastYieldLog = now
        log(
          `已有实例在跑（pid ${lock.pid}${lock.since ? `，起于 ${lock.since}` : ''}，owner=${lock.owner ?? 'standalone'}）` +
          ` —— 插件让位不启动，每 10 分钟重试一次；那个进程一停就自动接管，不用重启 DSH。` +
          `想立刻接管：先停掉 pid ${lock.pid}。`,
        )
      }
      beat?.(cfg)          // 心跳立刻改成 running:false，别撒谎
    }
    return
  }
  if (!alive()) {                       // 抢到锁的瞬间被叫停 ⇒ 立刻还回去，别占着
    try { lockMod.releaseLock(lock.file) } catch { /* 还不掉就算了 */ }
    return
  }
  rt.lockFile = lock.file
  log(`拿到单实例锁（宿主 pid ${process.pid}，owner=dsh-plugin）；关闭/卸载时自动放锁`)
  beat?.(cfg)

  /**
   * ②·补 群聊内容设置写回 config.json。
   *    必须在 `createChat()` 之前 —— src/chat.mjs 在那一刻 `loadConfig()`，写晚了这轮读旧的。
   *    「留空 = 不动」的字段这里会被跳过，所以没碰过就不会动 config.json。
   */
  applyChatOverrides(cfg, log)
  applyScrollOverrides(cfg, log)

  /* ③ 业务模块（延迟 import，这样 dataDir 才生效 + import 失败也只影响插件） */
  const [configMod, patrolMod, chatMod, qqMod, shareMod, privateMod,mentionsMod] = await Promise.all([
    import(srcUrl('config.mjs')),
    import(srcUrl('bili-patrol.mjs')),
    import(srcUrl('chat.mjs')),
    import(srcUrl('qq.mjs')),
    import(srcUrl('share.mjs')),
    import(srcUrl('bili-private.mjs')),
    import(srcUrl('bili-mentions.mjs')),
  ])
  if (!alive()) return
  const { loadConfig, loadState } = configMod
  const { runPatrol } = patrolMod
  const { runPrivateInbox } = privateMod
  const { runBiliMentions, mentionInitialDelay } = mentionsMod
  const { createChat } = chatMod

  /* ④ 业务配置：每轮现读（改完 config.json 不用重启 DSH） */
  let biz = null
  const refreshCfg = () => {
    try {
      const next = loadConfig()
      // ⚠️ **就地改**（Object.assign），不能整个换掉：createChat 里是 Proxy 读 `cfg.chat`，
      //    换对象的话群聊那头会一直拿着旧的配置（表现就是“WebUI 改了人设不生效”）。
      if (!biz) biz = next
      else Object.assign(biz, next)
      biz.chat ??= {}
      biz.share ??= {}
      // 巡检间隔听插件设置页的（config.json 里的同名键只是给独立 agent 用的）
      biz.share.replyPatrolMinutes = cfg.replyPatrolMinutes
      return true
    } catch (e) {
      if (!biz) throw e
      log(`重读 config.json 失败（继续用旧的）：${e?.message ?? e}`)
      return false
    }
  }
  refreshCfg()
  rt.refreshVoiceConfig=refreshCfg
  try{
    const {createLocalVoiceWatchdog}=await import(srcUrl('local-voice-watch.mjs'))
    if(!alive())return
    const watcher=createLocalVoiceWatchdog({config:()=>biz,logger:log})
    rt.localVoiceWatch=watcher
    watcher.start()?.catch(()=>{})
  }catch{log('本地语音：启动监督器未加载，请检查模块')}

  /* ⑤·补 config.json 热加载 —— WebUI 改完设定能不能立刻生效，全靠这一段。
   *
   * 背景：`src/agent.mjs` 有自己的 `watchConfig()`（2 秒轮询 mtime → Object.assign），
   *   所以**独立 agent** 跑着的时候，WebUI 点保存 2 秒内就换人设。
   *   但**插件不走 agent.mjs**，它只在 `createChat()` 那一刻 `loadConfig()`。
   *   ⇒ 不补这个，表现就是「WebUI / 我做的设置页改了人设，DSH 里这个 whale 还在说旧话」，
   *     只有重启 DSH 才生效 —— 而且这个现象极容易被误判成"WebUI 没存上"。
   *
   * 为什么这样改就够了：`src/chat.mjs` 内部是
   *   `new Proxy({}, { get: (_, k) => (cfg.chat ?? {})[k] })`
   *   **每次现读** `biz.chat`，所以 `refreshCfg()` 就地 Object.assign 完就生效，
   *   不用重挂 runtime（重挂会断 WebSocket，群里那几秒就漏消息了）。
   *
   * 轮询而非 fs.watch：config.json 被编辑器/脚本以「写临时文件再 rename」的方式替换时，
   *   watch 的 inode 会跟着换、监听失效；mtime 轮询没这个毛病，2 秒一次开销可忽略。
   */
  const cfgFile = join(PROJECT_ROOT, 'config.json')
  let cfgMtime = 0
  try { cfgMtime = statSync(cfgFile).mtimeMs } catch { /* 首次读不到就等下一轮 */ }
  const watchTimer = setInterval(() => {
    if (!alive()) return
    let m = 0
    try { m = statSync(cfgFile).mtimeMs } catch { return }
    if (m === cfgMtime) return
    cfgMtime = m
    try {
      refreshCfg()
      log('↻ 配置已热更新（外部改了 config.json，已就地生效，不用重挂）')
    } catch (e) {
      // 「这一轮没读成」可以，异常冒出去会撞 R1（漏网异常杀宿主）
      log(`· 配置热更新失败（继续用旧的）：${e?.message ?? e}`)
    }
  }, 2000)
  watchTimer.unref?.()
  rt.timers.add(watchTimer)

  /* ⑤ 定时器统一登记（R3 收摊时一把清干净）
   *  ⚠️ 一次性定时器**触发后自己从 Set 里摘掉** —— 巡检是「跑完再排下一轮」的自递归，
   *     不摘的话 Set 会一直涨（每轮 +1，跑一天就几百个陈旧的 Timeout 句柄）。 */
  const schedule = (fn, ms) => {
    const t = setTimeout(() => { rt.timers.delete(t); fn() }, ms)
    t.unref?.()                                  // 别因为这个定时器让宿主不肯退出
    rt.timers.add(t)
    return t
  }

  /* ── ⑥ B站评论区巡检 ────────────────────────────────────
   * 跟 src/agent.mjs 的 patrolTick 同一套口径：认静默时段、±10% 抖动
   * （别跟分享定时器撞在同一个点上打 B站接口）、间隔设 0 就只是跳过、定时器还活着。
   */
  // B 站风控码（跟 src/bili-patrol.mjs 的 RISK 同一套）：撞上就说明打太急了
  const patrolRisk = value => !/12002.*(?:关闭|closed|disabled)|评论区.*关闭/i.test(String(value)) && /-412|-352|12002|12015|HTTP (?:403|412|429)|非 JSON|Unexpected token.*</i.test(String(value))
  let patrolCooldownMs = 0
    let patrolBackoff = 1      // 1 = 正常；撞风控按 2 倍往上退，最多 8 倍
  const patrolTick = async () => {
    try {
      if (!alive()) return
      refreshCfg()
      const mins = Number(cfg.replyPatrolMinutes ?? 30)
      if (mins > 0||biz.biliInbox?.enabled||biz.biliInbox?.mentionsEnabled!==false) {
        if (inQuietHours(biz.chat?.quietHours)) {
          log(`[${new Date().toLocaleTimeString()}] 静默时段，跳过评论区巡检`)
        } else {
          try {
            let mentions
            try{mentions=await runBiliMentions(biz,{dry:cfg.dry,dataDir,isActive:alive})}catch(e){rt.mentions={lastAt:new Date().toISOString(),sent:0,why:e.message};throw e}
            rt.mentions={lastAt:new Date().toISOString(),...mentions}
            if(biz.biliInbox?.mentionsEnabled!==false)log(`B站@提醒：${mentions.why||'检查完成'}`)
            // ⚠️ runPatrol 的 logger 是**当函数调用**的（`logger('…')`，见 src/bili-patrol.mjs:323），
            //    不是 {log(){}} 那种对象 —— 传错形态会 TypeError，正好落在定时器回调里（R1）。
            const r = mins>0?await runPatrol(biz, loadState(), { dry: cfg.dry, logger: (m) => log(String(m)),isActive:alive }):{sent:0,why:'评论巡检已关闭'}
            rt.patrol = { lastAt: new Date().toISOString(), sent: r.sent, why: r.why, retryAfterMs: Number(r.retryAfterMs) || 0 }
            if (r.sent) log(`[${new Date().toLocaleTimeString()}] 评论区巡检回了 ${r.sent} 条`)
            else if (r.planned?.length) r.planned.forEach((p) => log(`[预演·巡检] ${p}`))
            else if (r.why) log(`[${new Date().toLocaleTimeString()}] 评论区巡检：${r.why}`)
            if(!r.retryAfterMs&&alive())try{
              const dm=await runPrivateInbox(biz,{dry:cfg.dry,dataDir,isActive:alive})
              rt.privateInbox={lastAt:new Date().toISOString(),...dm}
              if(biz.biliInbox?.enabled)log(`B站私信：${dm.why||'巡检完成'}`)
            }catch(e){rt.privateInbox={lastAt:new Date().toISOString(),sent:0,why:e.message};log(`B站私信：${e.message}`)}
            // ⭐ 撞风控就退避（30 秒一轮一天几万次请求，412 迟早来）：
            //   优先使用持久化冷却时间，至少 15 分钟；成功一轮再恢复正常间隔。
            patrolCooldownMs = Number(r?.retryAfterMs) || 0
            if (patrolRisk(String(r?.why ?? ''))) { patrolBackoff = Math.min(8, patrolBackoff * 2); patrolCooldownMs = Math.max(15 * 60_000, patrolCooldownMs) }
            else patrolBackoff = 1
          } catch (e) {
            // 「这一轮没跑成」可以，异常冒出去不行（R1）
            log(`· 评论区巡检失败（已兜住）：${e?.message ?? e}`)
            if (patrolRisk(String(e?.message ?? ''))) { patrolBackoff = Math.min(8, patrolBackoff * 2); patrolCooldownMs = Math.max(15 * 60_000, Number(e?.retryAfterMs) || 0) }
          }
        }
      }
    } catch (e) {
      log(`· 巡检定时器这一跳出错了（已兜住，不影响宿主）：${e?.stack ?? e}`)
    } finally {
      if (alive()) {
        // 下限五分钟，跟独立 Agent 同一套口径。
        // 风控时进一步退避；不能通过配置降低五分钟下限。
        const base = Math.max(5, Number(cfg.replyPatrolMinutes ?? 30) || Number(biz.biliInbox?.pollMinutes)||30) * 60_000
        if (patrolCooldownMs > 0 || patrolBackoff > 1) log(`[巡检] 撞到风控，间隔临时退到 ${(Math.max(patrolCooldownMs, base * patrolBackoff) / 60_000).toFixed(1)} 分钟，恢复后自动降回`)
        schedule(() => { patrolTick().catch(() => {}) }, Math.max(patrolCooldownMs, base * patrolBackoff * (1 + Math.random() * 0.1)))
      }
    }
  }
  /* ── ⑥·补 刷B站（谷时·每天一轮，从 dsh-bili-scroll 移植过来的那一轮）────────
   *
   * ⚠️ 刻意**不是**「每 N 分钟跑一轮」——那会把 B 站评论额度和模型额度一起烧光。
   *    口径照抄 dsh-bili-scroll：**一天最多一轮**，而且只在**谷时**跑
   *    （工作日 9–12 / 14–18 是高峰，其余时间 + 整个周末都算谷时）。
   *    ⇒ 这里的定时器只是「每隔 scrollMinutes 看一眼：今天跑过没 + 现在是不是谷时」。
   */
  const PEAK = [[9, 12], [14, 18]]                  // 工作日高峰时段
  const inValleyNow = (d = new Date()) => {
    const day = d.getDay()
    if (day === 0 || day === 6) return true         // 周末全天都是谷时
    const h = d.getHours()
    return !PEAK.some(([a, b]) => h >= a && h < b)
  }
  const scrollStateFile = () => join(dataDir, 'scroll-state.json')
  const readScrollState = () => {
    try { return JSON.parse(readFileSync(scrollStateFile(), 'utf8')) } catch { return {} }
  }
  const scrollTick = async () => {
    let nextScrollAt=0
    try {
      if (!alive()) return
      if (!cfg.scrollEnabled) return
      refreshCfg()
      const st = readScrollState()
      const today = new Date().toISOString().slice(0, 10)
      const { scrollDayUsage, hasPendingDeliveries } = await import(srcUrl('scroll-duty.mjs'))
      const sentToday = scrollDayUsage(st,today)
      const cap = Math.max(0,!biz.scroll?.hourlyReactionEnabled&&biz.scroll?.deliveryMode === 'comment' ? Math.min(Number(biz.scroll?.perDay ?? 3),Number(biz.scroll?.mentionPerDay ?? 10)) : Number(biz.scroll?.perDay ?? 3))
      if (sentToday >= cap && !hasPendingDeliveries()) return
      if (!biz.scroll?.hourlyReactionEnabled&&!inValleyNow()) return
      log(`[${new Date().toLocaleTimeString()}] 刷B站：谷时到，开始今天这一轮`)
      const { runScroll } = await import(srcUrl('scroll-duty.mjs'))
      const r = await runScroll(biz, { dry: cfg.dry, sentToday, logger: (m) => log(String(m)),isActive:alive })
      nextScrollAt=Number(r.nextAt)||0
      try {
        writeFileSync(scrollStateFile(), JSON.stringify({
          date: today,
          ranAt: new Date().toISOString(),
          sent: sentToday + (r.sent?.length ?? 0),
          planned: r.planned?.length ?? 0,
        }, null, 2), 'utf8')
      } catch { /* 记账失败最多导致今天多跑一次，不致命 */ }
      log(
        `[${new Date().toLocaleTimeString()}] 刷B站这一轮结束：看了 ${r.candidates} 条，` +
        `${cfg.dry ? `预演 ${r.planned?.length ?? 0} 条` : `发了 ${r.sent?.length ?? 0} 条`}，日报 .data/scroll-report.md`,
      )
    } catch (e) {
      // 定时器回调是 R1 最高危的位置：异常**绝不能**冒出宿主
      log(`· 刷B站这一轮失败（已兜住）：${e?.message ?? e}`)
    } finally {
      if (alive()) {
        const base = Math.max(6, Number(cfg.scrollMinutes ?? 6) || 6) * 60_000
        const delay=biz.scroll?.hourlyReactionEnabled?Math.max(1000,(nextScrollAt||Date.now()+60000)-Date.now()):base*(1+Math.random()*0.1)
        schedule(() => { scrollTick().catch(() => {}) }, delay)
      }
    }
  }
  if (cfg.scrollEnabled) {
    schedule(() => { scrollTick().catch(() => {}) }, 60_000)   // 起来 1 分钟后第一次看
  }

  // 测试缝：`DSH_WHALE_PATROL_FIRST_MS` 能把「第一次巡检」提前，好让 selfcheck 真的
  // 跑到 patrolTick 那一跳（定时器回调是 R1 最高危的位置，平时 3 分钟根本等不到）。
  const configuredFirstDelay = Math.max(5, Number(biz.share?.replyPatrolFirstDelayMinutes ?? 5)) * 60_000
  const firstDelay = Math.max(50, Number(process.env.DSH_WHALE_PATROL_FIRST_MS) || mentionInitialDelay(biz,{dataDir,defaultMs:configuredFirstDelay}))
  schedule(() => { patrolTick().catch(() => {}) }, firstDelay)
  log(`评论区巡检已排上：${firstDelay / 60_000} 分钟后第一次，之后每 ${cfg.replyPatrolMinutes} 分钟（±10% 抖动）`)

  /* ── ⑦ QQ 群聊 ─────────────────────────────────────────
   * ws 在 src/chat.mjs 内部（connect()），它自己有 open/message/error/close 兜底和重连。
   * 这里只负责：dry 时不给真发送函数、拿 selfId、以及收摊时 chat.stop()。
   */
  if (cfg.qqEnabled || cfg.scrollEnabled) {
    try {
      /* ── QQ 通道自举：SnowLuma 不在跑就拉起来 ──────────────────────
       * 为什么要有这段：独立进程 src/agent.mjs 里 `import { ensureSnowLuma, waitOneBot }`
       * 会自动把 QQ 通道带起来，但插件当初没搬这一段 ⇒ 用户必须先手动开一次
       * `C:\apps\snowluma\launcher.bat`，否则 WS 永远连不上、日志只有一句
       * 「OneBot 连不上」。补齐之后：开 DSH 就等于开全套。
       *
       * 安全性：ensureSnowLuma 内部 spawn 时用 detached:true + unref() + stdio:ignore
       * ⇒ SnowLuma 完全脱离 DSH，DSH 退出它照常活着，下轮启动走 already-running 直接复用。
       * 它自己还有 .data/snowluma.lock 并发锁 + 端口探测，重复调用是无害的。
       * 全程兜住 —— R1：异常绝不能冒出宿主进程。
       */
      try {
        const slMod = await import(srcUrl('snowluma.mjs'))
        if(!alive())return
        const {createSnowLumaWatchdog}=await import(srcUrl('snowluma-watch.mjs'))
        if(!alive())return
        const ports={httpPort:Number(new URL(biz.qq?.onebotHttp || 'http://127.0.0.1:3000').port || 3000),wsPort:Number(new URL(biz.qq?.wsUrl || 'ws://127.0.0.1:3001').port || 3001)}
        const watcher=createSnowLumaWatchdog({check:()=>slMod.oneBotReady(ports),ensure:()=>slMod.ensureSnowLuma(ports),logger:log})
        rt.snowLumaWatch=watcher
        await watcher.start()
      } catch (e) {
        log(`QQ 通道：拉起 SnowLuma 失败（已兜住）：${e?.message ?? e}`)
      }
      if (!alive()) return

      if (cfg.qqEnabled) {
      const drySay = cfg.dry
        ? (_c, target, msg) => { log(`  [预演→${target}] ${segsToText(msg)}`) }
        : undefined
      const drySayPrivate = cfg.dry
        ? (_c, uid, msg) => { log(`  [预演→私聊 ${uid}] ${segsToText(msg)}`) }
        : undefined

      const chat = createChat(biz, {
        // ⚠️ dry 时**必须**把发送函数换成打日志的桩：不换的话默认就是真的 sendGroup。
        ...(drySay ? { say: drySay } : {}),
        ...(drySayPrivate ? { sayPrivate: drySayPrivate } : {}),
        logger: { log, warn: (m) => log(`warn ${m}`), error: (m) => log(`error ${m}`) },
        onVideoRequest: async (target, opts = {}) => {
          try {
            return await shareMod.runShare(biz, {
              dry: cfg.dry,
              ...(opts.private ? { privateTo: target } : { groupId: target }),
            })
          } catch (e) {
            log(`点播挑片失败（已兜住）：${e?.message ?? e}`)
            return { sent: false, why: String(e?.message ?? e) }
          }
        },
      })
      rt.chat = chat

      // selfId：只在实发模式下去问 OneBot（预演模式没有可用连接是正常的，别刷一堆错）
      if (!cfg.dry) {
        try {
          const info = await qqMod.ping(biz)
          if (!alive()) { try { chat.stop() } catch { /* 已停 */ } return }
          chat.selfId(info.user_id)
          log(`OneBot 已连上：${info.nickname ?? '?'}（${info.user_id}）`)
        } catch (e) {
          log(
            `OneBot 连不上（${e?.message ?? e}）—— 群聊照常等 WS，通了就会自己连。` +
            `排查：SnowLuma 启了没、QQ 登录着没、3000/3001 通不通。`,
          )
        }
      }

      if (!alive()) { try { chat.stop() } catch { /* 已停 */ } return }
      chat.start()                                       // ws + 历史恢复（内部都有兜底）
      log(`QQ 群聊已启动（${cfg.dry ? '预演，不真发' : '实发'}）`)
      }
    } catch (e) {
      log(`QQ 群聊没起来（已兜住，巡检照常跑）：${e?.stack ?? e}`)
    }
  } else {
    log('QQ 群聊未启用（qqEnabled=false）')
  }

  // WebUI 由 apply() 中的独立 Node 监督器管理，避免宿主内 import 服务。

  if (!alive()) return
  log(`起来了。巡检 ${cfg.replyPatrolMinutes} 分钟一轮 · QQ ${cfg.qqEnabled ? (cfg.dry ? '预演' : '实发') : '关'} · ${cfg.dry ? '预演模式，不真发' : '实发模式'}`)
}

/** 给 selfcheck / 排错用：插件版本号 */
export function version() {
  try {
    return String(JSON.parse(readFileSync(join(PLUGIN_DIR, 'package.json'), 'utf8')).version || '')
  } catch {
    return ''
  }
}


// QQ output policy: ordinary users share 60/minute; administrator replies are exempt.
// Load the final administrator-aware QQ output ledger.

// Publish live every-message mode and queue statistics from the chat runtime.
// Live chat status includes bounded message diagnostics and the current connection retry state.
// Chat replyFormat reports direct text for the required-reply path.
// Reply policy v2 supports explicit guest word counts without granting administrator privileges.
// Requested length bounds use integer arithmetic to avoid floating-point off-by-one limits.
// Bilibili patrol remains scoped to tracked comment roots; QQ private chat does not imply Bilibili inbox support.
// Bilibili messaging v1 adds named private sessions and verified own-video comments.

// QQ command and explicit video integration, 2026-10-21.

// Role token caps: admin normal = guest x3; commands guest60K/admin200K.

// Explicit QQ search supplies verified source summaries before reply generation.

// Command-only titles expire after the current message; ordinary title pools remain active.
// QQ image observations use a separate vision model, 2026-10-22.
// QQNT image downloads accept the official qq.com.cn CDN, 2026-10-22.
// Short ordinary group replies may use native QQ AI voice, 2026-10-22.
// QQ native AI voice publishes once through its receipt-aware send action, 2026-10-22.
// Explicit websites supply public HTTP page text before command replies, 2026-10-22.
// Book dimensions, article IDs and separate learned knowledge, 2026-10-23.
// Library emotional expression with separate factual command retrieval, 2026-10-23.
// Qinge fairy persona policy and verified administrator affection, 2026-10-23.
// Tone-aware conversational literary allusions, 2026-10-23.
// Natural dialogue style and bounded reply repair, 2026-10-24.
// Dimension-first library retrieval for expression questions, 2026-10-24.
// Remove conversational colon announcer frames, 2026-10-24.
// Public book references and durable Bilibili mention queue, 2026-10-24.
// A sampled QQ message is answered once, without a second model silence decision, 2026-10-25.
// Current-event command requests dispatch actual web lookup before generation, 2026-10-25.
// Balanced per-group reply allocation and five-video Bilibili research with command read exemption, 2026-10-25.
// Ordinary group pictures and text share one reply selection before vision, 2026-10-25.
// User text only for video request intent; pictures do not force replies through video dispatch, 2026-10-25.
// All selected replies use actual research and DeepSeek thinking before final generation, 2026-10-25.
// Verified Zhuge Liang prose and novel dialogue references, preserving Qinge identity, 2026-10-25.
// Zhuge diction and contextual ellipsis, with actual last-reply referents, 2026-10-25.
// 2026-10-25: multi-source research and hourly reaction ranking.
// 2026-10-26: ordered QQ reply parts and an optional trailing sticker.
// 2026-10-26: biaoqingbao directory stickers without byte or count caps.
// 2026-10-26: explicit sticker requests and observable selection/delivery.
// 2026-10-26: persistent global per-image repeat interval.
// 2026-10-26: Wiki-first ordinary entity questions and no empty-result caching.
// Identity query phrasing and WebUI search guidance verified.
// 2026-10-26: hourly winner also respects enabled Bilibili private push.
// 2026-10-26: CosyVoice cloud speech and local-only preview.
// 2026-10-26: configurable CosyVoice output volume.
// cosyLoudnessRevision20261026: normalized PCM and expressive cloud speech
// cosyBoostRevision20261026: extra gain with soft limiting
// voiceStickerRevision20261026: shared sticker delivery after confirmed voice
// localSovitsRevision20261026: local synthesis and shared record/sticker delivery
// localGainRevision20261026: independent local five dB gain
// voiceBootRevision20261027: preload GPT-SoVITS and share actual voice pipeline preview
