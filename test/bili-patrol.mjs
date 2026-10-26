/**
 * B 站评论区巡检的离线测试。
 * 不联网、不调模型、不发评论：只验证「挑哪些视频 / 挑哪些楼层 / 对话链怎么拼 / 幂不幂等」。
 *
 * 跑：node test/bili-patrol.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ⚠ 测试绝不能写真实 .data/state.json。
 * 2026-10-19 真出过事：本文件跑完把假的 aid=170001 / rpid=R1 写进真实 state，
 * 巡检拿着假 aid 去翻别人的视频，主人在我们评论底下回的「oi」两小时没人接。
 * 所以先把 BILI_WHALE_DATA 指到临时目录，**再**动态载入被测模块（config.mjs 在 import 时就定死了 DATA）。
 */
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-whale-patrol-'))
process.env.BILI_WHALE_DATA = TMP_DATA

// 生产 state 的快照：跑完必须一个字节都没变（P0-1 的回归锁）
const REAL_STATE_FILE = fileURLToPath(new URL('../.data/state.json', import.meta.url))
const realStateBefore = fs.existsSync(REAL_STATE_FILE) ? fs.readFileSync(REAL_STATE_FILE, 'utf8') : null
let saves = 0 // 生产落盘次数（测试一律用只写内存的桩，这里应当永远是 0）

const { bvidOf, patrolVideos, pickReplyFloors, buildDialogue, findOwnRoots, runPatrol, composePatrolReply } = await import('../src/bili-patrol.mjs')

let pass = 0
let fail = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`) }
}
const okAsync = async (name, fn) => {
  try { await fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`) }
}

const SELF = '880010003'
const MASTER = '880010005'
const now = Math.floor(Date.now() / 1000)

const cfg = {
  raw: { bili: { dedeUserId: SELF } },
  llm: { provider: 'deepseek', apiKey: 'k', model: 'm' },
  masters: [{ mid: MASTER, name: '示例管理员' }],
  share: { masterReplyPerVideo: 2, replyPatrolWithinDays: 7, replyWatchVideos: [], biliGapSec:0 },
}

/* ────────────── bvidOf ────────────── */
console.log('bvidOf')
ok('认 BV 号 / 整条链接 / 对象', () => {
  assert.equal(bvidOf('BV1KEpn6cEf1'), 'BV1KEpn6cEf1')
  assert.equal(bvidOf('https://www.bilibili.com/video/BV1KEpn6cEf1/?p=1'), 'BV1KEpn6cEf1')
  assert.equal(bvidOf({ bvid: 'BV1KEpn6cEf1' }), 'BV1KEpn6cEf1')
})
ok('认不出来的返回空，不抛', () => {
  assert.equal(bvidOf(''), '')
  assert.equal(bvidOf(null), '')
  assert.equal(bvidOf('av170001'), '')
})

/* ────────────── patrolVideos ────────────── */
console.log('patrolVideos')
ok('手动名单 + 发过评论的视频，去重后合成一份', () => {
  const c = { ...cfg, share: { ...cfg.share, replyWatchVideos: ['BV1KEpn6cEf1'] } }
  const s = { commented: { BV1KEpn6cEf1: { rpid: '9', mid: MASTER, at: '2026-10-01T00:00:00Z' }, BV1aa1111111: { rpid: '5', mid: MASTER, at: '2026-10-09T00:00:00Z' } } }
  const list = patrolVideos(c, s)
  assert.deepEqual(list.map((x) => x.bvid), ['BV1KEpn6cEf1', 'BV1aa1111111'])
  assert.equal(list[0].rpid, '9')
})
ok('没发过评论也能靠手动名单兜底', () => {
  const c = { ...cfg, share: { ...cfg.share, replyWatchVideos: ['BV1KEpn6cEf1'] } }
  const list = patrolVideos(c, { commented: {} })
  assert.equal(list.length, 1)
  assert.equal(list[0].rpid, '') // 没发过评论，靠 mid 认自己
})
ok('同一个 BV 只出现一次', () => {
  const c = { ...cfg, share: { ...cfg.share, replyWatchVideos: ['BV1KEpn6cEf1', 'https://www.bilibili.com/video/BV1KEpn6cEf1'] } }
  const s = { commented: { BV1KEpn6cEf1: { rpid: '9' } } }
  assert.equal(patrolVideos(c, s).length, 1)
})
ok('视频太多时只取最近的（新评论更可能有人回）', () => {
  const s = { commented: { BV1aaaaaaaaa: { at: '2026-01-01T00:00:00Z' }, BV1bbbbbbbbb: { at: '2026-10-10T00:00:00Z' } } }
  const list = patrolVideos({ ...cfg, share: { ...cfg.share, replyPatrolMaxVideos: 1 } }, s)
  assert.equal(list.length, 1)
  assert.equal(list[0].bvid, 'BV1bbbbbbbbb')
})

