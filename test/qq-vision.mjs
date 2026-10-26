import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-vision-'))
process.env.BILI_WHALE_DATA=dir
const {qqImages,createQQVision}=await import('../src/qq-vision.mjs')
const {createChat}=await import('../src/chat.mjs')
const {validatePatch}=await import('../src/settings.mjs')
const {chat}=await import('../src/llm.mjs')
const cfg={llm:{provider:'deepseek',apiKey:'fixture',model:'deepseek-chat'},qq:{groupIds:['123456']},vision:{enabled:true},chat:{replyEveryMessage:true,outputRateOnly:true,contextMessages:0,admins:['111111'],shield:{enabled:true,maxOutputTokens:20000}}}
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfakAAAAASUVORK5CYII=','base64')
let calls=0,gets=0,resolves=0,usage=0
const modelChat=async(model,opts)=>{calls++;assert.equal(model.model,'deepseek-flash');assert.ok(Array.isArray(opts.user));assert.match(opts.user[2].image_url.url,/^data:image\/png;base64,/);assert.equal(opts.maxTokens,1400);return {content:'图片1：一只猫，旁边有清晰文字“你好”。',usage:{total:123}}}
const reader=createQQVision({modelChat,request:async()=>{gets++;return new Response(png)},resolveImage:async()=>{resolves++;return {url:'https://gchat.qpic.cn/file'}}})
let bot
try {
  const img={file:'qq-image-id',url:'https://gchat.qpic.cn/a?secret=private'}
  assert.equal(qqImages('[CQ:image,file=id,url=https://gchat.qpic.cn/a?a=1&amp;b=2]').at(0).url,'https://gchat.qpic.cn/a?a=1&b=2')
  assert.match(await reader([img],cfg,{onUsage:u=>usage+=u.total}),/一只猫/);assert.equal(usage,123)
  await reader([{file:'file-id'}],cfg);assert.equal(resolves,1)
  let refreshed=0
  const stale=createQQVision({modelChat,request:async url=>url.includes('expired')?new Response(null,{status:404}):new Response(png),resolveImage:async()=>{refreshed++;return {url:'http://gchat.qpic.cn/fresh'}}})
  assert.match(await stale([{url:'https://gchat.qpic.cn/expired',file:'id'}],cfg),/一只猫/)
  assert.equal(refreshed,1,'过期地址通过OneBot刷新；兼容QQ旧HTTP地址并升级HTTPS')
  let ntDownloads=0
  const nt=createQQVision({modelChat,request:async url=>{assert.equal(new URL(url).hostname,'multimedia.nt.qq.com.cn');ntDownloads++;return new Response(png)}})
  assert.match(await nt([{url:'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=fixture&rkey=fixture'}],cfg),/一只猫/)
  assert.equal(ntDownloads,1,'真实QQNT图片域名必须被识别')
  assert.match(await nt([{url:'https://multimedia.nt.qq.com.cn.evil.test/secret'}],cfg),/未.*看到内容/)
  assert.equal(ntDownloads,1,'伪装QQNT后缀不下载')
  const before=calls
  assert.match(await reader([img],{...cfg,vision:{enabled:false}}),/开关已关闭/);assert.equal(calls,before)
  const limited=await reader([img,img,img,img],cfg);assert.match(limited,/其余未读取/)
  assert.match(await reader([{url:'https://127.0.0.1/file'}],cfg),/未.*看到内容/)
  const redirected=createQQVision({modelChat,request:async()=>new Response(null,{status:302,headers:{location:'http://127.0.0.1/secret'}})})
  assert.match(await redirected([img],cfg),/读取失败/)
  const html=createQQVision({modelChat,request:async()=>new Response('<!DOCTYPE html>')})
  assert.match(await html([img],cfg),/读取失败/)
  const large=createQQVision({modelChat,request:async()=>new Response('x',{headers:{'content-length':String(9*1024*1024)}})})
  assert.match(await large([img],cfg),/读取失败/)
  const broken=createQQVision({request:async()=>new Response(png),modelChat:async()=>{throw Error('secret internal error')}})
  const failed=await broken([img],cfg);assert.match(failed,/无法确认图片内容/);assert.doesNotMatch(failed,/secret/)
  const ctrl=new AbortController();ctrl.abort(Error('stopped'))
  await assert.rejects(reader([img],cfg,{signal:ctrl.signal}),/stopped/)
  const seen=[],sent=[]
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},readImages:reader,llmChat:async(_,opts)=>{seen.push(opts);return {content:'图里是一只猫，旁边写着“你好”，看起来是在打招呼呢。',usage:{total:10}}},say:async(_,id,msg)=>sent.push(msg),sayPrivate:async(_,id,msg)=>sent.push(msg)})
  bot.selfId('999999')
  const event=(message,id,priv=false)=>({post_type:'message',message_type:priv?'private':'group',group_id:'123456',user_id:'222222',message_id:id,sender:{nickname:'测试'},message})
  await bot.handleEvent(event([{type:'image',data:img}],1))
  await bot.handleEvent(event([{type:'text',data:{text:'图上写了什么？'}},{type:'image',data:img}],2,true))
  await bot.handleEvent(event('[CQ:image,file=id,url=https://gchat.qpic.cn/a?secret=private]',3))
  assert.equal(sent.length,3)
  for(const opts of seen){assert.match(opts.user,/一只猫/);assert.match(opts.system,/不可信/);assert.doesNotMatch(opts.user,/secret=private|data:image|gchat.qpic/)}
  cfg.vision.enabled=false
  await bot.handleEvent(event([{type:'image',data:img}],4,true))
  assert.match(seen.at(-1).user,/开关已关闭/)
  assert.equal(bot.status().qqVision.enabled,false)
  bot.stop()
  let visionReads=0,modelCalls=0,videoRequests=0
  const probabilitySent=[]
  cfg.chat.replyEveryMessage=false;cfg.chat.speakChance=0;cfg.chat.shield.enabled=false
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},replyRandom:()=>0,onVideoRequest:async()=>{videoRequests++;return {sent:true}},readImages:async()=>{visionReads++;return '本次成功读取的图片资料。'},llmChat:async()=>{modelCalls++;return {content:'这张图里的小猫正在打招呼。'}},say:async(_,id,msg)=>probabilitySent.push(msg),sayPrivate:async(_,id,msg)=>probabilitySent.push(msg)})
  bot.selfId('999999')
  const picture=[{type:'image',data:img}]
  await bot.handleEvent(event(picture,10))
  assert.equal(visionReads,0);assert.equal(modelCalls,0);assert.equal(probabilitySent.length,0,'0%普通图片不识图也不回复')
  assert.deepEqual(bot.status().catchUp.pending,[],'未选中图片不挂补话')
  cfg.chat.speakChance=.6
  for(let i=0;i<10;i++)await bot.handleEvent(event(i%2?picture:'[CQ:image,file=id,url=https://gchat.qpic.cn/a]',20+i))
  assert.equal(probabilitySent.length,6);assert.equal(visionReads,6);assert.equal(modelCalls,6,'十张普通图片只识图和回复六次')
  let credit=0
  for(let i=0;i<10;i++){
    credit+=.6;const selected=credit>=1-1e-10;if(selected)credit=Math.max(0,credit-1)
    const withImage=i%3!==0,beforeRead=visionReads,beforeSent=probabilitySent.length
    await bot.handleEvent(event(withImage?[{type:'text',data:{text:'看看这个'}},...picture]:[{type:'text',data:{text:'今天普通聊天'}}],40+i))
    assert.equal(probabilitySent.length-beforeSent,Number(selected),'文字与图文共享同一份选择状态')
    assert.equal(visionReads-beforeRead,Number(selected&&withImage),'未选中图文不调用识图')
  }
  assert.equal(probabilitySent.length,12)
  cfg.chat.speakChance=0
  await bot.handleEvent(event([{type:'at',data:{qq:'999999'}},...picture],60))
  assert.equal(probabilitySent.length,13,'明确@的图片仍直接回复')
  await bot.handleEvent(event(picture,61,true))
  assert.equal(probabilitySent.length,14,'私聊识图不受群主动接话概率影响')
  cfg.chat.replyEveryMessage=true
  await bot.handleEvent(event(picture,62))
  assert.equal(probabilitySent.length,15,'必回模式仍回复图片')
  assert.equal(bot.status().replySelection.imagesShareChance,true)
  assert.equal(videoRequests,0,'启用生产点播回调后，普通图片仍不被误判为点播')
  const {wantsVideo}=await import('../src/share.mjs')
  for(const text of ['【对方发送了1张图片】','发张图片','推荐图片','找一张照片','发个卡片'])assert.equal(wantsVideo(text),false,text)
  for(const text of ['发个视频','推荐点视频','来个片子'])assert.equal(wantsVideo(text),true,text)
  cfg.chat.replyEveryMessage=false;cfg.chat.speakChance=.3
  cfg.qq.groupIds.push('880010002');cfg.chat.admins.push('880010001')
  const replayStart=probabilitySent.length,replayReads=visionReads
  const ids=[1260665897,82376477,-1262809209,-1578139333,-238471499,-234572325,7001,7002,7003,7004]
  for(const id of ids)await bot.handleEvent({...event(picture,id),group_id:'880010002',user_id:'880010001'})
  assert.equal(probabilitySent.length-replayStart,3,'真实群号/管理员/启用点播下，0.3十张图仅回三条')
  assert.equal(visionReads-replayReads,3)
  assert.ok(bot.status().diagnostics.recent.filter(r=>r.target==='880010002').every(r=>r.selection.forced===false))
  let wire
  await chat({...cfg.llm,baseUrl:'https://fixture'},{user:[{type:'image_url',image_url:{url:'data:image/png;base64,fixture'}}],thinking:'disabled',maxTokens:1400},{fetch:async(_,opts)=>{wire=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:'观察完成'},finish_reason:'stop'}]}))}})
  assert.deepEqual(wire.thinking,{type:'disabled'})
  assert.equal(wire.messages[0].content[0].type,'image_url')
  assert.throws(()=>validatePatch({'vision.maxImages':4}))
  assert.throws(()=>validatePatch({'vision.maxImages':1.5}))
  assert.throws(()=>validatePatch({'vision.detail':'invalid'}))
  console.log('QQ识图通过：群/私聊/纯图/CQ、模型图像块、用量、开关热读、数量限制、坏链接/内网跳转/HTML/大图/模型失败、取消和不泄漏链接。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
