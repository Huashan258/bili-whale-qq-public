import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-stickers-'))
process.env.BILI_WHALE_DATA=dir
const {createStickerStore,createStickerPicker}=await import('../src/qq-stickers.mjs')
const {createChat}=await import('../src/chat.mjs')
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII='
const store=createStickerStore({dir:path.join(dir,'library')})
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,voice:{enabled:true,chance:1,maxChars:80},contextMessages:0,shield:{enabled:true,maxOutputTokens:20000}}}
let bot
try {
  let state=store.snapshot()
  assert.equal(state.items.length,0)
  assert.throws(()=>store.save({action:'upload',revision:'stale',name:'测试',description:'开心',base64:png}),/更新/)
  assert.throws(()=>store.save({action:'upload',revision:state.revision,name:'测试',description:'开心',base64:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')}),/图片/)
  state=store.save({action:'upload',revision:state.revision,name:'<b>开心鲸</b>',description:'开心、被夸奖时使用，悲伤时不要用',base64:png})
  const id=state.items[0].id
  assert.equal(store.read(id).type,'image/png')
  assert.throws(()=>store.read('../config.json'),/不存在/)
  assert.deepEqual(store.read(id).bytes,Buffer.from(png,'base64'))
  state=store.save({action:'settings',revision:state.revision,enabled:true,chance:1,cooldownSec:60})
  let calls=0,usage=0,clock=100000,selected=id
  const picker=createStickerPicker({store,random:()=>0,now:()=>clock,llmChat:async(_,opts)=>{calls++;assert.equal(opts.thinking,'disabled');assert.match(opts.user,/开心鲸/);assert.match(opts.user,/你好/);return {content:JSON.stringify({id:selected}),usage:{total:7}}}})
  const pick=key=>picker({cfg,text:'你好',reply:'开心呀',key,onUsage:u=>usage+=u.total})
  assert.equal((await pick('group:1')).id,id);assert.equal(usage,7)
  assert.equal(await pick('group:1'),null);assert.equal(calls,1,'同会话冷却不重复调用')
  selected='../config.json';assert.equal(await pick('group:2'),null,'模型不能指定任意文件')
  selected='';assert.equal(await pick('group:3'),null,'不匹配时不发图')
  selected=id
  state=store.save({action:'update',revision:state.revision,id,name:'开心鲸',description:'打招呼、开心',enabled:false})
  const before=calls;assert.equal(await pick('group:4'),null);assert.equal(calls,before,'禁用图片不调用模型')
  state=store.save({action:'update',revision:state.revision,id,name:'开心鲸',description:'打招呼、开心',enabled:true})
  const stopped=new AbortController();stopped.abort();assert.equal(await picker({cfg,text:'你好',reply:'你好',key:'stopped',signal:stopped.signal}),null)
  const broken=createStickerPicker({store,random:()=>0,llmChat:async()=>{throw Error('timeout')}})
  assert.equal(await broken({cfg,text:'你好',reply:'你好',key:'failed'}),null)
  const deactivating=createStickerPicker({store,random:()=>0,llmChat:async()=>{
    state=store.save({action:'settings',revision:state.revision,enabled:false,chance:1,cooldownSec:0})
    return {content:JSON.stringify({id})}
  }})
  assert.equal(await deactivating({cfg,text:'你好',reply:'你好',key:'disabled-during-selection'}),null,'选图途中关闭不发送图片')
  state=store.save({action:'settings',revision:state.revision,enabled:true,chance:1,cooldownSec:60})
  cfg.chat.voice.enabled=false
  const sent=[];let voices=0,mode='ok',modelCalls=0
  bot=createChat(cfg,{stickerStore:store,stickerRandom:()=>0,stateFile:null,logFile:null,privateDir:dir,logger:{},voiceRandom:()=>0,
    sendVoice:async()=>voices++,llmChat:async(_,opts)=>{modelCalls++;return {content:opts.system.includes('挑一张已有表情包')?JSON.stringify({id}):'你好呀，见到你很开心！',usage:{total:3}}},
    say:async(_,gid,segs,ctx)=>{sent.push({gid,segs,ctx});if(mode==='unknown')throw Error('回执未知')},sayPrivate:async(_,uid,segs)=>sent.push({uid,segs})})
  const event=(message_id,priv=false)=>({post_type:'message',message_type:priv?'private':'group',group_id:'123456',user_id:'111111',message_id,sender:{nickname:'测试'},message:[{type:'text',data:{text:'你好呀'}}]})
  await bot.handleEvent(event(1));assert.equal(sent.length,2);assert.equal(sent[1].segs.filter(s=>s.type==='image').length,1);assert.equal(sent[0].segs.filter(s=>s.type==='text').length,1);assert.equal(voices,0);assert.equal(sent[0].ctx.replyToUserId,'111111');assert.equal(modelCalls,2)
  await bot.handleEvent(event(1));assert.equal(sent.length,2,'重复事件不发送')
  cfg.chat.voice.enabled=true
  await bot.handleEvent(event(2));assert.equal(voices,1,'表情间隔不影响正常文字/语音')
  await bot.handleEvent(event(3,true));assert.equal(sent.at(-1).segs.at(-1).type,'image','私聊同样支持图文')
  state=store.save({action:'settings',revision:state.revision,enabled:true,chance:1,cooldownSec:0})
  cfg.chat.voice.enabled=false
  mode='unknown';const n=sent.length;await bot.handleEvent(event(4));assert.equal(sent.length,n+1,'未知发送结果不重试图片或文字')
  assert.equal(bot.status().qqStickers.version,4)
  bot.stop();bot=null
  state=store.save({action:'remove',revision:state.revision,id});assert.throws(()=>store.read(id));assert.equal(state.items.length,0)
  console.log('QQ表情包通过：上传/用途/热改、类型和路径限制、模型按语境选图或不发、冷却、群私聊文字后单独表情、语音互斥、真实UID、去重、未知回执不重发。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