/* ────────────── pickReplyFloors ────────────── */
console.log('pickReplyFloors')
const floors = [
  { rpid: 'f1', mid: '111', uname: '路人A', text: '这操作我练了三天', ctime: now - 3600, root: 'R', parent: 'R' },
  { rpid: 'f2', mid: SELF, uname: '我自己', text: '我上一句回的话', ctime: now - 3500, root: 'R', parent: 'f1' },
  { rpid: 'f3', mid: MASTER, uname: '示例管理员', text: '对，我也觉得这里最难', ctime: now - 3400, root: 'R', parent: 'R' },
  { rpid: 'f4', mid: '222', uname: '路人B', text: '顶', ctime: now - 100 },
  { rpid: 'f5', mid: '333', uname: '老考古', text: '三个月前留的言', ctime: now - 90 * 86400 },
  { rpid: 'f6', mid: '444', uname: '空内容', text: '   ', ctime: now - 100 },
]
ok('排除自己、排除空内容、排除超期', () => {
  const got = pickReplyFloors(cfg, {}, { floors, masters: [MASTER], selfMid: SELF })
  assert.deepEqual(got.map((x) => x.rpid), ['f3', 'f1', 'f4'])
})
ok('主人排在最前，且不看时间', () => {
  const old = [{ rpid: 'x', mid: MASTER, uname: '主人', text: '很久以前说的', ctime: now - 200 * 86400 }]
  const got = pickReplyFloors(cfg, {}, { floors: old, masters: [MASTER], selfMid: SELF })
  assert.equal(got.length, 1)
  assert.equal(got[0].master, true)
  assert.equal(got[0].priority, 2)
})
ok('回过的楼层不再回（幂等）', () => {
  const got = pickReplyFloors(cfg, { replied: { f3: {}, f1: {} } }, { floors, masters: [MASTER], selfMid: SELF })
  assert.deepEqual(got.map((x) => x.rpid), ['f4'])
})
ok('非主人按时间从旧到新', () => {
  const many = [
    { rpid: 'b', mid: '1', uname: 'B', text: '后说的', ctime: now - 10 },
    { rpid: 'a', mid: '2', uname: 'A', text: '先说的', ctime: now - 100 },
  ]
  assert.deepEqual(pickReplyFloors(cfg, {}, { floors: many, masters: [], selfMid: SELF }).map((x) => x.rpid), ['a', 'b'])
})
ok('withinDays=0 时不看时间', () => {
  const got = pickReplyFloors({ ...cfg, share: { ...cfg.share, replyPatrolWithinDays: 0 } }, {}, { floors, masters: [], selfMid: SELF })
  assert.ok(got.some((x) => x.rpid === 'f5'))
})
ok('没有 dedeUserId 就不认自己（宁可漏，别自言自语）', () => {
  const got = pickReplyFloors({ raw: { bili: {} } }, {}, { floors: [floors[1]], masters: [], selfMid: '' })
  assert.equal(got.length, 1)
})
ok('空楼层不报错', () => {
  assert.deepEqual(pickReplyFloors(cfg, {}, { floors: null, masters: [] }), [])
  assert.deepEqual(pickReplyFloors(cfg, {}, { floors: [], masters: [] }), [])
})

/* ────────────── buildDialogue ────────────── */
console.log('buildDialogue')
ok('根评论在最前，自己说的话标 self', () => {
  const d = buildDialogue({
    rootComment: { rpid: 'R', text: '这条是我发的评论', ctime: now - 4000 },
    floors,
    selfMid: SELF,
    masters: [MASTER],
    title: '测试视频',
    nick: '青娥鱼',
  })
  assert.equal(d.lines[0].root, true)
  assert.equal(d.lines[0].self, true)
  assert.equal(d.lines.find((l) => l.rpid === 'f3').master, true)
  assert.equal(d.lines.find((l) => l.rpid === 'f2').self, true)
  assert.match(d.text, /^视频：《测试视频》/)
  assert.match(d.text, /青娥鱼（我）：这条是我发的评论/)
})
ok('主人的楼层带【主人】标记，模型才知道该谁优先', () => {
  const d = buildDialogue({ rootComment: { rpid: 'R', text: 'x' }, floors, selfMid: SELF, masters: [MASTER] })
  assert.match(d.text, /【主人】示例管理员/)
})
ok('没有根评论也能拼（只有楼中楼）', () => {
  const d = buildDialogue({ floors: [floors[0]], selfMid: SELF, masters: [] })
  assert.equal(d.lines.length, 1)
  assert.equal(d.lines[0].root, false)
})
ok('对话太长只留最后 N 条', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ rpid: `r${i}`, mid: '1', uname: `u${i}`, text: `第${i}句`, ctime: now - (30 - i) }))
  const d = buildDialogue({ rootComment: { rpid: 'R', text: 'root' }, floors: many, maxLines: 10 })
  assert.equal(d.lines.length, 10)
  assert.equal(d.lines[d.lines.length - 1].rpid, 'r29')
})
ok('单条过长会被截断，别把整栋楼撑爆', () => {
  const d = buildDialogue({ floors: [{ rpid: 'x', mid: '1', uname: 'u', text: '喵'.repeat(500) }], maxLines: 5 })
  assert.ok(d.text.length < 200)
})

