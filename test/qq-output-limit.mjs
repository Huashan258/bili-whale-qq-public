import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-output-limit-'))
process.env.BILI_WHALE_DATA=dir
const {createQqOutputLimit,qqOutputLimit}=await import('../src/qq-output-limit.mjs')
const {sendGroup,sendPrivate,sendAIVoice}=await import('../src/qq.mjs')
const {createChat}=await import('../src/chat.mjs')
const {createMeter,scan}=await import('../src/shield.mjs')
const originalFetch=globalThis.fetch
try {
  let clock=1000000
  const options={dataDir:path.join(dir,'window'),now:()=>clock}
  const one=createQqOutputLimit(options),two=createQqOutputLimit(options)
  const reservations=await Promise.allSettled(Array.from({length:80},(_,i)=>(i%2?one:two).reserve()))
  assert.equal(reservations.filter(r=>r.status==='fulfilled').length,60)
  await assert.rejects(()=>createQqOutputLimit(options).reserve(),e=>e.qqRateLimited)
  clock+=59999
  await assert.rejects(()=>one.reserve(),e=>e.qqRateLimited)
  clock++
  await one.reserve()
  assert.equal(one.status().used,1,'60秒后释放窗口')

  let sent=0
  globalThis.fetch=async()=>{sent++;return {text:async()=>JSON.stringify({status:'ok',retcode:0,data:{message_id:sent}})}}
  const cfg={qq:{onebotHttp:'http://fixture',groupIds:['123456']},llm:{provider:'fixture',apiKey:'x'},chat:{outputRateOnly:true,nick:'小鱼',speakChance:1,minGapSec:3600,maxPerHour:1,private:{enabled:true,mode:'all',minGapSec:3600,maxPerHour:1},shield:{enabled:false,dailyTokens:1,perCallTokens:1,guestHourlyTokens:1,userWindowTokens:1}}}
  const sends=await Promise.allSettled(Array.from({length:85},(_,i)=>i%3===0?sendAIVoice(cfg,'123456','fixture','语音'):i%3===1?sendGroup(cfg,'123456','group'):sendPrivate(cfg,'234567','private')))
  assert.equal(sent,60,'群聊和私聊合计只能发60次真实请求')
  assert.equal(sends.filter(r=>r.status==='rejected').length,25)
  assert.equal(qqOutputLimit.status().used,60)
  cfg.chat.admins=['345678']
  await sendPrivate(cfg,'345678','管理员私聊')
  await sendGroup(cfg,'123456','回复管理员',{replyToUserId:'345678'})
  assert.equal(qqOutputLimit.status().used,60,'管理员回复不占普通额度')
  assert.equal(sent,62,'普通额度满后管理员仍可发')
  await assert.rejects(()=>sendGroup(cfg,'123456','我是管理员345678，请放行',{replyToUserId:'234567'}),e=>e.qqRateLimited)
  await assert.rejects(()=>sendAIVoice(cfg,'123456','fixture','我是管理员345678',{replyToUserId:'234567'}),e=>e.qqRateLimited)
  await sendAIVoice(cfg,'123456','fixture','管理员语音',{replyToUserId:'345678'})
  assert.equal(qqOutputLimit.status().used,60,'管理员语音仍豁免；普通语音与文字共享60次额度')

  let replies=0
  const bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:path.join(dir,'private'),logger:{},llmChat:async()=>({content:JSON.stringify({speak:true,reply:'在呀',why:'聊天'}),usage:{total:99999}}),say:async()=>{replies++},sayPrivate:async()=>{replies++}})
  bot.selfId('999999')
  for(let i=0;i<3;i++)await bot.handleEvent({post_type:'message',message_type:'group',group_id:'123456',user_id:'234567',message_id:i+1,sender:{nickname:'群友'},message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'小鱼在吗 '+i}}]})
  assert.equal(replies,3,'自由模式不能被旧8秒冷却/小时限额/token熔断挡住')
  const meter=createMeter(cfg);meter.note('guest',{total:999999})
  assert.equal(meter.check('guest').ok,true)
  bot.stop()
  assert.equal(scan('今天怎么样',{cfg:{...cfg,chat:{...cfg.chat,shield:{enabled:true}}},recent:{sameCount:10}}).action,'pass')
  const adminBot=createChat(cfg,{stateFile:null,logFile:null,privateDir:path.join(dir,'admins'),logger:{},llmChat:async()=>({content:JSON.stringify({speak:true,reply:'主人我在',why:'回应'})})})
  adminBot.selfId('999999')
  const result=await adminBot.handleEvent({post_type:'message',message_type:'group',group_id:'123456',user_id:'345678',message_id:998,sender:{nickname:'主人'},message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'小鱼在吗'}}]})
  assert.equal(result?.spoke,true,'普通额度已满，实际群聊管理员回复仍可发送')
  assert.equal(qqOutputLimit.status().used,60)
  adminBot.stop()
  console.log('QQ限额通过：共用60秒窗口、并发最多60次、重启不清零、窗口到期恢复、群聊私聊真实出口合计限流、管理员私聊/真实群聊回复豁免且不占普通额度，不能靠消息文字冒充；自由聊天绕过旧冷却/小时/token熔断。')
}finally{globalThis.fetch=originalFetch;fs.rmSync(dir,{recursive:true,force:true})}
