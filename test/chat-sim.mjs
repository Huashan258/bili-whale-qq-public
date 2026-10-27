/**
 * 离线自测：不连 QQ、不调模型，验证「收到消息 → 决定说话 → 发出去」这条链。
 *
 * 用一个假 OneBot HTTP 服务和假模型，检查：
 *   1. 被 @ 时必须回，且发出去的是 reply + text 两段
 *   2. 没被叫到时，概率抽中后必须有正文
 *   3. 同一群连续两次 @，第二次被冷却挡住
 *   4. 群里别人说话不会触发私聊回复
 *
 * 跑：npm run test:chat
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const testData=fs.mkdtempSync(path.join(os.tmpdir(),'qq-chat-send-'))
process.env.BILI_WHALE_DATA=testData
const { createChat }=await import('../src/chat.mjs')

const sent = []
const sentPrivate = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    const j = JSON.parse(body || '{}')
    if (j.action === 'send_group_msg') sent.push(j.params)
    if (j.action === 'send_private_msg') sentPrivate.push(j.params)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }))
  })
})

await new Promise((r) => server.listen(3999, '127.0.0.1', r))

const cfg = {
  qq: { onebotHttp: 'http://127.0.0.1:3999', accessToken: '', groupIds: ['887000009'] },
  llm: { provider: 'x', apiKey: 'x', model: 'x' },
  chat: {
    nick: '青娥鱼',
    aliases: ['小鱼'],
    groups: ['887000009'],
    minGapSec: 75,
    maxPerHour: 20,
    contextMessages: 10,
    speakChance: 1,
    quote: true,
  },
}

let lastPrompt = ''
const llmChat = async (_llm, { user }) => {
  lastPrompt = user
  return { content: JSON.stringify({ speak: true, reply: '这梗我上个月才被骗过一次', why: '被点名' }) }
}

const chat = createChat(cfg, { llmChat, stateFile: null, logFile: null })
chat.selfId('3816283038')

const mk = (text, { at = false, uid = 1001, id = 1, gid = '887000009' } = {}) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: gid,
  group_name: '超级无敌小号群',
  user_id: uid,
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: '路人', card: '路人甲' },
  message: [
    ...(at ? [{ type: 'at', data: { qq: '3816283038' } }] : []),
    { type: 'text', data: { text } },
  ],
})

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

// 1. 被 @：必须回
const r1 = await chat.handleEvent(mk('@青娥鱼 这条视频你看了吗', { at: true, id: 11 }))
check('被 @ 会回复', r1?.spoke === true, JSON.stringify(r1))
check('发出的是 reply + text', sent[0]?.message?.[0]?.type === 'reply' && sent[0]?.message?.[1]?.type === 'text')
check('引用的是原消息 id', String(sent[0]?.message?.[0]?.data?.id) === '11')
check('提示词带上了群名和上下文', lastPrompt.includes('超级无敌小号群') && lastPrompt.includes('路人甲'))

// 2. 冷却：紧接着再 @ 一次，应该被挡住
const r2 = await chat.handleEvent(mk('@青娥鱼 再问一句', { at: true, id: 12 }))
check('冷却生效，不连发', r2 === null && sent.length === 1)

// 3. 概率抽中后不接受模型再次沉默；失败仍交付明确回执
const quiet = createChat(cfg, {
  llmChat: async () => ({ content: JSON.stringify({ speak: false, reply: '', why: '别人在聊' }) }),
  say: async () => {},
  stateFile: null,
  logFile: null,
})
quiet.selfId('3816283038')
const r3 = await quiet.handleEvent(mk('今天晚饭吃什么好呢', { id: 21, uid: 1002 }))
check('抽中后不被模型false吞掉', r3?.spoke === true)

// 4. 群外消息不处理
const r4 = await chat.handleEvent(mk('@青娥鱼 你好', { at: true, id: 31, gid: '999999' }))
check('不在配置里的群不处理', r4 === null)

// 5. 自己发的消息不回
const r5 = await chat.handleEvent(mk('@青娥鱼 我自己', { at: true, id: 41, uid: 3816283038 }))
check('不回复自己', r5 === null)

// 6. 状态里有频率信息
const st = chat.status()
check('status 可用', st.maxPerHour === 20 && st.groups.includes('887000009'))


/* ── 私聊：管理员记录，访客不留痕 ─────────────────── */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bwq-'))
const dmLog = path.join(tmp, 'chat.log')
cfg.chat.admins = ['9001']
const dm = createChat(cfg, {
  llmChat,
  stateFile: path.join(tmp, 'state.json'),
  logFile: dmLog,
  privateDir: path.join(tmp, 'private'),
})
dm.selfId('3816283038')

const pm = (text, uid, id) => ({
  post_type: 'message',
  message_type: 'private',
  user_id: uid,
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: '某人' },
  message: [{ type: 'text', data: { text } }],
})

const a = await dm.handleEvent(pm('在吗，帮我看看设置', '9001', 101))
check('管理员私聊会回复', a?.spoke === true)
check('私聊走 send_private_msg', sentPrivate.length === 1 && String(sentPrivate[0].user_id) === '9001')
const log1 = fs.readFileSync(dmLog, 'utf8')
check('管理员的消息落盘', log1.includes('帮我看看设置'))

const g = await dm.handleEvent(pm('我的手机号是13800000000', '8002', 102))
check('普通群友私聊也会回复', g?.spoke === true)
const log2 = fs.readFileSync(dmLog, 'utf8')
check('访客内容不落盘', !log2.includes('13800000000'))
check('访客只留一条未记录标记', log2.includes('访客消息'))
const outs = log2.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'out').length
check('访客回复不写日志', outs === 1, `out=${outs}`)

/* ── 管理员不限次数，但重复投递只回一次 ───────────── */

sentPrivate.length = 0
const gap = (pc = 0) => new Promise((r) => setTimeout(r, pc))

const burst = []
for (let i = 0; i < 5; i++) burst.push(await dm.handleEvent(pm('连发第' + (i + 1) + '条', '9001', 300 + i)))
check('管理员连发 5 条全部回复', burst.every((r) => r?.spoke === true), `实际 ${burst.filter((r) => r?.spoke).length}/5`)
check('5 条都真的发出去了', sentPrivate.length === 5, `sent=${sentPrivate.length}`)

const dup1 = await dm.handleEvent(pm('同一条消息', '9001', 999))
const dup2 = await dm.handleEvent(pm('同一条消息', '9001', 999))
check('首次投递正常回复', dup1?.spoke === true)
check('重复投递被拦下', dup2?.spoke === false && dup2?.why === '重复投递')

sentPrivate.length = 0
let guestSpoke = 0
for (let i = 0; i < 3; i++) {
  const r = await dm.handleEvent(pm('访客连发' + i, '8003', 700 + i))
  if (r?.spoke) guestSpoke++
  await gap(10)
}
check('访客连发仍受频率限制', guestSpoke === 1, `实际回复 ${guestSpoke}/3`)

fs.rmSync(tmp, { recursive: true, force: true })

server.close()
fs.rmSync(testData,{recursive:true,force:true})
const ok = results.every(Boolean)
console.log(ok ? '\n全部通过' : `\n${results.filter((x) => !x).length} 项失败`)
process.exit(ok ? 0 : 1)
