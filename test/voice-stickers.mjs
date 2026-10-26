import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-stickers-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const id='11111111-1111-1111-1111-111111111111'
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,voice:{enabled:true,chance:1,maxChars:80},shield:{enabled:false}}}
let bot
try {
  for(const mode of ['ok','unknown','image-failed','repeat','disabled','stopped']) {
    const events=[];let claims=0,picks=0
    bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},voiceRandom:()=>0,stickerRandom:()=>0,
      replySleep:async()=>{},stickerStore:{snapshot:()=>({enabled:mode!=='disabled',chance:1,cooldownSec:0,repeatMinutes:5,items:[{id,name:'开心',description:'开心'}]}),
        isAvailable:()=>true,read:()=>({bytes:Buffer.from('fixture')}),reserveUse:()=>{claims++;if(mode==='repeat')throw Object.assign(Error('repeat'),{stickerRepeatLimited:true})}},
      llmChat:async(_,o)=>{if(o.system.includes('挑一张已有表情包')){picks++;return {content:JSON.stringify({id})}}return {content:'本仙今日心情不错。'}},
      sendVoice:async()=>{events.push('voice');if(mode==='unknown')throw Error('unknown');if(mode==='stopped')bot.stop();return {message_id:42}},
      say:async(_,gid,segs,ctx)=>{assert.equal(segs[0].type,'image');assert.equal(gid,'123456');assert.equal(ctx.replyToUserId,'111111');await ctx.beforeDispatch?.();events.push('image');if(mode==='image-failed')throw Error('unknown image');return {message_id:43}}})
    await bot.handleEvent({post_type:'message',message_type:'group',group_id:'123456',user_id:'111111',message_id:1,message:[{type:'text',data:{text:'你好呀'}}]})
    if(mode==='ok'||mode==='image-failed')assert.deepEqual(events,['voice','image'])
    else assert.deepEqual(events,['voice'])
    if(mode==='unknown'||mode==='stopped')assert.equal(picks,0)
    if(mode==='ok'||mode==='image-failed'||mode==='repeat')assert.equal(claims,1,'出口保留同图原子占位')
    if(mode==='image-failed')assert.equal(bot.status().diagnostics.recent.at(-1).voice.reason,'sent','表情失败不覆盖语音成功状态')
    if(mode==='repeat')assert.equal(bot.status().diagnostics.recent.at(-1).sticker.reason,'repeat-cooldown')
    bot.stop()
  }
  console.log('语音后表情通过：先语音后图、共用选择与出口占位、关闭图库、同图间隔、未知语音不发图、表情失败不重发语音、停机不发图。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
