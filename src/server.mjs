#!/usr/bin/env node
import {createCosyVoice,cosyReady} from './cosyvoice.mjs'
import {createGptSovits,localVoiceReady,localVoiceEndpoint} from './gpt-sovits.mjs'
import {localVoiceOnline,startLocalVoice} from './local-voice-host.mjs'
import {randomUUID} from 'node:crypto'
import {hourlyScrollSummary} from './hourly-scroll.mjs'
import { createDiaryService } from './diary.mjs'
import { createDiaryScheduler } from './diary-auto.mjs'
import { createDiaryPublisher } from './diary-publish.mjs'
import { createStickerStore } from './qq-stickers.mjs'
import { biliFetch, biliPolicy } from './bili-policy.mjs'
/**
 * 本地 WebUI 控制台。
 *
 *   node src/server.mjs         → http://127.0.0.1:7788
 *
 * 只绑 127.0.0.1。这是单人本地工具，不做登录，也绝对不要绑 0.0.0.0 放公网，
 * 否则任何人打开这个页面都能用你的 B 站账号发评论。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, DATA, CONFIG_FILE, buildConfig, readRawConfig, writeRawConfig, loadState, saveState, ensureData, masterOf } from './config.mjs'
import { collect, toPromptText } from './collect.mjs'
import { chat, parseJSON, hasLLM } from './llm.mjs'
import { sendGroup, buildShareMessage, ping } from './qq.mjs'
import { SYSTEM, MASTER_SYSTEM } from './prompt.mjs'
import { check } from './guard.mjs'
import { addComment, verifyComment } from './bili-comment.mjs'
import { quotaSummary } from './quota.mjs'
import { DEFAULT_SHIELD } from './shield.mjs'
import { ensureSnowLuma, portPid } from './snowluma.mjs'
import { createAgentHost } from './agent-host.mjs'
import { createSettingsStore } from './settings.mjs'
import { fields as settingFields } from '../public/settings-schema.js'
import { createDshLink } from './dsh-link.mjs'
import { buildOverview } from './overview.mjs'
import { readJsonlTail } from './chat-diagnostics.mjs'

// 版本太旧时 prompt 级别的报错很晦涩（比如 import.meta.dirname 不存在），
// 不如在入口就把话说清楚
const NODE_MAJOR = Number(process.versions.node.split('.')[0])
if (NODE_MAJOR < 20) {
  console.error(`\n  Node ${process.versions.node} 太旧了，本项目要 >= 20.11（推荐 22/24）。`)
  console.error('  CLion: Settings → Languages & Frameworks → Node.js 换一个解释器\n')
  process.exit(1)
}

const argvPort = (() => {
  const i = process.argv.indexOf('--port')
  return i > -1 && process.argv[i + 1] ? Number(process.argv[i + 1]) : undefined
})()
let PORT = Number(process.env.PORT ?? argvPort ?? 7788)
const HOST = '127.0.0.1'
const PUBLIC = path.join(ROOT, 'public')
const HISTORY = path.join(DATA, 'history')
const settingsStore = createSettingsStore({ configFile: CONFIG_FILE, overlayFile: path.join(DATA, 'whale-ui.json'), backupDir: path.join(DATA, 'settings-backups') })
const dshLink = createDshLink({dataDir:DATA})
const diaryService = createDiaryService()
const diaryScheduler = createDiaryScheduler({service:diaryService})
const diaryPublisher=createDiaryPublisher()
process.on('exit',()=>diaryPublisher.stop())
const stickerStore=createStickerStore()
// 旧人设页与扫码/连接抽屉也走同一保存口径，避免它们留下过期 DSH 覆盖层。
function saveSettingsConfig(raw) {
  const before = readRawConfig(), patch = {}
  const get = (obj, key) => key.split('.').reduce((v,k) => v?.[k],obj)
  for (const f of settingFields) {
    if (f.path.startsWith('runtime.')) continue
    const value = get(raw,f.path)
    if (value !== undefined && JSON.stringify(value) !== JSON.stringify(get(before,f.path))) patch[f.path] = value
  }
  return settingsStore.save({ revision: settingsStore.snapshot().revision, patch })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
}

const cfg = () => buildConfig(readRawConfig())

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// 控制台带起群聊进程：少起一个就「连上了但没人回话」，这边统一管
const NO_AGENT = process.argv.includes('--no-agent')
const parentIndex=process.argv.indexOf('--parent-pid')
const managedParent=parentIndex>=0?Number(process.argv[parentIndex+1]):0
if (Number.isInteger(managedParent) && managedParent>0) {
  const parentWatch=setInterval(()=>{
    try{process.kill(managedParent,0)}catch(e){if(e.code==='ESRCH')process.exit(0)}
  },2000)
  parentWatch.unref()
}
const agentHost = createAgentHost({
  cwd: ROOT,
  entry: 'src/agent.mjs',
  heartbeatFile: path.join(DATA, 'agent.json'),
  onLine: (line) => console.log(line),
})
// 控制台一退出，子进程也一起收，别留下孤儿下次撞锁
process.on('exit', () => agentHost.dispose())
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { agentHost.dispose(); process.exit(0) })
}

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function readBody(req,limit=2*1024*1024) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (c) => {
      s += c
      if (s.length > limit) {reject(new Error('请求体太大'));req.destroy()}
    })
    req.on('end', () => {
      if (!s) return resolve({})
      try { resolve(JSON.parse(s)) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

function saveHistory(bvid, material, result) {
  fs.mkdirSync(HISTORY, { recursive: true })
  const f = path.join(HISTORY, `${bvid}.json`)
  let prev = {}
  if (fs.existsSync(f)) {
    try { prev = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* 覆盖 */ }
  }
  const rec = {
    ...prev,
    bvid,
    aid: material?.video?.aid ?? prev.aid,
    title: material?.video?.title ?? prev.title,
    owner: material?.video?.owner ?? prev.owner,
    cover: material?.video?.pic ?? prev.cover,
    duration: material?.video?.duration ?? prev.duration,
    stats: material?.video?.stat ?? prev.stats,
    collectedAt: new Date().toISOString(),
    counts: material
      ? { subtitle: material.subtitle?.lines?.length ?? 0, danmaku: material.danmaku?.total ?? 0, comments: material.comments?.length ?? 0 }
      : prev.counts,
    ...(result ? { result, composedAt: new Date().toISOString() } : {}),
  }
  fs.writeFileSync(f, JSON.stringify(rec, null, 2), 'utf8')
  return rec
}

