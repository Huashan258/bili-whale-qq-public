import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-repeat-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {repeatCandidate,createQqRepeater}=await import('../src/qq-repeat.mjs')
const settings={enabled:true,chance:1,text:true,stickers:true,cooldownSec:0,maxChars:200}
const image={type:'image',data:{file:'1234567890abcdef1234567890abcdef.image',url:'https://gchat.qpic.cn/fixture'}}
const face={type:'face',data:{id:'14'}},emoji={type:'image',data:{emoji_id:'face001',emoji_package_id:'101',key:'fixture',summary:'开心'}}
let bot
try{
 assert.deepEqual(repeatCandidate([{type:'text',data:{text:'咕咕嘎嘎。'}}],settings).segments,[{type:'text',data:{text:'咕咕嘎嘎。'}}])
 for(const s of [image,face,emoji])assert.ok(repeatCandidate([s],settings))
 assert.equal(repeatCandidate([{type:'text',data:{text:'字'.repeat(201)}}],settings),null)
 for(const type of ['at','reply','record','video','json','forward','file'])assert.equal(repeatCandidate([{type,data:{qq:'all'}}],settings),null)
 assert.equal(repeatCandidate([{type:'image',data:{file:'C:/secret.txt'}}],settings),null)
 assert.equal(repeatCandidate([{type:'image',data:{url:'http://127.0.0.1/private'}}],settings),null)
 assert.equal(repeatCandidate([image],{...settings,stickers:false}),null)
 assert.equal(repeatCandidate([{type:'text',data:{text:'hello'}},image],{...settings,text:false}),null)
 assert.equal(repeatCandidate('[CQ:face,id=14]',settings).segments[0].type,'face')
 let clock=1000
 const file=path.join(dir,'repeat.json'),r=createQqRepeater({file,now:()=>clock,random:()=>0})
 let x=r.select([image],{groupId:'a',settings,mediaRepeatMinutes:5});assert.ok(x);x.claim()
 assert.equal(createQqRepeater({file,now:()=>clock}).select([image],{groupId:'b',settings}),null,'重启仍记同图间隔')
 assert.equal(createQqRepeater({random:()=>.1}).select('边界',{groupId:'a',settings:{...settings,chance:.1}}),null)
 assert.ok(createQqRepeater({random:()=>.099}).select('边界',{groupId:'a',settings:{...settings,chance:.1}}))
 assert.equal(r.select([image],{groupId:'b',settings,mediaRepeatMinutes:5}),null)
 clock+=301000;assert.ok(r.select([image],{groupId:'b',settings,mediaRepeatMinutes:5}))
 assert.ok(!fs.readFileSync(file,'utf8').includes('qpic'),'持久记录只有哈希和时间')
 let model=0,voices=0;const sent=[],cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,repeat:{...settings},shield:{enabled:false},voice:{enabled:true,chance:1}}}
 bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},repeatRandom:()=>0,replySleep:async()=>{},stickerStore:{snapshot:()=>({enabled:false,items:[],repeatMinutes:5})},llmChat:async()=>{model++;return {content:'正常回答'}},sendVoice:async()=>{voices++;return {message_id:1}},say:async(_,__,s,context)=>{await context?.beforeDispatch?.();sent.push(s)},sayPrivate:async(_,__,s)=>sent.push(s)})
 bot.selfId('999999')
 const ev=(id,message)=>({post_type:'message',message_type:'group',group_id:'123456',user_id:'222222',message_id:id,message})
 let result=await bot.handleEvent(ev(1,[{type:'text',data:{text:'好耶。'}}]));assert.equal(result.repeated,true);assert.equal(model,0);assert.equal(voices,0);assert.equal(sent[0][0].data.text,'好耶。')
 await bot.handleEvent(ev(1,[{type:'text',data:{text:'好耶。'}}]));assert.equal(sent.length,1,'相同事件不再发')
 result=await bot.handleEvent(ev(2,[image]));assert.equal(result.repeatKind,'sticker');assert.equal(model,0);assert.deepEqual(sent.at(-1),repeatCandidate([image],settings).segments)
 await bot.handleEvent(ev(3,[{type:'text',data:{text:'好耶。'}}]));assert.equal(model,1,'同内容不反复复读')
 await bot.handleEvent(ev(4,[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'哈哈'}}]));assert.equal(model,2,'@走正常回答')
 await bot.handleEvent(ev(5,[{type:'text',data:{text:'你为什么这样？'}}]));assert.equal(model,3,'提问不复读')
 cfg.chat.replyEveryMessage=false;cfg.chat.speakChance=0;let count=sent.length;await bot.handleEvent(ev(6,[face]));assert.equal(sent.length,count,'不改变原0%回复概率')
 cfg.chat.replyEveryMessage=true;cfg.chat.repeat.chance=0;await bot.handleEvent(ev(7,[face]));assert.equal(model,4,'复读0%恢复正常回复')
 cfg.chat.repeat.chance=1;await bot.handleEvent({...ev(8,[face]),sender:{is_bot:true}});assert.equal(model,5,'已标记机器人不参与复读')
 const before=sent.length;await bot.handleEvent({...ev(9,[face]),user_id:'999999'});assert.equal(sent.length,before,'自己的消息不回应')
 bot.stop();let attempts=0
 bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},repeatRandom:()=>0,stickerStore:{snapshot:()=>({items:[]})},llmChat:async()=>{throw Error('不应生成兜底')},say:async()=>{attempts++;throw Error('unknown receipt')}})
 await bot.handleEvent(ev(10,[{type:'text',data:{text:'发送回执未明测试'}}]));assert.equal(attempts,1)
 console.log('QQ群复读通过：原文/图片/基础及商城表情、类型与长度开关、0/100%及原回复概率、@与提问不误复读、同图跨群间隔、同内容防循环、入站去重、自身/机器人排除、无需模型语音、未知回执不补发。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