/* ────────────── findOwnRoots ────────────── */
console.log('findOwnRoots')
ok('记了 rpid 就精确匹配，同时也认自己发的其它楼', () => {
  const list = [{ rpid: 'R', mid: '999', text: 'a' }, { rpid: 'X', mid: SELF, text: 'b' }]
  assert.deepEqual(findOwnRoots(list, { rpid: 'R', selfMid: SELF }).map((x) => x.rpid), ['R', 'X'])
})
ok('同一条只算一次', () => {
  const list = [{ rpid: 'R', mid: SELF, text: 'a' }, { rpid: 'R', mid: SELF, text: 'a' }]
  assert.deepEqual(findOwnRoots(list, { rpid: 'R', selfMid: SELF }).map((x) => x.rpid), ['R'])
})
ok('没记 rpid 时按 mid 认自己', () => {
  const list = [{ rpid: 'A', mid: '999', text: 'a' }, { rpid: 'B', mid: SELF, text: 'b' }]
  assert.deepEqual(findOwnRoots(list, { rpid: '', selfMid: SELF }).map((x) => x.rpid), ['B'])
})
ok('一条都不匹配就返回空', () => {
  assert.deepEqual(findOwnRoots([{ rpid: 'A', mid: '999' }], { rpid: 'R', selfMid: SELF }), [])
  assert.deepEqual(findOwnRoots(null, { rpid: 'R' }), [])
})

/* ────────────── runPatrol（注入假接口） ────────────── */
const mkState = () => ({
  commented: { BV1KEpn6cEf1: { rpid: 'R1', mid: MASTER, aid: '170001', title: '测试视频' } },
  replied: {},
  commentDaily: { day: new Date().toISOString().slice(0, 10), total: 0, byMid: {} },
})

const mkHooks = (over = {}) => {
  const sent = []
  return {
    sent,
    // ⚠ 落盘桩：只数次数，什么都不写。
    // 以前 runPatrol 直接 import saveState，测试跑一次就把 mkState() 这份假数据
    // 写进生产 .data/state.json —— 那是"AI 不回主人"的直接诱因。
    save: () => { saves++ },
    info: async () => ({ aid: '170001', title: '测试视频' }),
    listComments: async () => [{ rpid: 'R1', root: 'R1', parent: 'R1', mid: SELF, uname: '我', text: '我发的评论', ctime: now - 5000, count: 3 }],
    listReplies: async () => [
      { rpid: 'f1', root: 'R1', parent: 'R1', mid: '111', uname: '路人A', text: '这操作我练了三天', ctime: now - 4000 },
      { rpid: 'f2', root: 'R1', parent: 'f1', mid: SELF, uname: '我', text: '我回过一句', ctime: now - 3900 },
      { rpid: 'f3', root: 'R1', parent: 'R1', mid: MASTER, uname: '主人', text: '对，这里最难', ctime: now - 3800 },
    ],
    compose: async () => '确实，我到现在都过不去',
    send: async (_c, o) => { sent.push(o); return { ok: true, rpid: `new${sent.length}` } },
    ...over,
  }
}

await okAsync('主人优先：同一轮里主人那条排在最前面', async () => {
  const s = mkState()
  const h = mkHooks()
  const r = await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 2) // masterReplyPerVideo=2：主人 + 路人A
  assert.equal(h.sent[0].parent, 'f3', '主人的那条要先回')
  assert.equal(h.sent[0].root, 'R1')
  assert.equal(h.sent[0].text, '确实，我到现在都过不去')
  assert.ok(s.replied.f3 && s.replied.f1, '两条都要记账，下次不回')
})

await okAsync('单视频单轮最多 masterReplyPerVideo 条', async () => {
  const s = mkState()
  const h = mkHooks()
  const c1 = { ...cfg, share: { ...cfg.share, masterReplyPerVideo: 1 } }
  const r = await runPatrol(c1, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 1)
  assert.equal(h.sent[0].parent, 'f3')
})

await okAsync('幂等：回过的楼层第二轮不再回', async () => {
  const s = mkState()
  const h = mkHooks()
  await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.equal(h.sent.length, 2)
  const h2 = mkHooks()
  const r2 = await runPatrol(cfg, s, { ...h2, logger: () => {} })
  assert.equal(r2.sent, 0)
  assert.equal(h2.sent.length, 0)
})

await okAsync('单视频单轮最多 masterReplyPerVideo 条（按条数截）', async () => {
  const s = mkState()
  const h = mkHooks({ listReplies: async () => Array.from({ length: 9 }, (_, i) => ({ rpid: `g${i}`, root: 'R1', parent: 'R1', mid: `9${i}`, uname: `u${i}`, text: `第${i}个人的话`, ctime: now - 100 - i })) })
  const c2 = { ...cfg, share: { ...cfg.share, masterReplyPerVideo: 3 } }
  const r = await runPatrol(c2, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 3)
})

