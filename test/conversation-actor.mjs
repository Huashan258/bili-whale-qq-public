import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'actor-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {actorReplyIssue,textOnlyRequested}=await import('../src/conversation-actor.mjs')
const {searchIntent}=await import('../src/chat-search.mjs')
const {QINGE_PERSONA}=await import('../src/persona.mjs')
const {stickerRequest}=await import('../src/qq-stickers.mjs')
assert.equal(stickerRequest('还会自觉发表情包了，好棒，摸摸你的头'),false)
assert.equal(stickerRequest('还会自觉发表情包了，再发一张'),true)
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{persona:QINGE_PERSONA,nick:'青娥鱼',admins:['111111'],adminTitles:['主人','老板'],replyEveryMessage:true,outputRateOnly:true,contextMessages:12,deepReply:{enabled:true},voice:{enabled:true,chance:1,maxChars:80},shield:{enabled:false}}}
for(const t of ['你有没有能力不说语音而打文字？','这条别发语音','只发文字','用文字回答'])assert.equal(textOnlyRequested(t),true)
for(const t of ['不要文字，要语音','为什么语音有点小','随便聊聊'])assert.equal(textOnlyRequested(t),false)
for(const t of ['你爹是谁','你的父亲是谁','你妈妈是谁'])assert.equal(searchIntent(t),null)
assert.equal(searchIntent('景元的父亲是谁').source,'research')
const ordinary={admin:false,name:'当前群友',otherNames:['旁人'],adminTitles:['主人','老板']}
assert.equal(actorReplyIssue('嗯，头低一低。主人这声摸得轻巧。',ordinary),'actor-admin-address')
assert.equal(actorReplyIssue('诶，旁人方才不是打字了么。',ordinary,'认不太清楚人'),'actor-wrong-addressee')
assert.equal(actorReplyIssue('他喊的是“主人这声好”。',ordinary),null)
assert.equal(actorReplyIssue('语音倒还发不来呢。',{...ordinary,voiceEnabled:true}),'actor-voice-capability')
let bot,calls=0,voices=0,stage='seed';const sent=[],prompts=[]
try{
 bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},replySleep:async()=>{},voiceRandom:()=>0,stickerStore:{snapshot:()=>({enabled:false,items:[]})},
  lookup:async i=>{if(stage==='parent')assert.equal(i.source,'web');return {ok:true,source:'web',results:[{title:'不相关的星穹铁道',description:'无关游戏对白',url:'https://fixture.test'}]}},
  llmChat:async(_,o)=>{prompts.push(o);calls++;assert.match(o.user,/"senderUid"/);const actor=o.replyActor
   assert.ok(o.user.lastIndexOf('【本条发送者')>o.user.indexOf('历史消息'))
   if(stage==='seed')return {content:'这句记着了。'}
   assert.equal(actor.uid,'222222');assert.equal(actor.admin,false);assert.deepEqual(actor.mentions,['999999'])
   if(stage==='praise')return {content:o.system.includes('上一版把本条发送者')?'嗯，夸奖收下了。':'嗯，头低一低。主人这声摸得轻巧。'}
   if(stage==='text'){assert.equal(actor.previousReplyFormat,'voice');return {content:o.system.includes('上一版把本条发送者')?'可以呀，这条就打字回你。':'诶，旁人，好呀。'}}
   if(stage==='identity')return {content:o.system.includes('上一版把本条发送者')?'刚才把名字接错了，本仙在回你。':'诶，旁人方才不是打字了么。'}
   if(stage==='parent'){assert.doesNotMatch(o.user,/不相关的星穹铁道/);assert.doesNotMatch(o.system,/没点字数就按/);assert.equal(o.maxReplyChars,60);return {content:'本仙可没认过这门亲，别乱安辈分呀。'}}
   return {content:'这条照原设置聊。'}
  },sendVoice:async()=>{voices++;return {message_id:voices}},say:async(_,__,s)=>sent.push(s)})
 bot.selfId('999999')
 const ev=(id,uid,name,text)=>({post_type:'message',message_type:'group',group_id:'123456',user_id:uid,message_id:id,sender:{nickname:name},message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text}}]})
 await bot.handleEvent(ev(1,'111111','旧主人','前面说过旧话题'));await bot.handleEvent(ev(2,'333333','旁人','旁人刚才发过消息'))
 stage='praise';let before=calls;await bot.handleEvent(ev(3,'222222','当前群友','还会自觉发表情包了，好棒，摸摸你的头'));assert.equal(calls-before,2)
 stage='text';before=voices;await bot.handleEvent(ev(4,'222222','当前群友','你有没有能力不说语音而打文字？'));assert.equal(voices,before);assert.ok(sent.at(-1).some(s=>s.type==='text'&&s.data.text.includes('打字')))
 stage='identity';await bot.handleEvent(ev(5,'222222','当前群友','奇怪，你怎么好像认不太清楚人？没有设定要看消息发送者吗？'))
 stage='parent';await bot.handleEvent(ev(6,'222222','当前群友','你爹是谁'))
 stage='normal';before=voices;await bot.handleEvent(ev(7,'222222','当前群友','随便聊聊'));assert.equal(voices,before+1,'文字请求只影响本条，不改全局语音')
 console.log('当前发送者通过：多用户/旧管理员不串人、UID和@分开、错称主人及旁人最多修订一次、文字请求真实走文字且不改全局、你爹不查角色百科/不进长文、无关游戏资料不注入。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
