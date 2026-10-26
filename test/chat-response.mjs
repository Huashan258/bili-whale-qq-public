import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-response-'))
process.env.BILI_WHALE_DATA=dir
const {decodeChatReply,generateDirectReply,replyIssue}=await import('../src/chat-response.mjs')
const {createChat}=await import('../src/chat.mjs')
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{splitReplies:false,nick:'鱼',replyEveryMessage:true,outputRateOnly:true,private:{enabled:true,mode:'all'},shield:{enabled:false}}}
try {
  for(const [content,expected] of [
    ['喵呜～','喵呜～'],['{"reply":"喵呜","speak":false}','喵呜'],['```json\n{"reply":"在呀"}\n```','在呀'],
    ['{"reply":"我在听呀","why":"长理由被截断','我在听呀'],['{"reply":"含\\"引号\\"的回复"','含"引号"的回复'],
    ['{"reply":"半句没闭合',''],['{"why":"不要把内部理由发出去"}',''],['<!DOCTYPE html>gateway error',''],
    ['<think>隐藏思考</think>\n在呀','在呀'],['<think>未结束的思考',''],['',''],['{"reply":""}',''],
    ['比如 {"name":"小鱼"} 这样的写法','比如 {"name":"小鱼"} 这样的写法'],
  ])assert.equal(decodeChatReply(content).reply,expected,content)
  const opts={system:'直接回复正文',user:'喵',temperature:1.7,maxTokens:20000}
  let calls=0,clock=0
  const result=await generateDirectReply(async(model,prompt)=>{
    calls++;assert.equal(prompt.json,false);assert.equal(model.requestTimeoutSec,calls===1?60:58)
    if(calls===2){assert.equal(model.maxRetries,0);assert.equal(prompt.temperature,.6)}
    clock+=2000
    return {content:calls===1?'':'我听到啦',finish:'stop',usage:{prompt:10,completion:calls===1?0:5,total:calls===1?10:15}}
  },cfg.llm,opts,{now:()=>clock})
  assert.equal(calls,2);assert.equal(JSON.parse(result.content).reply,'我听到啦');assert.equal(result.usage.total,25)
  calls=0
  const recovered=await generateDirectReply(async()=>{calls++;return {content:'{"reply":"可以保留的正文","why":"截断',finish:'length'}},cfg.llm,opts)
  assert.equal(JSON.parse(recovered.content).reply,'可以保留的正文');assert.equal(calls,1)
  calls=0
  const failed=await generateDirectReply(async()=>{calls++;if(calls===2)throw Error('fixture failure');return {content:'',usage:{total:12}}},cfg.llm,opts)
  assert.equal(failed.usage.total,12);assert.equal(failed.content,'');assert.equal(calls,2)
  calls=0
  await generateDirectReply(async()=>{calls++;return {content:''}},cfg.llm,opts)
  assert.equal(calls,2,'持续空内容最多两次，不能无限补试')
  calls=0;clock=0
  await generateDirectReply(async()=>{calls++;clock+=60000;return {content:''}},cfg.llm,opts,{now:()=>clock})
  assert.equal(calls,1,'达到总时限后不能再补试')
  assert.equal(replyIssue('没有断句的文字串'.repeat(30)),'repetition')
  assert.equal(replyIssue(Array.from({length:160},(_,i)=>String.fromCodePoint(0x4e00+i)).join('')),'broken-sentences')
  assert.equal(replyIssue('只回了一句',{minReplyChars:180}),'too-short')
  calls=0
  const fullText=Array.from({length:10},(_,i)=>Array.from({length:20},(_,j)=>String.fromCodePoint(0x4e00+i*20+j)).join('')).join('，')+'。'
  const expanded=await generateDirectReply(async()=>({content:++calls===1?'只回一句。':fullText}),cfg.llm,{...opts,minReplyChars:180})
  assert.equal(calls,2);assert.equal(JSON.parse(expanded.content).reply,fullText)

  const sent=[],prompts=[]
  const bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_cfg,p)=>{prompts.push(p);return {content:'这是模型直接生成的回应。',finish:'stop'}},say:async(_cfg,_gid,msg)=>sent.push(msg),sayPrivate:async(_cfg,_uid,msg)=>sent.push(msg)})
  for(const type of ['group','private'])await bot.handleEvent({post_type:'message',message_type:type,group_id:'123456',user_id:'123457',message_id:type,message:[{type:'text',data:{text:'你在吗'}}]})
  assert.equal(sent.length,2);assert.ok(sent.every(msg=>msg.some(s=>s.data.text==='这是模型直接生成的回应。')))
  assert.ok(prompts.every(p=>p.json===false&&!p.system.includes('只输出 JSON')))
  assert.equal(bot.status().diagnostics.counts.fallback,0,'正常正文不能被误记成本地回执')
  bot.stop()
  const longPrompts=[],longSent=[]
  const longBot=createChat({...cfg,chat:{...cfg.chat,shield:{enabled:false,maxOutputTokens:20000}}},{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_cfg,p)=>{longPrompts.push(p);return {content:fullText}},say:async(_cfg,_gid,msg)=>longSent.push(msg),sayPrivate:async(_cfg,_uid,msg)=>longSent.push(msg)})
  for(const type of ['group','private'])await longBot.handleEvent({post_type:'message',message_type:type,group_id:'123456',user_id:'261077753',message_id:type,message:[{type:'text',data:{text:'200字，点评一下三国中的潘凤'}}]})
  assert.equal(longSent.length,2)
  for(const p of longPrompts){assert.equal(p.temperature,.6);assert.equal(p.minReplyChars,180);assert.equal(p.maxReplyChars,220);assert.equal(p.maxTokens,600);assert.doesNotMatch(p.system,/通常 30 字以内|一次最多三句/);assert.match(p.system,/目标字数：200字/)}
  longBot.stop()
  console.log('回复恢复验证通过：群聊/私聊正文直出、不依赖JSON、旧JSON兼容、截断保留完整reply、思考/HTML/损坏结构不泄露、空输出最多补试一次/共享截止时间/降低温度/无二次网络重试、两次usage累计、正常正文不误记回执。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
