import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-chance-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {parseGroupChances,validateGroupChances,groupReplyChance,formatGroupChances}=await import('../public/group-probabilities.js')
let bot
try{
 assert.deepEqual(parseGroupChances('123=0\n124：0.65\n125=1'),{'123':0,'124':.65,'125':1})
 assert.deepEqual(parseGroupChances(''),{})
 assert.deepEqual(parseGroupChances(formatGroupChances({'123':0,'124':.65})),{'123':0,'124':.65})
 for(const text of ['123=1.1','123=-1','123=0.5\n123=0.6','abc=0.5'])assert.throws(()=>parseGroupChances(text))
 for(const data of [[],null,{'123':'0.5'},{'123':NaN},{'123':null},{'__bad__':.5}])assert.throws(()=>validateGroupChances(data))
 assert.equal(groupReplyChance({speakChance:.6,groupSpeakChances:{'123':0}},'123'),0)
 assert.equal(groupReplyChance({speakChance:.6,groupSpeakChances:{'123':null}},'123'),.6)
 const cfg={qq:{groupIds:['123','124','125']},llm:{provider:'fixture',apiKey:'fixture'},chat:{replyEveryMessage:false,outputRateOnly:true,speakChance:.6,groupSpeakChances:{'123':1,'124':0},shield:{enabled:false}}}
 const counts={'123':0,'124':0,'125':0};let serial=0,vision=0
 bot=createChat(cfg,{replyRandom:()=>.99,llmChat:async()=>({content:'在呢'}),readImages:async()=>{vision++;return ''},say:async(_c,gid)=>counts[gid]++,stateFile:null,logFile:null,privateDir:dir,logger:{}});bot.selfId('999')
 const ev=gid=>({post_type:'message',message_type:'group',group_id:gid,user_id:'456',message_id:++serial,message:[{type:'text',data:{text:'普通聊天'}}]})
 for(let i=0;i<10;i++)for(const gid of cfg.qq.groupIds)await bot.handleEvent(ev(gid))
 assert.deepEqual(counts,{'123':10,'124':0,'125':6},'群间独立，未设置群沿用全局')
 cfg.chat.groupSpeakChances={'123':.2,'124':1}
 for(let i=0;i<10;i++)for(const gid of cfg.qq.groupIds)await bot.handleEvent(ev(gid))
 assert.deepEqual(counts,{'123':12,'124':10,'125':12},'热修改只改变相应群，不重置其它群分配')
 delete cfg.chat.groupSpeakChances['123']
 for(let i=0;i<10;i++)await bot.handleEvent(ev('123'))
 assert.equal(counts['123'],18,'删除覆盖后恢复全局')
 cfg.chat.groupSpeakChances['123']=0
 await bot.handleEvent({...ev('123'),message:[{type:'image',data:{url:'fixture'}}]});assert.equal(vision,0,'纯图片也使用本群概率')
 cfg.chat.replyEveryMessage=true;await bot.handleEvent(ev('123'));assert.equal(counts['123'],19)
 cfg.chat.replyEveryMessage=false
 await bot.handleEvent({...ev('123'),message:[{type:'at',data:{qq:'999'}},{type:'text',data:{text:'在吗'}}]});assert.equal(counts['123'],20,'定向@规则保留')
 const status=bot.status().replySelection;assert.equal(status.chance,.6);assert.deepEqual(status.groupChances,{'123':0,'124':1,'125':.6})
 assert.equal(status.perGroupChance,true)
 console.log('每群概率通过：0/1/小数、独立平滑分配、热改、删除回退全局、图片共用概率、必回/@原规则及输入校验。无真实QQ发送。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
