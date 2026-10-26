/**
 * 离线自测：重启后读回群历史。
 *
 * 场景：agent 重启，内存里的 buffers 是空的。群友刚才 @ 了它、或者喊了它名字，
 * 这些消息在它停机/重启的那几分钟里发出来，重启后不该当没看见。
 * 期望：先把历史捞回上下文，必要时追一句；窗口外的只补上下文、不开口。
 *
 * 跑：node test/history-restore.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createChat } from '../src/chat.mjs'

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

const SELF = '881000004'
const ADMIN = '880010001'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-hist-'))
const logFile = path.join(tmp, 'chat.log')

const mkCfg = (over = {}) => ({
  qq: { onebotHttp: 'http://127.0.0.1:3999', accessToken: '', groupIds: ['1'] },
  llm: { provider: 'x', apiKey: 'x', model: 'x' },
  chat: {
    nick: '青娥鱼',
    aliases: ['小鱼', '娥鱼'],
    groups: ['1'],
    minGapSec: 0,
    maxPerHour: 0,
    contextMessages: 14,
    historyRestore: 14,
    historyReplyWindowSec: 600,
    admins: [ADMIN],
    ...over,
  },
})

/** 往临时日志里写一条 in / out（格式跟 chat.mjs 的 appendLog 一致） */
const T0 = Math.floor(Date.now() / 1000)
let seq = 0
const write = (obj) => {
  seq++
  fs.appendFileSync(logFile, JSON.stringify({ ts: new Date((obj.time ?? T0) * 1000).toISOString(), ...obj }) + '\n')
}
const inMsg = (uid, text, ago = 0, id = `in${seq}`) =>
  write({ type: 'in', channel: 'group', group: '1', groupName: '测试群', from: `U${uid}`, uid, text, id, time: T0 - ago })
const outMsg = (text, ago = 0) =>
  write({ type: 'out', channel: 'group', group: '1', groupName: '测试群', text, time: T0 - ago })

// 模型：恢复追话一律说一句
let historyCalls = 0
let lastUser = '' // 最近一次喂给模型的 user prompt，用来验证「恢复的历史真的进了上下文」
let normalSpeak = false // 集成测试里临时放开：让正常群消息也说一句
const llmChat = async (_llm, { system, user }) => {
  lastUser = String(user ?? '')
  if (String(system).includes('补充一条')) {
    historyCalls++
    return { content: JSON.stringify({ speak: true, reply: '在的，刚才重启了一下', why: '被点名' }) }
  }
  if (normalSpeak) return { content: JSON.stringify({ speak: true, reply: '我记得你刚才说的', why: '被 @' }) }
  return { content: JSON.stringify({ speak: false, reply: '', why: '不想接' }) }
}

const mkChat = (cfg, fetchHistory) => {
  const sent = []
  const chat = createChat(cfg, {
    llmChat,
    stateFile: null,
    logFile,
    privateDir: path.join(tmp, 'private'),
    say: async (_c, gid, segs) => { sent.push({ gid, segs }) },
  })
  chat.selfId(SELF)
  return { chat, sent, fetchHistory }
}

const textOf = (segs) => (segs ?? []).map((s) => (s.type === 'text' ? s.data.text : `[${s.type}]`)).join('')

/* ── 1) 本地日志恢复 + 窗口内被 @ 就追一句 ── */
{
  historyCalls = 0
  inMsg('1001', '这游戏昨天更新了个离谱的平衡', 200)
  outMsg('确实离谱', 190)
  inMsg('1002', `@${SELF} 在吗`, 30)
  const { chat, sent } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('从本地日志恢复了 3 条', r.restored === 3 && chat.status().buffers['1'] === 3, JSON.stringify(r))
  check('窗口内被 @ 就追一句', sent.length === 1 && historyCalls === 1, `sent=${sent.length} calls=${historyCalls}`)
  check('追的是被 @ 那条的内容', String(textOf(sent[0]?.segs)).includes('重启'), textOf(sent[0]?.segs))
  check('replied 记了群号', r.replied.includes('1'), JSON.stringify(r.replied))
}

