import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-thread-priority-'))
process.env.BILI_WHALE_DATA=dir
const {runOwnVideoReplies}=await import('../src/bili-own-comments.mjs')
const cfg={raw:{bili:{dedeUserId:'887000005'}},masters:[{mid:'887000007'}],share:{biliGapSec:0,biliCommentPerDay:300}}
const video={bvid:'BV1pjwazUET1',aid:'116229364777417',ownerMid:'887000005'}
const now=Math.floor(Date.now()/1000)
const roots=[{rpid:'root-other',mid:'887000007',text:'牢鱼',count:1,ctime:now},{rpid:'root-fish',mid:'887000007',text:'鱼',count:8,ctime:now}]
const initial={replied:{'root-other':{},'root-fish':{}},ownCommentCursor:{[video.bvid]:0},ownCommentThreads:{[video.bvid]:{'root-other':{...roots[0],checkedReplyCount:1},'root-fish':{...roots[1],checkedReplyCount:7}}}}
let visited=[],target
const opts={listComments:async()=>roots,listReplies:async(_,p)=>{visited.push(p.root);return [{rpid:'new-question',mid:'887000007',text:'肥鱼肥鱼我是谁',ctime:now}]},compose:async(_,p)=>{target=p.target;return '主人，你是示例管理员呀'},send:async()=>({rpid:'reply-ok'}),save:()=>{}}
try {
  const dry=structuredClone(initial),snapshot=JSON.stringify(dry.ownCommentThreads)
  assert.equal((await runOwnVideoReplies(cfg,dry,video,{...opts,dry:true})).planned.length,1)
  assert.equal(visited.at(-1),'root-fish','即使游标指向其他楼，也优先检查回复数增长的楼')
  assert.equal(target.rpid,'new-question')
  assert.equal(JSON.stringify(dry.ownCommentThreads),snapshot,'预演不改变已检查计数')
  const state=structuredClone(initial)
  const r=await runOwnVideoReplies(cfg,state,video,opts)
  assert.equal(r.sent,1)
  assert.equal(state.replied['new-question'].rpid,'reply-ok')
  assert.equal(state.ownCommentThreads[video.bvid]['root-fish'].checkedReplyCount,8,'发送后仍保存检查基线')
  visited=[]
  const empty={...opts,listReplies:async(_,p)=>{visited.push(p.root);return []}}
  await runOwnVideoReplies(cfg,state,video,empty)
  assert.equal(visited.length,1,'每轮只读一栋楼，不增加请求')
  const unknown=structuredClone(initial)
  delete unknown.ownCommentThreads[video.bvid]['root-fish'].checkedReplyCount
  await runOwnVideoReplies(cfg,unknown,video,empty)
  assert.equal(unknown.ownCommentThreads[video.bvid]['root-fish'].checkedReplyCount,8,'没有新目标也保存成功读取基线')
  const failed=structuredClone(initial)
  await assert.rejects(runOwnVideoReplies(cfg,failed,video,{...opts,listReplies:async()=>{throw Error('风控')}}),/风控/)
  assert.equal(failed.ownCommentThreads[video.bvid]['root-fish'].checkedReplyCount,7,'读取失败不能确认已检查新回复')
  console.log('新增楼层优先通过：回复数增长优先于游标、精确目标、每轮只读一楼、旧状态迁移、成功基线持久化、读取失败不确认、预演不写。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
