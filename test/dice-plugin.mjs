import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-dice-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const cfg={qq:{groupIds:['123']},llm:{provider:'fixture',apiKey:'fixture'},chat:{dice:{enabled:true},speakChance:0,replyEveryMessage:true,outputRateOnly:true,shield:{enabled:false}}}
let bot,models=0;const group=[],dm=[]
const options={stateFile:null,logFile:path.join(dir,'chat.log'),privateDir:path.join(dir,'private'),logger:{},llmChat:async()=>{models++;throw Error('骰子不能调用LLM')},say:async(_c,g,m,context)=>group.push({g,m,context}),sayPrivate:async(_c,u,m,context)=>dm.push({u,m,context})}
const ev=(id,text,extra={})=>({post_type:'message',message_type:'group',group_id:123,user_id:456,message_id:id,sender:{nickname:'测试玩家'},message:[{type:'text',data:{text}}],...extra})
try{
 const {diceTheatre}=await import('../src/dice-plugin.mjs');await diceTheatre(cfg,{group:'123',commentary:false})
 bot=createChat(cfg,options);bot.selfId('999')
 assert.equal((await bot.handleEvent(ev(1,'.r d1'))).spoke,true);assert.equal(group.length,1);assert.match(group[0].m[0].data.text,/d1 = 1/);assert.equal(models,0);assert.equal(group[0].context.replyToUserId,'456')
 await bot.handleEvent(ev(1,'.r d1'));assert.equal(group.length,1)
 await bot.handleEvent(ev(2,'.rh d1'));assert.equal(group.length,2);assert.equal(dm.length,1);assert.match(dm[0].m[0].data.text,/d1 = 1/);assert.doesNotMatch(group[1].m[0].data.text,/d1 = 1/)
 assert.equal(dm[0].context.requireReceipt,true,'骰子私聊要求原生发送回执')
 const rows=fs.readFileSync(path.join(dir,'chat.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse);assert.ok(rows.filter(r=>r.type==='out'&&r.hidden).every(r=>!r.text.includes('d1 = 1')))
 await bot.handleEvent(ev(3,'.r d1',{group_id:444}));assert.equal(group.length,2)
 await bot.handleEvent(ev(4,'',{message:[{type:'at',data:{qq:'777'}},{type:'text',data:{text:'.r d1'}}]}));assert.equal(group.length,2);assert.equal(models,0)
 cfg.chat.replyEveryMessage=false;cfg.chat.dice.enabled=false;await bot.handleEvent(ev(5,'.r d1'));assert.equal(group.length,2)
 cfg.chat.dice.enabled=true;await bot.handleEvent(ev(6,'.r d1'));assert.equal(group.length,3,'0%普通接话不影响骰子命令')
 bot.stop();bot=createChat(cfg,options);bot.selfId('999');await bot.handleEvent(ev(6,'.r d1'));assert.equal(group.length,3,'重载宿主后仍不重掷')
 assert.equal(models,0);assert.equal(bot.status().replySelection.diceCommands,true)
 const {sendPrivate}=await import('../src/qq.mjs'),previousFetch=globalThis.fetch
 try{globalThis.fetch=async()=>new Response(JSON.stringify({status:'ok',retcode:0,data:{}}));await assert.rejects(sendPrivate({qq:{onebotHttp:'http://fixture.invalid'},chat:{admins:['456']}},456,'测试暗骰',{requireReceipt:true}),/回执/)
  globalThis.fetch=async()=>new Response(JSON.stringify({status:'ok',retcode:0,data:{message_id:123}}));assert.equal(await sendPrivate({qq:{onebotHttp:'http://fixture.invalid'},chat:{admins:['456']}},456,'测试暗骰',{requireReceipt:true}),'private')
 }finally{globalThis.fetch=previousFetch}
 const {setDiceKeeper,clearDicePlayers,diceStatus}=await import('../src/dice-plugin.mjs')
 await assert.rejects(clearDicePlayers(''),/确认/)
 await assert.rejects(setDiceKeeper(cfg,{group:'444',uid:'789'}),/白名单/)
 await setDiceKeeper(cfg,{group:'123',uid:'789',name:'KP测试'})
 await diceTheatre(cfg,{group:'123',npc:{name:'酒馆老板',background:'寡言，知道旧城秘密'},activation:{name:'酒馆老板',active:true}})
 bot.stop();let tasks=[];bot=createChat(cfg,{...options,llmChat:async(_model,task)=>{tasks.push(task);return {content:'老板放下酒杯，示意你坐下。',usage:{total:12}}}});bot.selfId('999')
 await bot.handleEvent(ev(30,'人格模拟：【PL询问旧城的事】'));assert.equal(tasks.length,1);assert.match(group.at(-1).m[0].data.text,/^青娥模拟：【.*】$/);assert.equal(group.at(-1).m.length,1)
 await bot.handleEvent(ev(30,'人格模拟：【PL询问旧城的事】'));assert.equal(tasks.length,1)
 await bot.handleEvent(ev(31,'.npc 123 老板 私聊追加的背景',{message_type:'private',user_id:789}));assert.match(dm.at(-1).m[0].data.text,/已保存/)
 await diceTheatre(cfg,{group:'123',commentary:true});await bot.handleEvent(ev(32,'.ra 侦查100'));assert.equal(tasks.length,2);assert.match(tasks.at(-1).user,/D100/)
 const reset=await clearDicePlayers('CLEAR_DICE_PLAYERS');assert.ok(reset.removedPlayers>0);assert.ok(reset.backup.startsWith(dir));assert.equal((await diceStatus()).keepers['123'].uid,'789');assert.equal((await diceStatus()).players,0)
 console.log('骰子宿主接入通过：白名单、概率不干扰、关闭点评零模型、人格模拟纯文本、KP私聊维护、骰点评、暗骰隐私与重启去重。无真实QQ发送。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
