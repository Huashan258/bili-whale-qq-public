import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'video-at-policy-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {explicitAtSelf,withoutVideoLinks}=await import('../src/video-link-policy.mjs')
const {prepareDeepReply}=await import('../src/deep-reply.mjs')
const botList=[]
try{
 const url='https://b23.tv/fixture',bv='BV1pjwazUET1'
 assert.equal(explicitAtSelf('[CQ:at,qq=999]'+url,'999'),true)
 for(const m of ['@999 '+url,[{type:'at',data:{qq:'all'}}],[{type:'at',data:{qq:'888'}}]])assert.equal(explicitAtSelf(m,'999'),false)
 const clean=withoutVideoLinks(url+' '+bv+' https://www.youtube.com/watch?v=abc https://fgo.wiki/w/首页')
 assert.equal(clean.text,'https://fgo.wiki/w/首页');assert.equal(clean.blocked,true)
 const cfg={qq:{groupIds:['123']},llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'鱼',aliases:['鱼'],replyEveryMessage:false,speakChance:0,outputRateOnly:true,deepReply:{enabled:true},search:{enabled:true},shield:{enabled:false}}}
 const reads=[],searches=[],prompts=[],sent=[],requests=[]
 const bot=createChat(cfg,{readVideo:async r=>{reads.push(r);return '\n视频实际素材'},lookup:async i=>{searches.push(i);return {ok:true,source:i.source,results:[]}},llmChat:async(_m,p)=>{prompts.push(p);return {content:'本仙在，先接着聊。'}},say:async(_c,_g,m)=>sent.push(m),sayPrivate:async(_c,_u,m)=>sent.push(m),onVideoRequest:async()=>{requests.push(1);return {sent:true}},readQuoted:async ev=>Array.isArray(ev.message)&&ev.message.some(s=>s.type==='reply')?({id:'77',self:true,verified:true,text:'旧消息'}):null,stateFile:null,logFile:null,privateDir:dir,logger:{}});bot.selfId('999');botList.push(bot)
 const event=(id,message)=>({post_type:'message',message_type:'group',group_id:123,user_id:456,message_id:id,message})
 const text=t=>({type:'text',data:{text:t}})
 // A bare link, @someone else and @all cannot commit a zero-probability reply.
 await bot.handleEvent(event(1,[text(url)]));assert.equal(reads.length,0);assert.equal(searches.length,0)
 await bot.handleEvent(event(2,[{type:'at',data:{qq:'888'}},text(url)]));assert.equal(reads.length,0);assert.equal(searches.length,0)
 await bot.handleEvent(event(3,[{type:'at',data:{qq:'all'}},text(url)]));assert.equal(reads.length,0)
 await bot.handleEvent(event(4,[text('鱼 '+url)]));assert.equal(reads.length,0)
 await bot.handleEvent(event(40,[{type:'reply',data:{id:'77'}},text(url)]));assert.equal(reads.length,0,'引用本仙仍不等于明确@')
 const card={type:'json',data:{data:JSON.stringify({meta:{news:{qqdocurl:url}}})}}
 await bot.handleEvent(event(5,[card]));assert.equal(reads.length,0)
 assert.ok(searches.every(i=>!JSON.stringify(i).includes(url)),'普通抽中/昵称/引用/卡片不能走网页兜底读取视频')
 assert.ok(prompts.every(p=>p.system.includes('视频读取条件')))
 cfg.chat.replyEveryMessage=true
 await bot.handleEvent(event(50,[card]));assert.equal(reads.length,0,'必回也不自动解析链接卡片')
 await bot.handleEvent(event(51,[text('给我来个视频')]));assert.equal(requests.length,0,'未@不触发随机点播')
 cfg.chat.replyEveryMessage=false
 await bot.handleEvent(event(6,[{type:'at',data:{qq:'999'}},text(url)]));assert.equal(reads.length,1)
 await bot.handleEvent({...event(7,[text(url)]),message_type:'private'});assert.equal(reads.length,2,'私聊仍可直接读取')
 const before=searches.length
 const opts={replyConfig:cfg,replyVideoLinksAllowed:false,styleTask:url,system:'自然回复',user:url,replyLookup:async()=>{throw Error('纯链接不应搜索')}}
 const prepared=await prepareDeepReply(cfg.llm,opts);assert.match(prepared.system,/所带视频链接或BV号未读取/)
 assert.equal(searches.length,before)
 let wiki
 await prepareDeepReply(cfg.llm,{...opts,styleTask:url+' https://fgo.wiki/w/首页',replyLookup:async i=>{wiki=i;return {ok:true,source:'page',results:[]}}});assert.deepEqual(wiki.urls,[new URL('https://fgo.wiki/w/首页').href])
 const historyFile=path.join(dir,'history.log');fs.writeFileSync(historyFile,JSON.stringify({ts:new Date(Date.now()-30000).toISOString(),type:'in',channel:'group',group:'123',uid:'456',id:'old',from:'管理员',text:url})+'\n')
 const historyOptions=[]
 const restored=createChat({...cfg,chat:{...cfg.chat,admins:['456'],historyRestore:5,historyReplyWindowSec:600}},{stateFile:null,logFile:historyFile,privateDir:dir,logger:{},lookup:async()=>{throw Error('无@旧链接不应搜索')},llmChat:async(_m,p)=>{historyOptions.push(p);return {content:JSON.stringify({speak:false,reply:''})}},say:async()=>{}});restored.selfId('999');botList.push(restored)
 await restored.restoreHistory({fetchHistory:async()=>[]});assert.equal(historyOptions.length,1);assert.equal(historyOptions[0].replyVideoLinksAllowed,false);assert.match(historyOptions[0].system,/视频读取条件/)
 console.log('视频@规则通过：原生/CQ明确@、无@/@别人/@全体/昵称/引用/卡片不解析、网页兜底不绕过、非视频网页保留、私聊保留。无真实QQ或B站请求。')
}finally{botList.forEach(b=>b.stop());fs.rmSync(dir,{recursive:true,force:true})}