await okAsync('普通观众额度用完就停，不会硬发（主人另有无限额规则）', async () => {
  const s = mkState()
  s.commentDaily = { day: new Date().toISOString().slice(0, 10), total: 60, byMid: {} }
  const h = mkHooks({listReplies:async()=>[{rpid:'guest-cap',root:'R1',parent:'R1',mid:'8888',uname:'普通观众',text:'在吗',ctime:now}]})
  const c3 = { ...cfg, share: { ...cfg.share, biliCommentPerDay: 60 } }
  const r = await runPatrol(c3, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 0)
  assert.match(r.why, /到上限/)
})

await okAsync('没人回过的楼不去拉楼中楼（count=0）', async () => {
  const s = mkState()
  let called = 0
  const h = mkHooks({
    listComments: async () => [{ rpid: 'R1', mid: SELF, uname: '我', text: 'x', count: 0 }],
    listReplies: async () => { called++; return [] },
  })
  const r = await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 0)
  assert.equal(called, 0)
})

await okAsync('dry 只打印不发送、也不记账', async () => {
  const s = mkState()
  const printed = []
  const h = mkHooks({ send: async () => { throw new Error('预演不该真发') } })
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: (m) => printed.push(m) })
  assert.equal(r.sent, 0)
  assert.equal(r.planned.length, 2)
  assert.equal(Object.keys(s.replied).length, 0) // 预演不写账，下次还能看
  assert.ok(printed.length > 0)
})

await okAsync('撞风控就立刻停手（不接着打接口）', async () => {
  const s = mkState()
  let tries = 0
  const h = mkHooks({ send: async () => { tries++; throw new Error('发评论失败：code=-412 被风控拦了') } })
  const r = await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 0)
  assert.equal(tries, 1, '-412 之后不该再试第二条')
})

await okAsync('没有 dedeUserId / 没配模型 / 没有视频：安静退出', async () => {
  const noSelf = await runPatrol({ ...cfg, raw: { bili: {} } }, mkState(), { ...mkHooks(), logger: () => {} })
  assert.equal(noSelf.sent, 0)
  assert.match(noSelf.why, /dedeUserId/)
  const noLLM = await runPatrol({ ...cfg, llm: { provider: 'none', apiKey: '' } }, mkState(), { ...mkHooks(), logger: () => {} })
  assert.match(noLLM.why, /模型未配置/)
  const noVideo = await runPatrol(cfg, { commented: {}, replied: {} }, { ...mkHooks(), logger: () => {} })
  assert.match(noVideo.why, /没有要巡检的视频/)
})

await okAsync('读评论区失败不炸，只记账', async () => {
  const s = mkState()
  const h = mkHooks({ listComments: async () => { throw new Error('读评论区失败：code=12002 评论太频繁') } })
  const r = await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 0)
  assert.match(r.why, /12002/)
})

/* ────────────── 真实楼层结构回归（BV1KEpn6cEf1） ────────────── */
/**
 * 2026-10-19 的线上现场：我们在 BV1KEpn6cEf1 发了条评论（rpid 321240743872），
 * 主人示例管理员在楼中楼回了一句「oi」（rpid 321241643424），两小时没人接。
 * 这里把那栋楼的结构原样搬进来（只改 rpid 前缀防误伤真实数据），
 * 断言「主人那条一定被选中、并且真的会生成回复」。
 */
console.log('真实楼层结构（BV1KEpn6cEf1）')

const REAL_BV = 'BV1KEpn6cEf1'
const REAL_AID = '117422526827117'
const REAL_ROOT = '321240743872'
const REAL_FLOOR = '321241643424'
const REAL_CTIME = 1792417758 // 2026-10-19 21:40:36 GMT+8

const realComments = [
  { rpid: '321241000000', root: '321241000000', parent: '321241000000', mid: '99999999', uname: '别的观众', text: '前排', ctime: REAL_CTIME - 500, count: 0 },
  { rpid: REAL_ROOT, root: REAL_ROOT, parent: REAL_ROOT, mid: SELF, uname: '核动力大肥鱼攻略组', text: '古风歌词配街霸6，你这鸟确实自由得有点抽象；那段丢个丢个重复三次时我脑子跟着词飞了', ctime: REAL_CTIME - 522, count: 1 },
]

const realFloors = [
  { rpid: REAL_FLOOR, root: REAL_ROOT, parent: REAL_ROOT, mid: MASTER, uname: '示例管理员', text: 'oi', ctime: REAL_CTIME },
]

const realState = () => ({
  // ✅ 关键：aid 必须是真的。之前被测试写成 170001，巡检就跑去翻别人的视频了
  commented: { [REAL_BV]: { rpid: REAL_ROOT, mid: MASTER, aid: REAL_AID, title: '【街霸6】我们是最自由的鸟', at: '2026-10-19T13:40:35.960Z' } },
  replied: {},
  commentDaily: { day: new Date().toISOString().slice(0, 10), total: 3, byMid: {} },
})

