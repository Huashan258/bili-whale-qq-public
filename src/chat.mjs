import {sendQQTextParts,sendQQReplySticker} from './qq-reply-parts.mjs'
import { personaPrompt, relationshipPrompt, isQinge } from './persona.mjs'
import { WEB_GROUNDING } from './web-reader.mjs'
import { bookContext } from './book-memory.mjs'
import { qqImages, createQQVision, VISION_GUARD } from './qq-vision.mjs'
import { createQQVoiceSender, voiceEligible } from './qq-voice.mjs'
import { createStickerPicker, createStickerStore,stickerRequest,stickerCapability } from './qq-stickers.mjs'
import { searchIntent, createChatSearch, searchPrompt, searchFallback, groundedSearchReply } from './chat-search.mjs'
import { commandMode, addressTitle, commandNote, addressReply } from './chat-command.mjs'
import { createQQVideoReader, videoReference, videoCardText } from './qq-video.mjs'
import { qqOutputLimit } from './qq-output-limit.mjs'
import { createChatDiagnostics, sendWhenAvailable } from './chat-diagnostics.mjs'
import { generateDirectReply } from './chat-response.mjs'
import { prepareDeepReply } from './deep-reply.mjs'
import { referenceContext } from './conversation-reference.mjs'
/**
 * 聊天层：接 OneBot v11 的 WebSocket，群聊 + 私聊两条路。
 *
 * 群聊支持逐条必回或按场景接话，由 chat.replyEveryMessage 决定。
 * 私聊原则：管理员的话才落盘。普通群友可以聊，但内容不写日志、不进长期上下文，
 *           会话只存在内存里，过期就没了。
 *
 * 只依赖 Node 22 自带能力：全局 WebSocket + fetch。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA, ensureData } from './config.mjs'
import { hasLLM, chat as callLLM, parseJSON } from './llm.mjs'
import { scan, createMeter, shieldCfg, kindLabel } from './shield.mjs'
import { sendGroup, sendPrivate, getGroupMsgHistory } from './qq.mjs'
import { CHAT_SYSTEM, EVERY_MESSAGE_SYSTEM, SELECTED_MESSAGE_SYSTEM, CATCHUP_SYSTEM, chatUserPrompt, catchUpPrompt, PRIVATE_SYSTEM, privateUserPrompt, GUARD_TEXT } from './prompt.mjs'
import { wantsVideo } from './share.mjs'

const CHAT_STATE = path.join(DATA, 'chat.json')
const CHAT_LOG = path.join(DATA, 'chat.log')
const PRIVATE_DIR = path.join(DATA, 'private')

/**
 * 把配置里的人设填进系统提示词。
 * 空的段落整段去掉——留一行空白给模型看，它的行为会漂。
 *
 * `guard: false` 只有管理员走这条路：他显式要求越狱时不套平台规则。
 * 其他人（包括群里被 @ 的情况）一律带上，这是提示词层面的兜底。
 */
