/**
 * 主人视频评论区回复 / B站额度 的离线测试。
 * 不联网、不调模型、不发评论，只验证「谁该回、额度算得对不对」。
 */
import assert from 'node:assert/strict'
import { pickTargets } from '../src/bili-reply.mjs'
import { quotaOf, noteComment, dayBucket, today, gapLeftMs } from '../src/quota.mjs'
import { normalizeMasters } from '../src/config.mjs'

let pass = 0
const ok = (name, fn) => {
  try { fn(); pass++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1 }
}

const now = Math.floor(Date.now() / 1000)
const cfg = { raw: { bili: { dedeUserId: '880010003' } }, share: { blockKeywords: ['政治'], masterReplyWithinDays: 3 } }
const master = { mid: '880010005', name: '示例管理员' }
const comments = [
  { rpid: '1', mid: '111', uname: '路人A', text: '这个操作确实稳，我上周试过', ctime: now - 3600 },
  { rpid: '2', mid: '880010003', uname: '自己', text: '这条是我自己发的', ctime: now - 3600 },
  { rpid: '3', mid: '880010005', uname: '主人', text: '主人自己说的话', ctime: now - 3600 },
  { rpid: '4', mid: '222', uname: '老人', text: '四天前留的言', ctime: now - 4 * 86400 },
  { rpid: '5', mid: '333', uname: '水军', text: '顶', ctime: now - 100 },
  { rpid: '6', mid: '444', uname: '广告哥', text: '加群领福利 https://x.xx', ctime: now - 200 },
  { rpid: '7', mid: '555', uname: '键政', text: '这波政治局势怎么看', ctime: now - 300 },
  { rpid: '8', mid: '666', uname: '两个字', text: '好', ctime: now - 300 },
  { rpid: '9', mid: '777', uname: '路人B', text: '第二关那个走位我也没看懂', ctime: now - 7200 },
]

console.log('pickTargets')
ok('只留下三天内、有内容的普通观众', () => {
  assert.deepEqual(pickTargets(cfg, {}, comments, { master, withinDays: 3 }).map((x) => x.rpid), ['1', '9'])
})
ok('已回复过的不再回', () => {
  assert.deepEqual(pickTargets(cfg, { replied: { 1: {} } }, comments, { master, withinDays: 3 }).map((x) => x.rpid), ['9'])
})
ok('天数可调：1 天时老评论也进不来', () => {
  const list = [{ rpid: 'a', mid: '1', uname: 'x', text: '昨天说的还行', ctime: now - 2 * 86400 }]
  assert.equal(pickTargets(cfg, {}, list, { master, withinDays: 1 }).length, 0)
  assert.equal(pickTargets(cfg, {}, list, { master, withinDays: 3 }).length, 1)
})
ok('空评论区不报错', () => {
  assert.deepEqual(pickTargets(cfg, {}, [], { master }), [])
  assert.deepEqual(pickTargets(cfg, {}, null, { master }), [])
})

console.log('quota')
const cfgq = { share: { biliCommentPerDay: 3, masterCommentPerDay: 1, masterReplyPerDay: 2 } }
ok('每个主人每天只能发 1 条评论', () => {
  const s = {}
  assert.equal(quotaOf(cfgq, s, '880010005', 'comment').ok, true)
  noteComment(cfgq, s, '880010005', 'comment')
  assert.equal(quotaOf(cfgq, s, '880010005', 'comment').ok, false)
  assert.match(quotaOf(cfgq, s, '880010005', 'comment').why, /这个主人/)
})
ok('回复和评论分开计，但共用总量', () => {
  const s = {}
  noteComment(cfgq, s, '880010005', 'reply')
  noteComment(cfgq, s, '880010005', 'reply')
  assert.equal(quotaOf(cfgq, s, '880010005', 'reply').ok, false) // 回复 2/2
  assert.equal(quotaOf(cfgq, s, '880010005', 'comment').ok, true) // 评论还没发
  assert.equal(quotaOf(cfgq, s, '880010005', 'reply').total, 2)
})
ok('账号总量到顶后谁都不许发', () => {
  const s = {}
  noteComment(cfgq, s, 'a', 'reply')
  noteComment(cfgq, s, 'b', 'comment')
  noteComment(cfgq, s, 'c', 'reply')
  const q = quotaOf(cfgq, s, 'd', 'comment')
  assert.equal(q.ok, false)
  assert.match(q.why, /总共/)
})
ok('跨天自动归零', () => {
  const s = { commentDaily: { day: '2000-01-01', total: 99, byMid: { x: 9 } } }
  assert.equal(dayBucket(s).total, 0)
  assert.equal(s.commentDaily.day, today())
  assert.equal(quotaOf(cfgq, s, 'x', 'comment').ok, true)
})
ok('旧版 byMid=数字 的结构能读进来', () => {
  const s = { commentDaily: { day: today(), byMid: { '880010005': 1 } } }
  assert.equal(quotaOf(cfgq, s, '880010005', 'comment').ok, false)
})
ok('额度可以设成 0（等于关掉）', () => {
  const c0 = { share: { biliCommentPerDay: 0, masterCommentPerDay: 1 } }
  assert.equal(quotaOf(c0, {}, 'x', 'comment').ok, false)
})
ok('两次发言间隔按上次写入时间算', () => {
  assert.ok(gapLeftMs({ share: { biliGapSec: 30 } }, { lastBiliWrite: new Date().toISOString() }) > 0)
  assert.equal(gapLeftMs({ share: { biliGapSec: 30 } }, { lastBiliWrite: new Date(Date.now() - 60_000).toISOString() }), 0)
  assert.equal(gapLeftMs({ share: { biliGapSec: 30 } }, {}), 0)
})

console.log('masters')
ok('replyComments 默认关，只有显式 true 才开', () => {
  const list = normalizeMasters([{ mid: '1', name: 'A' }, { mid: '2', replyComments: true }, '34567'])
  assert.deepEqual(list.map((x) => x.replyComments), [false, true, false])
})
ok('开关只认布尔 true（字符串 "true" 不算）', () => {
  assert.equal(normalizeMasters([{ mid: '1', replyComments: 'true' }])[0].replyComments, false)
})

console.log(`\n${pass} 项通过`)