const realHooks = (over = {}) => {
  const calls = { comments: 0, replies: 0, sent: [] }
  return {
    calls,
    save: () => { saves++ }, // 同上：测试不落盘
    info: async () => ({ aid: REAL_AID, title: '【街霸6】我们是最自由的鸟' }),
    // aid 不对就返回「别人的视频」的评论——真实接口就是这样，不会贴心地报错
    listComments: async (_c, o) => {
      calls.comments++
      calls.lastOid = o.aid
      if (String(o.aid) === REAL_AID) return realComments
      return [{ rpid: '999000000', root: '999000000', parent: '999000000', mid: '12345678', uname: '陌生人', text: '这是别的视频的评论', ctime: REAL_CTIME, count: 0 }]
    },
    listReplies: async (_c, o) => { calls.replies++; calls.lastOid = o.aid; calls.lastRoot = o.root; return realFloors },
    // 把喂给模型的对话链留下来：N2 那条用例要靠它验证「我们自己那条根评论在不在里面」
    compose: async (_c, o) => {
      calls.dialogue = String(o?.dialogue?.text ?? o?.dialogue ?? '')
      return 'oi～你终于来了，我还以为你把我忘在这楼里了'
    },
    send: async (_c, o) => { calls.sent.push(o); return { ok: true, rpid: '321242000000' } },
    ...over,
  }
}

await okAsync('真实结构：主人的「oi」被选中（含 aid 是从 state 里取的真 aid）', async () => {
  const s = realState()
  const h = realHooks()
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(h.calls.lastOid, REAL_AID, `巡检用的 aid 必须是真的，实际 ${h.calls.lastOid}`)
  assert.equal(h.calls.lastRoot, REAL_ROOT, '楼中楼要拉我们自己那条根评论底下的')
  assert.equal(r.planned.length, 1)
  assert.match(r.planned[0], /321241643424|oi/)
  assert.match(r.planned[0], /oi～你终于来了/)
})

await okAsync('真实结构：超短文本「oi」不会被空内容过滤掉', async () => {
  const got = pickReplyFloors(cfg, {}, { floors: realFloors, masters: [MASTER], selfMid: SELF })
  assert.deepEqual(got.map((x) => x.rpid), [REAL_FLOOR])
  assert.equal(got[0].master, true)
  assert.equal(got[0].text, 'oi')
})

await okAsync('真实结构：主人的回复不看 replyPatrolWithinDays 时间窗', async () => {
  const old = [{ ...realFloors[0], ctime: Math.floor(Date.now() / 1000) - 30 * 86_400 }]
  const got = pickReplyFloors(cfg, {}, { floors: old, masters: [MASTER], selfMid: SELF })
  assert.equal(got.length, 1, '等了一个月也要回主人')
})

await okAsync('真实结构：对话链里主人带【主人】标记、我们那条在最前', async () => {
  const d = buildDialogue({
    rootComment: realComments[1], floors: realFloors, selfMid: SELF, masters: [MASTER],
    title: '【街霸6】我们是最自由的鸟', nick: '青娥鱼',
  })
  assert.equal(d.lines[0].rpid, REAL_ROOT)
  assert.equal(d.lines[0].self, true)
  assert.match(d.text, /【主人】示例管理员：oi/)
})

await okAsync('真实结构：没记 rpid 也能靠 dedeUserId 认出自己那条根评论', async () => {
  const s = realState()
  s.commented[REAL_BV].rpid = '' // 模拟历史记录里没存 rpid
  const h = realHooks()
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(r.planned.length, 1)
  assert.equal(h.calls.lastRoot, REAL_ROOT)
})

await okAsync('真实结构：aid 错（170001）+ rpid 也丢了 + videoInfo 挂了 → 安静退出不炸', async () => {
  // 2026-10-19 的病根就是 aid 被写成 170001（生产上真的翻不到自己那条）。
  // 现在正常情况下会被自愈纠正（上面那条用例）；
  // 这条覆盖最坏情况：自愈也救不了、rpid 也没记 —— 必须安静退出，不能把进程搞崩。
  const s = realState()
  s.commented[REAL_BV].aid = '170001'
  s.commented[REAL_BV].rpid = ''
  const h = realHooks({ info: async () => { throw new Error('videoInfo 挂了') } })
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(r.planned.length, 0)
  assert.match(r.why, /复核 aid 失败|没找到自己发的评论/)
})

await okAsync('真实结构：实发时挂在主人那条下面（root=我们的评论，parent=主人那条）', async () => {
  const s = realState()
  const h = realHooks()
  const r = await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.equal(r.sent, 1)
  assert.equal(h.calls.sent[0].root, REAL_ROOT)
  assert.equal(h.calls.sent[0].parent, REAL_FLOOR)
  assert.ok(s.replied[REAL_FLOOR], '回过要记账，重启也不会再回一遍')
})

