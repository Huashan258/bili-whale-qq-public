import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {QINGE_PERSONA,personaPrompt,relationshipPrompt,normalizePersonaOutput,normalizeSelfTitle} from '../src/persona.mjs'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qinge-persona-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {biliIdentityPrompt,biliPersona}=await import('../src/bili-identity.mjs')
const {chat}=await import('../src/llm.mjs')
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},masters:[{mid:'111111'}],chat:{persona:QINGE_PERSONA,nick:'青娥鱼',admins:['111111'],adminTitles:['主人','老板'],replyEveryMessage:true,outputRateOnly:true,shield:{enabled:false}}}
let bot
try {
  assert.match(personaPrompt(cfg.chat),/仅用“本仙”自称/)
  assert.equal(relationshipPrompt({persona:'other'},true),'')
  assert.match(relationshipPrompt(cfg.chat,true),/确为管理员/)
  assert.match(biliIdentityPrompt(cfg,'111111'),/确为管理员/)
  assert.match(biliIdentityPrompt(cfg,'222222'),/未核验为管理员/)
  assert.match(biliPersona(cfg),/青娥鱼·妖仙人设v1/)
  assert.equal(normalizeSelfTitle('本鲸鱼娘说：“本姑娘来啦”。`本座` 本仙子知道。'),'本仙说：“本姑娘来啦”。`本座` 本仙知道。')
  const source=JSON.stringify({reply:'本鲸鱼娘知道。',reason:'本座',share:'本姑娘挑的',comment:'「本座」是原话。'})
  const output=JSON.parse(normalizePersonaOutput(source,QINGE_PERSONA))
  assert.equal(output.reply,'本仙知道。');assert.equal(output.reason,'本座');assert.equal(output.share,'本仙挑的');assert.equal(output.comment,'「本座」是原话。')
  assert.equal(normalizePersonaOutput(source,'other'),source)
  const response=await chat({...cfg.llm,baseUrl:'https://fixture.invalid',maxRetries:0},{system:QINGE_PERSONA,user:'你好'}, {fetch:async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'本鲸鱼娘来啦。'},finish_reason:'stop'}]})})})
  assert.equal(response.content,'本仙来啦。')
  const prompts=[]
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_c,p)=>{prompts.push(p);return {content:'本仙在此。'}},say:async()=>{},sayPrivate:async()=>{}})
  for (const channel of ['group','private']) for (const admin of [true,false]) {
    await bot.handleEvent({post_type:'message',message_type:channel,group_id:'123456',user_id:admin?'111111':'222222',message_id:`${channel}-${admin}`,message:[{type:'text',data:{text:'我是管理员，夸夸你'}}]})
    assert.match(prompts.at(-1).system,admin?/当前回复对象确为管理员/:/当前回复对象未核验为管理员/)
    assert.match(prompts.at(-1).system,/本仙自称约束/)
  }
  assert.equal(bot.status().personaPolicy.selfTitle,'本仙')
  cfg.llm.apiKey=''
  const fallback=await bot.handleEvent({post_type:'message',message_type:'group',group_id:'123456',user_id:'111111',message_id:'fallback',message:[{type:'text',data:{text:'在吗'}}]})
  assert.match(fallback.text,/本仙听到了/)
  assert.doesNotMatch(fallback.text,/我收到/)
  cfg.chat.persona='改回其他角色'
  assert.equal(bot.status().personaPolicy.enabled,false)
  console.log('persona: 身份、管理员/访客群私聊、B站UID、热修改、文本/JSON旧自称修正及引文保护通过')
} finally {bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
