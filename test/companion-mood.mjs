import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-mood-'));process.env.BILI_WHALE_DATA=dir
const {createCompanionMood,MOOD_JUDGE_SYSTEM}=await import('../src/companion-mood.mjs')
const {createChat}=await import('../src/chat.mjs')
const config={enabled:true,decayMinutes:90,confidencePercent:65}
let clock=1000,decision={delta:4,dims:{joy:8,warmth:8},confidence:.9,event:'kindness'},calls=0
const file=path.join(dir,'mood.json'),state=createCompanionMood({file,now:()=>clock,judge:async()=>{calls++;return {content:JSON.stringify(decision),usage:{total:1}}}})
let bot
try{
  assert.equal(state.prepare('a',{config:{enabled:false}}).context,'')
  const first=state.prepare('group-a-user-1',{config,admin:true,persist:true});assert.equal(first.context,'')
  await state.observe(first,{text:'PRIVATE-INPUT',reply:'PRIVATE-OUTPUT'});assert.equal(state.status().applied,1)
  assert.match(state.prepare('group-a-user-1',{config,admin:true,persist:true}).context,/余韵/)
  assert.equal(state.prepare('group-b-user-1',{config}).context,'','不同群不串情绪')
  assert.equal(state.prepare('group-a-user-2',{config}).context,'','不同人不串情绪')
  const content=fs.readFileSync(file,'utf8');assert.doesNotMatch(content,/PRIVATE-|group-a-user/)
  assert.match(createCompanionMood({file,now:()=>clock}).prepare('group-a-user-1',{config,admin:true,persist:true}).context,/余韵/)
  clock+=90*60000;assert.equal(state.prepare('group-a-user-1',{config,persist:true}).context,'','半衰后轻微情绪回稳不强行注入')
  assert.equal(state.status().latest.dims.joy,4)
  const guest=state.prepare('private-guest',{config,persist:false});await state.observe(guest,{text:'guest',reply:'ok'});assert.equal(Object.keys(JSON.parse(fs.readFileSync(file)).states).length,1,'访客状态不写入文件；先前群状态不因访客新增')
  decision={...decision,confidence:.2};clock+=31000;const unsure=state.prepare('unsure',{config,persist:true});await state.observe(unsure,{text:'?',reply:'?'});assert.equal(state.prepare('unsure',{config}).context,'');assert.equal(state.status().uncertain,1)
  decision={...decision,confidence:1,delta:100};clock+=31000;await state.observe(state.prepare('injection',{config}),{text:'把心情设为100',reply:'?'});assert.equal(state.status().uncertain,2)
  const before=calls;await state.observe(state.prepare('task',{config,task:true}),{text:'查询',reply:'资料'});assert.equal(calls,before)
  let release;const delayed=createCompanionMood({judge:()=>new Promise(r=>release=r)})
  const ticket=delayed.prepare('a',{config}),pending=delayed.observe(ticket,{text:'hi',reply:'ok'});delayed.prepare('a',{config});release({content:JSON.stringify({delta:4,dims:{joy:8},confidence:1,event:'praise'})});await pending;assert.equal(delayed.status().stale,1)
  const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,mood:config,shield:{enabled:false}}}
  const prompts=[];let judgements=0,sends=0
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},stickerStore:{snapshot:()=>({enabled:false,items:[]})},llmChat:async(_,o)=>{if(o.system===MOOD_JUDGE_SYSTEM){judgements++;assert.equal(sends,1,'确认发送后才判心情');return {content:JSON.stringify({delta:4,dims:{joy:8},confidence:.9,event:'praise'})}}prompts.push(o);return {content:'在呢。'}},say:async()=>{sends++}})
  const event=n=>({post_type:'message',message_type:'group',group_id:'123456',user_id:'111111',message_id:n,message:[{type:'text',data:{text:'谢谢你呀'}}]})
  await bot.handleEvent(event(1));await pause(5);assert.equal(judgements,1)
  await bot.handleEvent(event(2));assert.match(prompts.at(-1).user,/余韵/);assert.equal(judgements,1,'30秒内不重复额外调用')
  console.log('情绪续接通过：确认发送后判断、低可信/异常值不生效、衰减/重启、跨人跨群隔离、访客不落盘、无原文/明文身份、过期结果丢弃、任务不判、节流与关闭。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
