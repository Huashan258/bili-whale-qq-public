import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-forward-'));process.env.BILI_WHALE_DATA=dir
const {createForwardReader,hasForwardContent}=await import('../src/qq-forward.mjs')
const {createChat}=await import('../src/chat.mjs')
const {createQuotedReplyReader}=await import('../src/qq-quoted-reply.mjs')
const bots=[]
try{
 const pack=id=>[{type:'forward',data:{id}}]
 const text=t=>[{type:'text',data:{text:t}}]
 const node=(message,name='引用中的管理员')=>({sender:{user_id:888,nickname:name},message})
 let calls=0;const reader=createForwardReader({lookup:async(_c,id)=>{calls++;if(id==='bad')throw Error('fixture failure');return {messages:id==='outer'?[node(text('第一条原文')),node([{type:'image',data:{file:'image.png'}}]),node(pack('inner'))]:id==='inner'?[node(text('第二层原文')),node(pack('outer'))]:Array.from({length:130},()=>node(text('长'.repeat(1000))))}}})
 const r=await reader([pack('outer'),pack('outer')],{});assert.equal(r.summary.nodes,5);assert.equal(r.images.length,1);assert.equal(calls,2,'重复和环形转发不反复查询');assert.match(r.context,/第一条原文/);assert.match(r.context,/第二层原文/)
 const bad=await reader([pack('bad')],{});assert.equal(bad.summary.ok,false);assert.equal(bad.summary.failed,1)
 const large=await reader([pack('large')],{});assert.equal(large.summary.truncated,true);assert.ok(large.summary.chars<=6000)
 assert.equal(hasForwardContent('[CQ:forward,id=outer]'),true)
 const inline=await reader([[{type:'node',data:{nickname:'甲',content:text('内联原文')}}]],{});assert.match(inline.context,/内联原文/)
 const cfg={qq:{groupIds:['123']},llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'鱼',admins:[],replyEveryMessage:false,speakChance:0,outputRateOnly:true,shield:{enabled:false}}}
 const sent=[],prompts=[],seen=[];const quoted=createQuotedReplyReader({lookup:async()=>({group_id:123,message_id:77,message_type:'group',user_id:888,message:pack('outer')})})
 const bot=createChat(cfg,{readForward:reader,readQuoted:quoted,readImages:async images=>{seen.push(images);return '【本条QQ图片观察】本次记录里的图片内容【图片观察结束】'},llmChat:async(_c,p)=>{prompts.push(p);return {content:'记录里先说了第一件事，又转发了后面的讨论。'}},say:async(_c,_g,s)=>sent.push(s),sayPrivate:async(_c,_g,s)=>sent.push(s),stateFile:null,logFile:null,privateDir:dir,logger:{}});bots.push(bot);bot.selfId('999')
 const ev={post_type:'message',message_type:'group',group_id:123,user_id:456,message_id:1,message:[{type:'reply',data:{id:'77'}},{type:'at',data:{qq:'999'}},...text('这里面是什么')]}
 assert.equal((await bot.handleEvent(ev)).spoke,true);assert.match(prompts[0].user,/第一条原文/);assert.match(prompts[0].user,/第二层原文/);assert.match(prompts[0].user,/本次记录里的图片内容/);assert.equal(prompts[0].replyActor.uid,'456');assert.equal(prompts[0].replyActor.admin,false);assert.match(prompts[0].system,/不是当前消息发送者/);assert.equal(seen[0][0].file,'image.png')
 const before=calls;await bot.handleEvent({...ev,message_id:2,message:pack('outer')});assert.equal(calls,before,'纯转发不强制100%接话，也不提前展开读取')
 assert.equal(prompts.length,1)
 await bot.handleEvent({...ev,message_type:'private',message_id:3,message:pack('outer')});assert.equal(prompts.length,2);assert.match(prompts[1].user,/第一条原文/)
 console.log('合并转发通过：原生/CQ/内联/嵌套文本与图片、环形去重、截断/失败如实标注、引用别人的转发也可读取、当前发送者不串人、纯转发保留概率、私聊直发转发。无真实QQ发送。')
}finally{bots.forEach(b=>b.stop());fs.rmSync(dir,{recursive:true,force:true})}
