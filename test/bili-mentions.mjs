import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-mentions-'));process.env.BILI_WHALE_DATA=dir
const {mentionTarget,runBiliMentions}=await import('../src/bili-mentions.mjs')
const {composePatrolReply}=await import('../src/bili-patrol.mjs')
const cfg={raw:{bili:{dedeUserId:'999'}},masters:[{mid:'123',name:'主人'}],llm:{provider:'fixture',apiKey:'fixture'},biliInbox:{mentionsEnabled:true},share:{biliCommentPerDay:60,masterReplyPerDay:20}}
let time=Date.now(),state={},sends=0,reads=0,lists=0,mode='ok',generated
const row={user:{mid:123,nickname:'主人'},at_time:Math.floor(time/1000),item:{business_id:1,type:'reply',uri:'https://www.bilibili.com/video/BV1b7nk6WExb',subject_id:123456,source_id:111,root_id:0,source_content:'@鱼 周末给你装上',at_details:[{mid:999,nickname:'鱼'}]}}
try {
  assert.equal(mentionTarget(row,cfg,time).rpid,'111')
  assert.equal(mentionTarget({...row,at_time:time/1000-9*86400},cfg,time),null)
  assert.equal(mentionTarget({...row,item:{...row.item,business_id:11}},cfg,time),null)
  assert.equal(mentionTarget({...row,item:{...row.item,at_details:[{mid:1}]}},cfg,time),null)
  const deps={dataDir:dir,now:()=>time,load:()=>structuredClone(state),save:s=>state=s,list:async()=>{lists++;return [row]},verify:async t=>({...t,text:row.item.source_content}),info:async()=>({aid:'123456',title:'真实视频'}),readVideo:async()=>{reads++;return mode==='defer'?'【指定视频尚未读取成功】':'字幕实际内容：全自动搬史机。'},compose:async(_,opts)=>{generated=opts;assert.equal(opts.mentioned,true);assert.match(opts.videoContext,/全自动/);assert.equal(opts.target.text,'周末给你装上');return '主人，先等等，这台搬史机的活儿也太离谱了吧！'},send:async(_,opts)=>{sends++;assert.equal(opts.root,'111');assert.equal(opts.parent,'111');const ledger=JSON.parse(fs.readFileSync(path.join(dir,'bili-mentions.json')));assert.equal(ledger['999'].entries['111'].status,'pending');if(mode==='unknown')throw Error('回执未知');return {rpid:'222'}}}
  mode='defer';assert.equal((await runBiliMentions(cfg,deps)).sent,0);assert.equal(sends,0,'未读取视频不能编造后回复')
  assert.equal((await runBiliMentions(cfg,deps)).sent,0);assert.equal(lists,1,'持久化五分钟间隔')
  time+=301000;mode='ok';assert.equal((await runBiliMentions(cfg,deps)).sent,1);assert.equal(sends,1);assert.ok(state.replied['111'].mention)
  time+=301000;await runBiliMentions(cfg,deps);assert.equal(sends,1,'重启和巡检状态都去重')
  row.item.source_id=333;row.item.root_id=111;time+=301000;mode='unknown';await assert.rejects(runBiliMentions(cfg,{...deps,send:async()=>{sends++;throw Error('回执未知')}}),/回执未知/)
  time+=301000;await runBiliMentions(cfg,deps);assert.equal(sends,2,'未知结果不再次发送')
  const before=lists;await runBiliMentions({...cfg,biliInbox:{mentionsEnabled:false}},deps);assert.equal(lists,before)
  let prompt
  await composePatrolReply(cfg,{target:{mid:'123',rpid:'111',text:'周末装上'},dialogue:'视频标题',mentioned:true,videoContext:'【实际字幕】真的读到的视频字幕',llmChat:async(_,opts)=>{prompt=opts;return {content:'主人，这个发明也太离谱了，先别给我装呀。'}}})
  assert.match(prompt.user,/真的读到的视频字幕/);assert.match(prompt.system,/@你/)
  console.log('B站@通过：真实作者/视频提醒筛选、旧提醒排除、每五分钟一页一条、先读视频/失败等待、素材进入真实提示词、根楼/楼中楼定位、发送前pending、巡检去重/重启/未知回执不重发、开关。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
