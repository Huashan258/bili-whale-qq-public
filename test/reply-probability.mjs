import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reply-probability-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const bots=[]
const event=(text,id,at=false)=>({post_type:'message',message_type:'group',group_id:'123',user_id:'456',message_id:id,message:[...(at?[{type:'at',data:{qq:'999'}}]:[]),{type:'text',data:{text}}]})
function setup(chance,rate=true,random=()=>0){
 const cfg={qq:{groupIds:['123']},llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'鱼',aliases:['鱼'],replyEveryMessage:false,outputRateOnly:rate,speakChance:chance,catchUp:true,minGapSec:0,maxPerHour:0,shield:{enabled:false}}}
 const sent=[],prompts=[]
 const bot=createChat(cfg,{replyRandom:random,stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_c,p)=>{prompts.push(p);return {content:JSON.stringify({speak:false,reply:'本仙在。'})}},say:async(_c,_g,msg)=>sent.push(msg)})
 bot.selfId('999');bots.push(bot);return {cfg,bot,sent,prompts}
}
try{
 const full=setup(1,true,()=>{throw Error('100%不应抽签')})
 for(const [i,text] of ['喵','神秘','gugugaga','saljsoj','ajabansn','nslsnwjs','sksjjsjs','ksksnjs'].entries())assert.equal((await full.bot.handleEvent(event(text,i))).spoke,true)
 await full.bot.handleEvent({...event('',20),message:[{type:'face',data:{id:'1'}}]})
 assert.equal(full.sent.length,9)
 assert.ok(full.prompts.every(p=>p.json===false&&p.system.includes('本条消息已由程序选中')&&!p.system.includes('拿不准就别说')))
 assert.equal(full.bot.status().replySelection.chance,1)
 for(const rate of [true,false]){
  const off=setup(0,rate,()=>0)
  await off.bot.handleEvent(event('这是长一点的普通消息',30))
  assert.equal(off.sent.length,0);assert.equal(off.prompts.length,0)
  assert.deepEqual(off.bot.status().catchUp.pending,[],'概率未命中不能靠补话二次抽签')
  assert.equal((await off.bot.handleEvent(event('',31,true))).spoke,true)
  const named=setup(0,rate,()=>0)
  assert.equal((await named.bot.handleEvent(event('鱼',32))).spoke,true)
 }
 const draws=[0,.49,.5,.99],half=setup(.5,true,()=>draws.shift())
 for(let i=0;i<4;i++)await half.bot.handleEvent(event('短',40+i))
 assert.equal(half.sent.length,2);assert.equal(half.prompts.length,2)
 half.cfg.chat.speakChance=0;half.cfg.chat.replyEveryMessage=true
 assert.equal((await half.bot.handleEvent(event('必回热开关',50))).spoke,true)
 half.cfg.chat.replyEveryMessage=false
 await half.bot.handleEvent(event('关闭后恢复概率',51));assert.equal(half.sent.length,3)
 const balanced=setup(.6,true,()=>.99),hits=[]
 for(let i=0;i<20;i++){
  const before=balanced.sent.length
  await balanced.bot.handleEvent(event('普通聊天消息',100+i))
  hits.push(balanced.sent.length>before)
 }
 assert.equal(hits.slice(0,10).filter(Boolean).length,6)
 assert.equal(hits.slice(10).filter(Boolean).length,6)
 assert.equal(hits.map(x=>x?'1':'0').join('').includes('111'),false,'0.6不会连续回复三条普通消息')
 balanced.cfg.chat.speakChance=.3
 const start=balanced.sent.length
 for(let i=0;i<10;i++)await balanced.bot.handleEvent(event('修改为三成',150+i))
 assert.equal(balanced.sent.length-start,3)
 balanced.cfg.qq.groupIds.push('124')
 assert.equal((await balanced.bot.handleEvent({...event('另一群独立分配',180),group_id:'124'})).spoke,true)
 assert.equal(balanced.bot.status().replySelection.strategy,'balanced-per-group')
 console.log('reply-probability: 日志八句复现/短句表情/100%必交付/0%不抽签不补话/50%边界/自由聊天不覆盖概率/@和别名/热修改通过')
}finally{for(const bot of bots)bot.stop();fs.rmSync(dir,{recursive:true,force:true})}
