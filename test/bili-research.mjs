import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-research-'));process.env.BILI_WHALE_DATA=dir
const {createBiliResearch}=await import('../src/bili-research.mjs')
const {createChatSearch,searchIntent,searchPrompt,groundedSearchReply}=await import('../src/chat-search.mjs')
const {createBiliPolicy}=await import('../src/bili-policy.mjs')
const rows=Array.from({length:8},(_,i)=>({bvid:`BV${String(i).padStart(10,'0')}`,title:`渡鸦活动资料${i}`,desc:'渡鸦活动测试简介'}))
const material=(bvid)=>({video:{bvid,title:'渡鸦活动测试视频',owner:'测试',duration:60,stat:{},desc:'测试简介'},subtitle:{lines:bvid.endsWith('0')?[]:['这是测试取得的字幕']},collectedAt:new Date().toISOString()})
try {
 let time=100000000,read=0,searches=0,waits=0
 const policy={status:async()=>({nextWatchAt:read?time+360000:0})}
 // 状态随时间推进，确保同一视频只等待一次。
 let nextAt=0
 policy.status=async()=>({nextWatchAt:nextAt})
 const progress=[]
 const research=createBiliResearch({now:()=>time,sleep:async ms=>{waits++;assert.ok(ms<=30000);time+=ms},policy,searchVideos:async(_c,o)=>{searches++;assert.equal(o.limit,20);return rows},collectVideo:async id=>{read++;nextAt=time+360000;return material(id)}})
 const r=await research('渡鸦活动',{}, {onProgress:p=>progress.push(p)})
 assert.equal(r.complete,true);assert.equal(r.videosRead,5);assert.equal(read,5)
 assert.equal(new Set(r.videos.map(v=>v.bvid)).size,5)
 assert.ok(waits>=48);assert.ok(progress.some(p=>p.waiting));assert.equal(time,100000000+24*60000)
 assert.match(searchPrompt(r),/已实际读取5个/);assert.match(searchPrompt(r),/仅标题与简介/)
 assert.equal(searches,1)
 const cached=await research('渡鸦活动',{})
 assert.equal(cached.videosRead,5);assert.equal(read,5,'成功资料缓存不重复扣观看额度')
 const incomplete=createBiliResearch({searchVideos:async()=>[rows[0],rows[0],rows[1]],collectVideo:async()=>{throw Error('不应采集不足五个候选')}})
 const few=await incomplete('渡鸦活动',{})
 assert.equal(few.complete,false);assert.equal(few.videosRead,0)
 assert.match(groundedSearchReply(few,'我已读五个，评价如下','Master'),/尚未完成/)
 let attempts=0
 const backup=createBiliResearch({policy:{status:async()=>({nextWatchAt:0})},searchVideos:async()=>rows,collectVideo:async id=>{attempts++;if(attempts===1)throw Error('单条视频失效');return material(id)}})
 assert.equal((await backup('渡鸦活动',{})).complete,true);assert.equal(attempts,6)
 let secondPage=0
 const paged=createBiliResearch({policy:{status:async()=>({nextWatchAt:0})},searchVideos:async(_c,o)=>{secondPage=o.page;return o.page===1?rows.slice(0,3):rows.slice(3)},collectVideo:async id=>material(id)})
 assert.equal((await paged('渡鸦活动',{})).complete,true);assert.equal(secondPage,2)
 let cmdReads=0,cmdSleep=0
 const command=createBiliResearch({policy:{status:async()=>({nextWatchAt:Date.now()+3600000})},sleep:async()=>{cmdSleep++;throw Error('令咒不应等待本地额度')},searchVideos:async(_c,o)=>{assert.equal(o.commandRead,true);return rows},collectVideo:async(id,_c,o)=>{assert.equal(o.commandRead,true);cmdReads++;return material(id)}})
 const commandResult=await command('渡鸦活动',{}, {commandRead:true})
 assert.equal(commandResult.complete,true);assert.equal(cmdReads,5);assert.equal(cmdSleep,0)
 let cachedCalls=0
 const lookup=createChatSearch({commandResearch:async()=>{cachedCalls++;return commandResult}})
 const intent=searchIntent('锐评三角洲行动这次的渡鸦活动',{command:true})
 assert.deepEqual(intent,{source:'research',query:'三角洲行动 渡鸦活动',commandRead:true,fresh:true})
 await Promise.all([lookup(intent,{}),lookup(intent,{})]);await lookup(intent,{})
 assert.equal(cachedCalls,1)
 assert.equal(groundedSearchReply(commandResult,'依据资料回答','Master'),'依据资料回答')
 const answer='根据两条资料评价 '+r.results[0].url+' '+r.results[1].url
 assert.doesNotMatch(groundedSearchReply(commandResult,answer,'Master'),/https?:/)
 const stopped=new AbortController();stopped.abort()
 assert.equal((await command('渡鸦活动',{}, {commandRead:true,signal:stopped.signal})).complete,false)
 // 令咒只读免本地额度与间隔，仍串行；写入不享有这项豁免。
 let fetched=0,now=100000000
 const p=createBiliPolicy({dataDir:dir,now:()=>now,sleep:async ms=>{now+=ms},fetcher:async(_u,o)=>{assert.equal(o.commandRead,undefined);fetched++;return Response.json({code:0})}})
 for(let i=0;i<12;i++)await p.claim('watch',String(i),{commandRead:true})
 await assert.rejects(()=>p.claim('watch','normal'),/每小时/)
 for(let i=0;i<121;i++)await p.request('https://api.bilibili.com/test',{commandRead:true})
 assert.equal(now,100000000);assert.equal(fetched,121)
 await assert.rejects(()=>p.request('https://api.bilibili.com/test'),/请求上限/)
 await assert.rejects(()=>p.request('https://api.bilibili.com/test',{method:'POST',commandRead:true}),/请求上限/)
 await p.block();await assert.rejects(()=>p.claim('watch','blocked',{commandRead:true}),/全局冷却/)
 // 检查令咒标记穿过真实采集层的所有只读请求，不访问外网。
 const {biliPolicy}=await import('../src/bili-policy.mjs')
 const {collect}=await import('../src/collect.mjs')
 const originalRequest=biliPolicy.request,originalClaim=biliPolicy.claim,urls=[]
 try {
  biliPolicy.claim=async(kind,id,o)=>{assert.equal(kind,'watch');assert.equal(o.commandRead,true)}
  biliPolicy.request=async(url,o)=>{
   assert.equal(o.commandRead,true);urls.push(url)
   if(url.includes('/view?'))return Response.json({code:0,data:{title:'采集标记测试',pages:[{cid:123}],stat:{},owner:{name:'测试'}}})
   if(url.endsWith('/nav'))return Response.json({code:0,data:{wbi_img:{img_url:'https://test/'+ 'a'.repeat(32)+'.png',sub_url:'https://test/'+ 'b'.repeat(32)+'.png'}}})
   if(url.includes('/wbi/v2'))return Response.json({data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://subtitle.test/text'}]}}})
   return Response.json({body:[{content:'测试字幕'}]})
  }
  const m=await collect('BV9999999999',{}, {commandRead:true})
  assert.equal(m.subtitle.lines[0],'测试字幕');assert.equal(urls.length,4)
 }finally{biliPolicy.request=originalRequest;biliPolicy.claim=originalClaim}
 console.log('B站多视频研究通过：五个真实素材门槛/三页候选/去重/正文注入/不足不评价/字幕范围/普通24分钟排队/令咒只读豁免/缓存并发/停止/真实风控与写入不绕过。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