/* ────────────── 垃圾话口径（产品拍板：楼中楼不过滤） ────────────── */
ok('「oi」「顶」「哈哈」这种超短/垃圾话**必须**被选中（有意为之，别顺手统一口径）', () => {
  // 楼中楼是「有人在跟 AI 说话」的场景：主人说「oi」「顶」也是在对它说话，接一句是对的。
  // bili-reply.mjs 那套 ≥4 字 + JUNK 规则是给「回陌生人一级评论」定的，场景不同，**不要**搬过来。
  const junk = [
    { rpid: 'j1', mid: MASTER, uname: '示例管理员', text: 'oi', ctime: now - 30 },
    { rpid: 'j2', mid: '555', uname: '路人', text: '顶', ctime: now - 20 },
    { rpid: 'j3', mid: '556', uname: '路人2', text: '哈哈', ctime: now - 10 },
  ]
  const got = pickReplyFloors(cfg, {}, { floors: junk, masters: [MASTER], selfMid: SELF })
  assert.deepEqual(got.map((x) => x.rpid), ['j1', 'j2', 'j3'])
  assert.equal(got[0].master, true, '主人那句排最前')
})

/* ────────────── aid 自愈（P0-2） ────────────── */
await okAsync('aid 写错成合法数字（170001）时会自动纠正并找到真实评论', async () => {
  const s = realState()
  s.commented[REAL_BV].aid = '170001' // ← 生产上真出过这个
  const h = realHooks()
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(s.commented[REAL_BV].aid, REAL_AID, 'aid 要被改回真的')
  assert.equal(h.calls.lastOid, REAL_AID, '重扫时用的是纠正后的 aid')
  assert.equal(r.planned.length, 1)
  assert.match(r.planned[0], /oi～你终于来了/)
})

await okAsync('已知根评论不扫一级列表，有回复待发时仅核对一次 aid', async () => {
  const s = realState()
  const h = realHooks()
  let infoCalls = 0
  const hh = { ...h, info: async () => { infoCalls++; return { aid: REAL_AID, title: 'x' } } }
  const r = await runPatrol(cfg, s, { ...hh, dry: true, logger: () => {} })
  assert.equal(infoCalls, 1, '直读楼中楼后，发送前只核对一次 aid')
  assert.equal(h.calls.comments,0,'已知根评论不应扫一级列表')
  assert.equal(r.planned.length, 1)
})

/* ────────────── rpid 反查兜底（P0-4 / D-7） ────────────── */
const strangerOnly = () => [{ rpid: '999000001', mid: '777', uname: '别人', text: 'x', ctime: REAL_CTIME, count: 0 }]

await okAsync('楼太深扫不到时，按记下的 rpid 直接读这栋楼（不跳过）', async () => {
  const s = realState()
  // 模拟「评论太多，我们那条被挤出 pages 页」：一级评论里根本不出现我们
  const h = realHooks({ listComments: async () => strangerOnly() })
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(h.calls.lastRoot, REAL_ROOT, '兜底要用记下的 rpid 去拉楼中楼')
  assert.equal(r.planned.length, 1)
})

/* ── N1：兜底必须排在 aid 复核前面，否则每轮白打一次 videoInfo ── */
await okAsync('N1：评论被挤出 pages 且那栋楼没人回 → 一次 videoInfo 都不打', async () => {
  // QA 用真接口实测：反过来的话 3 条视频 × 每 30 分钟 = 一天白打 144 次。
  const s = realState()
  let infoCalls = 0
  let seenRoot = ''
  const h = realHooks({
    listComments: async () => strangerOnly(),
    listReplies: async (_c, o) => { seenRoot = String(o.root); return [] }, // 没人回
    info: async () => { infoCalls++; return { aid: REAL_AID, title: 'x' } },
  })
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(seenRoot, REAL_ROOT, '还是走了兜底')
  assert.equal(infoCalls, 0, '没人回的楼不该为了复核 aid 去打 videoInfo')
  assert.equal(r.planned.length, 0)
})

ok('N2 兜底：正文取不到时也要留一行说明（不能让模型蒙在鼓里瞎接）', () => {
  // 兜底路径常常拿不到根评论正文（评论被挤出 pages 页，且历史记录里没存 text）。
  // 这时候宁可明说「没取到」，也别让对话链里干脆没有我们自己那条。
  const d = buildDialogue({
    rootComment: { rpid: REAL_ROOT, text: '', ctime: 0 },
    floors: realFloors, selfMid: SELF, masters: [MASTER], nick: '青娥鱼',
  })
  assert.equal(d.lines[0].root, true)
  assert.equal(d.lines[0].rpid, REAL_ROOT)
  assert.equal(d.lines[0].missingText, true)
  assert.match(d.text, /没取到正文/)
  assert.match(d.text, /【主人】示例管理员：oi/)
})