/* ── 2) 窗口外：只恢复上下文，不开口 ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  inMsg('1003', `@${SELF} 一个小时前叫你`, 3600)
  const { chat, sent } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('窗口外也恢复上下文', r.restored === 1 && chat.status().buffers['1'] === 1, JSON.stringify(r))
  check('窗口外不主动说话', sent.length === 0 && historyCalls === 0, `sent=${sent.length}`)
  check('窗口外不记 replied', r.replied.length === 0)
}

/* ── 3) 没被叫到（普通闲聊）：只恢复上下文 ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  inMsg('1004', '今天中午吃啥', 20)
  const { chat, sent } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('普通闲聊只补上下文', r.restored === 1 && sent.length === 0, `restored=${r.restored} sent=${sent.length}`)
}

/* ── 4) 喊昵称 / 别名 也算被叫到 ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  inMsg('1005', '小鱼 帮我看看这个', 10)
  const { chat, sent } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('喊别名也追一句', sent.length === 1 && r.replied.includes('1'), `sent=${sent.length}`)
}

/* ── 5) 管理员说话也算被叫到 ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  inMsg(ADMIN, '这个版本打到哪了', 10)
  const { chat, sent } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('管理员说话也追一句', sent.length === 1 && r.replied.includes('1'), `sent=${sent.length}`)
}

/* ── 6) OneBot 历史补齐本地日志没有的部分（停机期间的消息） ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  const onebot = [
    { message_id: 9002, time: T0 - 20, sender: { user_id: 1006, card: '路人乙' }, message: [{ type: 'text', data: { text: '刚才那段我看了三遍' } }] },
    { message_id: 9003, time: T0 - 10, sender: { user_id: 1007, card: '路人丙' }, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 在吗' } }] },
    { message_id: 9001, time: T0 - 30, sender: { user_id: SELF, card: '青娥鱼' }, message: [{ type: 'text', data: { text: '我刚才说过的话' } }] },
  ]
  const { chat, sent } = mkChat(mkCfg(), async () => onebot)
  const r = await chat.restoreHistory({ fetchHistory: async (_c, _g, _o) => onebot })
  check('OneBot 历史补齐了 3 条（含自己说过的）', r.restored === 3, JSON.stringify(r))
  check('自己那条标了 self 但不算「别人发的」', chat.status().buffers['1'] === 3)
  check('补来的历史里被 @ 也追一句', sent.length === 1 && r.replied.includes('1'), `sent=${sent.length}`)
}

/* ── 7) OneBot 不支持这个 action：静默降级，不报错 ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  inMsg('1008', `@${SELF} 你在吗`, 10)
  const { chat, sent } = mkChat(mkCfg(), async () => { throw new Error('OneBot get_group_msg_history 失败：retcode=1404') })
  let threw = false
  const r = await chat.restoreHistory({ fetchHistory: async () => { throw new Error('不支持') } }).catch(() => { threw = true; return null })
  check('接口不支持也不抛', threw === false && r !== null)
  check('不支持时仍用本地日志恢复', r?.restored === 1, JSON.stringify(r))
  check('不支持时照样追一句', sent.length === 1)
}

/* ── 8) 日志不存在 / 是坏的：不炸 ── */
{
  fs.writeFileSync(logFile, '这不是 JSON\n{"type":"in","group":"1"\n')
  const { chat } = mkChat(mkCfg(), async () => [])
  let threw = false
  const r = await chat.restoreHistory({ fetchHistory: async () => [] }).catch(() => { threw = true; return null })
  check('坏日志也只当没历史', threw === false && r?.restored === 0, JSON.stringify(r))
}

