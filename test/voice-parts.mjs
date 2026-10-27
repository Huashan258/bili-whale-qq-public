import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-parts-'));process.env.BILI_WHALE_DATA=dir
const {splitVoiceReply,voiceEligible}=await import('../src/qq-voice.mjs')
const {createChat}=await import('../src/chat.mjs')
const voice={enabled:true,chance:1,maxChars:35,splitLong:true}
const text='这第一段说的是今天遇到的小事，本仙先慢慢讲给你听。'+'第二段则换个角度想一想，不着急下定论，总有可商量的余地。'+'末了再补一句，今日说到这里，你若有话便接着说。'
const parts=splitVoiceReply(text,voice)
assert.equal(parts.length,3);assert.equal(parts.join(''),text);assert.ok(parts.every(p=>[...p].length<=35))
assert.equal(voiceEligible(text,voice,()=>0),true)
const fifth='这句话用来核对第五段。'.repeat(5),fiveParts=splitVoiceReply(fifth,{...voice,maxChars:15})
assert.equal(fiveParts.length,5);assert.equal(fiveParts.join(''),fifth)
assert.deepEqual(splitVoiceReply(fifth+'这句话用来核对第六段。',{...voice,maxChars:15}),[])
assert.deepEqual(splitVoiceReply(text,{...voice,splitLong:false}),[])
assert.deepEqual(splitVoiceReply('字'.repeat(110),voice),[])
assert.deepEqual(splitVoiceReply('“'+text+'”',voice),[],'不拆开过长引语')
assert.deepEqual(splitVoiceReply('https://example.com/'+text,voice),[])
let draws=0;voiceEligible(text,voice,()=>{draws++;return 0});assert.equal(draws,1)
let bot
try{
 for(const mode of ['ok','unknown-second','synthesis-second','first-synthesis','stop-after-first']){
  const records=[],texts=[],order=[],stickerId='11111111-1111-1111-1111-111111111111'
  const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,voice,shield:{enabled:false}}}
  let attempts=0
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},voiceRandom:()=>0,replySleep:async()=>{},
   stickerStore:{snapshot:()=>({enabled:mode==='ok',chance:1,cooldownSec:0,items:[{id:stickerId,name:'开心'}]}),isAvailable:()=>true,read:()=>({bytes:Buffer.from('fixture')}),reserveUse:()=>{}},
   llmChat:async(_,o)=>({content:o.system.includes('挑一张已有表情包')?JSON.stringify({id:stickerId}):text}),
   sendVoice:async p=>{attempts++;if(mode==='unknown-second'&&attempts===2)throw Error('unknown');if((mode==='synthesis-second'&&attempts===2)||mode==='first-synthesis')throw Object.assign(Error('not sent'),{voiceNotSent:true});records.push(p);order.push('voice');if(mode==='stop-after-first')bot.stop();return {message_id:attempts}},say:async(_,__,s)=>{texts.push(s);order.push(s[0].type)}})
  const ev={post_type:'message',message_type:'group',group_id:'123456',user_id:'111111',message_id:1,message:[{type:'text',data:{text:'聊聊今天吧'}}]}
  await bot.handleEvent(ev)
  if(mode==='ok'){assert.deepEqual(records,parts);assert.deepEqual(order,['voice','voice','voice','image']);await bot.handleEvent(ev);assert.equal(attempts,3,'重复入站不重发')}
  else if(mode==='first-synthesis'){assert.equal(records.length,0);assert.equal(texts.length,1)}
  else {assert.deepEqual(records,[parts[0]]);assert.equal(texts.length,0,'部分已发不回退整段文字');assert.ok(attempts<=2)}
  bot.stop()
 }
 console.log('语音分段通过：最多五段/每段上限/不丢字/概率只抽一次/长引语与链接回文字/逐段确认/未知不重试/首段合成失败才回文字/中途停止/入站去重。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
