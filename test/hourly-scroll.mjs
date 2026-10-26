import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hourly-scroll-'));process.env.BILI_WHALE_DATA=dir
const {reactionCounts,reactionScore,readVideoReactions}=await import('../src/video-reactions.mjs')
const {runHourlyScroll,readHourlyScroll,hourlyScrollSummary}=await import('../src/hourly-scroll.mjs')
const ids=Array.from({length:10},(_,i)=>'BV'+String(i).padStart(10,'0'))
try{
 const counts=reactionCounts(['???？？妈妈妈妈','妈妈'],['?','？','妈妈'])
 assert.equal(counts.byKeyword['?'],3);assert.equal(counts.byKeyword['？'],2);assert.equal(counts.byKeyword['妈妈'],3);assert.equal(reactionScore(counts),8)
 assert.equal(reactionCounts(['.*.*'],['.*']).total,2,'选词按字面而非正则')
 assert.equal(reactionCounts(['__proto__'],['__proto__']).total,1)
 const cfg={llm:{provider:'fixture',apiKey:'fixture'},qq:{groupIds:['880010002','880010006']},raw:{bili:{dedeUserId:'999'}},chat:{outputRateOnly:true},scroll:{hourlyReactionEnabled:true,reactionKeywords:['?','？','妈妈'],danmakuSample:1000,commentSample:20}}
 const actual=await readVideoReactions({video:{bvid:ids[0],cid:1,aid:2}},cfg,{request:async()=>new Response('<i><d p="1">?？妈妈</d><d p="2">妈妈</d></i>'),listComments:async()=>[{rpid:'1',mid:'123',text:'??'},{rpid:'1',mid:'123',text:'??'},{rpid:'2',mid:'999',text:'妈妈妈妈'}]})
 assert.equal(actual.complete,true);assert.equal(actual.score,6);assert.equal(actual.coverage.comments,1)
 let time=100000000,lastWatch=0,reads=0,model=0,claims=0
 const sent=[],deps={dataDir:dir,now:()=>time,policyStatus:async()=>({nextWatchAt:lastWatch?lastWatch+360000:0,nextShareAt:0}),collect:async id=>{reads++;lastWatch=time;return {video:{bvid:id,title:'视频'+id,aid:1,stat:{},desc:'已读取的简介'},subtitle:{lines:['已读取的官方字幕']}}},readReactions:async m=>{const i=ids.indexOf(m.video.bvid),samples=[i===2?'妈妈'.repeat(20):'?'.repeat(i)];const counts=reactionCounts(samples,cfg.scroll.reactionKeywords);return {samples,counts,score:reactionScore(counts),coverage:{comments:1,danmaku:1},complete:true}},chat:async()=>{model++;return {content:'这段处理挺有意思，来看看。'}},claimShare:async()=>{claims++},sendGroup:async(_c,id,text)=>sent.push({id,text}),sleep:async()=>{}}
 const options={deps},helpers={gather:async()=>ids.map(bvid=>({bvid}))}
 const dry=await runHourlyScroll(cfg,{...options,dry:true},helpers);assert.equal(dry.sent.length,0);assert.equal(reads,0)
 for(let i=0;i<10;i++){
  if(i===5)cfg.scroll.reactionKeywords=['妈妈']
  const r=await runHourlyScroll(cfg,options,helpers)
  assert.equal(sent.length,0,'未满十个且未满本轮一小时，不提前发送')
  assert.equal(readHourlyScroll(dir).items.length,i+1)
  if(i<9)time+=360000
 }
 assert.equal(reads,10);assert.equal(model,0)
 const s=readHourlyScroll(dir)
 assert.equal(s.items[2].reactions.score,20,'本小时旧采样按新词重新计数')
 cfg.scroll.reactionKeywords=['?']
 const view=hourlyScrollSummary(s,cfg)
 assert.equal(view.items[2].score,0,'UI保存选词后立即用已有采样刷新显示')
 cfg.scroll.reactionKeywords=['妈妈']
 time=100000000+3600000
 const r=await runHourlyScroll(cfg,options,helpers)
 assert.equal(r.sent.length,1);assert.equal(sent.length,2);assert.equal(claims,1);assert.equal(model,1);assert.equal(reads,10)
 assert.equal(readHourlyScroll(dir).winner,ids[2]);assert.ok(sent.every(x=>x.text.includes(ids[2])))
 // 已发送批次重载不得再发；下一次只开始新批次采集。
 await runHourlyScroll(cfg,options,{gather:async()=>[]});assert.equal(sent.length,2)
 cfg.scroll.reactionKeywords=[]
 const paused=await runHourlyScroll(cfg,options,helpers);assert.match(paused.why,/选词列表为空/);assert.equal(reads,10)
 // 一群发送回执不明时不盲目重发，也不重发已成功的另一群。
 const failureDir=path.join(dir,'unknown');fs.mkdirSync(failureDir)
 const previous={startedAt:time-3600000,items:s.items,pool:[],status:'waiting-hour',keywords:['妈妈']}
 fs.writeFileSync(path.join(failureDir,'hourly-scroll.json'),JSON.stringify(previous))
 cfg.scroll.reactionKeywords=['妈妈']
 const attempts={}
 const uncertain={...deps,dataDir:failureDir,sendGroup:async(_c,id)=>{attempts[id]=(attempts[id]||0)+1;if(id==='880010002')throw Error('回执不明')}}
 await runHourlyScroll(cfg,{deps:uncertain},helpers)
 await runHourlyScroll(cfg,{deps:uncertain},helpers)
 assert.equal(attempts['880010002'],1);assert.equal(attempts['880010006'],1)
 // 小时模式也读取B站推送开关；先写pending再发，同一获选视频多渠道只占一个额度。
 const syncDir=path.join(dir,'bili-sync');fs.mkdirSync(syncDir)
 fs.writeFileSync(path.join(syncDir,'hourly-scroll.json'),JSON.stringify(previous))
 cfg.scroll.biliPrivateEnabled=true;cfg.scroll.biliPrivateUsers=['880010005']
 let groupSends=0,biliSends=0,shareClaims=0,message='',confirm=false
 const sync={...deps,dataDir:syncDir,policyStatus:async()=>({nextShareAt:shareClaims?time+3600000:0}),claimShare:async()=>shareClaims++,sendGroup:async()=>groupSends++,sendBiliPrivate:async(_c,id,text)=>{
   biliSends++;message=text;assert.equal(id,'880010005')
   assert.equal(readHourlyScroll(syncDir).receipts['bili-private:880010005'].status,'pending','请求前必须落盘回执占位')
   throw Error('回执不明')
 },listBiliPrivate:async()=>confirm?[{sender_uid:'999',receiver_id:'880010005',receiver_type:1,msg_status:0,msg_type:1,msg_key:'confirmed',timestamp:Date.now()/1000,content:JSON.stringify({content:message})}]:[]}
 await runHourlyScroll(cfg,{deps:sync},helpers)
 assert.equal(groupSends,2);assert.equal(biliSends,1);assert.equal(shareClaims,1)
 assert.equal(readHourlyScroll(syncDir).status,'sharing')
 await runHourlyScroll(cfg,{deps:sync},helpers)
 assert.equal(groupSends,2);assert.equal(biliSends,1);assert.equal(shareClaims,1,'同批核对不占用第二次分享额度')
 confirm=true;await runHourlyScroll(cfg,{deps:sync},helpers)
 assert.equal(readHourlyScroll(syncDir).status,'done');assert.equal(biliSends,1)
 assert.equal(hourlyScrollSummary(readHourlyScroll(syncDir),cfg).deliveries.find(t=>t.kind==='bili-private').status,'sent')
 console.log('小时比较通过：十个后且满一小时才选一次/最高选词采样计数/逐条持久化与重载/中途改词无额外访问/UI即时重算/两群只占一个视频分享/空词暂停/预演零观看/字面计数和去重。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