function fillSystem(tpl, c = {}, extra = {}) {
  const taboo = (c.taboo ?? '').trim()
  return tpl
    .replace('{{nick}}', c.nick ?? '群友')
    .replace('{{persona}}', personaPrompt(c) + relationshipPrompt(c, extra.admin === true))
    .replace('{{taboo}}', taboo ? `另外还守这几条：\n${taboo}` : '')
    .replace('{{guard}}', extra.guard === false ? '' : GUARD_TEXT)
    .replace('{{trust}}', extra.trust ?? '')
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function loadChatState(file = CHAT_STATE) {
  ensureData()
  let s = {}
  if (file && fs.existsSync(file)) {
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { s = {} }
  }
  if (s.day !== today()) s = { ...s, day: today(), spoken: [], shared: 0 }
  s.spoken ??= []
  s.seenVideos ??= {}
  s.shared ??= 0
  return s
}

function saveChatState(s, file = CHAT_STATE) {
  if (!file) return
  ensureData()
  fs.writeFileSync(file, JSON.stringify(s, null, 2))
}

const TTY = Boolean(process.stdout.isTTY)
const paint = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const clock = () => new Date().toTimeString().slice(0, 8)

/**
 * 终端实时回显。写文件是给排查用的；这段是给 `npm run agent` 前台运行时
 * 直接看对话的——否则只能 tail chat.log，等于「连上了但看不见」。
 * 只打收、发、错、连接状态；judge/skip 这类内部事件不打，免得刷屏。
 */
function echoLine(obj) {
  const where = obj.channel === 'private' ? '私聊' : obj.group ? `群 ${obj.group}` : ''
  switch (obj.type) {
    case 'in':
      console.log(`${paint('90', clock())} ${paint('36', where)} ${paint('1', obj.from ?? obj.uid ?? '?')}：${String(obj.text ?? '').replace(/\n/g, ' ')}`)
      break
    case 'out':
      console.log(`${paint('90', clock())}           ${paint('32', `→ ${String(obj.text ?? '').replace(/\n/g, ' / ')}`)}`)
      break
    case 'error':
      console.log(`${paint('90', clock())} ${paint('31', `! ${obj.why ?? '出错'}`)}`)
      break
    case 'ws':
      console.log(`${paint('90', clock())} ${paint('90', `· OneBot ${obj.event === 'open' ? '已连接' : obj.event ?? ''}`)}`)
      break
    case 'dry':
      console.log(`${paint('90', clock())} ${paint('90', `· 预演，没有发送${obj.why ?? obj.reason ? `：${obj.why ?? obj.reason}` : ''}`)}`)
      break
    default:
      break
  }
}

function appendLog(file = CHAT_LOG, obj) {
  if (!file) return
  ensureData()
  const rec = { ts: new Date().toISOString(), ...obj }
  fs.appendFileSync(file, JSON.stringify(rec) + '\n')
  try { echoLine(rec) } catch { /* 终端打印出问题也不能影响聊天 */ }
}

/**
 * 把消息段数组压成纯文本。
 * 只取文字：表情、图片、语音、卡片、戳一戳一律不进上下文——模型读不懂它们，
 * 塞 [表情] 之类的占位符只会让它误判成"有人在说话"。
 * @ 保留，因为"在跟谁说话"是文字语义的一部分。
 */
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

function mentionedSelf(message, selfId, aliases) {
  if (Array.isArray(message)) {
    for (const s of message) {
      if (s?.type === 'at' && String(s.data?.qq) === String(selfId)) return true
    }
  }
  const t = segsToText(message)
  return aliases.some((a) => a && t.includes(a))
}

function inQuietHours(quiet) {
  if (!Array.isArray(quiet) || quiet.length !== 2) return false
  const [from, to] = quiet
  const h = new Date().getHours()
  return from <= to ? h >= from && h < to : h >= from || h < to
}

/**
 * 清理模型吐出来的正文。
 *
 * ⚠️ `maxChars` / `maxLines` **必须能放开**。以前这里写死 `t.slice(0, 260)`，
 *    结果模型写多长都只留 260 字 —— 用户要「400 字读后感」时，模型其实写够了，
 *    是**这里**砍掉的，表现成「永远只有 260 字、第二项锐评整个不见」（2026-10-20 实测抓到）。
 *    闲聊继续按 260 字 / 3 行收；长文走调用方传进来的大上限。
 *
 * @param {string} text
 * @param {string} self 昵称（去掉「青娥鱼：」这种前缀）
 * @param {{maxChars?: number, maxLines?: number}} [o] maxLines=0 表示不限行数
 */
function cleanReply(text, self, o = {}) {
  const maxChars = Number.isFinite(o.maxChars) ? o.maxChars : 260
  const maxLines = Number.isFinite(o.maxLines) ? o.maxLines : 3
  let t = String(text ?? '').trim()
  t = t.replace(/^```[\s\S]*?```$/g, (m) => m.replace(/```[a-z]*\n?/gi, '')).trim()
  t = t.replace(new RegExp(`^${self}\\s*[:：]\\s*`), '')
  t = t.replace(/^["“]([\s\S]*)["”]$/, '$1').trim()
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean)
  if (maxLines > 0 && lines.length > maxLines) t = lines.slice(0, maxLines).join('\n')
  return t.slice(0, maxChars)
}

/* ── 管理员私聊记录（只有这部分会落盘） ───────────────── */

function adminHistoryFile(uid, dir = PRIVATE_DIR) {
  return path.join(dir, `${uid}.jsonl`)
}

function readAdminHistory(uid, dir, limit = 12) {
  const f = adminHistoryFile(uid, dir)
  if (!fs.existsSync(f)) return []
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').slice(-limit)
  const out = []
  for (const l of lines) {
    try { out.push(JSON.parse(l)) } catch { /* 跳过坏行 */ }
  }
  return out
}

function appendAdminHistory(uid, entry, dir) {
  ensureData()
  fs.mkdirSync(dir, { recursive: true })
  const f = adminHistoryFile(uid, dir)
  fs.appendFileSync(f, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')

  // 别让文件无限长，超过 400 行就只留最后 200 行
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n')
  if (lines.length > 400) fs.writeFileSync(f, lines.slice(-200).join('\n') + '\n')
}

export function createChat(cfg, {
  llmChat: rawLlmChat = callLLM,
  say: rawSay = sendGroup,
  sayPrivate: rawSayPrivate = sendPrivate,
  logger = console,
  onVideoRequest = null,
  readVideo = createQQVideoReader(),
  readImages = createQQVision(),
  sendVoice: rawSendVoice = createQQVoiceSender(),
  voiceRandom = Math.random,
  replyRandom = Math.random,
  stickerStore = createStickerStore(),
  stickerRandom = Math.random,
  replySleep,
  lookup = createChatSearch(),
  stateFile = CHAT_STATE,
  logFile = CHAT_LOG,
  privateDir = PRIVATE_DIR,
  diagnosticsFile = logFile ? path.join(path.dirname(logFile),'chat-traces.jsonl') : null,
  rateSleep,
  webSocketFactory = url=>new WebSocket(url),
  reconnectTimers = {set:setTimeout,clear:clearTimeout},
} = {}) {
  const lifetime=new AbortController()
  const diagnostics=createChatDiagnostics({file:diagnosticsFile})
  const llmChat=async(model,options)=>{
    options=await prepareDeepReply(model,{...options,signal:lifetime.signal,replyConfig:cfg,replyLookup:lookup,replyIsActive:()=>!stopped,replyOnProgress:fields=>{diagnostics.phase('search');diagnostics.searchResult(fields)},replyOnResearch:fields=>diagnostics.searchResult(fields)})
    return diagnostics.model(async()=>{
    try {
      const r=options.directReply
        ? await generateDirectReply(rawLlmChat,model,{...options,signal:lifetime.signal},{onResult:fields=>diagnostics.modelResult(fields)})
        : await rawLlmChat(model,{...options,signal:lifetime.signal})
      if(options.directReply&&!r.content)diagnostics.fallback(r.replyFormat)
      return r
    }catch(e){if(alwaysReply())diagnostics.fallback(e.code==='MODEL_TIMEOUT'||e.name==='TimeoutError'?'timeout':'model-error');throw e}
    })
  }
  const deliver=fn=>diagnostics.send(()=>sendWhenAvailable(()=>{diagnostics.phase('sending');return fn()},{signal:lifetime.signal,sleep:rateSleep,onWait:()=>diagnostics.phase('rate-wait')}))
  const say=(...args)=>deliver(()=>rawSay(...args))
  const sayPrivate=(...args)=>deliver(()=>rawSayPrivate(...args))
  const sendVoice=(...args)=>deliver(()=>rawSendVoice(...args))
  const pickSticker=createStickerPicker({store:stickerStore,random:stickerRandom,llmChat:(model,options)=>diagnostics.model(()=>rawLlmChat(model,options))})
  const noteSticker=fields=>{diagnostics.stickerResult(fields);logger.log?.('[chat] 表情包：'+fields.reason)}
  const lookupWithDiagnostics=async intent=>{
    diagnostics.phase('search')
    const result=await lookup(intent,cfg,{isActive:()=>!stopped,signal:lifetime.signal,onProgress:fields=>diagnostics.searchResult({...fields,ok:false})})
    const pagesRead=result.pages?.filter(p=>p.ok).length??0,pagesFailed=result.pages?.filter(p=>!p.ok).length??0
    diagnostics.searchResult({source:result.source,ok:result.ok,count:result.results.length,cached:Boolean(result.cached),pagesRead,pagesFailed,...(result.requiredVideos?{videosRead:result.videosRead,requiredVideos:result.requiredVideos,complete:result.complete}:{})})
    if(result.pages?.length)logger.log?.(`[chat] 网页正文读取：成功${pagesRead}页，失败${pagesFailed}页；未读取的页面不作为已核实来源`)
    return result
  }

  // config.json 会被 agent 热加载（watchConfig 里 Object.assign 换掉整个 chat 对象），
  // 所以这里不能抄一份副本存着——用代理每次现读，否则「WebUI 加了群 / 改了人设」
  // 必须重启进程才生效，表现就是「新群怎么都不说话」。
  const c = new Proxy({}, { get: (_, k) => (cfg.chat ?? {})[k] })
  const pc = new Proxy({}, { get: (_, k) => (cfg.chat?.private ?? {})[k] })

  // 群白名单：chat.groups 和 qq.groupIds 都写了就取并集。
  // 设置页只改 qq.groupIds，若严格以 chat.groups 为准，新加的群会被静默忽略。
  const groupSet = () => {
    const a = (cfg.chat?.groups ?? []).map(String)
    const b = (cfg.qq?.groupIds ?? []).map(String)
    return new Set([...(a.length ? a : b), ...b])
  }
  const adminSet = () => new Set((cfg.chat?.admins ?? []).map(String))
  const aliasList = () => [c.nick, ...(Array.isArray(c.aliases)?c.aliases:String(c.aliases??'').split(/[,，\s]+/))].map(v=>String(v??'').trim()).filter(Boolean)
  // 令咒称呼只用于当前令咒消息；普通聊天恢复按用户轮换的称呼池。
  const adminTitles = () => {
    const raw=c.adminTitles??[]
    const reserved=[addressTitle(c,true),addressTitle(c,false)].map(v=>v.toLowerCase())
    const pool=(Array.isArray(raw)?raw:String(raw).split(/[,，、\s]+/)).map(v=>String(v).trim()).filter(v=>v&&!reserved.includes(v.toLowerCase()))
    return pool.length?pool:[['主人','老板','管理员','朋友'].find(v=>!reserved.includes(v.toLowerCase()))]
  }
  const titleCursor=new Map()
  const nextAdminTitle = uid => {
    const pool=adminTitles(),key=String(uid),index=titleCursor.get(key)??0
    titleCursor.set(key,index+1)
    return pool[index%pool.length]
  }
  const rateOnly = () => c.outputRateOnly === true
  const alwaysReply = () => c.replyEveryMessage === true
  const replyChance = () => {const n=Number(c.speakChance??.55);return Number.isFinite(n)?Math.min(1,Math.max(0,n)):.55}
  const replyCredits=new Map()
  const lastGroupReplies=new Map()
  function selectOrdinaryReply(gid,chance) {
    if(chance<=0||chance>=1){replyCredits.delete(gid);return chance>=1}
    let state=replyCredits.get(gid)
    if(!state||state.chance!==chance)state={chance,credit:Math.min(.999999999,Math.max(0,Number(replyRandom())||0))}
    state.credit+=chance
    const hit=state.credit>=1-1e-10
    if(hit)state.credit=Math.max(0,state.credit-1)
    replyCredits.set(gid,state)
    return hit
  }
  const fallbackReply = () => isQinge(c) ? '本仙听到了，只是这次没能组织好回复，容本仙缓一缓。' : '我收到啦，刚才没能组织好回复，但我在听。'
  const messageText = message => {
    const images=qqImages(message)
    const safe=typeof message==='string'?message.replace(/\[CQ:image,[^\]]+\]/g,''):message
    return [segsToText(safe),videoCardText(safe),images.length?`【对方发送了${images.length}张图片】`:''].filter(Boolean).join('\n') || (Array.isArray(message) && message.some(s=>['face','record','video','json','xml','mface'].includes(s?.type)) ? '【对方发送了非文字消息，内容暂时不可读取】' : '')
  }
  const minGapMs = () => rateOnly() ? 0 : (c.minGapSec ?? 75) * 1000
  const hourlyCap = () => rateOnly() ? 0 : c.maxPerHour ?? 20
  const contextN = () => c.contextMessages ?? 14

  /**
   * 取最近 n 条当上下文；**n=0 表示「一条历史都不给」**（只留当前这句）。
   *
   * 🔴 `buf.slice(-0)` 在 JS 里等于 `buf.slice(0)` —— **整锅端**。
   *    以前没出事，只因为 contextMessages 从来没被设成 0；现在「0 = 不记忆」是
   *    合法配置（用户明确要求只留人设、群消息一律不记），这个坑必须先堵上，
   *    否则设 0 反而会把缓冲里那 30 条全塞进去 —— 比默认的 14 条还长。
   *
   * @param {Array<{name:string,text:string,uid?:string,id:any}>} buf
   * @param {number} n 想要几条；<=0 时退回「只有最后一条」
   * @param {object} [focus] 指定「当前要回的那条」（补话路径里它不一定在队尾）
   */
  const tailCtx = (buf, n, focus) => {
    if (n > 0) return buf.slice(-n)
    if (focus) return [focus]
    return buf.slice(-1)
  }

  // 重启恢复。historyRestore 默认跟 contextMessages 走：恢复太多，模型拿到的是
  // 一小时前的闲聊，反而会答非所问。窗口是一个「还热乎」的判断——超过它只补上下文、不开口。
  const historyN = () => {
    const n = Number(c.historyRestore)
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : contextN()
  }
  const historyWindowMs = () => Math.max(0, Number(c.historyReplyWindowSec ?? 600)) * 1000

  /**
   * 这句话是不是在点名要「长内容」（读后感 / 锐评 / 说了字数 / 让写一篇）。
   *
   * 为什么需要单独认出来：`CHAT_SYSTEM` 里写着「通常 30 字以内」—— 那是**闲聊**的口径，
   *    模型拿它长文请求时会老老实实缩成一句傲娇话（2026-10-20 实测：
   *    问「400 字读后感 + 100 字锐评张辽」，completion 只用了 **56 token** 就收尾，
   *    回的是「主人你这胃口还挺大的…让我拿高中满分作文那个稳风写吧」—— 一个字没写）。
   *    所以长文请求得单独放行：字数上限抬高、温度压下来、并在提示词里明确覆盖那条 30 字规则。
   *
   * 群友明确指定字数时也执行，仍受其自己的输入规则和输出尺寸约束，不提升管理员权限。
   */
  const LONG_FORM = /(\d{2,4})\s*字|读后感|观后感|小作文|写一篇|来一篇|写篇|长文|锐评|总结一下|分析一下|介绍一下|详细讲讲/
  const wantsLongForm = (t) => {
    const s = String(t ?? '')
    if (s.length > 400) return false          // 太长的多半是别的东西，不当请求
    return LONG_FORM.test(s)
  }
  /** 他在话里点明的字数（400 字 / 100 字…）。拿到就写进提示里当硬指标 ——
   *  光说「写满」模型会偷懒，点名「至少 350 字」它才当回事。 */
  const askedChars = (t) => {
    const out = []
    for (const m of String(t ?? '').matchAll(/(\d{2,4})\s*字/g)) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 20 && n <= 3000 && !out.includes(n)) out.push(n)
    }
    return out
  }
  /** 长文时的输出上限 / 温度（都可配置；没配就给写 500 字够用的默认值） */
  const longFormCap = () => Math.max(600, Math.floor(Number(shieldCfg(cfg)?.longFormMaxOutputTokens) || 2400))
  const longFormTemp = () => {
    const n = Number(c.longFormTemperature)
    return Number.isFinite(n) && n > 0 ? n : 0.6
  }

  /**
   * 长文请求时附在 user 提示里的一段「这次例外」声明。
   *
   * 不放进 `CHAT_SYSTEM` 是因为那条 30 字的规则对**闲聊**还是对的 —— 长文是例外，
   *   例外就该在该发生的那一次说，而不是把常态改掉。
   */
  /**
   * 长文备注：按他这次的具体要求现拼。
   * @param {string} text 原话（用来抓他点名的字数）
   */
  const longFormNote = (text,admin=true) => {
    const asks = askedChars(text)
    const quota = asks.length
      ? `\n字数是目标长度，不是最低长度。${asks.map(n=>`${n}字的内容控制在${Math.max(20,Math.round(n*.9))}~${Math.round(n*1.1)}字`).join('；')}。不要明显超出，也不要用一句话打发。`
      : '\n    🔴 没点字数就按「有分量」写：400 字上下，别一句话打发。'
    return `这次${admin?'主人':'对方'}要的是完整内容，不是随口闲聊。\n` +
      '    系统提示里「通常 30 字以内」这条**本次不适用**：别缩成一句，也别先答应下来不写。\n' +
      '    🔴 「他列了几项」就写几项：比如「读后感 + 锐评张辽」是两项，两项都得有，' +
      '中间空一行分开，**绝不能只写第一项就收尾**。' +
      quota + '\n' +
      '围绕指定主题给出观点与依据，事实不确定就说明；不要把史实、小说和网络梗混为一谈。\n' +
      '人设只影响少量语气，不替换回答内容，不绕开主题讲无关角色故事。句子应当完整、自然、连贯。\n' +
      '直接输出正文，不要先承诺「这就写」，不要为了人设重复称呼或堆砌语气词。'
  }
  const longSystem=(system,text)=>system.replace('像打字，不像写作文。一般一句，最多两句，通常 30 字以内。','这次是完整内容请求，按对方明确指定的字数回答；短句闲聊限制本次不适用。')
    .replace('一次最多三句，不列清单、不写小作文。对方问得具体就答得具体。','本次按要求给出完整内容，不受三句闲聊限制。')
    +'\n本次优先完整回答目标问题，按要求写作，避免无关角色联想与不通顺串词。'+(askedChars(text).length?`目标字数：${askedChars(text).join('、')}字。`:'')

  const state = loadChatState(stateFile)
  const buffers = new Map() // groupId -> [{name,text,ts,id}]
  const groupNames = new Map()
  const lastSpoke = new Map()
  const lastSpokeMsg = new Map()
  const lastVideoAt = new Map()
  const privSessions = new Map() // uid -> { msgs, lastAt }
  const privRate = new Map() // uid -> { last, times: [] }
  let selfId = ''
  let stopped = false

  // 防注入 / 防烧 token：所有拦截都在调模型之前完成，本地判断，0 token。
  const meter = createMeter(cfg)
  const recentText = new Map() // uid -> { text, count, at }
  let shieldHits = { total: 0, byKind: {}, blockedTokens: 0 }

  function noteRecent(uid, text) {
    const key = String(uid)
    const now = Date.now()
    const r = recentText.get(key)
    if (!r || now - r.at > 120_000 || r.text !== text) {
      recentText.set(key, { text, count: 1, at: now })
      return { sameCount: 1 }
    }
    r.count++
    r.at = now
    if (recentText.size > 500) recentText.delete(recentText.keys().next().value)
    return { sameCount: r.count }
  }

  function recordShield(scanRes, uid, gid, text, forced) {
    shieldHits.total++
    shieldHits.byKind[scanRes.kind] = (shieldHits.byKind[scanRes.kind] ?? 0) + 1
    appendLog(logFile, {
      type: 'shield',
      channel: gid ? 'group' : 'private',
      group: gid ?? undefined,
      uid: String(uid),
      kind: scanRes.kind,
      why: scanRes.why,
      forced: Boolean(forced),
      text: String(text ?? '').slice(0, 120),
    })
    logger.log?.(`[chat] 拦下一条${kindLabel(scanRes.kind)}：${scanRes.why}`)
  }

  /** 拼给模型的上下文有总量上限。不然群里有人刷长段，一次就几千 prompt token。 */
  function clipLines(lines) {
    const max = shieldCfg(cfg).maxContextChars ?? 2400
    let total = 0
    const out = []
    for (let i = lines.length - 1; i >= 0; i--) {
      const len = String(lines[i].text ?? '').length
      if (out.length && total + len > max) break
      out.unshift(lines[i])
      total += len
    }
    return out
  }

  /** 记一次真实用量，超阈值就熔断这个人（管理员只记账不熔断） */
  function noteUsage(uid, usage, where, isAdmin = false) {
    const r = meter.note(uid, usage, { isAdmin })
    if (r.abnormal) {
      appendLog(logFile, { type: 'budget', channel: where, uid: String(uid), tokens: r.total, limit: r.limit, exempt: Boolean(r.exempt) })
      if (r.exempt) {
        logger.warn?.(`[chat] 管理员单次 ${r.total} tokens，超过阈值 ${r.limit}（不熔断，仅记账）`)
      } else {
        logger.warn?.(`[chat] 单次调用 ${r.total} tokens，超过阈值 ${r.limit}，已熔断 ${Math.round((shieldCfg(cfg).userCooldownSec ?? 600) / 60)} 分钟`)
      }
    }
    return r
  }

  const isAdmin = (uid) => adminSet().has(String(uid))
  const paused = () => fs.existsSync(path.join(DATA, 'pause'))

  function groupBuffer(gid) {
    if (!buffers.has(gid)) buffers.set(gid, [])
    return buffers.get(gid)
  }

  function canSpeakNow(gid, forced) {
    if (stopped) return { ok: false, why: '已停止' }
    if (paused()) return { ok: false, why: '已暂停' }
    if(rateOnly() || alwaysReply())return {ok:true}
    const now = Date.now()
    const gap = now - (lastSpoke.get(gid) ?? 0)
    const minGap = minGapMs()
    if (!forced && gap < minGap) return { ok: false, why: `冷却中（${Math.ceil((minGap - gap) / 1000)}s）` }
    if (forced && gap < 8000) return { ok: false, why: '刚说过话' }
    const hourAgo = now - 3_600_000
    state.spoken = state.spoken.filter((t) => t > hourAgo)
    // maxPerHour <= 0 视为无限制（后台可以把上限拉到不限）
    const maxPerHour = hourlyCap()
    if (maxPerHour > 0 && state.spoken.length >= maxPerHour) return { ok: false, why: '本小时额度用完' }
    return { ok: true }
  }

  /* ── 补话：这条没回的，隔一会儿再看要不要接 ─────────────
   * 真实群里消息有先有后，常常一条话头飘过去就没人接了。
   * 这里给"没回上的消息"挂个定时器，到点了再问一次模型；
   * 前置判断尽量严格（还冷静默、额度、间隔、窗口），避免变成复读机。
   */
  const pending = new Map() // gid -> { ts, messageId, text, timer }
  const lastCatchUp = new Map()

  const catchUpOn = () => !alwaysReply() && c.catchUp !== false
  const catchUpDelay = () => Math.max(1, Number(c.catchUpSec ?? 45)) * 1000
  const catchUpWindow = () => Math.max(60, Number(c.catchUpWindowSec ?? 300)) * 1000

  function clearPending(gid) {
    const p = pending.get(gid)
    if (!p) return
    clearTimeout(p.timer)
    pending.delete(gid)
  }

  function queueCatchUp(gid, messageId, text) {
    if (alwaysReply() || !catchUpOn()) return
    // 纯表情、"哈"、"收到"这种不值得占用一次模型调用
    if (String(text ?? '').replace(/\s/g, '').length < 2) return
    clearPending(gid)
    const rec = { ts: Date.now(), messageId, text, timer: null }
    rec.timer = setTimeout(() => { runCatchUp(gid).catch(() => {}) }, catchUpDelay())
    rec.timer.unref?.()
    pending.set(gid, rec)
  }

  async function runCatchUp(gid) {
    const p = pending.get(gid)
    if (!p) return null
    pending.delete(gid)

    if (!catchUpOn() || stopped || paused()) return null
    if (!groupSet().has(String(gid))) return null
    return catchUpSpeak(gid, { messageId: p.messageId, atMs: p.ts, maxAgeMs: catchUpWindow(), source: 'catchup' })
  }

  /**
   * 补话和「重启后追一句」共用的判断链。
   * 两条路的差别只在配额之外的那几个参数，闸门（冷却 / 小时额度 / 静默 / 暂停 / 模型）完全共用，
   * 免得以后改了补话的规矩、重启恢复那条悄悄绕过。
   *
   * @param {string} gid
   * @param {{messageId: string, atMs: number, maxAgeMs: number, source: 'catchup'|'history', forced?: boolean}} o
   */
  async function catchUpSpeak(gid, { messageId, atMs, maxAgeMs, source = 'catchup', forced = false } = {}) {
    if (stopped || paused()) return null
    if (!groupSet().has(String(gid))) return null
    if (!Number.isFinite(atMs)) return null
    // 太久了就不接了：十个小时前的 @ 现在才回，谁都看出不对劲
    if (Date.now() - atMs > maxAgeMs) return null
    // 后来它自己说过了（被 @ 或者其他消息触发），就不用补
    if ((lastSpoke.get(gid) ?? 0) >= atMs) return null
    // 补话也要留呼吸感，别跟上一句粘在一起
    if (Date.now() - (lastSpoke.get(gid) ?? 0) < 20_000) return null
    // 同一个群两分钟内只补一次，防止折腾
    if (Date.now() - (lastCatchUp.get(gid) ?? 0) < 120_000) return null
    if (!rateOnly() && inQuietHours(c.quietHours)) return null

    const gate = canSpeakNow(gid, forced)
    if (!gate.ok) {
      appendLog(logFile, { type: source === 'history' ? 'history-skip' : 'catchup-skip', channel: 'group', group: gid, why: gate.why })
      return null
    }
    if (!hasLLM(cfg.llm)) return null

    const buf = groupBuffer(gid)
    const pendingEntry = buf.find((m) => String(m.id) === String(messageId))
    const title = pendingEntry && isAdmin(pendingEntry.uid) ? nextAdminTitle(pendingEntry.uid) : ''
    const lines = clipLines(tailCtx(buf, contextN(), pendingEntry).map((m) => ({
      name: m.name,
      text: m.text,
      self: isSelfEntry(m),
      admin: isAdmin(m.uid),
    })))
    let verdict = { speak: false, why: '未判定' }
    try {
      const r = await llmChat(cfg.llm, {
        replyTask:pendingEntry?.text??lines.at(-1)?.text??'',
        system: fillSystem(CHAT_SYSTEM + CATCHUP_SYSTEM, c, {admin:Boolean(pendingEntry && isAdmin(pendingEntry.uid))}) + commandNote({active:false,adminTitle:addressTitle(c,true),guestTitle:addressTitle(c,false)},title),
        user: catchUpPrompt({ groupName: groupNames.get(gid) ?? gid, lines, title:title||adminTitles()[0], titles: adminTitles() }),
        json: true,
        temperature: c.temperature ?? 0.8,
        maxTokens: shieldCfg(cfg).maxOutputTokens,
      })
      noteUsage(`group:${gid}`, r.usage, source === 'history' ? 'history' : 'catchup')
      verdict = parseJSON(r.content) ?? { speak: false, why: r.truncated ? '输出超长被截断' : '输出不是 JSON' }
    } catch (e) {
      appendLog(logFile, { type: 'error', channel: 'group', group: gid, why: e.message })
      logger.error?.(`[chat] ${source === 'history' ? '恢复追话' : '补话'}调模型失败：${e.message}`)
      return null
    }

    lastCatchUp.set(gid, Date.now())
    appendLog(logFile, { type: source === 'history' ? 'history' : 'catchup', channel: 'group', group: gid, speak: Boolean(verdict.speak), reply: verdict.reply, why: verdict.why })

    if (!verdict.speak) return { spoke: false, why: `${source === 'history' ? '恢复追话' : '补话'}放弃：${verdict.why ?? ''}` }
    let reply = addressReply(cleanReply(verdict.reply, c.nick ?? ''),title,{active:false,adminTitle:addressTitle(c,true),guestTitle:addressTitle(c,false)})
    if (!reply) return null

    const sent = await sendReply(gid, messageId, reply, pendingEntry?.uid)
    if (sent) {
      reply=sent
      lastGroupReplies.set(String(gid),{uid:String(pendingEntry?.uid??''),text:reply,at:Date.now()})
      lastSpoke.set(gid, Date.now())
      lastSpokeMsg.set(gid, messageId)
      state.spoken.push(Date.now())
      saveChatState(state, stateFile)
      appendLog(logFile, { type: 'out', channel: 'group', group: gid, groupName: groupNames.get(gid), text: reply, [source === 'history' ? 'history' : 'catchUp']: true })
      logger.log?.(`[chat] 群 ${gid} ${source === 'history' ? '恢复追话' : '补话'} → ${reply}`)
      return { spoke: true, text: reply }
    }
    return null
  }

  /* ── 重启恢复：把停机那会儿错过的群消息捞回来 ──────────
   * agent 一重启 buffers 就是空的，群友 @ 它、喊它名字，它一句都不回
   * ——表现就是「重启之后变哑巴」。这里做三件事：
   *   1) 本地 .data/chat.log 里读回最近 N 条（in/out 都要，bot 自己说过的话也算上下文）；
   *   2) 能用 OneBot 的 get_group_msg_history 就再拉一次真实历史，
   *      补上「进程没在跑那段时间」的消息（SnowLuma 没有这个 action，拉不到就静默跳过）；
   *   3) 最后一条别人发的消息还在窗口内、且确实是在叫它，就走一次 catchUpSpeak。
   * 全程失败不改行为：日志坏了、接口没有、文件不存在，都当没这回事。
   */

  /** 一条 buffer 记录算不算「我自己说的」 */
  const isSelfEntry = (m, id) => Boolean(m?.self)
    || (id !== undefined && id !== null && String(m?.id) === String(id))
    || (Boolean(selfId) && String(m?.uid ?? '') === String(selfId) && Boolean(m?.out))

  /** 去重键：OneBot 和本地日志会给同一条消息不同的 id，用「人+时间+内容」对齐 */
  const entryKey = (m) => `${String(m?.uid ?? '')}|${Number(m?.ts ?? 0)}|${String(m?.text ?? '')}`

  /** 从本地 JSONL 消息日志里读回某个群最近的 in/out 消息（时间升序） */
  function readGroupLog(gid, limit, file = logFile) {
    if (!file || !(limit > 0)) return []
    let lines = []
    try {
      if (!fs.existsSync(file)) return []
      lines = fs.readFileSync(file, 'utf8').split('\n')
    } catch { return [] }
    const out = []
    // 从后往前扫够 N 条就停：chat.log 能长到几十 MB，整读一遍会把启动卡住
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const s = String(lines[i] ?? '').trim()
      if (!s) continue
      let r = null
      try { r = JSON.parse(s) } catch { continue }
      if (!r || String(r.group ?? '') !== String(gid)) continue
      const text = String(r.text ?? '')
      if (!text) continue
      const ts = Math.floor(new Date(r.ts ?? Date.now()).getTime() / 1000)
      if (r.type === 'in') {
        out.unshift({ name: r.from ?? r.uid ?? '某人', text, ts, id: r.id ?? `log-in-${i}`, uid: String(r.uid ?? ''), self: false })
      } else if (r.type === 'out') {
        out.unshift({ name: c.nick ?? '我', text, ts, id: `log-out-${i}`, uid: String(selfId ?? ''), self: true, out: true })
      }
    }
    return out
  }

  /** OneBot 的历史消息 → buffer 记录 */
  function historyToEntries(list) {
    const out = []
    for (const m of list ?? []) {
      const text = segsToText(m?.message ?? m?.raw_message)
      if (!text) continue
      const uid = String(m?.sender?.user_id ?? m?.user_id ?? '')
      const id = m?.message_id ?? m?.real_id ?? ''
      if (!id) continue
      out.push({
        name: m?.sender?.card || m?.sender?.nickname || uid || '某人',
        text,
        ts: Number(m?.time ?? 0),
        id,
        uid,
        self: Boolean(selfId) && uid === String(selfId),
      })
    }
    return out
  }

  /** 这句话里有没有 @ 它 / 喊它的名字或别名 */
  const mentionsSelf = (text) => {
    const t = String(text ?? '')
    if (Boolean(selfId) && t.includes(`@${selfId}`)) return true
    return aliasList().some((a) => a && t.includes(a))
  }

  /** 这条消息是不是在叫它：@ 了它、喊了它名字/别名、或者是管理员在说话 */
  function worthHistoryReply(entry) {
    if (!entry) return false
    if (mentionsSelf(entry.text)) return true
    return Boolean(entry.uid) && isAdmin(entry.uid)
  }

  /**
   * 每个配置群恢复上下文，必要时追一句。
   * @returns {Promise<{restored: number, replied: string[], groups: number}>}
   */
  async function restoreHistory({ fetchHistory = getGroupMsgHistory } = {}) {
    const n = historyN()
    const win = historyWindowMs()
    const res = { restored: 0, replied: [], groups: 0 }
    if (n <= 0) return res
    if (stopped) return res

    for (const gid of groupSet()) {
      res.groups++
      const buf = groupBuffer(gid)
      const seen = new Set(buf.map(entryKey))
      const push = (m) => {
        const k = entryKey(m)
        if (seen.has(k)) return false
        seen.add(k)
        buf.push(m)
        res.restored++
        return true
      }

      try { for (const m of readGroupLog(gid, n)) push(m) } catch { /* 日志坏了就当没历史 */ }

      // 本地日志只覆盖「进程活着时」的消息。停机那段靠 OneBot 补；
      // 端不支持这个扩展 action（SnowLuma 就是）时返回空数组，静默跳过。
      try {
        const list = await fetchHistory(cfg, gid, { count: Math.max(n, 20) })
        for (const m of historyToEntries(list).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0))) push(m)
      } catch { /* 拉不到就用本地日志，不报错 */ }

      buf.sort((a, b) => (Number(a?.ts ?? 0)) - (Number(b?.ts ?? 0)))
      if (buf.length > 30) buf.splice(0, buf.length - 30)

      if (win <= 0 || alwaysReply()) continue
      const last = [...buf].reverse().find((m) => !m.self && String(m?.uid ?? '') !== String(selfId))
      if (!last || !worthHistoryReply(last)) continue
      const atMs = Number(last.ts ?? 0) * 1000
      if (!atMs || Date.now() - atMs > win) continue

      appendLog(logFile, { type: 'history-check', channel: 'group', group: gid, id: last.id, text: String(last.text ?? '').slice(0, 120) })
      const r = await catchUpSpeak(gid, {
        messageId: last.id,
        atMs,
        maxAgeMs: win,
        source: 'history',
        // 被 @ / 被喊名字才算「点名」，点名可以突破冷却；管理员闲聊不算
        forced: mentionsSelf(last.text),
      })
      if (r?.spoke) res.replied.push(gid)
    }
    return res
  }

  /* ── 群聊 ───────────────────────────────────────────── */

  async function sendReply(gid, messageId, text, replyUid='',allowVoice=false,sticker=null) {
    if(stopped)return false
    const chooseSticker=typeof sticker==='function'?sticker:sticker?async()=>sticker:null
    if(allowVoice && voiceEligible(text,c.voice,voiceRandom)) {
      let voiceSent=false
      try {
        await sendVoice(text,gid,cfg,{signal:lifetime.signal,replyToUserId:replyUid,onSynthesis:fields=>diagnostics.voiceResult({format:'voice',reason:'synthesized',...fields})})
        diagnostics.voiceResult({format:'voice',reason:'sent'})
        voiceSent=true
      }catch(e) {
        if(e.voiceNotSent){diagnostics.voiceResult({format:'text',reason:e.voiceReason||'synthesis-failed'});logger.warn?.('[chat] 云端语音未进入QQ发送，改发文字')}
        else{diagnostics.voiceResult({format:'voice',reason:'send-unconfirmed'});logger.error?.('[chat] 语音发送失败或回执不明，不再补发语音或文字');return false}
      }
      if(voiceSent){
        await sendQQReplySticker({chooseSticker,signal:lifetime.signal,isActive:()=>!stopped,wait:replySleep,onSticker:noteSticker,
          send:(segments,index,context)=>say(cfg,gid,segments,{replyToUserId:replyUid,...context}),
          onError:()=>logger.warn?.('[chat] 语音已发送，后续表情包未发送或回执未确认，不重发语音')})
        return text
      }
    }
    const result=await sendQQTextParts(text,{config:c,signal:lifetime.signal,isActive:()=>!stopped,wait:replySleep,onSticker:noteSticker,chooseSticker,
      send:async(segments,index,context={})=>{
        const quote=index===0&&c.quote!==false&&messageId!==undefined&&messageId!==null
        const segs=quote?[{type:'reply',data:{id:String(messageId)}},...segments]:segments
        try{await say(cfg,gid,segs,{replyToUserId:replyUid,...context})}catch(e){
          if(!quote||!e.onebotRejected||e.qqRateLimited)throw e
          await say(cfg,gid,segments,{replyToUserId:replyUid,...context})
        }
      },onError:()=>logger.error?.('[chat] 分条发送失败或回执未确认，停止后续发送，不重发已发送内容')})
    diagnostics.partsResult(result)
    return result.text||false
  }

  /**
   * 从事件里抠 uid。**两个位置都要试**：有的端只给顶层 user_id，有的只给 sender.user_id。
   *
   * 别直接 `String(ev.user_id)` —— 顶层没有时会得到字符串 `"undefined"`，
   * 它是真值，于是 isAdmin / 额度 / 落盘全都拿这个假 uid 在跑：
   * 管理员被认成普通人，历史恢复里 `isAdmin(entry.uid)` 恒 false，
   * 停机前管理员说的话就当没叫过它。宁可给空串，也别给 "undefined"。
   */
  const uidOf = (ev) => {
    const raw = ev?.user_id ?? ev?.sender?.user_id ?? ''
    const s = String(raw ?? '').trim()
    return s && s !== 'undefined' && s !== 'null' ? s : ''
  }

  async function handleGroup(ev) {
    if (!groupSet().has(String(ev.group_id))) {diagnostics.skip('非白名单群');return null}
    // 自己发的不回。uid 拿不到时不能拿空串去比 selfId（两边都空会把自己发的全丢掉）
    if (uidOf(ev) && uidOf(ev) === String(selfId)) return null

    const gid = String(ev.group_id)
    const uid = uidOf(ev)
    const name = ev.sender?.card || ev.sender?.nickname || uid
    const images = qqImages(ev.message)
    const raw = messageText(ev.message)
    // 意图识别只看用户输入，图片/媒体占位说明不能触发“发视频”等必回入口。
    const requestText=segsToText(typeof ev.message==='string'?ev.message.replace(/\[CQ:image,[^\]]+\]/g,''):ev.message)
    if (!raw || raw.startsWith('#sl')) {diagnostics.skip('空消息或SnowLuma命令');return null}

    const stickerRequested=stickerRequest(requestText)
    const command = commandMode(raw, c, selfId)
    const video = videoReference(raw)
    const lookupIntent = !video ? searchIntent(command.active?command.text:raw,{enabled:c.search?.enabled!==false,command:command.active}) : null
    const forcedReasons=[stickerRequested?'sticker-request':'',command.active?'command':'',video?'video-link':'',lookupIntent?'search':'',onVideoRequest&&wantsVideo(requestText)?'video-request':'',mentionedSelf(Array.isArray(ev.message)?ev.message:requestText,selfId,aliasList())?'mention':''].filter(Boolean)
    const forced = forcedReasons.length>0
    diagnostics.selectionResult({forced,forcedReasons,chance:replyChance(),mode:alwaysReply()?'every-message':'probability'})
    const admin = isAdmin(uid)

    // 0) 用量熔断：这个人最近烧太多，先冷着。连内容都不看——看完就已经花钱了。
    const budget = meter.check(uid, { isAdmin: admin })
    if (!budget.ok) {
      diagnostics.skip('用量闸门拦截')
      appendLog(logFile, { type: 'budget-skip', channel: 'group', group: gid, uid, why: budget.why })
      if (forced) logger.log?.(`[chat] 群 ${gid} 静默：${budget.why}`)
      return { spoke: false, why: budget.why }
    }

    // 1) 本地闸门：写代码 / 改设定 / 超长 / 刷屏，一分钱不花就挡掉。
    //    管理员走 adminBypass，只保留长度截断；token 上限仍对他生效。
    const scanRes = scan(command.active ? command.text : raw, { cfg, uid, allowTasks:command.active||Boolean(lookupIntent)||stickerRequested, isAdmin: admin, forced: forced || alwaysReply(), recent: noteRecent(uid, raw) })
    const text = scanRes.text
    if (scanRes.action === 'skip' || scanRes.action === 'reply') {
      diagnostics.skip('本地输入规则拦截')
      recordShield(scanRes, uid, gid, raw, forced)
      // 被 @ 了回一句固定短话：本地池子里挑，不走模型。
      // 但得先过冷却，否则有人连发十条就回十条。
      if ((scanRes.action === 'reply' || alwaysReply()) && canSpeakNow(gid, true).ok) {
        const tease = scanRes.tease || '这条内容太长啦，分成短一点发给我吧。'
        if (await sendReply(gid, ev.message_id, tease, uid)) {
          lastSpoke.set(gid, Date.now())
          lastSpokeMsg.set(gid, ev.message_id)
          state.spoken.push(Date.now())
          saveChatState(state, stateFile)
          appendLog(logFile, { type: 'out', channel: 'group', group: gid, groupName: groupNames.get(gid), text: tease, shield: scanRes.kind })
          logger.log?.(`[chat] 群 ${gid} 挡回 → ${tease}`)
        }
      }
      return { spoke: false, why: scanRes.why }
    }

    const buf = groupBuffer(gid)
    buf.push({ name, text, ts: ev.time ?? Math.floor(Date.now() / 1000), id: ev.message_id, uid })
    if (buf.length > 30) buf.splice(0, buf.length - 30)

    groupNames.set(gid, ev.group_name ?? groupNames.get(gid) ?? '')
    appendLog(logFile, { type: 'in', channel: 'group', group: gid, groupName: groupNames.get(gid), from: name, uid, admin, text, id: ev.message_id })

    if (!alwaysReply() && !rateOnly() && !forced && inQuietHours(c.quietHours)) {diagnostics.skip('静默时段');return null}

    // One decision only: a hit commits this message to a real reply, including short text.
    if (!forced && !alwaysReply()) {
      const chance=replyChance()
      if(!selectOrdinaryReply(gid,chance)){diagnostics.skip('接话概率未命中');return null}
    }

    const gate = canSpeakNow(gid, forced)
    if (!gate.ok) {
      diagnostics.skip(gate.why)
      if (forced) appendLog(logFile, { type: 'skip', channel: 'group', group: gid, why: gate.why })
      // 额度用完就不挂补话了，挂了也发不出去
      if (!gate.why.includes('额度')) queueCatchUp(gid, ev.message_id, text)
      return null
    }

    // 群友点播：这条优先于聊天判断，但要单独控频，免得被刷
    if (!images.length && !video && !lookupIntent && !command.active && onVideoRequest && wantsVideo(text)) {
      const last = lastVideoAt.get(gid) ?? 0
      if (Date.now() - last < (c.videoRequestCooldownSec ?? 1800) * 1000) {
        if(alwaysReply())return finishGroupReply(gid,ev.message_id,uid,'视频推荐还在冷却中，先陪你聊。')
        appendLog(logFile, { type: 'skip', channel: 'group', group: gid, why: '点播冷却中' })
        return null
      }
      lastVideoAt.set(gid, Date.now())
      appendLog(logFile, { type: 'video-request', channel: 'group', group: gid, text })
      const r = await onVideoRequest(gid, { private: false }).catch((e) => ({ sent: false, why: e.message }))
      if (r?.sent) {
        clearPending(gid)
        lastSpoke.set(gid, Date.now())
        state.spoken.push(Date.now())
        saveChatState(state, stateFile)
        return { spoke: true, text: r.text }
      }
      logger.log?.(`[chat] 点播没发出去：${r?.why ?? '未知'}`)
      if(alwaysReply())return finishGroupReply(gid,ev.message_id,uid,'这次暂时没能分享视频，先陪你聊。')
      return null
    }

    if (!hasLLM(cfg.llm)) {
      diagnostics.fallback()
      appendLog(logFile, { type: 'dry', channel: 'group', group: gid, forced, reason: '模型未配置' })
      logger.warn?.('[chat] 模型未配置（llm.provider/apiKey）')
      return finishGroupReply(gid,ev.message_id,uid,isQinge(c)?'本仙听到了，但回复服务暂时没有准备好。':'我收到啦，但回复服务暂时没有准备好。')
    }

    const sc = shieldCfg(cfg)
    // 长文请求（主人点名要读后感/锐评/说了字数）单独放行：抬高上限 + 降温
    const long = command.active || Boolean(video) || Boolean(lookupIntent) || wantsLongForm(text) && (admin || askedChars(text).length>0)
    const askedTotal=askedChars(text).reduce((a,b)=>a+b,0)
    const baseCap = long ? (admin?Math.max(sc.adminMaxOutputTokens,longFormCap()):Math.min(sc.maxOutputTokens,Math.max(600,askedTotal*2+200))) : (admin ? (sc.adminMaxOutputTokens ?? 1200) : sc.maxOutputTokens)
    const outCap = command.active ? (admin?200000:60000) : lookupIntent ? (admin?shieldCfg(cfg).adminMaxOutputTokens:shieldCfg(cfg).maxOutputTokens) : baseCap
    const videoContext = video ? await readVideo(video, cfg, {isActive:()=>!stopped,commandRead:command.active}) : ''
    const imageContext = images.length ? await readImages(images,cfg,{signal:lifetime.signal,onUsage:usage=>noteUsage(uid,usage,ev.message_type==='private'?'private':'group',admin)}) : ''
    let searchResult=null
    if(lookupIntent)searchResult=await lookupWithDiagnostics(lookupIntent)
    const searchContext=searchResult?searchPrompt(searchResult):''
    const temp = long ? longFormTemp() : (c.temperature ?? 0.8)
    const title = command.active ? addressTitle(c, admin) : admin ? nextAdminTitle(uid) : ''
    const lines = clipLines(tailCtx(buf, contextN()).map((m) => ({ name: m.name, text: m.text, self: isSelfEntry(m), admin: isAdmin(m.uid) })))
    const requestedSticker=stickerRequested?await pickSticker({cfg,text:requestText,reply:'用户明确要求挑一张已有表情包',key:`group:${gid}`,signal:lifetime.signal,force:true,onDecision:noteSticker,onUsage:usage=>noteUsage(uid,usage,'group-sticker',admin)}):null
    const system=fillSystem(alwaysReply()?EVERY_MESSAGE_SYSTEM:SELECTED_MESSAGE_SYSTEM,c,{admin,guard:!admin&&!command.active&&!lookupIntent})+stickerCapability(stickerStore,{explicit:stickerRequested,selected:requestedSticker})
    const bookMaterial=await bookContext(text,{conversationKey:`qq:group:${gid}:${uid}`,expression:!command.active&&!lookupIntent&&!video})
    let verdict = { speak: false, reply: '', why: '模型未判定' }
    try {
      const r = await llmChat(cfg.llm, {
        styleTask:text,
        replyCommand:command.active,replySearchResult:searchResult,replyMaterial:imageContext+videoContext,
        system: (long?longSystem(system,command.active?'':text):system) + commandNote(command,title) + (images.length?VISION_GUARD:'') + (searchResult||command.active?WEB_GROUNDING:'') + (searchResult?'\n本次必须依据已提供的真实检索结果回答，最终回答不贴来源网址或Markdown链接；不能声称没有联网能力，不能补造检索结果里没有的机制。结果为空或失败时如实解释。来源网址仅内部核对，不在回复中列出。':''),
        user: referenceContext(c,text,{uid,recent:buf,lastReply:lastGroupReplies.get(gid)})+chatUserPrompt({ groupName: ev.group_name ?? gid, lines, forced, replyEveryMessage:alwaysReply(),replySelected:true, title:admin?title:adminTitles()[0], titles:command.active&&admin?[title]:adminTitles() })
          + (long && !command.active ? `\n\n${longFormNote(text,admin)}` : '') + videoContext + searchContext + imageContext + bookMaterial,
        json: true,
        directReply:true,
        minReplyChars:command.active?Math.max(200,Math.floor(askedTotal*.9)):long?Math.floor(askedTotal*.9):0,
        strictMinReply:command.active,
        outputTokenCeiling:command.active?(admin?200000:60000):(admin?60000:20000),
        maxReplyChars:long&&askedTotal?Math.max(command.active?320:0,Math.ceil(askedTotal*11/10)):0,
        temperature: temp,
        maxTokens: outCap,
      })
      if (long) logger.log?.(`[chat] 群 ${gid} 长文请求（上限 ${outCap} token / 温度 ${temp}）`)
      noteUsage(uid, r.usage, "group", admin)
      verdict = parseJSON(r.content) ?? { speak: false, why: alwaysReply()?'模型未返回可用正文（已重试）':r.truncated ? '输出超长被截断' : '输出不是 JSON' }
    } catch (e) {
      appendLog(logFile, { type: 'error', channel: 'group', group: gid, why: e.message })
      logger.error?.(`[chat] 模型调用失败：${e.message}`)
      if(!alwaysReply())diagnostics.fallback('model-error')
      verdict={speak:true,reply:command.active?'':fallbackReply(),why:'模型调用失败，发送本地回执'}
    }

    appendLog(logFile, { type: 'judge', channel: 'group', group: gid, forced, ...verdict })

    const candidate=searchResult?groundedSearchReply(searchResult,verdict.reply,title):verdict.reply
    if(searchResult&&candidate!==verdict.reply)diagnostics.fallback('search-source-fallback')
    const reply = addressReply(cleanReply(candidate, c.nick ?? '', long ? { maxChars: command.active?12000:4000, maxLines: 0 } : {}),title,command) || (searchResult?searchFallback(searchResult,title):command.active?`${title}，这次未能生成满足200字要求的完整回复，请稍后重试。`:fallbackReply())
    if (!reply) {
      queueCatchUp(gid, ev.message_id, text)
      return { spoke: false, why: '空回复' }
    }

    const sticker=stickerRequested?(requestedSticker?async()=>requestedSticker:null):verdict.reply&&!reply.includes(fallbackReply())?()=>pickSticker({cfg,text:lines.slice(-4).map(x=>`${x.name}: ${x.text}`).join('\n'),reply,key:`group:${gid}`,signal:lifetime.signal,onDecision:noteSticker,onUsage:usage=>noteUsage(uid,usage,'group-sticker',admin)}):null
    return finishGroupReply(gid,ev.message_id,uid,reply,{voice:!stickerRequested&&Boolean(verdict.reply)&&!long&&!reply.includes(fallbackReply()),sticker})
  }

  async function finishGroupReply(gid,messageId,uid,reply,{voice=false,sticker=null}={}) {
    if(stopped)return {spoke:false,why:'已停止'}
    const sentText=await sendReply(gid,messageId,reply,uid,voice,sticker)
    if (sentText) {
      reply=sentText
      lastGroupReplies.set(String(gid),{uid:String(uid??''),text:reply,at:Date.now()})
      clearPending(gid)
      lastSpoke.set(gid, Date.now())
      lastSpokeMsg.set(gid, messageId)
      state.spoken.push(Date.now())
      saveChatState(state, stateFile)
      appendLog(logFile, { type:'out',channel:'group',group:gid,groupName:groupNames.get(gid),uid,replyTo:messageId,text:reply })
      return {spoke:true,text:reply}
    }
    return {spoke:false,why:'发送失败或普通输出分钟额度已满'}
  }

  /* ── 私聊 ───────────────────────────────────────────── */

  function privateGate(uid) {
    if (stopped) return { ok: false, why: '已停止' }
    if (paused()) return { ok: false, why: '已暂停' }
    const now = Date.now()
    const r = privRate.get(uid) ?? { last: 0, times: [] }
    r.times = r.times.filter((t) => t > now - 3_600_000)

    if(rateOnly() || alwaysReply()){privRate.set(uid,r);return {ok:true}}
    // 管理员不限次数、不限间隔。重复投递由 message_id 去重兜住（见 handleEvent），
    // 这里不再用时间去抖——连发几条短句是正常聊天，不该被吞。
    if (isAdmin(uid)) return { ok: true }

    if (now - r.last < (pc.minGapSec ?? 8) * 1000) return { ok: false, why: '太频繁' }
    if (r.times.length >= (pc.maxPerHour ?? 30)) return { ok: false, why: '本小时聊太多了' }
    privRate.set(uid, r)
    return { ok: true }
  }

  function privSession(uid, admin) {
    const ttl = (pc.guestMemoryMinutes ?? 30) * 60_000
    let s = privSessions.get(uid)
    if (s && !admin && Date.now() - s.lastAt > ttl) s = null
    if (!s) {
      s = { msgs: [], lastAt: Date.now() }
      // 管理员的上下文从磁盘恢复；访客每次都是新的
      if (admin) s.msgs = readAdminHistory(uid, privateDir).map((x) => ({ role: x.role, text: x.text }))
      privSessions.set(uid, s)
    }
    return s
  }

  async function adminCommand(uid, text) {
    const cmd = text.trim()
    if (cmd === '#状态') {
      const hourAgo = Date.now() - 3_600_000
      const said = state.spoken.filter((t) => t > hourAgo).length
      const body = [
        `在线：${selfId || '?'}`,
        `群：${[...groupSet()].join('、') || '无'}`,
        `模型：${hasLLM(cfg.llm) ? cfg.llm.model : '未配置'}`,
        `这一小时说过：${said}/${hourlyCap() || '不限'}`,
        `今日已分享：${state.sharedToday ?? 0}/${cfg.share?.maxPerDay ?? 2}`,
        `状态：${paused() ? '已暂停' : '正常'}`,
      ].join('\n')
      await sayPrivate(cfg, uid, [{ type: 'text', data: { text: body } }])
      return { spoke: true, text: body }
    }
    if (cmd === '#暂停' || cmd === '#继续') {
      const f = path.join(DATA, 'pause')
      if (cmd === '#暂停') {
        ensureData()
        fs.writeFileSync(f, new Date().toISOString())
      } else if (fs.existsSync(f)) {
        fs.unlinkSync(f)
      }
      const msg = cmd === '#暂停' ? '已暂停，群里和私聊都不说话了。' : '恢复了。'
      await sayPrivate(cfg, uid, [{ type: 'text', data: { text: msg } }])
      return { spoke: true, text: msg }
    }
    if (cmd === '#发视频') {
      if (!onVideoRequest) {
        await sayPrivate(cfg, uid, [{ type: 'text', data: { text: '分享模块没接上。' } }])
        return { spoke: true }
      }
      const r = await onVideoRequest(uid, { private: true }).catch((e) => ({ sent: false, why: e.message }))
      if (!r?.sent) {
        await sayPrivate(cfg, uid, [{ type: 'text', data: { text: `没发出去：${r?.why ?? '未知'}` } }])
        return { spoke: true }
      }
      return { spoke: true, text: r.text }
    }
    await sayPrivate(cfg, uid, [{ type: 'text', data: { text: '可用命令：#状态、#暂停、#继续、#发视频' } }])
    return { spoke: true }
  }

  async function handlePrivate(ev) {
    const uid = uidOf(ev) // 同上：私聊也要能从 sender.user_id 兜住
    if (uid && uid === String(selfId)) return null

    const images = qqImages(ev.message)
    const text = messageText(ev.message)
    if (!text) return null

    const admin = isAdmin(uid)
    const stickerRequested=stickerRequest(segsToText(ev.message))
    const command = commandMode(text, c, selfId)
    const video = videoReference(text)
    const lookupIntent = !video ? searchIntent(command.active?command.text:text,{enabled:c.search?.enabled!==false,command:command.active}) : null
    const name = ev.sender?.card || ev.sender?.nickname || uid
    // 私聊不套群里的静默时段，但保留频率闸门
    const gate = privateGate(uid)
    if (!gate.ok) return { spoke: false, why: gate.why }

    if (admin && text.startsWith('#')) {
      const r = await adminCommand(uid, text)
      if (r?.spoke) {const rec=privRate.get(uid)??{last:0,times:[]};rec.last=Date.now();privRate.set(uid,rec)}
      // 只有管理员的入站内容会写日志；访客只记一条"来过"，不记内容
      appendLog(logFile, { type: 'in', channel: 'private', admin: true, uid, from: name, text })
      return r
    }

    // 用量熔断：管理员不拦（他要调试、要长回复），普通人超了就冷一会儿
    if (!admin) {
      const budget = meter.check(uid)
      if (!budget.ok) {
        appendLog(logFile, { type: 'budget-skip', channel: 'private', uid, why: budget.why })
        try { await sayPrivate(cfg, uid, [{ type: 'text', data: { text: '等一下，你说太快了，我歇会儿' } }]) } catch { /* 发不出去就算了 */ }
        return { spoke: false, why: budget.why }
      }
    }

    // 本地闸门。私聊被拦也要应一声，不然对面以为号死了——
    // 但只回一句固定短话，本地拼的，不走模型，所以照样不花钱。
    const scanRes = scan(command.active ? command.text : text, { cfg, uid, allowTasks:command.active||Boolean(lookupIntent)||stickerRequested, isAdmin: admin, forced: true, recent: noteRecent(uid, text) })
    if (scanRes.action === 'skip' || scanRes.action === 'reply') {
      recordShield(scanRes, uid, null, text, true)
      const tease = scanRes.tease ?? '这个我不会啦，我只会聊天'
      try {
        await sayPrivate(cfg, uid, [{ type: 'text', data: { text: tease } }])
        const rec0 = privRate.get(uid) ?? { last: 0, times: [] }
        rec0.last = Date.now()
        if (!admin) rec0.times.push(Date.now())
        privRate.set(uid, rec0)
      } catch { /* 发不出去就算了 */ }
      return { spoke: true, text: tease, shielded: scanRes.kind }
    }
    const msg = scanRes.text

    // 只有管理员的入站内容会写日志；访客只记一条"来过"，不记内容
    appendLog(logFile, admin
      ? { type: 'in', channel: 'private', admin: true, uid, from: name, text: msg }
      : { type: 'guest', channel: 'private', admin: false, uid, note: '访客消息（未记录）' })

    const s = privSession(uid, admin)
    s.msgs.push({ role: 'other', text: msg })
    s.lastAt = Date.now()
    if (s.msgs.length > 20) s.msgs.splice(0, s.msgs.length - 20)
    if (admin) appendAdminHistory(uid, { role: 'other', text: msg }, privateDir)

    if (!hasLLM(cfg.llm)) {
      appendLog(logFile, { type: 'dry', channel: 'private', uid, reason: '模型未配置' })
      if(!alwaysReply()&&!command.active&&!video&&!lookupIntent)return null
    }

    const sc2 = shieldCfg(cfg)
    const long2 = command.active || Boolean(video) || Boolean(lookupIntent) || wantsLongForm(msg) && (admin || askedChars(msg).length>0)
    const askedTotal=askedChars(msg).reduce((a,b)=>a+b,0)
    const baseCap = long2 ? (admin?Math.max(sc2.adminMaxOutputTokens,longFormCap()):Math.min(sc2.maxOutputTokens,Math.max(600,askedTotal*2+200))) : (admin ? (sc2.adminMaxOutputTokens ?? 1200) : sc2.maxOutputTokens)
    const outCap = command.active ? (admin?200000:60000) : lookupIntent ? (admin?shieldCfg(cfg).adminMaxOutputTokens:shieldCfg(cfg).maxOutputTokens) : baseCap
    const videoContext = video ? await readVideo(video, cfg, {isActive:()=>!stopped,commandRead:command.active}) : ''
    const imageContext = images.length ? await readImages(images,cfg,{signal:lifetime.signal,onUsage:usage=>noteUsage(uid,usage,ev.message_type==='private'?'private':'group',admin)}) : ''
    let searchResult=null
    if(lookupIntent)searchResult=await lookupWithDiagnostics(lookupIntent)
    const searchContext=searchResult?searchPrompt(searchResult):''
    const temp = long2 ? longFormTemp() : (c.temperature ?? 0.8)
    const title = command.active ? addressTitle(c, admin) : admin ? nextAdminTitle(uid) : ''
    const lines = clipLines(s.msgs.slice(-12).map((m) => ({ name: m.role === 'self' ? (c.nick ?? '我') : name, text: m.text })))
    const requestedSticker=stickerRequested?await pickSticker({cfg,text:msg,reply:'用户明确要求挑一张已有表情包',key:`private:${uid}`,signal:lifetime.signal,force:true,onDecision:noteSticker,onUsage:usage=>noteUsage(uid,usage,'private-sticker',admin)}):null
    const template=alwaysReply()||images.length||command.active||video||lookupIntent||stickerRequested?PRIVATE_SYSTEM.replace(/只输出 JSON，不要任何解释：[\s\S]*$/, '只输出要发到 QQ 的回复正文，不要 JSON、字段名、解释或思考过程。正文必须非空。'):PRIVATE_SYSTEM
    const bookMaterial=await bookContext(msg,{conversationKey:`qq:private:${uid}`,expression:!command.active&&!lookupIntent&&!video})
    let out = ''
    try {
      if(!hasLLM(cfg.llm))throw Error('模型未配置')
      const r = await llmChat(cfg.llm, {
        styleTask:msg,
        replyCommand:command.active,replySearchResult:searchResult,replyMaterial:imageContext+videoContext,
        system: fillSystem(long2?longSystem(template,command.active?'':msg):template, c, {
          admin,
          trust: admin
            ? `你的主人，也是这台号的管理员${title ? `（这轮叫他「${title}」）` : ''}。他问「我是谁」「你认得我吗」就直接认他，别装不认识；他会看到你的回复。`
            : '普通群友（没有管理权限，且这段对话不会被保存）',
          guard: !admin&&!command.active&&!lookupIntent,
        }) + stickerCapability(stickerStore,{explicit:stickerRequested,selected:requestedSticker}) + commandNote(command,title) + (images.length?VISION_GUARD:'') + (searchResult||command.active?WEB_GROUNDING:'') + (searchResult?'\n本次必须依据已提供的真实检索结果回答，最终回答不贴来源网址或Markdown链接；不能声称没有联网能力，不能补造检索结果里没有的机制。结果为空或失败时如实解释。来源网址仅内部核对，不在回复中列出。':''),
        user: privateUserPrompt({ name, lines, admin, title, titles: command.active?[title]:admin?adminTitles():[],optionalAddress:c.learnedStyle?.zhugeEnabled===true&&!command.active })
          + (long2 && !command.active ? `\n\n${longFormNote(msg,admin)}` : '') + videoContext + searchContext + imageContext + bookMaterial,
        json: true,
        directReply:alwaysReply() || Boolean(images.length) || command.active || Boolean(video) || Boolean(lookupIntent)||stickerRequested,
        minReplyChars:command.active?Math.max(200,Math.floor(askedTotal*.9)):long2?Math.floor(askedTotal*.9):0,
        strictMinReply:command.active,
        outputTokenCeiling:command.active?(admin?200000:60000):(admin?60000:20000),
        maxReplyChars:long2&&askedTotal?Math.max(command.active?320:0,Math.ceil(askedTotal*11/10)):0,
        temperature: temp,
        maxTokens: outCap,
      })
      if (long2) logger.log?.(`[chat] 私聊 ${uid} 长文请求（上限 ${outCap} token / 温度 ${temp}）`)
      noteUsage(uid, r.usage, 'private', admin)
      out = parseJSON(r.content)?.reply ?? ''
    } catch (e) {
      appendLog(logFile, { type: 'error', channel: 'private', uid, why: e.message })
      logger.error?.(`[chat] 私聊模型调用失败：${e.message}`)
      if(!alwaysReply()&&!command.active&&!video&&!lookupIntent)return null
      out=command.active?'':fallbackReply()
    }

    const candidate=searchResult?groundedSearchReply(searchResult,out,title):out
    if(searchResult&&candidate!==out)diagnostics.fallback('search-source-fallback')
    let reply = addressReply(cleanReply(candidate, c.nick ?? '', long2 ? { maxChars: command.active?12000:4000, maxLines: 0 } : {}),title,command) || (searchResult?searchFallback(searchResult,title):command.active?`${title}，这次未能生成满足200字要求的完整回复，请稍后重试。`:alwaysReply()?fallbackReply():'')
    if (!reply) return { spoke: false, why: '空回复' }

    const sticker=stickerRequested?(requestedSticker?async()=>requestedSticker:null):out&&!reply.includes(fallbackReply())?()=>pickSticker({cfg,text:lines.slice(-4).map(x=>`${x.name}: ${x.text}`).join('\n'),reply,key:`private:${uid}`,signal:lifetime.signal,onDecision:noteSticker,onUsage:usage=>noteUsage(uid,usage,'private-sticker',admin)}):null
    if(stopped)return {spoke:false,why:'已停止'}
    const delivery=await sendQQTextParts(reply,{config:c,signal:lifetime.signal,isActive:()=>!stopped,wait:replySleep,onSticker:noteSticker,chooseSticker:sticker,
      send:(segments,index,context)=>sayPrivate(cfg,uid,segments,context),onError:()=>appendLog(logFile,{type:'error',channel:'private',uid,why:'分条发送失败或回执不明，停止后续内容，不重发'})})
    diagnostics.partsResult(delivery)
    if(!delivery.text)return {spoke:false,why:'发送失败'}
    reply=delivery.text

    // 管理员走的是「不建 privRate 条目」的捷径，这里自己兜一下，
    // 免得 grep 不到的 undefined 在发送成功之后才炸。
    const rec = privRate.get(uid) ?? { last: 0, times: [] }
    rec.last = Date.now()
    if (!admin) rec.times.push(Date.now())
    privRate.set(uid, rec)
    s.msgs.push({ role: 'self', text: reply })
    if (admin) {
      appendAdminHistory(uid, { role: 'self', text: reply }, privateDir)
      state.spoken.push(Date.now())
      saveChatState(state, stateFile)
      appendLog(logFile, { type: 'out', channel: 'private', admin: true, uid, text: reply })
      logger.log?.(`[chat] 私聊 ${uid} → ${reply}`)
    } else {
      // 访客：连回复内容也不落盘，只留一个已答复的记号
      appendLog(logFile, { type: 'guest', channel: 'private', admin: false, uid, note: '已回复访客（内容未记录）' })
      logger.log?.(`[chat] 私聊访客 ${uid} → 已回复（未记录）`)
    }
    return { spoke: true, text: reply }
  }

  /* ── 入口 ───────────────────────────────────────────── */

  // OneBot 在重连/重放时可能把同一条消息再推一次。按 message_id 去重，
  // 这样就不需要用「时间间隔」这种会误杀正常连发的办法来防重复。
  const seenMsgIds = new Set()
  function isDuplicate(id) {
    if (id === undefined || id === null) return false
    const key = String(id)
    if (seenMsgIds.has(key)) return true
    seenMsgIds.add(key)
    if (seenMsgIds.size > 400) {
      const it = seenMsgIds.values()
      for (let i = 0; i < 200; i++) seenMsgIds.delete(it.next().value)
    }
    return false
  }

  const messageQueues=new Map()
  let queuedMessages=0
  async function handleEvent(ev) {
    if (!ev || ev.post_type !== 'message') return null
    if (!['private','group'].includes(ev.message_type))return null
    const channel=ev.message_type==='group'?`group:${ev.group_id}`:`private:${uidOf(ev)}`
    if (ev.message_id!==undefined && ev.message_id!==null && isDuplicate(`${channel}:${ev.message_id}`)) return {spoke:false,why:'重复投递'}
    if(stopped)return {spoke:false,why:'已停止'}
    if(uidOf(ev)&&uidOf(ev)===String(selfId))return null
    const trace=diagnostics.begin(ev)
    // 管理员有独立会话队列，避免普通群友等待分钟额度时把管理员也堵住。
    const queueKey=isAdmin(uidOf(ev))?`${channel}:admin`:channel
    const task=(messageQueues.get(queueKey)??Promise.resolve()).catch(()=>{}).then(()=>diagnostics.run(trace,async()=>{
      diagnostics.start(trace)
      let result,error
      try {
        result=stopped?{spoke:false,why:'已停止'}:await (ev.message_type==='private'?handlePrivate(ev):handleGroup(ev))
        return result
      }catch(e){error=e;throw e}finally{diagnostics.finish(trace,result,error)}
    }))
    queuedMessages++
    messageQueues.set(queueKey,task)
    const done=()=>{queuedMessages--;if(messageQueues.get(queueKey)===task)messageQueues.delete(queueKey)}
    task.then(done,done)
    return task
  }

  let currentWs=null,reconnectTimer=null,reconnectAttempts=0,nextReconnectAt=0
  function scheduleReconnect() {
    if(stopped||reconnectTimer!==null)return
    const wait=Math.min(2000*2**Math.min(reconnectAttempts++,4),30000)
    nextReconnectAt=Date.now()+wait
    logger.warn?.(`[chat] 连接断开，${wait / 1000}s 后重连`)
    reconnectTimer=reconnectTimers.set(()=>{reconnectTimer=null;nextReconnectAt=0;connect()},wait)
    reconnectTimer?.unref?.()
  }
  function connect() {
    if(stopped)return null
    const base = (cfg.qq?.wsUrl ?? 'ws://127.0.0.1:3001').replace(/\/+$/, '')
    const token = cfg.qq?.wsToken ?? cfg.qq?.accessToken ?? ''
    const url = token ? `${base}/?access_token=${encodeURIComponent(token)}` : `${base}/`
    let ws
    try {ws=webSocketFactory(url)}catch{scheduleReconnect();return null}
    currentWs=ws

    ws.addEventListener('open', () => {
      if(stopped||currentWs!==ws)return
      reconnectAttempts = 0
      nextReconnectAt=0
      logger.log?.(`[chat] 已连上 ${base}`)
      appendLog(logFile, { type: 'ws', event: 'open' })
    })
    ws.addEventListener('message', (e) => {
      if(stopped||currentWs!==ws)return
      let ev
      try { ev = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data)) } catch { return }
      if (ev?.post_type === 'message') handleEvent(ev).catch((err) => logger.error?.(`[chat] ${err.message}`))
      else if (ev?.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
        logger.log?.(`[chat] 生命周期：${ev.sub_type}`)
      }
    })
    ws.addEventListener('error', () => { /* close 里统一处理 */ })
    ws.addEventListener('close', () => {
      if (stopped||currentWs!==ws) return
      scheduleReconnect()
    })
    return ws
  }

  return {
    selfId: (id) => { selfId = String(id) },
    handleEvent,
    get ws(){return currentWs},
    start() {
      if(currentWs||reconnectTimer!==null)return currentWs
      const ws = connect()
      // 先把历史捞回来再接话：不 await，连 WS 不该被磁盘 IO 和 OneBot 拖住。
      // 它只读本地日志 + 拉一次历史，失败静默，出错了也不影响后面收消息。
      this.restoring = restoreHistory().catch((e) => {
        logger.warn?.(`[chat] 历史恢复失败（忽略）：${e.message}`)
        return { restored: 0, replied: [], groups: 0 }
      })
      return ws
    },
    /** 手动补一次历史恢复（测试用，也给未来「重启后手动追话」留口子） */
    restoreHistory: (opts = {}) => restoreHistory(opts),
    stop() {
      stopped = true
      lifetime.abort(Error('已停止'))
      if(reconnectTimer!==null)reconnectTimers.clear(reconnectTimer)
      reconnectTimer=null;nextReconnectAt=0
      for (const gid of [...pending.keys()]) clearPending(gid)
      try { this.ws?.close() } catch { /* 已断 */ }
    },
    status() {
      let stickerCount=null
      try{stickerCount=stickerStore.snapshot().items.length}catch{}
      let outputRate=null
      try{outputRate=qqOutputLimit.status()}catch{}
      return {
        outputRate,
        outputRateOnly:rateOnly(),
        replyEveryMessage:alwaysReply(),
        replyFormat:'text',
        replyParts:{version:1,enabled:c.splitReplies!==false,minChars:c.splitReplyChars??90,maxParts:3,gapMs:800,stickerAfterText:true},
        replySelection:{version:4,mode:alwaysReply()?'every-message':'probability',chance:replyChance(),strategy:'balanced-per-group',singleGate:true,shortMessages:true,imagesShareChance:true,userTextIntents:true,forcedBypass:true},
        replyPolicyVersion:8,
        deepReply:{version:1,enabled:c.deepReply?.enabled===true,searchEveryReply:c.deepReply?.enabled===true&&c.search?.enabled!==false,thinking:'enabled',reasoningEffort:'high'},
        learnedStyle:{version:2,zhugeEnabled:c.learnedStyle?.zhugeEnabled===true,maxExamples:2,syntaxAndEllipsis:true,focusContext:true,identityPreserved:true},
        naturalStyle:{version:3,colonFrames:false,publicBookSpeech:true,maxRepairAttempts:1,sharedReplyDeadline:true},
        tokenCaps:{guest:shieldCfg(cfg).maxOutputTokens,admin:shieldCfg(cfg).adminMaxOutputTokens,guestCommand:60000,adminCommand:200000},
        commandMode:{enabled:c.command?.enabled!==false,prefix:c.command?.prefix??'我以令咒命之：',minChars:200,guestMaxTokens:60000,adminMaxTokens:200000,adminTitle:addressTitle(c,true),guestTitle:addressTitle(c,false)},
        ordinaryAdminTitles:adminTitles(),
        addressPolicyVersion:2,
        qqVideoLinks:true,
        qqStickers:{version:4,repeatLimit:true,explicitRequests:true,diagnostics:true,source:'biaoqingbao',count:stickerCount,maxBytes:null,maxItems:null},
        personaPolicy:{version:1,enabled:isQinge(c),selfTitle:isQinge(c)?'本仙':null,adminRelationshipByUid:true,fallbackSelfTitle:true},
        bookMemory:{version:3,publicReferences:true,mode:'dimensions-articles-fragments',personaSeparate:true,emotionalExpression:true,expressionRoutingVersion:3,inquiryDimensions:true,expressionFragments:2,expressionChars:450,expressionCooldownSeconds:180,maxFragments:3,maxCharsPerFragment:700,automaticIndexing:false},
        qqVoice:{version:7,stickerAfterVoice:true,boostDb:c.voice?.boostDb??0,normalizeLoudness:c.voice?.normalizeLoudness!==false,loudnessTarget:c.voice?.loudnessTarget??-16,volume:c.voice?.volume??50,provider:c.voice?.provider||'qq-native',model:c.voice?.provider==='cosyvoice'?(c.voice?.model||'cosyvoice-v3.5-flash'):null,hasVoiceId:Boolean(c.voice?.voiceId),enabled:c.voice?.enabled===true,maxChars:c.voice?.maxChars??80,chance:c.voice?.chance??.35,character:c.voice?.character||'lucy-voice-xueling',groupOnly:true},
        qqVision:{version:2,enabled:cfg.vision?.enabled!==false,model:cfg.vision?.model|| (cfg.llm?.provider==='deepseek'?'deepseek-flash':cfg.llm?.model),maxImages:cfg.vision?.maxImages??3},
        search:{enabled:c.search?.enabled!==false,version:6,ordinaryWikiQuestions:true,automaticCommands:true,preferredSource:'game-wiki',priorityWikis:c.search?.priorityWikis??['fgo.wiki','prts.wiki','wiki.biligame.com/sr','wiki.biligame.com/ys'],crossCheckAllSources:c.search?.crossCheck!==false,fallbackOrder:['bili','web','youtube'],engines:c.search?.engines??['bing','duckduckgo','brave'],youtube:c.search?.youtube!==false,answerSourceURLs:false,freshCacheMinutes:c.search?.freshCacheMinutes??2,minVideos:5,commandReadLimits:false,bili:true,web:true,pageRead:true,maxPages:10,cacheMinutes:10},
        queuedMessages,
        diagnostics:diagnostics.status(),
        connection:{reconnectAttempts,nextReconnectAt},
        connected:this.ws?.readyState===1,
        groups: [...groupSet()],
        admins: [...adminSet()],
        catchUp: { enabled: catchUpOn(), delaySec: Math.round(catchUpDelay() / 1000), pending: [...pending.keys()] },
        history: { restore: historyN(), replyWindowSec: Math.round(historyWindowMs() / 1000) },
        quietHours: c.quietHours ?? null,
        spokenThisHour: state.spoken.filter((t) => t > Date.now() - 3_600_000).length,
        maxPerHour: hourlyCap(),
        paused: paused(),
        lastSpoke: Object.fromEntries([...lastSpoke].map(([k, v]) => [k, new Date(v).toISOString()])),
        lastSpokeMsg: Object.fromEntries(lastSpokeMsg),
        buffers: Object.fromEntries([...buffers].map(([k, v]) => [k, v.length])),
        privateSessions: [...privSessions].map(([uid, s]) => ({ uid, admin: isAdmin(uid), messages: s.msgs.length })),
        shield: {
          enabled: shieldCfg(cfg).enabled,
          blocked: shieldHits.total,
          byKind: shieldHits.byKind,
          ...meter.stats(),
        },
      }
    },
  }
}

// Every-message mode processes each channel sequentially without short-message filtering.
// Runtime diagnostics track metadata; administrator queues remain independent of ordinary quota waits.
// Every-message replies use direct text, with one bounded recovery for genuinely empty content.
// Explicit guest word counts use the guest output budget and a complete-answer system instruction.

// QQ command and explicit video integration, 2026-10-21.

// Explicit QQ search supplies verified source summaries before reply generation.

// Command-only titles expire after the current message; ordinary title pools remain active.
// Book memory runtime version 2, 2026-10-23.
