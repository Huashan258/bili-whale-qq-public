import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-quote-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {createQuotedReplyReader,quotedMessageId}=await import('../src/qq-quoted-reply.mjs')
const bots=[]
try{
 assert.equal(quotedMessageId('[CQ:reply,id=-12]你好'),'-12')
 assert.equal(quotedMessageId([{type:'text',data:{text:'回复青娥鱼'}}]),null)
 let lookups=0;const reader=createQuotedReplyReader({lookup:async(_c,id)=>{lookups++;if(id==='404')throw Error('offline');return {message_id:Number(id),message_type:'group',group_id:id==='3'?999:123,user_id:id==='2'?456:999,sender:{nickname:'青娥鱼'},message:[{type:'image',data:{file:'fixture.png'}}]}}})
 const cfg={qq:{groupIds:['123']},llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'青娥鱼',replyEveryMessage:false,speakChance:0,outputRateOnly:true,repeat:{enabled:true,chance:1,text:true},shield:{enabled:false},contextMessages:2}}
 const sent=[],prompts=[],seen=[]
 const bot=createChat(cfg,{readQuoted:reader,readImages:async images=>{seen.push(images);return '\n本次引用图片观察：红夹子头饰、大兽耳'},llmChat:async(_m,p)=>{prompts.push(p);return {content:'红夹子配这对耳朵，倒挺精神的'}},say:async(_c,_g,m)=>sent.push(m),stateFile:null,logFile:path.join(dir,'chat.log'),privateDir:path.join(dir,'private'),logger:{}});bot.selfId('999');bots.push(bot)
 const event=(id,quote='1')=>({post_type:'message',message_type:'group',group_id:123,user_id:456,message_id:id,sender:{nickname:'群友'},message:[{type:'reply',data:{id:quote}},{type:'text',data:{text:'那对红夹子头饰，配上大兽耳。'}}]})
 assert.equal((await bot.handleEvent(event(-1893066460))).spoke,true,'没有@且普通概率0也识别对本仙的引用')
 assert.equal(sent.length,1);assert.equal(prompts.length,1);assert.match(prompts[0].user,/当前消息的引用对象/);assert.match(prompts[0].user,/本次引用图片观察/);assert.equal(prompts[0].replyActor.uid,'456','原图作者不能变成当前发言者');assert.equal(seen[0][0].file,'fixture.png')
 const row=fs.readFileSync(path.join(dir,'chat.log'),'utf8').split('\n').filter(Boolean).map(JSON.parse).find(r=>r.type==='in');assert.equal(row.quote.self,true);assert.equal(row.quote.id,'1');assert.equal(row.quote.images,undefined,'日志不存图片URL')
 const trace=bot.status().diagnostics.recent.find(r=>r.messageId==='-1893066460');assert.ok(trace.selection.forcedReasons.includes('reply-to-self'))
 for(const quote of ['2','3','404']){await bot.handleEvent(event(20+Number(quote),quote));assert.equal(sent.length,1,'回复其他人、跨群或查不到原文不能误触发')}
 assert.equal(seen.length,1,'未选中的普通引用不额外识图')
 await reader(event(200),cfg,'999');assert.equal(lookups,4,'已核验引用短时缓存避免重复拉取')
 const unresolved=await reader(event(201,'404'),cfg,'999');assert.equal(unresolved.verified,false)
 console.log('QQ引用回复通过：无@定向接话/原图识别/当前发言者不串人/引用落盘/其他人及跨群和失败不强回/缓存。无真实QQ发送。')
}finally{bots.forEach(b=>b.stop());fs.rmSync(dir,{recursive:true,force:true})}
