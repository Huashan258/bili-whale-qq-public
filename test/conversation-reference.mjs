import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reference-'));process.env.BILI_WHALE_DATA=dir
const {referenceContext}=await import('../src/conversation-reference.mjs')
const {createChat}=await import('../src/chat.mjs')
const {QINGE_PERSONA}=await import('../src/persona.mjs')
let bot
try{
 const now=Date.now(),cfg={contextMessages:1,learnedStyle:{zhugeEnabled:true}}
 const recent=[{uid:'123',text:'我的鱼像人了一点',ts:Math.floor(now/1000)-10},{uid:'456',text:'不相关人的游戏话题',ts:Math.floor(now/1000)-5}]
 const lastReply={uid:'123',text:'才一点呀？',at:now-3000}
 const context=referenceContext(cfg,'好了又不是人了',{uid:'123',recent,lastReply,now})
 assert.match(context,/我的鱼像人了一点/);assert.match(context,/才一点呀/);assert.match(context,/不能擅自换成/);assert.doesNotMatch(context,/游戏话题/)
 assert.equal(referenceContext({...cfg,contextMessages:0},'又不是人了',{uid:'123',recent,lastReply,now}),'')
 assert.equal(referenceContext(cfg,'又不是人了',{uid:'789',recent,lastReply,now}),'')
 assert.equal(referenceContext(cfg,'又不是人了',{uid:'123',recent,lastReply,now:now+181000}),'')
 assert.equal(referenceContext(cfg,'写一篇文章说明诸葛亮的历史地位',{uid:'123',recent,lastReply,now}),'')
 const prompts=[],sent=[]
 const c={llm:{provider:'fixture',apiKey:'fixture'},qq:{groupIds:['880010002']},chat:{...cfg,persona:QINGE_PERSONA,replyEveryMessage:true,outputRateOnly:true,admins:['123'],search:{enabled:false},shield:{enabled:false}}}
 bot=createChat(c,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_m,o)=>{prompts.push(o);return {content:prompts.length===1?'才一点呀？':'哪句又说怪了？'}},say:async(_c,_g,m)=>sent.push(m)})
 const event=(text,id)=>({post_type:'message',message_type:'group',group_id:'880010002',user_id:'123',message_id:id,message:[{type:'text',data:{text}}]})
 await bot.handleEvent(event('我的鱼像人了一点',1));await bot.handleEvent(event('好了又不是人了',2))
 assert.match(prompts[1].user,/短句承接线索/);assert.match(prompts[1].user,/我的鱼像人了一点/);assert.match(prompts[1].user,/本仙当时实际回复「才一点呀？/)
 assert.equal(c.chat.contextMessages,1,'不更改用户原上下文设置')
 c.chat.contextMessages=0
 await bot.handleEvent(event('还是不像',3));assert.doesNotMatch(prompts[2].user,/短句承接线索/)
 assert.equal(sent.length,3)
 console.log('省略承接通过：日志场景/真实已发送答复/同一人且三分钟内/跨人隔离/长任务不补/显式0不补/不改上下文设置。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
