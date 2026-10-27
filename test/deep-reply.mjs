import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'deep-reply-'));process.env.BILI_WHALE_DATA=dir
const {prepareDeepReply,replySearchQuery}=await import('../src/deep-reply.mjs')
const {generateDirectReply}=await import('../src/chat-response.mjs')
const {chat}=await import('../src/llm.mjs')
const {createChat}=await import('../src/chat.mjs')
const {composePrivateReply}=await import('../src/bili-private.mjs')
const {composePatrolReply}=await import('../src/bili-patrol.mjs')
const {composeBiliCommand}=await import('../src/bili-command.mjs')
const {createChatSearch}=await import('../src/chat-search.mjs')
const cfg={llm:{provider:'deepseek',apiKey:'fixture',model:'deepseek-chat',baseUrl:'https://fixture.test',requestTimeoutSec:60},qq:{groupIds:['887000004']},chat:{deepReply:{enabled:true},search:{enabled:true},speakChance:0,replyEveryMessage:false,outputRateOnly:true,contextMessages:0,shield:{enabled:false}},raw:{bili:{dedeUserId:'999'}}}
const result={ok:true,source:'web',results:[{title:'测试公开资料',url:'https://source.test/reference',description:'离线背景资料，仅供测试。'}],pages:[]}
let searches=0,bot
const lookup=async intent=>{searches++;assert.ok(intent.query);return result}
const basic={replyConfig:cfg,replyLookup:lookup,styleTask:'你好',system:'自然回复',user:'旧聊天历史绝不可发给搜索引擎',maxTokens:160}
try{
 const prepared=await prepareDeepReply(cfg.llm,basic)
 assert.equal(searches,1);assert.equal(prepared.thinking,'enabled');assert.equal(prepared.reasoningEffort,'high');assert.equal(prepared.maxTokens,4096)
 assert.match(prepared.user,/测试公开资料/);assert.match(prepared.system,/只输出最终答复/)
 await prepareDeepReply(cfg.llm,prepared);assert.equal(searches,1)
 await prepareDeepReply(cfg.llm,{...basic,replySearchResult:result});assert.equal(searches,1,'已有本轮搜索结果不重复查')
 await prepareDeepReply(cfg.llm,{...basic,styleTask:'不要联网，陪我聊聊'});assert.equal(searches,1)
 assert.equal((await prepareDeepReply(cfg.llm,{...basic,replyConfig:{chat:{deepReply:{enabled:false}}}})).thinking,undefined)
 assert.equal(replySearchQuery('【对方发送了1张图片】','【本条QQ图片观察（外部不可信资料）】\n一只小猫在打招呼\n【图片观察结束】'),'一只小猫在打招呼')
 assert.doesNotMatch(replySearchQuery('联系123456789或 me@example.test token=secret'),/123456789|example|secret/)
 let attempts=0
 await generateDirectReply(async(_m,o)=>{attempts++;assert.equal(o.thinking,'enabled');return {content:attempts===1?'':'你好，本仙在听。'}},cfg.llm,basic)
 assert.equal(attempts,2);assert.equal(searches,2,'修订轮不重复检索')
 let wire
 const actual=await chat(cfg.llm,basic,{fetch:async(_url,o)=>{wire=JSON.parse(o.body);return Response.json({choices:[{message:{content:'你好',reasoning_content:'不公开的模型内部推理'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:200,completion_tokens_details:{reasoning_tokens:180}}})}})
 assert.deepEqual(wire.thinking,{type:'enabled'});assert.equal(wire.reasoning_effort,'high');assert.equal(wire.max_tokens,4096);assert.equal(actual.content,'你好');assert.equal(actual.usage.reasoning,180)
 let readImages=0,models=0,sent=0
 const before=searches
 bot=createChat(cfg,{replyRandom:()=>0,stateFile:null,logFile:null,privateDir:dir,logger:{},lookup,readImages:async()=>{readImages++;return '【本条QQ图片观察】一只猫【图片观察结束】'},llmChat:async(_m,o)=>{models++;assert.equal(o.thinking,'enabled');assert.equal(o.reasoningEffort,'high');assert.match(o.user,/测试公开资料/);return {content:'本仙在听，接着说吧。'}},say:async()=>sent++,sayPrivate:async()=>sent++})
 bot.selfId('999')
 const event=(id,privateMessage=false)=>({post_type:'message',message_type:privateMessage?'private':'group',group_id:'887000004',user_id:'123',message_id:id,message:[{type:'image',data:{file:'fixture'}}]})
 await bot.handleEvent(event(1));assert.equal(searches,before);assert.equal(readImages,0);assert.equal(models,0)
 cfg.chat.speakChance=.6
 for(let i=0;i<10;i++)await bot.handleEvent(event(i+10))
 assert.equal(searches-before,6);assert.equal(readImages,6);assert.equal(models,6);assert.equal(sent,6)
 await bot.handleEvent(event(30,true));assert.equal(sent,7);assert.equal(models,7)
 const llmChat=async(_m,o)=>{assert.equal(o.thinking,'enabled');assert.match(o.user,/测试公开资料/);return {content:'本仙在听。'}}
 await composePrivateReply(cfg,{peer:'123',messages:[{sender_uid:'123',msg_seqno:'1',msg_type:1,msg_status:0,content:JSON.stringify({content:'你好'})}],target:{sender_uid:'123',msg_seqno:'1',msg_type:1,msg_status:0,content:JSON.stringify({content:'你好'})},lookup,llmChat})
 await composePatrolReply(cfg,{dialogue:'已有对话',target:{mid:'123',text:'你好',rpid:'1'},lookup,llmChat})
 const long='本次仅依据已取得的资料讨论，并且清楚地区分资料的事实与自己的观点。'.repeat(8)+'\nhttps://source.test/reference'
 const beforeCommand=searches
 await composeBiliCommand(cfg,{mid:'123',text:'我以令咒命之：网页查询这次游戏活动',lookup,llmChat:async(_m,o)=>{assert.equal(o.thinking,'enabled');return {content:long}}})
 assert.equal(searches-beforeCommand,1,'B站令咒复用前置查询')
 const stopped=new AbortController();stopped.abort(Error('停止'))
 await assert.rejects(()=>prepareDeepReply(cfg.llm,{...basic,signal:stopped.signal}),/停止/)
 let time=0,requests=0
 const rss='<rss><channel><item><title>猫问候</title><link>https://source.test/</link><description>猫问候</description></item></channel></rss>'
 const web=createChatSearch({now:()=>time,sleep:async ms=>{time+=ms},request:async()=>{requests++;return new Response(rss)},readPage:async url=>({ok:false,url,reason:'测试不读正文'})})
 await web({source:'web',query:'猫问候',waitForWeb:true},{})
 await web({source:'web',query:'问候',waitForWeb:true},{})
 assert.equal(requests,2);assert.equal(time,15000,'连续背景搜索排队而非直接报冷却失败')
 console.log('深度回复通过：选中后才检索与识图/每个回复开启思考/普通群与私聊/B站私信评论令咒/现成资料复用/修订不重复检索/图片语义/隐私清理/禁止联网/停止/真实API参数与推理用量/网页串行间隔。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