/* ── N2：兜底路径的对话链里必须有我们自己那条根评论 ── */
await okAsync('N2：兜底时自己那条根评论在对话链里（模型不是只看到楼中楼）', async () => {
  const s = realState()
  s.commented[REAL_BV].text = '古风歌词配街霸6，你这鸟确实自由得有点抽象'
  const h = realHooks({ listComments: async () => strangerOnly() })
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(r.planned.length, 1)
  assert.ok(h.calls.dialogue?.includes('古风歌词配街霸6'), `对话链里缺我们自己那条：${h.calls.dialogue}`)
  assert.ok(h.calls.dialogue?.includes('【主人】示例管理员：oi'), '楼中楼也还在')
})

/* ── 兜底路径真发前必须校验 aid（oid 错了会把回复挂到别人的视频上） ── */
await okAsync('兜底路径真发前会校验 aid，且发出去时用纠正后的 aid', async () => {
  const s = realState()
  s.commented[REAL_BV].aid = '170001' // rpid 对、aid 错
  let infoCalls = 0
  const h = realHooks({
    listComments: async (_c, o) => (String(o.aid) === REAL_AID ? realComments : strangerOnly()),
    info: async () => { infoCalls++; return { aid: REAL_AID, title: 'x' } },
  })
  const r = await runPatrol(cfg, s, { ...h, logger: () => {} }) // 非 dry：真发
  assert.equal(infoCalls, 1, '真要说话时才值得花这一次 videoInfo')
  assert.equal(s.commented[REAL_BV].aid, REAL_AID, 'aid 要被纠正')
  assert.equal(r.sent, 1)
  assert.equal(h.calls.sent[0].aid, REAL_AID, '绝不能拿着 170001 发出去')
})

/* ────────────── dry 必须零副作用（P0-3） ────────────── */
await okAsync('dry 时一个字节都不落盘（aid 自愈也只在内存里改）', async () => {
  const s = realState()
  s.commented[REAL_BV].aid = '' // 逼它走「查 aid」这条会落盘的分支
  const before = saves
  const h = realHooks({ save: () => { throw new Error('预演居然落盘了') } })
  const r = await runPatrol(cfg, s, { ...h, dry: true, logger: () => {} })
  assert.equal(r.planned.length, 1)
  assert.equal(s.commented[REAL_BV].aid, REAL_AID, '内存里可以纠正')
  assert.equal(saves, before, '但磁盘一次都没写')
})

await okAsync('非 dry 时才落盘', async () => {
  const s = realState()
  s.commented[REAL_BV].aid = ''
  const before = saves
  const h = realHooks()
  await runPatrol(cfg, s, { ...h, logger: () => {} })
  assert.ok(saves > before, '实发要记账')
})

/* ── V6：跨重启幂等 —— replied 从「盘」读回后再跑一轮必须为 0 ── */
await okAsync('重启幂等：把 state 落盘再读回来重跑，回过的楼层一条都不再回', async () => {
  // 真正的重启 = 内存没了、state 从磁盘重新 load。这里用 JSON 往返模拟读写盘，
  // 比"同一个对象跑两遍"更接近现实（QA 点名要的）。
  let disk = null
  const s1 = realState()
  const h1 = realHooks({ save: (st) => { disk = JSON.parse(JSON.stringify(st)) } })
  const r1 = await runPatrol(cfg, s1, { ...h1, logger: () => {} })
  assert.equal(r1.sent, 1)
  assert.ok(disk, '要真的写过一次"盘"')

  const s2 = JSON.parse(JSON.stringify(disk)) // ← 重启后 loadState()
  const h2 = realHooks({ save: () => {} })
  const r2 = await runPatrol(cfg, s2, { ...h2, logger: () => {} })
  assert.equal(r2.sent, 0, '重启不该把回过的楼再回一遍')
  assert.equal(h2.calls.sent.length, 0)
  assert.ok(s2.replied[REAL_FLOOR], 'replied 必须真的落了盘，否则重启就失忆')
})

await okAsync('HTML 拦截立即停整轮，冷却落盘后重启不再发请求', async () => {
  const state = mkState()
  let reads = 0, disk
  const hooks = mkHooks({ listComments: async () => { reads++; throw new Error('B站评论接口 HTTP 412，返回非 JSON 页面') }, save: st => { disk = JSON.parse(JSON.stringify(st)) } })
  const result = await runPatrol(cfg, state, {...hooks, logger:()=>{}})
  assert.equal(reads, 1)
  assert.ok(result.retryAfterMs >= 15 * 60000)
  assert.ok(disk.commentPatrolCooldown.until > Date.now())
  const second = await runPatrol(cfg, JSON.parse(JSON.stringify(disk)), {...hooks, logger:()=>{}})
  assert.equal(reads, 1)
  assert.match(second.why, /冷却中/)
  // 冷却结束后若仍被拦截，继续加倍。
  disk.commentPatrolCooldown.until = Date.now() - 1
  const third = await runPatrol(cfg, disk, {...hooks,logger:()=>{}})
  assert.ok(third.retryAfterMs >= 30 * 60000)
})

