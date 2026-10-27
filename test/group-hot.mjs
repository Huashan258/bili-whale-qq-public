/**
 * 离线自测：WebUI 里加群之后，能不能不重启就生效。
 *
 * 曾经的 bug：createChat() 在启动时把群白名单算成一个 Set 存起来，
 * 而设置页只写 qq.groupIds、chat.groups 还留着旧的两三个群。
 * 结果新加的群被静默过滤（handleEvent 直接 return null，连日志都不写），
 * 表现就是「加了群但它一直不说话」。
 *
 * 跑：node test/group-hot.mjs
 */
import { createChat } from '../src/chat.mjs'

const sent = []
const cfg = {
  qq: { onebotHttp: 'http://127.0.0.1:3999', accessToken: '', groupIds: ['111'] },
  llm: { provider: 'x', apiKey: 'x', model: 'x' },
  chat: { nick: '青娥鱼', groups: ['111'], minGapSec: 0, maxPerHour: 0, contextMessages: 8, speakChance: 1 },
}

const llmChat = async () => ({ content: JSON.stringify({ speak: true, reply: '来了', why: '被点名' }) })
const chat = createChat(cfg, { llmChat, stateFile: null, logFile: null, say: async (_c, gid) => { sent.push(gid) } })
chat.selfId('3816283038')

const mk = (gid, id) => ({
  post_type: 'message',
  message_type: 'group',
  group_id: String(gid),
  group_name: '测试群' + gid,
  user_id: 1001,
  message_id: id,
  time: Math.floor(Date.now() / 1000),
  sender: { nickname: '路人', card: '路人甲' },
  message: [{ type: 'text', data: { text: '@青娥鱼 在吗' } }],
})

const results = []
const check = (name, ok, extra = '') => {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`)
}

// 1. 未配置的群：必须安静
const r1 = await chat.handleEvent(mk(222, 1))
check('没配的群不回应', r1 === null && sent.length === 0)

// 2. 模拟 agent.mjs 的 watchConfig（Object.assign 换掉整个 chat 对象）
Object.assign(cfg, {
  chat: { ...cfg.chat, groups: ['111', '222'] },
  qq: { ...cfg.qq, groupIds: ['111', '222'] },
})

const r2 = await chat.handleEvent(mk(222, 2))
check('热更新后新群立刻能说话', r2?.spoke === true && sent.length === 1, JSON.stringify(r2))

// 3. 只改了 qq.groupIds（设置页的写法），chat.groups 还是旧的：应当取并集
Object.assign(cfg, {
  chat: { ...cfg.chat, groups: ['111'] },
  qq: { ...cfg.qq, groupIds: ['111', '333'] },
})

const r3 = await chat.handleEvent(mk(333, 3))
check('只改 groupIds 也能生效（并集）', r3?.spoke === true && sent.length === 2)

// 4. status() 报告的群列表要跟着走（此时 chat.groups=["111"]，groupIds 有 333）
const st = chat.status()
check('status 里能看到并集', JSON.stringify(st.groups) === JSON.stringify(['111', '333']), JSON.stringify(st.groups))

const ok = results.every(Boolean)
console.log(ok ? `\n全部通过（${results.length} 项）` : `\n有 ${results.filter((x) => !x).length} 项失败`)
process.exit(ok ? 0 : 1)