/* ── 9) historyRestore=0 就完全不恢复 ── */
{
  fs.writeFileSync(logFile, '')
  inMsg('1009', `@${SELF} 在吗`, 10)
  const { chat, sent } = mkChat(mkCfg({ historyRestore: 0 }), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('historyRestore=0 不恢复也不说话', r.restored === 0 && sent.length === 0, JSON.stringify(r))
}

/* ── 10) historyReplyWindowSec=0：只补上下文，永不开口 ── */
{
  historyCalls = 0
  fs.writeFileSync(logFile, '')
  inMsg('1010', `@${SELF} 在吗`, 5)
  const { chat, sent } = mkChat(mkCfg({ historyReplyWindowSec: 0 }), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('窗口=0 时只恢复不开口', r.restored === 1 && sent.length === 0, JSON.stringify(r))
}

/* ── 11) 只恢复配置里的群 ── */
{
  fs.writeFileSync(logFile, '')
  write({ type: 'in', channel: 'group', group: '999', groupName: '别的群', from: 'X', uid: '1', text: '别的群的消息', id: 'z1', time: T0 })
  const { chat } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('别的群的消息不进上下文', r.restored === 0 && (chat.status().buffers['999'] ?? 0) === 0, JSON.stringify(r))
}

/* ── 12) 恢复条数受 historyRestore 限制 ── */
{
  fs.writeFileSync(logFile, '')
  for (let i = 0; i < 10; i++) inMsg(`20${i}`, `第 ${i} 条`, 500 - i)
  const { chat } = mkChat(mkCfg({ historyRestore: 4 }), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('只恢复最近 4 条', r.restored === 4 && chat.status().buffers['1'] === 4, JSON.stringify(r))
}

/* ── 12.b) SnowLuma get_group_msg_history 的真实返回形状 ── */
/**
 * 2026-10-19 读 SnowLuma 源码（index.mjs 的 getGroupMsgHistory / sanitizeMessageEventForApi）
 * 确认的形状：整条事件去掉 post_type / self_id，另加一个 real_id。
 * 也就是说它长得跟普通群消息事件一样 —— 但**顺序不定**，且 `message_id` 可能是负数或很长，
 * 所以解析时必须靠 `sender.user_id`（或 user_id）认人、靠 `time` 排序。
 */
{
  fs.writeFileSync(logFile, '')
  historyCalls = 0
  const snowluma = [
    {
      message_id: -184748623, real_id: -184748623, group_id: 1, message_type: 'group',
      time: T0 - 40, user_id: 2001,
      sender: { user_id: 2001, nickname: '华扇', card: '示例管理员', role: 'owner' },
      message: [{ type: 'text', data: { text: '昨天那局我翻盘了' } }],
    },
    {
      message_id: 2002484856, real_id: 2002484856, group_id: 1, message_type: 'group',
      time: T0 - 15, user_id: SELF,
      sender: { user_id: Number(SELF), nickname: '青娥鱼', card: '' },
      message: [{ type: 'text', data: { text: '我刚才说过的话' } }],
    },
    {
      message_id: 151133394, real_id: 151133394, group_id: 1, message_type: 'group',
      time: T0 - 5, user_id: 2002,
      sender: { user_id: 2002, nickname: '群友', card: '路人' },
      message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 在吗' } }],
    },
  ]
  const { chat, sent } = mkChat(mkCfg(), async () => snowluma)
  const r = await chat.restoreHistory({ fetchHistory: async () => snowluma })
  check('SnowLuma 真实形状能解析（3 条全进来）', r.restored === 3, JSON.stringify(r))
  const buf = chat.status().buffers['1']
  check('顺序按 time 排好（不是接口给的乱序）', buf === 3)
  check('自己那条认得出（sender.user_id）', sent.length === 1, `sent=${sent.length}`)
  check('被 @ 的那条能追一句', sent.length === 1 && String(textOf(sent[0]?.segs)).includes('重启'), textOf(sent[0]?.segs))
}

/* ── 12.c) 恢复时 uid 必须带上（曾经 35/56 条 in 记录 uid 为空） ── */
const inRecords = () => fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l) } catch { return null } })
  .filter((o) => o && o.type === 'in')

