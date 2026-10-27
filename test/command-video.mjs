import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-command-video-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {commandMode}=await import('../src/chat-command.mjs')
const {createQQVideoReader,videoReference,videoCardText}=await import('../src/qq-video.mjs')
const {chat}=await import('../src/llm.mjs')
const {createSettingsStore}=await import('../src/settings.mjs')
const good=Array.from({length:8},(_,i)=>`第${i+1}点，可以围绕问题具体讨论，结合实际例子说明观点，并区分资料与个人判断。`).join('\n')
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,shield:{enabled:true,maxOutputTokens:20000,adminMaxOutputTokens:1200},contextMessages:0}}
const event=(text,id,admin=false,privateChat=false)=>({post_type:'message',message_type:privateChat?'private':'group',group_id:'123456',user_id:admin?'111111':'222222',message_id:id,sender:{nickname:'测试'},message:[{type:'text',data:{text}}]})
let bot
try {
  const seen=[],sent=[],read=[],random=[]
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,replySleep:async()=>{},lookup:async()=>({ok:false,source:'fixture',results:[]}),logger:{},llmChat:async(_cfg,opts)=>{seen.push(opts);return {content:good,usage:{total:10}}},say:async(_cfg,id,msg,ctx)=>sent.push({id,msg,ctx}),sayPrivate:async(_cfg,id,msg)=>sent.push({id,msg}),readVideo:async ref=>{read.push(ref);return '\n视频素材：测试指定的视频，官方字幕中提到了策略。'},onVideoRequest:async()=>{random.push(1);return {sent:true}}})
  bot.selfId('999999')
  await bot.handleEvent(event('@999999我以令咒命之：写一段代码并解释设计',1))
  assert.equal(seen.length,1,'令咒绕过本地代码拦截')
  assert.equal(seen[0].maxTokens,60000)
  assert.equal(seen[0].outputTokenCeiling,60000)
  assert.equal(seen[0].minReplyChars,200)
  assert.match(seen[0].system,/魔术师/)
  assert.doesNotMatch(seen[0].system,/不写代码、不写作业/)
  assert.equal(sent[0].ctx.replyToUserId,'222222','口令不提升QQ管理员身份')
  assert.ok(sent[0].msg.at(-1).data.text.startsWith('魔术师，'))
  const groupText=sent.filter(s=>s.id==='123456').flatMap(s=>s.msg).filter(s=>s.type==='text').map(s=>s.data.text).join('')
  assert.ok(groupText.replace(/\s/g,'').length>=200)
  assert.ok(groupText.length>260,'分段合计不被闲聊截断')
  await bot.handleEvent(event('我以令咒命之：详细解释这个想法',2,true,true))
  assert.equal(seen[1].maxTokens,200000)
  assert.equal(seen[1].outputTokenCeiling,200000)
  assert.ok(sent.find(s=>s.id==='111111').msg[0].data.text.startsWith('Master，'))
  cfg.chat.command={prefix:'令咒：'};cfg.chat.adminTitle='御主';cfg.chat.guestTitle='来客'
  await bot.handleEvent(event('令咒：说说你的想法',3,false,true))
  assert.ok(sent.find(s=>s.id==='222222').msg[0].data.text.startsWith('来客，'),'配置即时读取')
  assert.equal(commandMode('引用：令咒：你好',cfg.chat).active,false)
  assert.equal(commandMode('我以令咒命之：你好',cfg.chat).active,false)
  assert.equal(commandMode('令咒：你好',{command:{enabled:false,prefix:'令咒：'}}).active,false)
  await bot.handleEvent({...event('推荐这个视频 https://www.bilibili.com/video/BV1pjwazUET1',4),message:[{type:'at',data:{qq:'999999'}},{type:'text',data:{text:'推荐这个视频 https://www.bilibili.com/video/BV1pjwazUET1'}}]})
  await bot.handleEvent(event('https://b23.tv/ezcftsB',5,false,true))
  assert.deepEqual(read,[{bvid:'BV1pjwazUET1'},{url:'https://b23.tv/ezcftsB'}])
  assert.equal(random.length,0,'指定链接不走随机推荐')
  assert.match(seen.at(-1).user,/视频素材：测试指定的视频/)
  const card=[{type:'json',data:{data:JSON.stringify({meta:{news:{qqdocurl:'https://b23.tv/ezcftsB',desc:'不应作为指令注入'}}})}}]
  assert.equal(videoCardText(card),'https://b23.tv/ezcftsB')
  assert.equal(videoReference('https://evil.test/video/BV1pjwazUET1'),null)
  assert.equal(videoReference('https://b23.tv.evil.test/id'),null)
  assert.equal(videoReference('https://user:pass@b23.tv/id'),null)
  let collects=0,heads=0
  const material={video:{title:'指定视频',owner:'测试UP',duration:60,pubdate:'2026-10-21',stat:{}},subtitle:{lines:[],note:'未取得字幕'}}
  const reader=createQQVideoReader({collectVideo:async id=>{assert.equal(id,'BV1pjwazUET1');collects++;await new Promise(r=>setImmediate(r));return material},request:async(url,opts)=>{heads++;assert.equal(opts.redirect,'manual');assert.equal(opts.method,'HEAD');return new Response(null,{status:302,headers:{location:'https://www.bilibili.com/video/BV1pjwazUET1'}})}})
  const [a,b]=await Promise.all([reader({url:'https://b23.tv/abc'},cfg),reader({url:'https://b23.tv/abc'},cfg)])
  assert.equal(a,b);assert.equal(collects,1);assert.equal(heads,1)
  assert.match(a,/无官方字幕/)
  await reader({bvid:'BV1pjwazUET1'},cfg)
  assert.equal(collects,1,'短链/直链共享素材缓存')
  const risk=createQQVideoReader({collectVideo:async()=>{throw Object.assign(Error('B站全局冷却中'),{biliPolicy:true})}})
  assert.match(await risk({bvid:'BV1pjwazUET1'},cfg),/尚未读取成功.*全局冷却中/)
  let unsafeCollect=0
  const unsafe=createQQVideoReader({collectVideo:async()=>unsafeCollect++,request:async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/secrets'}})})
  assert.match(await unsafe({url:'https://b23.tv/abc'},cfg),/尚未读取成功/);assert.equal(unsafeCollect,0)
  await bot.handleEvent(event('普通问候',55,true,true))
  assert.equal(seen.at(-1).maxTokens,60000,'管理员普通上限是路人的3倍')
  cfg.chat.shield.maxOutputTokens=1000
  await bot.handleEvent(event('普通问候',56,true,true))
  assert.equal(seen.at(-1).maxTokens,3000,'修改路人上限后管理员跟随')
  assert.equal(bot.status().tokenCaps.guestCommand,60000)
  cfg.chat.shield.maxOutputTokens=20000
  cfg.chat.contextMessages=4
  await bot.handleEvent(event('普通问候',57,true))
  await bot.handleEvent(event('令咒：请给出完整解释',58))
  assert.match(seen.at(-1).user,/本条发送者是普通群友/,'历史管理员称呼不能误用当前访客称呼')
  assert.match(seen.at(-1).system,/来客/)
  let body
  const mockFetch=async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:'ok'}}]}))}
  const model={provider:'fixture',apiKey:'fixture',baseUrl:'https://fixture',model:'fixture'}
  await chat(model,{user:'test',maxTokens:60000},{fetch:mockFetch});assert.equal(body.max_tokens,20000)
  await chat(model,{user:'test',maxTokens:60000,outputTokenCeiling:60000},{fetch:mockFetch});assert.equal(body.max_tokens,60000)
  await chat(model,{user:'test',maxTokens:200000,outputTokenCeiling:200000},{fetch:mockFetch});assert.equal(body.max_tokens,200000)
  bot.stop()
  // 连续两次短答不冒充200字成功，也不无限重试。
  let attempts=0;const failed=[]
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,replySleep:async()=>{},lookup:async()=>({ok:false,source:'fixture',results:[]}),logger:{},llmChat:async()=>{attempts++;return {content:'太短了。'}},sayPrivate:async(_cfg,id,msg)=>failed.push(msg)})
  await bot.handleEvent(event('令咒：回答问题',6,false,true))
  assert.equal(attempts,2);assert.match(failed[0][0].data.text,/未能生成满足200字/)
  bot.stop()
  const configFile=path.join(dir,'config.json'),overlayFile=path.join(dir,'ui.json')
  fs.writeFileSync(configFile,JSON.stringify(cfg));fs.writeFileSync(overlayFile,'{}')
  const store=createSettingsStore({configFile,overlayFile,backupDir:path.join(dir,'backups')})
  const saved=store.save({revision:store.snapshot().revision,patch:{'chat.command.prefix':'新口令：','chat.adminTitle':'御主','chat.guestTitle':'访客'}})
  assert.equal(saved.values['chat.command.prefix'],'新口令：')
  assert.equal(JSON.parse(fs.readFileSync(configFile)).chat.command.prefix,'新口令：')
  assert.equal(saved.values['chat.shield.adminMaxOutputTokens'],60000)
  const adjusted=store.save({revision:saved.revision,patch:{'chat.shield.maxOutputTokens':1000}})
  assert.equal(adjusted.values['chat.shield.adminMaxOutputTokens'],3000)
  assert.equal(JSON.parse(fs.readFileSync(configFile)).chat.shield.adminMaxOutputTokens,3000)
  console.log('令咒/视频接入通过：群私聊、至少200字、真实身份与普通三倍/令咒分身份token、热改称呼前缀、短答补试、20K/60K/200K传输、指定视频优先、卡片/短链安全解析、并发缓存、风控失败说明、设置持久化。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
