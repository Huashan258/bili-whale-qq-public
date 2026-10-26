/**
 * B 站评论区巡检：有人在「我们发的评论」下面说话，就接一句。
 *
 * 为什么单独一个模块，而不是塞进 bili-reply.mjs：
 *   - bili-reply 是「挑片时顺带跑一次，回陌生人的一级评论」，主人被明确排除（那是给陌生人功能定的规矩）；
 *   - 这里是「常驻巡检，专回我们评论底下的楼中楼」，主人反而是最该回的人。
 * 两个功能的挑选规则不一样，混在一起只会互相打脸（改了一个另一个跟着坏）。
 *
 * 不依赖内存：每轮都现拉「根评论 + 楼中楼全楼层」拼成对话链，
 * 所以进程重启、隔了三天再跑，上下文一样是全的——这是需求里「重启后读历史再回答」的关键。
 *
 * 幂等：回过的楼层 rpid 记在 state.replied，重跑不会重复回。
 */
import { chat as callLLM, parseJSON, hasLLM } from './llm.mjs'
import { bookContext } from './book-memory.mjs'
import { PATROL_REPLY_SYSTEM } from './prompt.mjs'
import { listRecentComments, listReplyReplies, addComment } from './bili-comment.mjs'
import { quotaOf, noteComment, noteWrite, waitGap } from './quota.mjs'
import { saveState, log, DATA } from './config.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { videoInfo } from './collect.mjs'
import { generateDirectReply } from './chat-response.mjs'
import { runOwnVideoReplies } from './bili-own-comments.mjs'
import { biliIdentity, biliIdentityPrompt, biliPersona } from './bili-identity.mjs'
import { composeBiliCommand } from './bili-command.mjs'

/** 风控码。撞上就立刻收手，别接着打接口——越打封得越久。 */
import { isCommentRisk } from './comment-response.mjs'

