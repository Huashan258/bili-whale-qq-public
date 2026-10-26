import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-command-'))
process.env.BILI_WHALE_DATA=dir
const {biliCommandMode,composeBiliCommand}=await import('../src/bili-command.mjs')
const {composePrivateReply,privateMessageText}=await import('../src/bili-private.mjs')
const {composePatrolReply}=await import('../src/bili-patrol.mjs')
const cfg={raw:{bili:{dedeUserId:'880010003'}},masters:[{mid:'880010005',name:'示例管理员'}],llm:{provider:'fixture',apiKey:'fixture'},chat:{adminTitles:['主人'],nick:'青娥鱼',command:{enabled:true}}}
const body=Array.from({length:6},(_,i)=>`第${i+1}点，这里依据已经提供的真实资料说明当前问题，区分能够确认的内容和仍然缺少的信息，不会把没有阅读的页面说成读完。`).join('\n')
const prompts=[]
const llmChat=async(_,opts)=>{prompts.push(opts);return {content:body,usage:{total:10}}}
const message=(text,sender='880010005',n='1')=>({sender_uid:sender,receiver_id:'880010003',receiver_type:1,msg_type:1,msg_status:0,msg_seqno:n,content:JSON.stringify({content:text})})
try {
  assert.equal(biliCommandMode('回复 @核动力大肥鱼攻略组 :我以令咒命之：点评张飞',cfg,{comment:true}).active,true)
  assert.equal(biliCommandMode('有人说我以令咒命之：测试',cfg).active,false)
  const target=message('我以令咒命之：点评一下张飞')
  const reply=await composePrivateReply(cfg,{peer:'880010005',messages:[target],target,llmChat})
  assert.ok(reply.startsWith('Master，'));assert.ok(reply.replace(/\s/g,'').length>=200);assert.ok(reply.length<=500)
  assert.equal(prompts.at(-1).maxTokens,200000);assert.equal(prompts.at(-1).outputTokenCeiling,200000)
  assert.doesNotMatch(prompts.at(-1).system,/本条没有触发令咒|一到三句/)
  const guest=message('我以令咒命之：说明这个问题','777777')
  assert.match(await composePrivateReply(cfg,{peer:'777777',messages:[guest],target:guest,llmChat}),/^魔术师，/)
  assert.equal(prompts.at(-1).maxTokens,60000)
  const comment=await composePatrolReply(cfg,{dialogue:'旧上下文',target:{mid:'880010005',text:'回复 @鱼 :我以令咒命之：点评张飞'},ownVideo:true,llmChat})
  assert.match(comment,/^Master，/);assert.ok(comment.length>200&&comment.length<=900,'评论不被普通80字截断')
  const normal=message('你认得我吗','880010005','2')
  await composePrivateReply(cfg,{peer:'880010005',messages:[target,normal],target:normal,llmChat})
  assert.equal(prompts.at(-1).maxTokens,500,'历史口令不延续到下一条')
  assert.match(prompts.at(-1).system,/本条没有触发令咒/)
  cfg.chat.command.prefix='令咒：';cfg.chat.adminTitle='御主';cfg.chat.guestTitle='来客'
  const custom=await composeBiliCommand(cfg,{mid:'880010005',text:'令咒：解释这个问题',llmChat})
  assert.match(custom,/^御主，/)
  assert.equal(await composeBiliCommand(cfg,{mid:'880010005',text:'我以令咒命之：旧口令',llmChat}),null)
  let searches=0,reads=0
  const lookup=async()=>{searches++;return {ok:true,source:'page',pages:[{ok:true,url:'https://fixture.test/',finalURL:'https://fixture.test/',title:'实际网页',body:'这是实际读取的资料。',readAt:Date.now(),links:[]}],results:[{title:'实际网页',url:'https://fixture.test/',description:'实际资料'}]}}
  const grounded=await composeBiliCommand(cfg,{mid:'880010005',text:'令咒：读取https://fixture.test',lookup,llmChat:async(_,opts)=>{assert.match(opts.user,/已实际读取网页正文/);return {content:body+'\nhttps://fixture.test/',usage:{total:1}}}})
  assert.ok(grounded.length>=200);assert.equal(searches,1)
  let autoIntent
  await composeBiliCommand(cfg,{mid:'880010005',text:'令咒：锐评三角洲行动这次的渡鸦活动',lookup:async i=>{autoIntent=i;return lookup()},llmChat:async(_,opts)=>{assert.match(opts.user,/联网回答引导/);return {content:body+'\nhttps://fixture.test/'}}})
  assert.deepEqual(autoIntent,{source:'research',query:'三角洲行动 渡鸦活动',commandRead:true,fresh:true})
  assert.equal(searches,2)
  await composeBiliCommand(cfg,{mid:'880010005',text:'令咒：看看BV1pjwazUET1',lookup,readVideo:async()=>{reads++;return '明确提供的视频资料'},llmChat:async(_,opts)=>{assert.match(opts.user,/明确提供的视频资料/);return {content:body}}})
  assert.equal(reads,1);assert.equal(searches,2,'视频链接不重复触发网页检索')
  assert.equal(await composeBiliCommand(cfg,{mid:'880010005',text:'令咒：读取网页',isActive:()=>false,llmChat}), '')
  assert.ok(Buffer.byteLength(JSON.stringify({content:privateMessageText(reply)}))<=1900)
  console.log('B站令咒通过：私信/评论回复包装、200字且保留平台单条长度、主人200K/路人60K、专属称呼和自定义前缀、下一条恢复、网页正文/视频读取、停止不处理。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
