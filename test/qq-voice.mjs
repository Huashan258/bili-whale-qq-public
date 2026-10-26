import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-voice-'))
process.env.BILI_WHALE_DATA=dir
const {voiceEligible,createQQVoiceSender}=await import('../src/qq-voice.mjs')
const {createChat}=await import('../src/chat.mjs')
const {validatePatch}=await import('../src/settings.mjs')
const voice={enabled:true,maxChars:80,chance:1,character:'lucy-voice-xueling'}
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,voice,contextMessages:0,shield:{enabled:true,maxOutputTokens:20000}}}
const event=(id,privateChat=false)=>({post_type:'message',message_type:privateChat?'private':'group',group_id:'123456',user_id:'111111',message_id:id,sender:{nickname:'测试'},message:[{type:'text',data:{text:'你好呀'}}]})
let bot
try {
  assert.equal(voiceEligible('你好呀',voice,()=>.99),true)
  for(const text of ['字'.repeat(81),'https://b23.tv/example','```js\n1```','|列|列|','1. 第一点','😀😀'])assert.equal(voiceEligible(text,voice,()=>0),false,text)
  assert.equal(voiceEligible('你好',{...voice,chance:0},()=>0),false)
  assert.equal(voiceEligible('你好',{...voice,enabled:false},()=>0),false)
  assert.equal(voiceEligible('你好',{...voice,chance:.35},()=>.5),false)
  let speech
  const make=createQQVoiceSender({send:async(_,gid,character,text,opts)=>{speech={gid,character,text,signal:opts.signal,uid:opts.replyToUserId};return {message_id:123}}})
  assert.equal((await make('你好','123456',cfg,{replyToUserId:'111111'})).message_id,123)
  assert.equal(speech.character,voice.character);assert.equal(speech.uid,'111111')
  const controller=new AbortController();controller.abort(Error('已停止'))
  await assert.rejects(make('你好','123456',cfg,{signal:controller.signal}),/已停止/)
  const sent=[];let voiceCalls=0,mode='ok',modelFailure=false,modelCalls=0
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},voiceRandom:()=>0,sendVoice:async(text,gid,config,ctx)=>{voiceCalls++;if(mode==='unknown')throw Error('回执未知');if(mode==='rejected')throw Object.assign(Error('服务返回失败但可能已发布'),{onebotRejected:true});sent.push({voice:true,ctx,text});return {message_id:voiceCalls}},llmChat:async()=>{modelCalls++;if(modelFailure)throw Error('fixture');return {content:'你好呀，今天有什么想聊的？',usage:{total:5}}},say:async(_,gid,segs,ctx)=>sent.push({segs,ctx}),sayPrivate:async(_,uid,segs)=>sent.push({segs,private:true})})
  bot.selfId('999999')
  await bot.handleEvent(event(1));assert.equal(sent.at(-1).voice,true);assert.equal(sent.at(-1).ctx.replyToUserId,'111111')
  assert.equal(modelCalls,1,'语音不多调一次聊天模型')
  assert.equal(bot.status().diagnostics.recent.at(-1).voice.format,'voice')
  const before=sent.length;await bot.handleEvent(event(1));assert.equal(sent.length,before);assert.equal(voiceCalls,1,'重复投递不发送')
  mode='rejected';const prev=sent.length;await bot.handleEvent(event(3));assert.equal(sent.length,prev,'原生发布可能已完成，服务返回失败也不补发文字')
  mode='unknown';await bot.handleEvent(event(4));assert.equal(sent.length,prev,'回执不明不补发文字')
  mode='ok';const n=voiceCalls;await bot.handleEvent(event(5,true));assert.equal(voiceCalls,n);assert.equal(sent.at(-1).segs[0].type,'text','私聊保留文字')
  cfg.chat.voice.enabled=false;await bot.handleEvent(event(6));assert.equal(voiceCalls,n,'开关热读')
  cfg.chat.voice.enabled=true;modelFailure=true;await bot.handleEvent(event(7));assert.equal(voiceCalls,n,'服务错误回执不读语音')
  assert.deepEqual(validatePatch({'chat.voice.chance':.35}),{'chat.voice.chance':.35})
  for(const patch of [{'chat.voice.chance':1.1},{'chat.voice.maxChars':2},{'chat.voice.maxChars':5.5},{'chat.voice.character':'unknown'}])assert.throws(()=>validatePatch(patch))
  bot.stop()
  // 模拟真实SnowLuma：语音接口自身就发布，不能再发record段。
  const originalFetch=globalThis.fetch,requests=[]
  globalThis.fetch=async(_,opts)=>{requests.push(JSON.parse(opts.body));return new Response(JSON.stringify({status:'ok',retcode:0,data:{message_id:999}}))}
  try {
    cfg.qq.onebotHttp='http://fixture'
    bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},voiceRandom:()=>0,llmChat:async()=>({content:'你好呀',usage:{total:1}})})
    await bot.handleEvent(event(8));assert.equal(requests.length,1);assert.equal(requests[0].action,'send_group_ai_record')
    assert.equal(requests[0].params.character,voice.character)
    assert.equal(bot.status().diagnostics.recent.at(-1).delivered,1)
    // 原生接口失败或缺回执同样不能触发第二次发送。
    globalThis.fetch=async(_,opts)=>{requests.push(JSON.parse(opts.body));return new Response(JSON.stringify({status:'failed',retcode:1200}))}
    const count=requests.length;await bot.handleEvent(event(9));assert.equal(requests.length,count+1)
    bot.stop()
    let release,ready
    const started=new Promise(resolve=>ready=resolve)
    bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},voiceRandom:()=>0,llmChat:async()=>{ready();await new Promise(resolve=>release=resolve);return {content:'你好呀',usage:{total:1}}}})
    const pending=bot.handleEvent(event(10));await started;bot.stop();release();await pending;assert.equal(requests.length,count+1,'发送前停机不再请求')
  }finally{globalThis.fetch=originalFetch}
  console.log('QQ语音通过：单次原生发布、不转发record、不额外调模型、真实UID、群私聊、设置热改、去重、失败和未知回执不补发、停机不发送。')

}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