function plain(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function num(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/** 从各种写法里抠出 BV 号：直接写、写成对象、粘了整条链接都认。 */
export function bvidOf(v) {
  if (!v) return ''
  if (typeof v === 'object') return bvidOf(v.bvid ?? v.bv ?? v.url ?? '')
  const s = String(v)
  const m = s.match(/BV[0-9A-Za-z]{8,12}/)
  return m ? m[0] : ''
}

/**
 * 这轮要看哪些视频。
 * = 我们发过评论的视频（state.commented，按时间新的优先）∪ 手动兜底名单 share.replyWatchVideos。
 *
 * 手动名单排前面：它是用户明确写死的（比如「BV1KEpn6cEf1 一定要看」），
 * 而 commented 会越攒越多，靠前的名额给了它反而可能轮不到用户指定的那条。
 */
export function patrolVideos(cfg, state, { maxVideos } = {}) {
  const cap = maxVideos ?? Math.max(1, num(cfg.share?.replyPatrolMaxVideos, 12))
  const map = new Map()
  // 同一条视频可能两边都出现：手动名单给了 BV，commented 里记着 rpid。
  // 这时候要合并而不是丢掉其中一个——丢掉 rpid 的话，巡检就退化成「按 mid 找自己发的评论」，慢还容易漏。
  const add = (bvid, rpid, mid, at) => {
    const bv = bvidOf(bvid)
    if (!bv) return
    const cur = map.get(bv) ?? { bvid: bv, rpid: '', mid: '', at: '' }
    cur.rpid ||= rpid ? String(rpid) : ''
    cur.mid ||= mid ? String(mid) : ''
    cur.at ||= at ? String(at) : ''
    map.set(bv, cur)
  }

  for (const bvid of [...(cfg.share?.replyFocusVideos??[]),...(cfg.share?.replyWatchVideos ?? [])]) add(bvid, '', '', '')

  const done = Object.entries(state?.commented ?? {})
    .map(([bvid, rec]) => ({ bvid, rec: rec ?? {}, at: String(rec?.at ?? '') }))
    // 新发的评论更可能有人回，老的先放一边（超出 cap 就被截掉）
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  for (const { bvid, rec, at } of done) add(bvid, rec.rpid, rec.mid, at)

  return [...map.values()].slice(0, Math.max(1, cap))
}

/**
 * 哪些楼层值得回。纯函数，方便离线测试。
 *
 * 规则：
 *   - 排除自己（B 站自己的 mid 是 bili.dedeUserId）；
 *   - 排除 state.replied 里记过的（幂等，重启不重复回）；
 *   - 主人的回复**不排除且优先**（以前 bot 从不理主人，就是被 pickTargets 那句「排除主人」挡的）；
 *   - 非主人的楼层受 replyPatrolWithinDays 限制，翻出三个月前的老回复去接话一眼就是机器人。
 */
export function pickReplyFloors(cfg, state, { floors, masters = [], selfMid, withinDays } = {}) {
  const self = String(selfMid ?? cfg.raw?.bili?.dedeUserId ?? '')
  const masterMids = new Set((masters ?? []).map((m) => String(m ?? '')).filter(Boolean))
  const days = num(withinDays, num(cfg.share?.replyPatrolWithinDays, 7))
  const since = Date.now() / 1000 - Math.max(0, days) * 86_400
  const replied = state?.replied ?? {}

  const out = []
  for (const f of floors ?? []) {
    if (!f?.rpid) continue
    const rpid = String(f.rpid)
    if (replied[rpid]) continue
    const mid = String(f.mid ?? '')
    if (self && mid === self) continue // 自己说的，不算「别人回我」
    const text = plain(f.text)
    if (!text) continue
    const isMaster = Boolean(mid) && masterMids.has(mid)
    // days<=0 表示不看时间；主人永远不看时间（等了三天也要回他）
    if (!isMaster && days > 0 && Number(f.ctime ?? 0) < since) continue
    out.push({
      rpid,
      root: String(f.root ?? ''),
      parent: String(f.parent ?? ''),
      mid,
      uname: f.uname ?? '',
      text,
      ctime: Number(f.ctime ?? 0),
      master: isMaster,
      priority: isMaster ? 2 : 1,
    })
  }
  // 主人先，其次按时间从旧到新（顺着对话接，别跳着回）
  out.sort((a, b) => (b.priority - a.priority) || (a.ctime - b.ctime))
  return out
}

/**
 * 把「根评论 + 楼中楼」拼成一栋楼的对话链。
 * 返回 { lines, text }：lines 给测试和上层复用，text 直接喂模型。
 */
export function buildDialogue({ rootComment, floors, selfMid = '', masters = [], title = '', nick = '我', maxLines = 20, target } = {}) {
  const self = String(selfMid ?? '')
  const masterMids = new Set((masters ?? []).map((m) => String(m ?? '')).filter(Boolean))
  const clip = (s) => (s.length > 120 ? `${s.slice(0, 100)}…` : s)

  const lines = []
  const root = rootComment ?? {}
  if (plain(root.text)) {
    lines.push({
      name: nick,
      text: clip(plain(root.text)),
      self: true,
      master: false,
      root: true,
      rpid: String(root.rpid ?? ''),
      ctime: Number(root.ctime ?? 0),
    })
  } else if (String(root.rpid ?? '')) {
    // 我们知道自己在这发过评论（有 rpid），但正文没取到 —— 兜底路径常见。
    // 这时候**必须**留一行，否则模型只看到楼中楼、压根不知道我们在说什么，
    // 接出来的话会前言不搭后语。宁可明说"没取到"，也别让它蒙在鼓里瞎接。
    lines.push({
      name: nick,
      text: '（我在这条视频下发过评论，但这次没取到正文）',
      self: true,
      master: false,
      root: true,
      missingText: true,
      rpid: String(root.rpid ?? ''),
      ctime: Number(root.ctime ?? 0),
    })
  }
  let relevant = floors ?? []
  if (target?.rpid) {
    const index = relevant.findIndex(f => String(f.rpid) === String(target.rpid))
    relevant = index >= 0 ? relevant.slice(0,index+1) : [...relevant,target]
  }
  for (const f of relevant) {
    const text = plain(f.text)
    if (!text) continue
    const mid = String(f.mid ?? '')
    lines.push({
      name: f.uname || '某位观众',
      text: clip(text),
      self: Boolean(self) && mid === self,
      master: Boolean(mid) && masterMids.has(mid),
      root: false,
      rpid: String(f.rpid ?? ''),
      ctime: Number(f.ctime ?? 0),
    })
  }
  // 根评论与目标留言都必须保留；后面的其他分支不能替换回复对象。
  const cap = Math.max(2,maxLines)
  const kept = lines.length > cap ? [lines[0], ...lines.slice(-(cap-1))] : lines
  const body = kept.map((l) => {
    const who = l.master ? `【主人】${l.name}` : l.self ? `${l.name}（我）` : l.name
    return `${who}：${l.text}`
  }).join('\n')
  const head = plain(title) ? `视频：《${plain(title).slice(0, 60)}》\n` : ''
  return { lines: kept, text: `${head}${body}` }
}

/** 让模型顺着整栋楼接一句 */
export async function composePatrolReply(cfg, { dialogue, master, target, maxChars = 80, llmChat = callLLM,ownVideo=false,mentioned=false,videoContext='',isActive=()=>true,lookup,readVideo,signal }) {
  const baseContext=(typeof dialogue==='string'?dialogue:String(dialogue?.text??''))+videoContext
  const command=await composeBiliCommand(cfg,{mid:target?.mid,text:target?.text,context:baseContext,channel:'comment',llmChat,isActive,lookup,readVideo,signal})
  if(command!==null)return command
  const context=baseContext+await bookContext(target?.text,{conversationKey:`bili:comment:${target?.mid||'unknown'}`,expression:!videoContext})
  const identity=biliIdentity(cfg,target?.mid)
  const r = await generateDirectReply(llmChat,cfg.llm, {
    replyConfig:cfg,replyLookup:lookup,replyIsActive:isActive,replyMaterial:videoContext,signal,
    styleTask:plain(target?.text),
    system: PATROL_REPLY_SYSTEM
      .replace('这条视频的 UP 主是你主人（{{master}}），而且底下这栋楼里已经有你（{{nick}}）发过的评论，所以你本来就在场。',mentioned?'对方在视频评论区@你，这是收到的真实提醒。结合下面实际取得的视频资料回应对方；没有字幕时只根据标题简介，不假称看过画面。':ownVideo?'这条视频是你（{{nick}}）自己的投稿，对方在视频下给你留言。':'这栋楼里已经有你（{{nick}}）发过的评论，所以你本来就在场。视频作者身份与当前留言者身份分开判断。')
      .replace('{{master}}', master?.name || '主人')
      .replace('{{nick}}', cfg.raw?.bili?.nick || cfg.chat?.nick || '我')
      .replace(/只输出 JSON，不要解释：[\s\S]*$/,'只输出回复正文，不要JSON、解释或思考过程。') + biliPersona(cfg) + biliIdentityPrompt(cfg,target?.mid),
    user: `${context}\n\n本次只回复这条留言（rpid=${target?.rpid ?? ''}，作者UID=${identity.uid||'未知'}，${identity.master?'已核验主人':'普通观众'}）：${target?.uname || target?.mid || '对方'}：「${plain(target?.text)}」。\n必须回应这条留言本身；只有 oi、在吗之类招呼时，简单打招呼，不要编造视频细节或对方观点。`,
    temperature: cfg.share?.patrolTemperature ?? 0.7,
    maxTokens: 160,
  })
  const v = parseJSON(r.content)
  return plain(v?.reply ?? v?.comment ?? '').slice(0, Math.max(1, maxChars))
}

/** 在一级评论里找我们自己发的那条（优先按记录的 rpid 精确匹配，其次按 mid） */
export function findOwnRoots(comments, { rpid = '', selfMid = '' } = {}) {
  const self = String(selfMid ?? '')
  const want = String(rpid ?? '')
  const out = []
  const seen = new Set()
  for (const c of comments ?? []) {
    if (!c?.rpid) continue
    const id = String(c.rpid)
    if (seen.has(id)) continue
    const hit = (want && id === want) || (self && String(c.mid ?? '') === self)
    if (!hit) continue
    seen.add(id)
    out.push(c)
  }
  return out
}

/**
 * 跑一轮巡检。
 * @returns {Promise<{sent:number, why:string, videos:number, dry:boolean, planned:string[]}>}
 */
export async function runPatrol(cfg,state,options={}) {
  fs.mkdirSync(DATA,{recursive:true})
  const lock=path.join(DATA,'bili-patrol.lock')
  let handle
  try{handle=fs.openSync(lock,'wx');fs.writeFileSync(handle,String(process.pid))}catch(e){
    if(e.code!=='EEXIST')throw e
    try{const pid=Number(fs.readFileSync(lock,'utf8'));try{process.kill(pid,0)}catch(err){if(err.code==='ESRCH')fs.unlinkSync(lock)}}catch{}
    return {sent:0,why:'已有评论巡检在执行，本轮不重复访问',videos:0,planned:[],retryAfterMs:0}
  }
  try{return await runPatrolUnlocked(cfg,state,options)}finally{fs.closeSync(handle);fs.unlinkSync(lock)}
}

async function runPatrolUnlocked(cfg, state, {
  dry = false, logger = log, maxVideos,
  // 下面几个是「注入点」：离线测试用它们替掉真实的 B 站/模型调用，
  // 线上跑时不传，走默认实现。别在别处另写一个 runPatrol 的副本。
  listComments = listRecentComments,
  listReplies = listReplyReplies,
  compose = composePatrolReply,
  send = addComment,
  info = videoInfo,
  // ⚠ 落盘也是注入点。以前写死 import 的 saveState，测试跑一次就把 mkState() 的假数据
  //   （aid=170001 / rpid=R1）写进生产 .data/state.json，巡检拿着假 aid 去翻别人的视频，
  //   主人在我们评论底下回的话一条都回不了。测试必须传只写内存的桩。
  save = saveState,
  isActive = ()=>true,
  onlyVideos = null,
} = {}) {
  const empty = { sent: 0, why: '', videos: 0, dry: Boolean(dry), planned: [] }
  const cooldown = state.commentPatrolCooldown
  if (Number(cooldown?.until) > Date.now()) return { ...empty, why: `评论接口冷却中，至 ${new Date(cooldown.until).toLocaleTimeString()}`, retryAfterMs: cooldown.until - Date.now() }
  if (!hasLLM(cfg.llm)) return { ...empty, why: '模型未配置' }

  const perVideo = Math.max(0, num(cfg.share?.masterReplyPerVideo, 2))
  if (!perVideo) return { ...empty, why: 'share.masterReplyPerVideo 设成 0 了，巡检不回' }

  const selfMid = String(cfg.raw?.bili?.dedeUserId ?? '')
  if (!selfMid) return { ...empty, why: '没填 bili.dedeUserId，认不出哪条是自己发的' }

  const withinDays = num(cfg.share?.replyPatrolWithinDays, 7)
  const pages = 1 // 每次只读一页，避免深翻评论区
  const allTargets = patrolVideos(cfg, state, { maxVideos }).filter(v=>Number(state.commentPatrolClosed?.[v.bvid] ?? 0)<Date.now()&&(!onlyVideos||onlyVideos.includes(v.bvid)))
  const cursor = Number(state.commentPatrolCursor ?? 0) % Math.max(1,allTargets.length)
  let targets = [...allTargets.slice(cursor),...allTargets.slice(0,cursor)].slice(0,Math.min(2,maxVideos ?? 2))
  const focusSet=new Set((cfg.share?.replyFocusVideos??[]).map(bvidOf))
  const focus=allTargets.filter(v=>focusSet.has(v.bvid)),background=allTargets.filter(v=>!focusSet.has(v.bvid))
  if(focus.length){
    const fc=Number(state.commentPatrolFocusCursor??0)%focus.length,bc=Number(state.commentPatrolBackgroundCursor??0)%Math.max(1,background.length)
    targets=[focus[fc],background[bc]??focus[(fc+1)%focus.length]].filter((v,i,a)=>a.findIndex(x=>x.bvid===v.bvid)===i).slice(0,Math.min(2,maxVideos??2))
    if(!dry){state.commentPatrolFocusCursor=(fc+1)%focus.length;state.commentPatrolBackgroundCursor=(bc+1)%Math.max(1,background.length)}
  }
  if (targets.length && !dry) {state.commentPatrolCursor = (cursor+targets.length)%allTargets.length; save(state)}
  if (!targets.length) return { ...empty, why: '没有要巡检的视频（没发过评论，replyWatchVideos 也是空的）' }

  const planned = []
  const notes = []
  let sent = 0
  let rootsRead=0,floorsRead=0,pendingFloors=0
  let stopAll = false
  let retryAfterMs = 0
  const stopOnRisk = (error) => {
    if (!isCommentRisk(error)) return false
    stopAll = true
    retryAfterMs = Math.max(retryAfterMs, Number(error?.retryAfterMs) || 0, Math.min(2 * 60 * 60_000, 15 * 60_000 * 2 ** Math.min(3, Number(cooldown?.strikes) || 0)))
    return true
  }

  for (const v of targets) {
    if (stopAll||!isActive()) break

    // 新增自己的投稿入口；元信息存独立watch表，不伪造“机器人发过根评论”。
    if(cfg.share?.ownVideoReplies&&(!state.commented?.[v.bvid]||state.commentWatchVideos?.[v.bvid]?.ownerMid===selfMid)) {
      try {
        let meta=state.commentWatchVideos?.[v.bvid]
        if(!meta){const got=await info(v.bvid,cfg);meta={bvid:v.bvid,aid:String(got.aid),ownerMid:String(got.ownerMid??''),title:got.title??''};if(!dry){state.commentWatchVideos??={};state.commentWatchVideos[v.bvid]=meta;save(state)}}
        if(meta.ownerMid===selfMid){
          const result=await runOwnVideoReplies(cfg,state,meta,{dry,listComments,listReplies,compose,send,save,logger,isActive})
          sent+=result.sent;planned.push(...(result.planned??[]));if(result.why)notes.push(result.why)
          continue
        }
      }catch(e){notes.push(`${v.bvid} 自己的投稿接话失败：${e.message}`);if(stopOnRisk(e))break;continue}
    }

    // aid：B 站所有评论接口都要 aid，BV 号不行。state 里没存就现查一次。
    let aid = String(state?.commented?.[v.bvid]?.aid ?? '')
    let title = String(state?.commented?.[v.bvid]?.title ?? '')

    // 改内存 / 落盘分开：预演（dry）允许在内存里纠正，但**一个字节都不许写到磁盘**。
    // 「预演」有副作用就不是预演了——以前 :237 那段无论 dry 与否都 saveState。
    const remember = (patch) => {
      state.commented ??= {}
      state.commented[v.bvid] = { ...(state.commented[v.bvid] ?? {}), ...patch }
    }
    const persist = () => { if (!dry) save(state) }

    if (!/^\d+$/.test(aid)) {
      try {
        const got = await info(v.bvid, cfg)
        aid = String(got?.aid ?? '')
        title = String(got?.title ?? title)
        remember({ aid, ...(title ? { title } : {}) })
        persist()
      } catch (e) {
        notes.push(`${v.bvid} 查 aid 失败：${e.message}`)
        continue
      }
    }
    if (!/^\d+$/.test(aid)) { notes.push(`${v.bvid} 没有 aid`); continue }

    // 作者不自动成为机器人主人；只有配置的B站UID拥有主人身份。
    const ownerMid = String(v.mid ?? state?.commented?.[v.bvid]?.mid ?? '')
    const masterMids = [...new Set([
      ...(cfg.masters ?? []).map((m) => String(m.mid ?? '')),
    ].filter(Boolean))]
    const master = (cfg.masters ?? []).find((m) => String(m.mid ?? '') === ownerMid) ?? cfg.masters?.[0] ?? null
    const quotaMid = ownerMid || String(master?.mid ?? '')
    const nick = cfg.raw?.bili?.nick || cfg.chat?.nick || '我'

    /** 读一级评论；失败时把风控往上抛给调用方决定要不要停手 */
    const readComments = async (useAid) => {
      try {
        return await listComments(cfg, { bvid: v.bvid, aid: useAid, ps: 20, pages })
      } catch (e) {
        notes.push(`${v.bvid} 读评论区失败：${e.message}`)
        if (e.commentClosed) {state.commentPatrolClosed ??= {};state.commentPatrolClosed[v.bvid]=Date.now()+86400000;if(!dry)save(state)}
        stopOnRisk(e)
        return null
      }
    }

    const hasRpid = /^\d{6,}$/.test(String(v.rpid ?? ''))
    // 已保存根评论 ID 时直读楼中楼，省掉每次扫整个视频评论区。
    let comments = hasRpid ? [] : await readComments(aid)
    if (comments === null) { if (stopAll) break; continue }

    let roots = findOwnRoots(comments, { rpid: v.rpid, selfMid })
    let usedFallback = false
    let healed = false

    /**
     * aid 自愈：记错的 aid 只要是「合法数字」（比如被测试写成 170001），
     * 旧的 `!/^\d+$/.test(aid)` 就永远放行 —— 接口正常返回**别人的视频**的评论，
     * 于是"找不到自己那条"然后永久哑掉。所以扫不到时必须怀疑 aid，重新查一次并纠正。
     * @returns {Promise<boolean>} aid 真的被纠正了才返回 true
     */
    const healAid = async () => {
      let fixed = null
      try { fixed = await info(v.bvid, cfg) } catch (e) { notes.push(`${v.bvid} 复核 aid 失败：${e.message}`); return false }
      const freshAid = String(fixed?.aid ?? '')
      if (!/^\d+$/.test(freshAid) || freshAid === aid) return false
      aid = freshAid
      title = String(fixed?.title ?? title)
      remember({ aid, ...(title ? { title } : {}) })
      persist()
      healed = true
      logger(`  [巡检·自愈] ${v.bvid} 记录的 aid 是错的，已纠正为 ${aid}`)
      const again = await readComments(aid)
      if (again === null) return false
      comments = again
      return true
    }

    // ── ① rpid 兜底优先（别先去复核 aid） ──────────────────────
    // 顺序不能反：评论被挤出 pages 页时 aid 本来就是对的，先复核就是纯浪费
    // （QA 实测：3 条视频 × 每 30 分钟 = 一天白打 144 次 videoInfo）。
    // 记着 rpid 就直接按 root 读那栋楼 —— 楼中楼接口不需要它出现在前几页。
    if (!roots.length && hasRpid) {
      roots = [{
        rpid: String(v.rpid), root: String(v.rpid), parent: String(v.rpid),
        mid: selfMid, uname: nick,
        // 根评论正文：share.mjs 发评论时存过。没有的话对话链里就缺我们自己那句，
        // 模型只看到楼中楼、不知道我们在说什么，回复质量会掉。
        text: String(state?.commented?.[v.bvid]?.text ?? ''),
        ctime: Number(state?.commented?.[v.bvid]?.ctime ?? 0),
        count: 1, // 兜底路径不知道这栋楼有几层，只能先拉一次再看
      }]
      usedFallback = true
      logger(`  [巡检·兜底] ${v.bvid} 按记下的 rpid ${v.rpid} 直接读这栋楼`)
    }

    // ── ② 连 rpid 都没有（没法兜底）才去怀疑 aid 记错了 ──────────
    if (!roots.length && !hasRpid) {
      if (await healAid()) roots = findOwnRoots(comments, { rpid: v.rpid, selfMid })
    }

    if (stopAll) break
    if (!roots.length) {
      notes.push(`${v.bvid} 前 ${pages} 页里没找到自己发的评论`)
      continue
    }

    // 顺手把真实的 rpid 记回来：靠 mid 认出来的那条，下次就不用再扫全页了
    if (!usedFallback && String(roots[0].rpid) !== String(v.rpid)) {
      remember({ rpid: String(roots[0].rpid) })
      persist()
    }

    for (const root of roots) {
      if (stopAll) break
      // 一栋楼里没人回过就别去拉楼中楼了，省一次请求也省风控
      if (Number(root.count ?? 0) === 0) continue

      const readFloors = () => listReplies(cfg, { bvid: v.bvid, aid, root: root.rpid, ps: 20, pages })

      let floors = []
      try {
        floors = await readFloors()
      } catch (e) {
        let err = e
        if(e.commentClosed){state.commentPatrolClosed??={};state.commentPatrolClosed[v.bvid]=Date.now()+86400000;if(!dry)save(state);notes.push(`${v.bvid} 评论区关闭，暂停该视频24小时`);break}
        if (stopOnRisk(e)) { notes.push(`${v.bvid} 读楼中楼失败：${e.message}`); break }
        // 兜底路径读不到楼中楼，最大嫌疑是 aid 记错了（oid 不对，rpid 再对也查不到）。
        // 纠正一次再试，别让「rpid 有、aid 错」这种组合永久哑掉。
        if (usedFallback && !healed && await healAid()) {
          try { floors = await readFloors(); err = null } catch (e2) { err = e2 }
        }
        if (err) {
          notes.push(`${v.bvid} 读楼中楼失败：${err.message}`)
          if (stopOnRisk(err)) break
          continue
        }
      }

      let picked = pickReplyFloors(cfg, state, { floors, masters: masterMids, selfMid, withinDays })
      rootsRead++;floorsRead+=floors.length
      if (!picked.length) continue

      // 兜底路径**真发之前**必须确认 aid 是对的：
      // oid 错了的话 send() 会把这条回复挂到**别人的视频**上，比不回更糟。
      // 放在这里（而不是每次都复核）是因为只有真要说话时才值得花这一次 videoInfo ——
      // 没人回的楼（N1 那种最常见的情况）走到上面就 continue 了，一次都不打。
      if (usedFallback && !healed && await healAid()) {
        if (stopAll) break
        try { floors = await readFloors() } catch (e) {
          notes.push(`${v.bvid} 读楼中楼失败：${e.message}`)
          if (stopOnRisk(e)) break
          continue
        }
        picked = pickReplyFloors(cfg, state, { floors, masters: masterMids, selfMid, withinDays })
        if (!picked.length) continue
      }

      if (stopAll) break
      pendingFloors+=picked.length
      let sentHere = 0
      for (const f of picked) {
        if (sentHere >= perVideo) break

        // 对面是主人/管理员 ⇒ 不占每天的额度线（quota 内部放行，但仍计数）
        const q = quotaOf(cfg, state, quotaMid, 'reply', { master: Boolean(f.master) })
        if (!q.ok) { notes.push(q.why); break }

        const dialogue = buildDialogue({
          rootComment: { rpid: root.rpid, text: root.text, ctime: root.ctime },
          floors,
          selfMid,
          masters: masterMids,
          title,
          nick,
          target:f,
        })

        let text = ''
        try {
          text = await compose(cfg, { dialogue, master:(cfg.masters ?? []).find(m => String(m.mid) === f.mid) ?? master, target:f,isActive })
        } catch (e) {
          notes.push(`写回复失败：${e.message}`)
          break
        }
        if (!text) { notes.push('模型没写出回复'); continue }

        if (dry) {
          // 预演不写 state.replied，下次还能看到它想回什么
          planned.push(`${v.bvid} → ${f.uname || f.mid}：「${plain(f.text).slice(0, 20)}」→「${text}」`)
          sentHere++
          logger(`  [预演·巡检] ${v.bvid} 回 ${f.uname || f.mid}：${text}`)
          continue
        }

        try {
          await waitGap(cfg, state)
          if(!isActive())break
          const r = await send(cfg, { bvid: v.bvid, aid, text, root: String(root.rpid), parent: String(f.rpid),isActive })
          state.replied ??= {}
          state.replied[f.rpid] = {
            at: new Date().toISOString(),
            rpid: r.rpid,
            bvid: v.bvid,
            root: String(root.rpid),
            mid: String(quotaMid),
            to: f.uname,
            quote: plain(f.text).slice(0, 80),
            text,
            patrol: true,
          }
          noteComment(cfg, state, quotaMid, 'reply')
          noteWrite(state)
          save(state) // 走注入点，测试里是只写内存的桩
          sent++
          sentHere++
          logger(`  巡检回 ${f.uname || f.mid}（${v.bvid}）：「${plain(f.text).slice(0, 20)}」→「${text}」`)
        } catch (e) {
          notes.push(`发回复失败：${e.message}`)
          if(e.commentClosed){state.commentPatrolClosed??={};state.commentPatrolClosed[v.bvid]=Date.now()+86400000;if(!dry)save(state);break}
          if (stopOnRisk(e)) break
        }
      }
    }
  }

  if (stopAll) {
    state.commentPatrolCooldown = { until: Date.now() + retryAfterMs, strikes: Math.min(4, (Number(cooldown?.strikes) || 0) + 1) }
    if (!dry) save(state)
  } else if (cooldown) {
    delete state.commentPatrolCooldown
    if (!dry) save(state)
  }
  const why=notes.join('；')||(!sent&&!planned.length?`本轮检查${targets.length}条视频、${rootsRead}个评论楼，读到${floorsRead}条楼中楼，未发现新的待回复留言`:'')
  return { sent, why, videos: targets.length, rootsRead, floorsRead, pendingFloors, dry: Boolean(dry), planned, retryAfterMs }
}

// Stop the entire patrol on a blocked comment response.
// Patrol generation consumes dialogue.text and reports when tracked threads have no new replies.
// Bilibili conversation integration: shared gentle policy and persistent reply tracking.
