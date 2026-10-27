import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-script-host-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs'),{scripts,SCRIPT_ROOT}=await import('../src/trpg-scripts.mjs'),{sendGroup,sendAIVoice,sendAudioRecord,sendPrivate}=await import('../src/qq.mjs')
const oldFetch=globalThis.fetch;let serial=500,bot,models=0
globalThis.fetch=async()=>new Response(JSON.stringify({status:'ok',retcode:0,data:{message_id:++serial}}))
const cfg={qq:{groupIds:['123'],onebotHttp:'http://fixture.invalid'},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['456'],speakChance:0,replyEveryMessage:false,outputRateOnly:true,shield:{enabled:false},catchUp:false,dice:{enabled:false}}}
const ev=(id,text,uid=456,extra={})=>({post_type:'message',message_type:'group',group_id:123,user_id:uid,message_id:id,sender:{nickname:uid==='456'?'KP':'玩家甲'},message:[{type:'text',data:{text}}],...extra})
try{
 bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:path.join(dir,'private'),logger:{},llmChat:async()=>{models++;throw Error('0%不生成')}});bot.selfId('999')
 const {diceTheatre,npcMemory}=await import('../src/dice-plugin.mjs');for(const name of ['甲','乙'])await diceTheatre(cfg,{group:'123',npc:{name,background:'背景'}})
 await bot.handleEvent(ev(100,'.npc use all'));await bot.handleEvent(ev(101,'启用后两位均记住','777'));assert.ok((await npcMemory(cfg,'123','甲')).recent.some(x=>x.text==='启用后两位均记住'));assert.ok((await npcMemory(cfg,'123','乙')).recent.some(x=>x.text==='启用后两位均记住'));await bot.handleEvent(ev(102,'.npc stop 甲'));await bot.handleEvent(ev(103,'只让乙记住','777'));assert.ok(!(await npcMemory(cfg,'123','甲')).recent.some(x=>x.text==='只让乙记住'));assert.ok((await npcMemory(cfg,'123','乙')).recent.some(x=>x.text==='只让乙记住'))
 assert.equal((await bot.handleEvent(ev(1,'.log on'))).handled,true);assert.equal((await (await scripts()).status()).active['123'].status,'awaiting-name')
 await bot.handleEvent(ev(2,'雾城纪事'));await bot.handleEvent(ev(3,'普通聊天，AI不回复也要记录','777'));await bot.handleEvent(ev(3,'重复消息','777'));await bot.handleEvent(ev(4,'别群不能记','777',{group_id:124}));assert.equal(models,0)
 cfg.chat.replyEveryMessage=true;const outside='**KP场外交流：不要让NPC知道暗门';const aside=await bot.handleEvent(ev(104,outside,'777'));assert.equal(aside.spoke,false);assert.equal(models,0);assert.ok(!(await npcMemory(cfg,'123','乙')).recent.some(x=>x.text.includes('暗门')));cfg.chat.replyEveryMessage=false
 await sendGroup(cfg,123,[{type:'text',data:{text:'机器人独立发言'}}],{replyToUserId:'456'});const selfId=serial;await bot.handleEvent(ev(selfId,'机器人独立发言','999',{post_type:'message_sent'}))
 await sendAIVoice(cfg,123,'fixture','原生语音正文',{replyToUserId:'456'});await sendAudioRecord(cfg,123,Buffer.from('fixture-secret'),{replyToUserId:'456',scriptText:'本地语音正文'});await sendPrivate(cfg,456,'私聊不混入群剧本')
 await bot.handleEvent(ev(5,'.log off'));await bot.handleEvent(ev(6,'暂停期间不录','777'));await bot.handleEvent(ev(7,'.log on'));await bot.handleEvent(ev(8,'.log end'));const state=await (await scripts()).status(),archive=state.ended[0].path;assert.ok(archive.startsWith(SCRIPT_ROOT));assert.equal(state.active['123'],undefined)
 const rows=fs.readFileSync(path.join(archive,'chat.jsonl'),'utf8').trim().split('\n').map(JSON.parse),text=rows.map(x=>x.text).join('\n');assert.match(text,/普通聊天/);assert.match(text,/原生语音正文/);assert.match(text,/本地语音正文/);assert.equal(rows.filter(x=>x.text==='机器人独立发言').length,1);assert.doesNotMatch(text,/重复消息|别群不能记|私聊不混入|fixture-secret|暂停期间不录/);assert.equal(models,0)
 assert.equal(rows.find(x=>x.text===outside).ooc,true)
 console.log('剧本宿主通过：无骰子/0%仍记录、命名询问、暂停继续、所有群发送/语音文本、自身回声去重、私聊及跨群隔离、归档。所有调用为隔离mock，未向QQ发送。')
}finally{bot?.stop();globalThis.fetch=oldFetch;fs.rmSync(dir,{recursive:true,force:true})}