function listHistory() {
  if (!fs.existsSync(HISTORY)) return []
  return fs.readdirSync(HISTORY)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(HISTORY, f), 'utf8')) } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.collectedAt).localeCompare(String(a.collectedAt)))
    .slice(0, 40)
}

const synthesizeVoice=createCosyVoice()
const synthesizeLocalVoice=createGptSovits()
let voicePreviewBusy=false
const routes = {
  async 'GET /api/voice/status'(){
    const c=cfg(),v=c.chat?.voice??{},local=v.provider==='gpt-sovits';let online=null
    if(local)online=await localVoiceOnline(c)
    return {provider:v.provider||'qq-native',configured:local?localVoiceReady(c):cosyReady(c),online,model:local?'gpt-sovits':v.model||'cosyvoice-v3.5-flash',voiceId:local?'':v.voiceId||'',region:local?null:v.region||'beijing',volume:v.volume??50,localNormalizeLoudness:v.localNormalizeLoudness===true,localGainDb:v.localGainDb??0}
  },
  async 'POST /api/voice/local/start'(){return startLocalVoice(cfg())},
  async 'POST /api/voice/preview'(body){
    if(voicePreviewBusy)throw Error('已有音频试听正在生成，请稍候')
    voicePreviewBusy=true
    try{
      const dsh=await dshLink.read()
      if(dsh?.status?.running){
        if(dsh.status.chat?.qqVoice?.senderRevision!==2)throw Error('请先重新加载DSH语音模块，使试听与实际发送使用同一条链路')
        const r=await fetch(dsh.base+'/api/whale/voice/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:body.text||'本仙在此，你有什么想说的，尽管道来。'}),signal:AbortSignal.timeout(610000)})
        const preview=await r.json();if(!r.ok)throw Error(preview.error||'DSH语音试听失败');return preview
      }
      const c=cfg(),provider=c.chat?.voice?.provider||'qq-native'
      if(provider==='qq-native')throw Error('QQ原生语音不能在本地试听，请选择CosyVoice或本地GPT-SoVITS')
      const audio=await (provider==='gpt-sovits'?synthesizeLocalVoice:synthesizeVoice)(body.text||'本仙在此，你有什么想说的，尽管道来。',c)
      const dir=path.join(DATA,'voice-preview');fs.mkdirSync(dir,{recursive:true})
      const id=randomUUID();fs.writeFileSync(path.join(dir,id+'.wav'),audio.bytes,{flag:'wx'})
      const files=fs.readdirSync(dir).filter(f=>/^[a-f0-9-]{36}\.wav$/.test(f)).map(f=>({f,mtime:fs.statSync(path.join(dir,f)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime)
      for(const entry of files.slice(5))fs.unlinkSync(path.join(dir,entry.f))
      return {ok:true,url:'/api/voice/preview?id='+id,provider,characters:audio.characters,bytes:audio.bytes.length,loudness:audio.loudness}
    }finally{voicePreviewBusy=false}
  },
  async 'GET /api/overview'() {
    const [dsh,policy]=await Promise.all([dshLink.read(),biliPolicy.status()])
    let lines=[]
    try {lines=fs.readFileSync(path.join(DATA,'dsh-plugin.log'),'utf8').slice(-64000).split(/\r?\n/).filter(line=>/巡检|刷B站|已分享|风控|收摊|起来了|QQ 通道/.test(line))}catch{}
    return {...buildOverview({cfg:cfg(),state:loadState(),policy,dsh,agent:agentHost.status(),heartbeat:dshLink.heartbeat(),activity:lines,hourlyScroll:hourlyScrollSummary(undefined,cfg())}),revision:settingsStore.snapshot(dsh).revision}
  },
  async 'GET /api/diary'() { return {ok:true,job:diaryService.status(),automation:diaryScheduler.status(),publishing:diaryPublisher.status()} },
  async 'GET /api/stickers'() {return stickerStore.snapshot()},
  async 'POST /api/stickers'(body) {return stickerStore.save(body)},
  async 'POST /api/diary'(body) { return diaryService.start({...(body.day?{day:body.day}:{})}) },
  async 'GET /api/settings'() { return settingsStore.snapshot(await dshLink.read()) },
  async 'GET /api/bili/diagnostics'() {
    const c=cfg(), state=loadState()
    const read=(name,fallback)=>{try{return fs.readFileSync(path.join(DATA,name),'utf8')}catch{return fallback}}
    let lastRun=null
    let privateState={}
    try{privateState=JSON.parse(read('bili-private.json','{}'))}catch{}
    try {lastRun=JSON.parse(read('scroll-state.json','null'))}catch{}
    return {
      dshRunning:Boolean(dshLink.heartbeat()),
      hasCookie:Boolean(c.cookie?.sessdata && c.cookie?.bili_jct),
      topics:c.scroll?.tags ?? [],keywords:c.scroll?.keywords ?? [],
      deliveryMode:c.scroll?.deliveryMode ?? 'private',syncGroups:c.scroll?.syncGroups !== false,
      privateUsers:c.scroll?.privateUsers?.length ? c.scroll.privateUsers : c.chat?.admins ?? [],
      biliPrivatePushEnabled:c.scroll?.biliPrivateEnabled===true,biliPrivatePushUsers:c.scroll?.biliPrivateUsers?.length?c.scroll.biliPrivateUsers:c.biliInbox?.privateUsers?.length?c.biliInbox.privateUsers:(c.masters??[]).map(m=>String(m.mid)),
      syncGroupIds:c.scroll?.groupIds?.length ? c.scroll.groupIds : c.qq?.groupIds ?? [],
      quota:quotaSummary(c,state),lastRun,
      hourlyScroll:hourlyScrollSummary(undefined,c),hourlyReactionEnabled:c.scroll?.hourlyReactionEnabled===true,reactionKeywords:c.scroll?.reactionKeywords??['?','？','妈妈'],
      research:{priorityWikis:c.chat?.search?.priorityWikis??['fgo.wiki','prts.wiki','wiki.biligame.com/sr','wiki.biligame.com/ys'],crossCheck:c.chat?.search?.crossCheck!==false,engines:c.chat?.search?.engines??['bing','duckduckgo','brave'],youtube:c.chat?.search?.youtube!==false,sourceURLsInAnswers:false},
      conversations:{privateEnabled:Boolean(c.biliInbox?.enabled),privateUsers:c.biliInbox?.privateUsers??[],privateLastPollAt:privateState.lastPollAt??0,privateSent:Object.values(privateState.peers??{}).reduce((n,r)=>n+(r.sent??0),0),privateUncertain:Object.values(privateState.peers??{}).filter(r=>r.pending).length,ownVideoReplies:Boolean(c.share?.ownVideoReplies),focusVideos:c.share?.replyFocusVideos??[]},
      trackedVideos:Object.keys(state.commented ?? {}).length,
      repliedFloors:Object.keys(state.replied ?? {}).length,
      report:read('scroll-report.md','暂无日报'),
      log:read('dsh-plugin.log','').split('\n').filter(line=>/巡检|刷B站|搜索|候选|取 UP|判断.*失败|处理 .*出错/.test(line)).slice(-25).join('\n'),
    }
  },
  async 'POST /api/settings'(body) { return settingsStore.save(body) },
  async 'GET /api/status'() {
    const c = cfg()
    const s = loadState()
    const raw = readRawConfig()
    // 密钥永不回传，只给一个能确认"确实是刚存的那把"的掩码
    const k = c.llm.apiKey || ''
    const keyMask = !k ? '' : k.length <= 8 ? '••••' : `${k.slice(0, 3)}…${k.slice(-4)}`
    return {
      app: 'bili-whale-qq',
      configFile: CONFIG_FILE,
      today: s.day,
      used: s.sharedToday ?? 0,
      max: c.guard?.maxSharePerDay ?? 3,
      cooldownDays: c.guard?.sameVideoCooldownDays ?? 7,
      minScore: c.guard?.minScore ?? 13,
      hasCookie: Boolean(c.cookie.sessdata && c.cookie.bili_jct),
      hasLLM: hasLLM(c.llm),
      provider: c.llm.provider,
      model: c.llm.model,
      onebot: c.qq?.onebotHttp ?? '',
      groups: c.qq?.groupIds ?? [],
      whale: Boolean(c.whale?.dir),
      masters: c.masters ?? [],
      biliQuota: quotaSummary(c, s),
      // 给前端回显用：密钥永远不出后端，只告诉它"有没有"
      raw: {
        llm: { provider: raw.llm?.provider, baseUrl: raw.llm?.baseUrl, model: raw.llm?.model, temperature: raw.llm?.temperature, apiKeyMask: keyMask },
        qq: { onebotHttp: raw.qq?.onebotHttp, groupIds: raw.qq?.groupIds, accessToken: raw.qq?.accessToken ? 'set' : '', atAll: raw.qq?.atAll },
        chat: { admins: raw.chat?.admins ?? [], nick: raw.chat?.nick ?? '', minGapSec: raw.chat?.minGapSec, maxPerHour: raw.chat?.maxPerHour },
        guard: raw.guard ?? {},
        whale: { dir: raw.whale?.dir ?? '', ffmpeg: raw.whale?.ffmpeg ?? '' },
        bili: { hasSessdata: Boolean(c.cookie.sessdata), hasBiliJct: Boolean(c.cookie.bili_jct), hasBuvid3: Boolean(c.cookie.buvid3), mid: raw.bili?.dedeUserId ?? '' },
        share: {
          maxPerDay: c.share?.maxPerDay ?? c.guard?.maxSharePerDay ?? 2,
          randomPick: c.share?.randomPick !== false,
          biliCommentPerDay: c.share?.biliCommentPerDay ?? 6,
          pluginReservePerDay: c.share?.pluginReservePerDay ?? 0,
          masterCommentPerDay: c.share?.masterCommentPerDay ?? 1,
          masterReplyPerDay: c.share?.masterReplyPerDay ?? 3,
          masterReplyPerVideo: c.share?.masterReplyPerVideo ?? 2,
          masterReplyWithinDays: c.share?.masterReplyWithinDays ?? 3,
          biliGapSec: c.share?.biliGapSec ?? 25,
          masterMaxAgeDays: c.share?.masterMaxAgeDays ?? 30,
        },
      },
    }
  },

  /** 群聊进程：控制台把它当子进程带着，页面上看状态、看输出、能启停 */
  async 'GET /api/agent'() {
    const dsh = await dshLink.read()
    if (dsh) return { ...agentHost.status(), running:false, external:{pid:dsh.pid}, source:'dsh', tail:dsh.status.logTail?.split('\n') ?? [] }
    return agentHost.status()
  },

  async 'POST /api/agent/start'() {
    const hb = dshLink.heartbeat()
    if (hb) return {ok:true,started:false,source:'dsh',pid:hb.pid}
    const r = agentHost.start({ reason: 'manual' })
    if (!r.ok && r.why === 'external') {
      throw new Error(`别处已经有一个 agent 在跑了（pid ${r.pid}），先去那边停掉，或用这里的停止后再启动`)
    }
    return { ok: true, ...r }
  },

  async 'POST /api/agent/stop'() {
    return { ok: true, ...agentHost.stop() }
  },

  async 'POST /api/config'(body) {
    const raw = readRawConfig()
    const keep = (v) => v === '' || v === undefined ? undefined : v

    if (body.bili) {
      raw.bili = raw.bili ?? {}
      for (const k of ['sessdata', 'bili_jct', 'buvid3']) {
        const v = keep(body.bili[k])
        if (v !== undefined) raw.bili[k] = v
      }
    }
    if (body.llm) {
      // 逐字段合并。整对象展开会把前端没初始化的空值（provider=""、temperature=NaN）
      // 直接盖到配置上，之前就因此把 key 配好后又变回 provider=none。
      const l = body.llm
      if (['deepseek', 'openai', 'workbuddy', 'none'].includes(l.provider)) raw.llm.provider = l.provider
      if (l.baseUrl) raw.llm.baseUrl = l.baseUrl
      if (l.model) raw.llm.model = l.model
      const t = Number(l.temperature)
      if (Number.isFinite(t) && t >= 0 && t <= 2) raw.llm.temperature = t
      const k = keep(l.apiKey)
      if (k !== undefined) raw.llm.apiKey = k
    }
    if (body.qq) {
      const q = body.qq
      if (q.onebotHttp) raw.qq.onebotHttp = q.onebotHttp
      if (q.wsUrl) raw.qq.wsUrl = q.wsUrl
      if (Array.isArray(q.groupIds)) raw.qq.groupIds = q.groupIds
      if (typeof q.sendCard === 'boolean') raw.qq.sendCard = q.sendCard
      if (typeof q.atAll === 'boolean') raw.qq.atAll = q.atAll
      const t = keep(q.accessToken)
      if (t !== undefined) raw.qq.accessToken = t
      const w = keep(q.wsToken)
      if (w !== undefined) raw.qq.wsToken = w
    }
    if (body.chat) raw.chat = { ...raw.chat, ...body.chat }
    if (body.share) {
      const s = body.share
      raw.share = raw.share ?? {}
      for (const [k, v] of Object.entries(s)) {
        if (v === undefined || v === null || v === '') continue
        if (typeof v === 'number' || typeof v === 'boolean') raw.share[k] = v
      }
    }
    // 主人开关：只改已有名单里的字段，不接受通过这个入口新增/删除 UP
    if (Array.isArray(body.masters)) {
      raw.bili = raw.bili ?? {}
      const list = Array.isArray(raw.bili.masters) ? raw.bili.masters : []
      for (const p of body.masters) {
        const hit = list.find((m) => m && typeof m === 'object' && String(m.mid) === String(p?.mid))
        if (!hit) continue
        if (typeof p.replyComments === 'boolean') hit.replyComments = p.replyComments
        if (typeof p.autoComment === 'boolean') hit.autoComment = p.autoComment
      }
      raw.bili.masters = list
    }
    if (body.guard) raw.guard = { ...raw.guard, ...body.guard }
    if (body.whale) raw.whale = { ...raw.whale, ...body.whale }

    // 群号只在设置页维护一处（qq.groupIds）。同步写给 chat.groups，
    // 免得两处不一致时新加的群被老白名单静默过滤掉。
    if (Array.isArray(body.qq?.groupIds)) raw.chat.groups = [...body.qq.groupIds]

    saveSettingsConfig(raw)

    // 回执：不再让前端"猜"存没存上。这里把写盘后的真实状态原样返回，
    // 顺便记一行日志，方便下次排查"我明明填了却没变"。
    const after = readRawConfig()
    const key = after.llm?.apiKey ?? ''
    const mask = !key ? '' : key.length <= 8 ? '••••' : `${key.slice(0, 3)}…${key.slice(-4)}`
    const gotKey = typeof body.llm?.apiKey === 'string' ? body.llm.apiKey.trim() : ''
    try {
      ensureData()
      fs.appendFileSync(
        path.join(DATA, 'config-save.log'),
        `${new Date().toISOString()} 收到key长度=${gotKey.length} 写盘后尾号=${key.slice(-4)} 文件=${CONFIG_FILE}\n`,
      )
    } catch { /* 日志写不了不影响保存 */ }
    return {
      ok: true,
      configFile: CONFIG_FILE,
      received: { apiKeyLen: gotKey.length },
      saved: { apiKeyMask: mask, hasLLM: hasLLM(buildConfig(after).llm), provider: after.llm?.provider, model: after.llm?.model },
    }
  },

  /** 用当前 key 打一次最小请求，直接告诉用户"到底通不通" */
  async 'POST /api/llm/test'() {
    const c = cfg()
    if (!hasLLM(c.llm)) throw new Error('还没配 key，或者 provider 是 none')
    const t0 = Date.now()
    const res = await chat(c.llm, {
      system: '你是连通性测试。只回复两个字：收到',
      user: '在吗',
      temperature: 0,
    })
    const content = typeof res === 'string' ? res : (res?.content ?? '')
    return {
      ok: true,
      ms: Date.now() - t0,
      model: c.llm.model,
      reply: String(content).trim().slice(0, 60),
      tokens: res?.usage?.total_tokens ?? null,
    }
  },

  async 'GET /api/history'() {
    return { items: listHistory() }
  },

  async 'POST /api/collect'(body) {
    const bvid = String(body.bvid ?? '').trim()
    if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) throw new Error('BV 号格式不对（大小写敏感，别手动改）')
    const c = cfg()
    const material = await collect(bvid, c, { whale: Boolean(body.whale) })
    const text = toPromptText(material, c.llm)
    saveHistory(bvid, material, null)
    return { material, text, len: text.length }
  },

  async 'POST /api/compose'(body) {
    const bvid = String(body.bvid ?? '').trim()
    const c = cfg()
    if (!hasLLM(c.llm)) {
      throw new Error(`模型未配置（provider=${c.llm.provider}、apiKey 为空）。去「设置」里填 DeepSeek Key。`)
    }
    const material = await collect(bvid, c, { whale: Boolean(body.whale) })
    const text = toPromptText(material, c.llm)
    // 主人 UP 的片子换个语气写：放开一点，不用像对陌生 UP 那样客套
    const master = masterOf(c, material.video?.ownerMid)
    const system = master ? MASTER_SYSTEM.replace('{{master}}', master.name || material.video.owner || '主人') : SYSTEM
    const { content, usage } = await chat(c.llm, { system, user: text, json: true,replyConfig:c,replyTask:material.video?.title,replyMaterial:text })
    const result = parseJSON(content)
    if (!result) throw new Error(`模型没吐合法 JSON：${content.slice(0, 200)}`)
    saveHistory(bvid, material, result)
    const state = loadState()
    return { material, text, len: text.length, result, usage, master, problems: check(c, state, result, bvid) }
  },

  async 'POST /api/send'(body) {
    const bvid = String(body.bvid ?? '').trim()
    const text = String(body.text ?? '').trim()
    if (!text) throw new Error('群分享文案是空的')
    const c = cfg()
    const groupIds = body.groupId ? [String(body.groupId)] : (c.qq?.groupIds ?? []).map(String)
    if (!groupIds.length) throw new Error('没配群号')

    const f = path.join(HISTORY, `${bvid}.json`)
    const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}

    if (!body.go) {
      return { dry: true, preview: { groupIds, text, title: rec.title ?? bvid, url: `https://www.bilibili.com/video/${bvid}` } }
    }

    const msg = buildShareMessage({
      bvid,
      title: rec.title ?? bvid,
      text,
      cover: rec.cover,
      atAll: Boolean(body.atAll ?? c.qq?.atAll),
    })
    await biliPolicy.claim('share',bvid)
    const results = []
    for (const gid of groupIds) {
      if(results.length && !c.chat?.outputRateOnly)await new Promise(r=>setTimeout(r,30000))
      const shape = await sendGroup(c, gid, msg)
      results.push({ groupId: gid, shape })
    }
    const state = loadState()
    state.sharedToday = (state.sharedToday ?? 0) + 1
    state.seen[bvid] = new Date().toISOString()
    saveState(state)
    return { dry: false, results, used: state.sharedToday }
  },

  async 'POST /api/comment'(body) {
    const bvid = String(body.bvid ?? '').trim()
    const text = String(body.text ?? '').trim()
    const c = cfg()
    if (!text) throw new Error('评论是空的')
    if (!c.cookie.bili_jct) throw new Error('缺 bili_jct，没法发评论（去设置里补）')

    const f = path.join(HISTORY, `${bvid}.json`)
    const rec = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {}

    if (!body.confirmRisk) {
      return { dry: true, preview: { text, title: rec.title, aid: rec.aid } }
    }

    // 没 aid 也不要紧：addComment 会拿 bvid 现查一次
    const r = await addComment(c, { bvid, aid: rec.aid, text })
    const verified = await verifyComment(c, { bvid, aid: r.aid, rpid: r.rpid })
    return { ok: true, rpid: r.rpid, aid: r.aid, verified }
  },

  async 'GET /api/ping'() {
    const info = await ping(cfg())
    return { online: true, data: info.data ?? info }
  },

  async 'GET /api/balance'() {
    const c = cfg()
    if (!hasLLM(c.llm)) throw new Error('模型未配置')
    const r = await fetch(`${c.llm.baseUrl}/user/balance`, { headers: { authorization: `Bearer ${c.llm.apiKey}` } })
    const j = await r.json().catch(() => null)
    if (!r.ok) throw new Error(`查询余额失败 HTTP ${r.status}`)
    return j
  },

  /** 群聊：常驻进程的心跳 + 最近对话。控制台和 agent 是两个进程，用文件通信。 */
  async 'GET /api/chat'() {
    const hbf = path.join(DATA, 'agent.json')
    let hb = null
    if (fs.existsSync(hbf)) {
      try { hb = JSON.parse(fs.readFileSync(hbf, 'utf8')) } catch { /* 忽略半截文件 */ }
    }
    const dsh = await dshLink.read()
    if (dsh) hb = { ...dsh.heartbeat, ...dsh.status.chat }
    const online = Boolean(hb && Date.now() - Number(hb.heartbeat ?? 0) < 90_000)

    const logf = path.join(DATA, 'chat.log')
    const log = []
    if (fs.existsSync(logf)) {
      log.push(...readJsonlTail(logf,150))
    }
    const c = cfg()
    return {
      online,
      heartbeat: hb,
      source:dsh ? 'dsh' : 'agent',
      connected:dsh?.status.chat?.connected ?? null,
      snowLuma:dsh?.status.snowLuma ?? null,
      paused: fs.existsSync(path.join(DATA, 'pause')),
      nick: c.chat?.nick ?? '',
      groups: c.chat?.groups ?? c.qq?.groupIds ?? [],
      admins: c.chat?.admins ?? [],
      maxPerHour: c.chat?.maxPerHour ?? 20,
      replyEveryMessage: hb?.replyEveryMessage ?? Boolean(c.chat?.replyEveryMessage),
      replyFormat:hb?.replyFormat ?? null,
      queuedMessages: hb?.queuedMessages ?? 0,
      diagnostics: online ? hb?.diagnostics ?? null : null,
      connection: online ? hb?.connection ?? null : null,
      traces:readJsonlTail(path.join(DATA,'chat-traces.jsonl'),60),
      outputRate: hb?.outputRate ?? null,
      catchUp: hb?.catchUp?.enabled ?? (!c.chat?.replyEveryMessage && c.chat?.catchUp !== false),
      catchUpSec: c.chat?.catchUpSec ?? 45,
      shield: hb?.shield ?? null,
      log,
    }
  },

  /* ── B 站扫码登录 ───────────────────────────────────── */

  /** 拿一张登录二维码。返回的 key 只用来轮询，url 才是要画成二维码的内容。 */
  async 'GET /api/bili/qr'() {
    const r = await biliFetch('https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    })
    const j = await r.json().catch(() => null)
    if (j?.code !== 0 || !j?.data?.qrcode_key) {
      throw new Error(`取二维码失败：${j?.message ?? `HTTP ${r.status}`}`)
    }
    return { key: j.data.qrcode_key, url: j.data.url }
  },

  /** 轮询扫码状态。扫成功后把三件套写进 config.json。 */
  async 'GET /api/bili/qr/poll'(_, url) {
    const key = url?.searchParams?.get('key')
    if (!key) throw new Error('缺 qrcode key')

    const r = await biliFetch(
      `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
      { headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' } },
    )
    const j = await r.json().catch(() => null)
    const code = j?.data?.code

    if (code === 86101) return { status: 'waiting' }
    if (code === 86090) return { status: 'scanned' }
    if (code === 86038) return { status: 'expired' }
    if (code !== 0) return { status: 'fail', message: j?.message ?? j?.data?.message ?? '未知错误' }

    // 成功时凭据有两个来源：Set-Cookie，以及 data.url 上的 query。
    // 只信 Set-Cookie 很容易踩空（不同 Node / 代理会把多个头合并掉），
    // 所以两边都解析，url 优先——它一定带着 SESSDATA 和 bili_jct。
    const jar = {}
    const grab = (from) => {
      for (const line of from) {
        const pair = String(line).split(';')[0]
        const i = pair.indexOf('=')
        if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
      }
    }
    try { grab(r.headers.getSetCookie?.() ?? []) } catch { /* 老 Node 没有这个 API */ }
    if (!Object.keys(jar).length) {
      const merged = r.headers.get('set-cookie')
      if (merged) grab(merged.split(/,(?=\s*[A-Za-z_][\w-]*=)/))
    }

    // 从回跳地址里抠（保留原始编码，SESSDATA 里的 %2C 不能解码）
    const fromUrl = {}
    const qs = String(j?.data?.url ?? '').split('?')[1] ?? ''
    for (const part of qs.split('&')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      const k = part.slice(0, i)
      if (['SESSDATA', 'bili_jct', 'buvid3', 'DedeUserID'].includes(k)) fromUrl[k] = part.slice(i + 1)
    }

    const pick = (name) => fromUrl[name] || jar[name] || ''

    const raw = readRawConfig()
    raw.bili = raw.bili ?? {}
    if (pick('SESSDATA')) raw.bili.sessdata = pick('SESSDATA')
    if (pick('bili_jct')) raw.bili.bili_jct = pick('bili_jct')
    if (pick('buvid3')) raw.bili.buvid3 = pick('buvid3')
    if (pick('DedeUserID')) raw.bili.dedeUserId = pick('DedeUserID')

    // buvid3 常常不在登录 cookie 里，单独要一个，否则部分接口照样 412
    if (!raw.bili.buvid3) {
      try {
        const sp = await biliFetch('https://api.bilibili.com/x/frontend/finger/spi', {
          headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
        })
        const sj = await sp.json()
        if (sj?.data?.b_3) raw.bili.buvid3 = sj.data.b_3
      } catch { /* 拿不到就算了，能看公开数据 */ }
    }
    writeRawConfig(raw)

    // 顺便确认一下登录真的生效了（用刚写进去的 cookie，而不是旧配置）
    const fresh = buildConfig(readRawConfig())
    let user = null
    let navCode = null
    try {
      const me = await biliFetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { cookie: fresh.cookieHeader, 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      })
      const mj = await me.json()
      navCode = mj?.code ?? null
      if (mj?.data?.isLogin) user = { mid: mj.data.mid, name: mj.data.uname }
    } catch { /* 忽略 */ }

    // 回跳地址里偶尔没有 DedeUserID，用 nav 查到的补上，界面上才能显示是谁
    if (user?.mid && String(raw.bili.dedeUserId ?? '') !== String(user.mid)) {
      raw.bili.dedeUserId = String(user.mid)
      writeRawConfig(raw)
    }

    const saved = {
      sessdata: Boolean(fresh.cookie.sessdata),
      bili_jct: Boolean(fresh.cookie.bili_jct),
      buvid3: Boolean(fresh.cookie.buvid3),
    }
    try {
      ensureData()
      fs.appendFileSync(
        path.join(DATA, 'bili-login.log'),
        `${new Date().toISOString()} url=${Object.keys(fromUrl).join(',') || '-'} cookie=${Object.keys(jar).join(',') || '-'} ` +
          `sessdataLen=${(fresh.cookie.sessdata || '').length} saved=${JSON.stringify(saved)} nav=${navCode} user=${user?.name ?? '-'}\n`,
      )
    } catch { /* 日志失败不影响结果 */ }

    return {
      status: 'ok',
      user,
      navCode,
      saved,
      // 给了前端一个"到底缺哪一件"的明确说法
      missing: Object.entries(saved).filter(([, v]) => !v).map(([k]) => k),
      source: Object.keys(fromUrl).length ? 'url' : 'set-cookie',
    }
  },

  /** 查一下当前 cookie 还有效吗（扫码后想确认，或隔天想复查） */
  async 'GET /api/bili/me'() {
    const c = cfg()
    if (!c.cookie.sessdata) return { loggedIn: false, reason: '没有 SESSDATA，先扫码登录' }
    const r = await biliFetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { cookie: c.cookieHeader, 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    })
    const j = await r.json().catch(() => null)
    return {
      loggedIn: Boolean(j?.data?.isLogin),
      mid: j?.data?.mid ?? null,
      name: j?.data?.uname ?? null,
      code: j?.code ?? null,
      message: j?.message ?? null,
    }
  },

  /** 人设：单独一组读写，跟「连接配置」分开，免得改人设时把 token 带崩 */
  async 'GET /api/persona'() {
    const c = cfg()
    const hbf = path.join(DATA, 'agent.json')
    let online = false
    if (fs.existsSync(hbf)) {
      try {
        const hb = JSON.parse(fs.readFileSync(hbf, 'utf8'))
        online = Date.now() - Number(hb.heartbeat ?? 0) < 60_000
      } catch { /* 忽略 */ }
    }
    return {
      online,
      nick: c.chat?.nick ?? '',
      aliases: c.chat?.aliases ?? [],
      persona: c.chat?.persona ?? '',
      taboo: c.chat?.taboo ?? '',
      minGapSec: c.chat?.minGapSec ?? 75,
      maxPerHour: c.chat?.maxPerHour ?? 20,
      quietHours: c.chat?.quietHours ?? [],
      speakChance: c.chat?.speakChance ?? 0.55,
      temperature: c.chat?.temperature ?? 1.2,
      catchUp: hb?.catchUp?.enabled ?? (!c.chat?.replyEveryMessage && c.chat?.catchUp !== false),
      catchUpSec: c.chat?.catchUpSec ?? 45,
      admins: c.chat?.admins ?? [],
      adminTitles: c.chat?.adminTitles ?? [],
      shield: { ...DEFAULT_SHIELD, ...(c.chat?.shield ?? {}) },
    }
  },

  async 'POST /api/persona'(body) {
    const raw = readRawConfig()
    raw.chat = raw.chat ?? {}
    if (typeof body.nick === 'string' && body.nick.trim()) raw.chat.nick = body.nick.trim()
    if (typeof body.persona === 'string') raw.chat.persona = body.persona
    if (typeof body.taboo === 'string') raw.chat.taboo = body.taboo
    if (Array.isArray(body.aliases)) raw.chat.aliases = body.aliases.map((s) => String(s).trim()).filter(Boolean)
    if (Array.isArray(body.admins)) raw.chat.admins = body.admins.map((s) => String(s).trim()).filter(Boolean)
    // 管理员的称呼池：可以一次给好几个，模型每轮随机挑一个
    if (Array.isArray(body.adminTitles)) {
      raw.chat.adminTitles = body.adminTitles.map((s) => String(s).trim()).filter(Boolean).slice(0, 12)
    } else if (typeof body.adminTitles === 'string') {
      raw.chat.adminTitles = body.adminTitles.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 12)
    }

    const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null }
    const gap = n(body.minGapSec)
    if (gap !== null && gap >= 0) raw.chat.minGapSec = gap
    const mph = n(body.maxPerHour)
    if (mph !== null && mph >= 0) raw.chat.maxPerHour = mph
    const temp = n(body.temperature)
    if (temp !== null && temp >= 0 && temp <= 2) raw.chat.temperature = temp
    const chance = n(body.speakChance)
    if (chance !== null && chance >= 0 && chance <= 1) raw.chat.speakChance = chance
    // 补话：没回上的消息隔一会儿要不要再补一句
    if (typeof body.catchUp === 'boolean') raw.chat.catchUp = body.catchUp
    const cuSec = n(body.catchUpSec)
    if (cuSec !== null && cuSec >= 1 && cuSec <= 3600) raw.chat.catchUpSec = Math.round(cuSec)
    if (Array.isArray(body.quietHours)) {
      const q = body.quietHours.map(Number).filter((x) => Number.isInteger(x) && x >= 0 && x < 24)
      if (body.quietHours.length === 0) raw.chat.quietHours = []
      else if (q.length === 2) raw.chat.quietHours = q
    }

    // 防注入 / 用量闸门。只认白名单字段，数值都夹在安全区间里，
    // 免得手滑填个 0 把输出上限关死，或者填个 10^9 把限额撑破。
    if (body.shield && typeof body.shield === 'object') {
      const s = { ...DEFAULT_SHIELD, ...(raw.chat.shield ?? {}) }
      const bools = ['enabled', 'adminBypass', 'teaseWhenForced']
      for (const k of bools) if (typeof body.shield[k] === 'boolean') s[k] = body.shield[k]
      const ranges = {
        maxInputChars: [50, 8000],
        hardMaxChars: [100, 20000],
        maxContextChars: [200, 12000],
        maxOutputTokens: [32, 20000],
        adminMaxOutputTokens: [96, 60000],
        perCallTokens: [0, 200000],
        dailyTokens: [0, 20000000],
        guestHourlyTokens: [0, 20000000],
        userWindowSec: [60, 86400],
        userWindowTokens: [0, 1000000],
        userCooldownSec: [0, 86400],
        adminHardMaxChars: [100, 40000],
      }
      for (const [k, [lo, hi]] of Object.entries(ranges)) {
        const v = n(body.shield[k])
        if (v !== null && v >= lo && v <= hi) s[k] = Math.round(v)
      }
      if (Array.isArray(body.shield.tease)) {
        s.tease = body.shield.tease.map((x) => String(x).trim()).filter(Boolean).slice(0, 12)
      }
      raw.chat.shield = s
    }

    saveSettingsConfig(raw)
    return { ok: true, restartNeeded: false }
  },

  /** 急停：写一个 pause 文件，agent 下一条消息就不再接话 */
  async 'POST /api/chat/pause'(body) {
    const f = path.join(DATA, 'pause')
    if (body?.paused) {
      fs.mkdirSync(DATA, { recursive: true })
      fs.writeFileSync(f, new Date().toISOString())
    } else if (fs.existsSync(f)) {
      fs.unlinkSync(f)
    }
    return { paused: fs.existsSync(f) }
  },
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('404')
  }
  // no-store：本地开发工具，宁可每次都重新拉，也别让浏览器留着旧 app.js
  // （之前改完前端没生效，就是因为旧脚本还在缓存里跑）
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  fs.createReadStream(file).pipe(res)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const key = `${req.method} ${url.pathname}`

  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    return serveStatic(req, res, url.pathname)
  }

  if(key==='GET /api/voice/preview'){
    const id=url.searchParams.get('id')||'';if(!/^[a-f0-9-]{36}$/.test(id))return json(res,404,{error:'试听音频不存在'})
    try{const bytes=fs.readFileSync(path.join(DATA,'voice-preview',id+'.wav'));res.writeHead(200,{'content-type':'audio/wav','cache-control':'no-store'});return res.end(bytes)}catch{return json(res,404,{error:'试听音频不存在'})}
  }
  if(key==='GET /api/diary/download'){
    try{const r=diaryService.read(url.searchParams.get('file'));res.writeHead(200,{'content-type':'text/plain; charset=utf-8','content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(r.filename)}`,'cache-control':'no-store'});res.end(r.content)}catch{json(res,404,{error:'日记文件不存在或名称无效'})}
    return
  }
  if(key==='GET /api/stickers/image'){
    try{const image=stickerStore.read(url.searchParams.get('id'));res.writeHead(200,{'content-type':image.type,'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(image.bytes)}catch{json(res,404,{error:'表情包不存在'})}
    return
  }
  const handler = routes[key]
  if (!handler) return json(res, 404, { error: `没有这个接口：${key}` })

  try {
    const body = req.method === 'POST' ? await readBody(req,key==='POST /api/stickers'?Infinity:undefined) : {}
    const t0 = Date.now()
    const data = await handler(body, url)
    console.log(`${key} ${Date.now() - t0}ms`)
    json(res, 200, data)
  } catch (e) {
    console.error(`${key} ✗`, e.message)
    json(res, 400, { error: e.message })
  }
})

/**
 * 端口冲突时不要甩一堆堆栈出来。先判断占用者是谁：
 * - 是本工具自己的另一个实例 → 告诉用户直接开浏览器，然后正常退出
 * - 是别的程序 → 自动往后找一个空端口
 */
function probe(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port, path: '/api/status', timeout: 1200 }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => {
        try {
          resolve(JSON.parse(s).app === 'bili-whale-qq' ? 'ours' : 'other')
        } catch {
          resolve('other')
        }
      })
    })
    req.on('timeout', () => { req.destroy(); resolve('other') })
    req.on('error', () => resolve('free'))
  })
}