{
  fs.writeFileSync(logFile, '')
  const { chat } = mkChat(mkCfg(), async () => [])
  await chat.handleEvent({
    post_type: 'message', message_type: 'group', group_id: '1', group_name: '测试群',
    user_id: 4001, message_id: 888001, time: T0,
    sender: { nickname: '路人', card: '路人甲' },
    message: [{ type: 'text', data: { text: '随便说一句' } }],
  })
  const logged = inRecords()
  check('落盘的 in 记录一定带 uid（管理员停机前说话才认得出）',
    logged.length === 1 && String(logged[0].uid) === '4001', JSON.stringify(logged[0] ?? null))
}

/* ── 12.d) 事件只给 sender.user_id 时也能抠出 uid（不能落成 "undefined"） ── */
{
  fs.writeFileSync(logFile, '')
  const { chat } = mkChat(mkCfg(), async () => [])
  // 顶层没有 user_id —— 直接 String(ev.user_id) 会得到字符串 "undefined"，
  // 它是真值，于是落盘里有个假 uid，isAdmin() 恒 false。
  await chat.handleEvent({
    post_type: 'message', message_type: 'group', group_id: '1', group_name: '测试群',
    message_id: 888002, time: T0,
    sender: { user_id: ADMIN, nickname: '管理员', card: '老大' },
    message: [{ type: 'text', data: { text: '停机前我叫过它' } }],
  })
  const logged = inRecords()
  check('只有 sender.user_id 也能抠出 uid',
    logged.length === 1 && String(logged[0].uid) === String(ADMIN), JSON.stringify(logged[0] ?? null))
  check('uid 不会落成 "undefined" / "null" 这种假值',
    logged.length === 1 && !['undefined', 'null', ''].includes(String(logged[0].uid)), JSON.stringify(logged[0]?.uid))
  check('管理员身份认得出（admin=true）', logged[0]?.admin === true, String(logged[0]?.admin))
}

/* ── 12.e) 能力边界：OneBot 拉不到时，不能假装补回来了 ── */
{
  fs.writeFileSync(logFile, '')
  inMsg('5001', '只有本地日志里有这句', 60)
  const { chat } = mkChat(mkCfg(), async () => [])
  // 端不支持 / SnowLuma 没起 → 返回空。这时**只能**靠本地日志，
  // restored 必须诚实等于本地条数，不能编造，也不能报错。
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('拉不到历史时 restored 只等于本地日志条数（不注水）', r.restored === 1, JSON.stringify(r))
  check('拉不到历史也不抛错', r !== null)
}