await okAsync('楼中楼风控不尝试 aid 自愈或继续发送，成功后清除过期冷却', async () => {
  const state = mkState()
  for (const v of Object.values(state.commented)) v.rpid = '123456789'
  let infoCalls = 0
  const hooks = mkHooks({listComments:async()=>[],listReplies:async()=>{throw new Error('HTTP 429')},info:async()=>{infoCalls++;throw new Error('不该自愈')}})
  const result = await runPatrol(cfg,state,{...hooks,logger:()=>{}})
  assert.equal(result.sent,0)
  assert.equal(infoCalls,0)
  assert.ok(result.retryAfterMs >= 15 * 60000)
  state.commentPatrolCooldown.until = Date.now() - 1
  await runPatrol(cfg,state,{...mkHooks({listComments:async()=>[],listReplies:async()=>[]}),logger:()=>{}})
  assert.equal(state.commentPatrolCooldown,undefined)
})

await okAsync('关闭评论只跳过该视频，其他视频仍能回复，不触发全局冷却', async () => {
  const s=mkState()
  s.commented.BV1sFJd6JEXt={aid:'333',rpid:'R2'}
  let reads=0
  const h=mkHooks({listComments:async()=>{if(++reads===1)throw Object.assign(new Error('评论区已关闭（code=12002）'),{commentClosed:true});return [{rpid:'R1',mid:SELF,text:'根',count:1}]}})
  const result=await runPatrol(cfg,s,{...h,logger:()=>{}})
  assert.equal(reads,2)
  assert.equal(result.retryAfterMs,0)
  assert.equal(s.commentPatrolCooldown,undefined)
  assert.ok(Object.values(s.commentPatrolClosed).length===1)
  assert.ok(result.sent>0,'其他正常视频仍可回复')
})

await okAsync('轮换检查两条视频，下一轮不会一直盯住相同两条', async () => {
  const s=mkState()
  s.commented.BV1sFJd6JEXt={aid:'333',rpid:'1234567'}
  s.commented.BV1ibnV6pEXa={aid:'444',rpid:'7654321'}
  const visited=[]
  const h=mkHooks({listComments:async(_c,o)=>{visited.push(o.bvid);return []},listReplies:async(_c,o)=>{visited.push(o.bvid);return []},info:async()=>({aid:'333'})})
  await runPatrol(cfg,s,{...h,logger:()=>{}})
  await runPatrol(cfg,s,{...h,logger:()=>{}})
  assert.ok(new Set(visited).size>=3)
})

await okAsync('实际评论生成读dialogue.text，不再把对象变成[object Object]，并接受正文直出', async()=>{
  const dialogue=buildDialogue({rootComment:{rpid:'root',text:'这是我先前的评论'},floors:[{rpid:'f',mid:MASTER,text:'在吗',uname:'主人'}],selfMid:SELF,masters:[MASTER]})
  const text=await composePatrolReply(cfg,{dialogue,target:{rpid:'f',mid:MASTER,text:'在吗'},master:cfg.masters[0],llmChat:async(_cfg,p)=>{
    assert.match(p.user,/这是我先前的评论/)
    assert.match(p.user,/在吗/)
    assert.doesNotMatch(p.user,/\[object Object\]/)
    assert.equal(p.json,false)
    return {content:'在呀，我看到了。'}
  }})
  assert.equal(text,'在呀，我看到了。')
})

await okAsync('没有新留言时返回可核对的读取数量，不再静默空why',async()=>{
  const result=await runPatrol(cfg,mkState(),{...mkHooks({listReplies:async()=>[]}),logger:()=>{}})
  assert.equal(result.sent,0)
  assert.ok(result.rootsRead>0)
  assert.equal(result.floorsRead,0)
  assert.match(result.why,/未发现新的待回复留言/)
})

/* ────────────── P0-1 回归锁：生产 state 必须一个字节都没变 ────────────── */
ok(`跑完测试后生产 .data/state.json 内容不变（落盘次数 ${saves} 次，全是内存桩）`, () => {
  const after = fs.existsSync(REAL_STATE_FILE) ? fs.readFileSync(REAL_STATE_FILE, 'utf8') : null
  // ⚠ 这条断言只在**没有常驻 agent 在跑**时才可靠：agent 每轮巡检会自己写 state.json，
  // 正好撞在测试的快照窗口里就会偶发红。看到它红，先确认 `node src/agent.mjs` / 控制台
  // 里那个进程是不是活着——是的话停掉再跑；不是，那就是真的又被测试污染了。
  assert.equal(
    after, realStateBefore,
    '生产状态文件被改了。两种可能：① 又有地方直接 import saveState（真 bug）；'
    + '② 有常驻 agent 正在跑、它自己写的（不是 bug，停掉 agent 再跑一次确认）',
  )
  assert.ok(!fs.existsSync(path.join(TMP_DATA, 'state.json')), '临时目录里也不该有落盘')
})

try { fs.rmSync(TMP_DATA, { recursive: true, force: true }) } catch { /* 临时目录清不掉就算了 */ }

console.log(`\n${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail ? 1 : 0)