function announce(port, bumped) {
  console.log(`\n  控制台  http://${HOST}:${port}${bumped ? `   （${PORT} 被占用，已自动切换）` : ''}\n`)
  console.log(`  只监听本机。别改成 0.0.0.0，这个页面能直接操纵你的账号。\n`)
}

server.on('error', async (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error(`启动失败：${err.message}`)
    process.exit(1)
  }

  const who = await probe(PORT)

  if (who === 'ours') {
    const holder = portPid(PORT)
    console.log(`\n  已经有一个控制台在跑了：http://${HOST}:${PORT}${holder ? `（pid ${holder}）` : ''}`)
    console.log(`  群聊进程跟着它，直接用浏览器打开就行，不用再起一个。`)
    console.log(`  想让这个窗口接管：taskkill /PID ${holder ?? '<pid>'} /F  然后重新运行\n`)
    process.exit(0)          // 正常退出，不当作错误
  }

  if (who === 'other') {
    console.log(`\n  ${PORT} 被别的程序占用了，找一个空端口…`)
  }

  for (let p = PORT + 1; p <= PORT + 10; p++) {
    if ((await probe(p)) === 'free') {
      PORT = p
      server.listen(PORT, HOST, () => { announce(PORT, true); boot() })
      return
    }
  }

  console.error(`\n  ${PORT} 之后的 10 个端口都被占用。手动指定一个：node src/server.mjs --port 7800\n`)
  process.exit(1)
})

