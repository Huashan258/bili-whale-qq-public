import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sticker-request-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {stickerRequest}=await import('../src/qq-stickers.mjs')
let bot
try{
  assert.equal(stickerRequest('发一张你喜欢的表情包'),true)
  assert.equal(stickerRequest('来个表情包'),true)
  assert.equal(stickerRequest('不要发表情包'),false)
  assert.equal(stickerRequest('如何制作表情包'),false)
  const id='11111111-1111-1111-1111-111111111111',sent=[],cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:false,speakChance:0,outputRateOnly:true,contextMessages:0,voice:{enabled:true,chance:1,maxChars:80},shield:{enabled:false}}}
  let enabled=true,selected=0,voices=0
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},replySleep:async()=>{},stickerRandom:()=>1,voiceRandom:()=>0,
    stickerStore:{snapshot:()=>({enabled,chance:0,cooldownSec:3600,items:[{id,name:'喜欢',description:'喜欢与开心'}]}),read:()=>({bytes:Buffer.from('fixture')})},
    sendVoice:async()=>voices++,llmChat:async(_,o)=>{
      if(o.system.includes('挑一张已有表情包')){selected++;assert.match(o.system,/明确要求/);return {content:JSON.stringify({id})}}
      assert.match(o.system,/程序可发送已有表情包/)
      return {content:'看看这张，可合心意？'}
    },say:async(_,target,segs)=>sent.push(segs),sayPrivate:async(_,target,segs)=>sent.push(segs)})
  const event=(n,priv=false)=>({post_type:'message',message_type:priv?'private':'group',group_id:'123456',user_id:'111111',message_id:n,sender:{nickname:'测试'},message:[{type:'text',data:{text:'发一张你喜欢的表情包'}}]})
  for(const [n,priv] of [[1,false],[2,false],[3,true]]){
    const before=sent.length;await bot.handleEvent(event(n,priv));assert.equal(sent.length,before+2);assert.equal(sent.at(-1)[0].type,'image')
    const trace=bot.status().diagnostics.recent.find(r=>r.messageId===String(n));assert.equal(trace.sticker.reason,'sent');assert.equal(trace.sticker.explicit,true)
  }
  assert.equal(selected,3,'明确索取绕过0概率和同会话冷却');assert.equal(voices,0,'点图请求不被短语音出口提前结束')
  await bot.handleEvent(event(3,true));assert.equal(selected,3,'重复事件仍去重')
  enabled=false;const before=sent.length;await bot.handleEvent(event(4));assert.equal(selected,3);assert.equal(sent.length,before+1)
  assert.equal(bot.status().diagnostics.recent.find(r=>r.messageId==='4').sticker.reason,'disabled')
  console.log('明确点图通过：零普通回复概率仍处理/绕过随机概率及冷却/群私聊/先选图再告知模型能力/不被语音抢先/文字后图片/诊断回执/重复去重/关闭开关仍尊重。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