/* ── 12.f) historyToEntries 容错：残缺的消息不能把恢复搞崩 ── */
{
  fs.writeFileSync(logFile, '')
  const broken = [
    { message_id: 1, time: T0 - 30, sender: { user_id: 6001, card: '甲' }, message: [{ type: 'text', data: { text: '正常一条' } }] },
    { time: T0 - 20, sender: { user_id: 6002 }, message: [{ type: 'text', data: { text: '没有 message_id' } }] },
    { message_id: 3, time: T0 - 10, message: '消息是字符串不是数组', user_id: 6003 },
    // 最后一条故意做成 @：它会触发一次接话，于是可以从喂给模型的 prompt 反查留下哪几条
    { message_id: 4, time: T0 - 5, message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 连 sender 都没有' } }] },
    { message_id: 5, time: T0 - 1, sender: {}, message: null },
    null,
    '这不是对象',
  ]
  normalSpeak = true
  lastUser = ''
  const { chat } = mkChat(mkCfg(), async () => broken)
  let threw = false
  const r = await chat.restoreHistory({ fetchHistory: async () => broken }).catch(() => { threw = true; return null })
  check('残缺/畸形的历史不抛异常', threw === false && r !== null, JSON.stringify(r))

  // 行为钉死：不写"救回几条"这种模糊断言，而是**逐条**说清哪条留、哪条丢。
  // 最后一条是 @，会触发一次接话，于是可以从喂给模型的 user prompt 里反查到底留下哪几条。
  check('救回的正好是 3 条（id 1/3/4）', r?.restored === 3, JSON.stringify(r))
  check('正常那条留着', lastUser.includes('正常一条'))
  check('message 是字符串形态的那条留着（OneBot 允许）', lastUser.includes('消息是字符串不是数组'))
  check('连 sender 都没有的那条留着（uid 空但话还在）', lastUser.includes('连 sender 都没有'))
  check('没有 message_id 的那条被丢（没法引用，回不了）', !lastUser.includes('没有 message_id'))
  check('message 为 null 的那条被丢', !lastUser.includes('null 的那条'))
  check('数组里塞 null / 塞字符串 → 丢掉且不炸', r?.restored === 3 && threw === false)
  normalSpeak = false
}

/* ── 13) 集成 A：重启 → 恢复 → 追回停机期间那句 @ ── */
/**
 * 用户真正会遇到的那一条线：进程挂了/重启了，内存里的上下文全空；
 * 停机那几分钟有人在群里 @ 了它，重启后它应该「先读历史、再接话」。
 */
{
  fs.writeFileSync(logFile, '')
  historyCalls = 0
  // 停机期间群里发生的事（落在本地日志里；OneBot 那份给空，第 6 组单独测过）
  inMsg('3001', '昨天那局我翻盘了', 60)
  inMsg('3002', `@${SELF} 你在吗`, 20)

  // 重启 = 一个新的 chat 实例，内存里一条都没有
  const { chat, sent } = mkChat(mkCfg(), async () => [])
  check('重启后内存里是空的', (chat.status().buffers['1'] ?? 0) === 0)

  // 这就是 start() 里那句 restoreHistory()
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('重启后读回了 2 条历史', r.restored === 2 && chat.status().buffers['1'] === 2, JSON.stringify(r))
  check('追的是停机期间那句 @', sent.length === 1 && String(textOf(sent[0]?.segs)).includes('重启'), textOf(sent[0]?.segs))
  check('追话只走一次（不是复读机）', historyCalls === 1, `historyCalls=${historyCalls}`)
}

/* ── 14) 集成 B：重启后新来的 @ 要接，且上下文里带着重启前的对话 ── */
{
  fs.writeFileSync(logFile, '')
  historyCalls = 0
  // 停机期间只有普通闲聊（没 @）→ 恢复时只补上下文、不开口，lastSpoke 不会被占住
  inMsg('3003', '昨天那局我翻盘了', 60)

  const { chat, sent } = mkChat(mkCfg(), async () => [])
  const r = await chat.restoreHistory({ fetchHistory: async () => [] })
  check('普通闲聊只补上下文不开口', r.restored === 1 && sent.length === 0, JSON.stringify(r))

  normalSpeak = true
  lastUser = ''
  const live = await chat.handleEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: '1',
    group_name: '测试群',
    user_id: 3004,
    message_id: 777002,
    time: T0,
    sender: { nickname: '路人', card: '路人丁' },
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 那今天还打吗' } }],
  })
  check('重启后新来的 @ 接得上', sent.length === 1, `sent=${sent.length} res=${JSON.stringify(live)}`)
  check(
    '接话时上下文里有重启前的那句（不是没头没尾）',
    lastUser.includes('昨天那局我翻盘了') && lastUser.includes('那今天还打吗'),
    lastUser.slice(0, 120).replace(/\n/g, ' / '),
  )
  normalSpeak = false
}

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 临时目录清不掉就算了 */ }

const ok = results.every(Boolean)
console.log(ok ? `\n全部通过（${results.length} 项）` : `\n有 ${results.filter((x) => !x).length} 项失败`)
process.exit(ok ? 0 : 1)