/** 端口起来之后：先保证 SnowLuma 在，再把群聊进程带起来 */
function boot() {
  if(!process.argv.includes('--no-services')||managedParent>0){diaryScheduler.start();diaryPublisher.start()}
  if (process.argv.includes('--no-services')) return
  if (dshLink.heartbeat()) {
    console.log('  检测到 DSH 正在运行，控制台跟随读取其配置、聊天日志和状态。')
    return
  }
  // 顺手把 SnowLuma 拉起来，免得「控制台开着但 3000 连不上」
  ensureSnowLuma()
    .then((r) => {
      if (r.reason === 'already-running') console.log(`  SnowLuma 已在跑（${r.port}），OneBot 应该可用`)
      else if (r.ok) console.log(`  SnowLuma 已自动拉起（node ${r.version}），等它注入 QQ 后 3000/3001 就通了`)
      else console.log(`  ⚠ SnowLuma 没起来：${r.reason}`)

      if (NO_AGENT) {
        console.log(`  群聊进程：本次不自动带起（--no-agent），页面上有开关\n`)
        return
      }
      const r2 = agentHost.start({ reason: 'boot' })
      if (r2.ok && r2.started) console.log(`  群聊进程已带起：pid ${r2.pid}，它的输出直接打在这个窗口里`)
      else if (r2.ok) console.log(`  群聊进程已在跑：pid ${r2.pid}`)
      else if (r2.why === 'external') console.log(`  群聊进程别处已在跑（pid ${r2.pid}），这边不抢。要交给控制台：先停那边，再点页面上的启动`)
      else console.log(`  群聊进程没能带起：${r2.why ?? '未知'}`)
      console.log('')
    })
    .catch((e) => console.log(`  ⚠ SnowLuma 自启失败（不影响控制台）：${e.message}\n`))
}

server.listen(PORT, HOST, () => {
  announce(PORT, false)
  boot()
})
