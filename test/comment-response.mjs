import assert from 'node:assert/strict'
import { commentJSON, isCommentRisk } from '../src/comment-response.mjs'
import { clampUiPatch } from '../dsh-plugin/lib/uicfg.mjs'
import { listRecentComments, listReplyReplies } from '../src/bili-comment.mjs'

for (const status of [200, 403, 412, 429, 502]) {
  await assert.rejects(() => commentJSON(new Response('<!DOCTYPE html><title>blocked</title>', {status})), error => {
    assert.ok(isCommentRisk(error))
    assert.match(error.message, new RegExp(`HTTP ${status}`))
    assert.doesNotMatch(error.message, /Unexpected token/)
    return true
  })
}
await assert.rejects(() => commentJSON(new Response('{}', {status:429,headers:{'retry-after':'1800'}})), error => error.retryAfterMs === 1800000)
await assert.rejects(() => commentJSON(Response.json({code:12002,message:'频繁'})), isCommentRisk)
assert.deepEqual(await commentJSON(Response.json({code:0,data:{replies:[]}})), {code:0,data:{replies:[]}})

assert.equal(clampUiPatch({replyPatrolMinutes:0}).replyPatrolMinutes,0)
assert.equal(clampUiPatch({replyPatrolMinutes:0.1}).replyPatrolMinutes,5)

await assert.rejects(()=>commentJSON(Response.json({code:12002,message:'当前页面评论功能已关闭'})),e=>e.commentClosed && !isCommentRisk(e))

const originalFetch = globalThis.fetch
try {
  for (const read of [listRecentComments, listReplyReplies]) {
    let calls = 0
    globalThis.fetch = async () => ++calls === 1
      ? Response.json({code:0,data:{replies:[{rpid:1,content:{message:'ok'}}]}})
      : new Response('<!DOCTYPE html>', {status:412})
    await assert.rejects(() => read({}, {aid:'1',root:'123456',ps:1,pages:3,request:(...args)=>fetch(...args)}), isCommentRisk)
    assert.equal(calls, 2, '第二页被拦截也要抛出，不能当作读取成功')
  }
} finally { globalThis.fetch = originalFetch }
console.log('comment-response: HTML/HTTP/业务风控码、Retry-After、正常响应和分页中途拦截全部通过')
