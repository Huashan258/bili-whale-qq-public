// Catch-up is for a selected reply delayed by a gate, never a second probability draw.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-catchup-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const realNow=Date.now;let clock=realNow();Date.now=()=>clock
const bots=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms))
const ev=(id,at=false)=>({post_type:'message',message_type:'group',group_id:'1',user_id:'1001',message_id:id,message:[...(at?[{type:'at',data:{qq:'999'}}]:[]),{type:'text',data:{text:'这游戏最近的更新有点离谱'}}]})
function make(extra={}){
 const cfg={qq:{groupIds:['1']},llm:{provider:'fixture',apiKey:'fixture'},chat:{speakChance:1,replyEveryMessage:false,minGapSec:10,maxPerHour:10,catchUp:true,catchUpSec:1,shield:{enabled:false},...extra}}
 const sent=[];let catchups=0
 const bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_c,p)=>{if(p.system.includes('补充一条')){catchups++;return {content:JSON.stringify({speak:true,reply:'刚才那句本仙接着说。'})}}return {content:'本仙在。'}},say:async(_c,_g,msg)=>sent.push(msg)})
 bot.selfId('999');bots.push(bot);return {bot,sent,calls:()=>catchups}
}
try{
 const delayed=make();await delayed.bot.handleEvent(ev(1));clock+=1000;await delayed.bot.handleEvent(ev(2))
 assert.ok(delayed.bot.status().catchUp.pending.includes('1'))
 clock+=21000;await sleep(1200)
 assert.equal(delayed.sent.length,2);assert.equal(delayed.calls(),1);assert.deepEqual(delayed.bot.status().catchUp.pending,[])
 const cleared=make();await cleared.bot.handleEvent(ev(3));clock+=1000;await cleared.bot.handleEvent(ev(4));assert.ok(cleared.bot.status().catchUp.pending.includes('1'))
 clock+=9000;await cleared.bot.handleEvent(ev(5,true));await sleep(1200)
 assert.deepEqual(cleared.bot.status().catchUp.pending,[]);assert.equal(cleared.sent.length,2);assert.equal(cleared.calls(),0)
 const capped=make({minGapSec:0,maxPerHour:1});await capped.bot.handleEvent(ev(6));await capped.bot.handleEvent(ev(7));assert.equal(capped.sent.length,1);assert.deepEqual(capped.bot.status().catchUp.pending,[])
 const disabled=make({catchUp:false});await disabled.bot.handleEvent(ev(8));clock+=1000;await disabled.bot.handleEvent(ev(9));assert.deepEqual(disabled.bot.status().catchUp.pending,[])
 console.log('catchup: 冷却阻塞后补话/点名回复清除待补/小时额度不补/关闭不挂补话通过')
}finally{Date.now=realNow;for(const bot of bots)bot.stop();fs.rmSync(dir,{recursive:true,force:true})}
