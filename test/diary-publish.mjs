import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'diary-publish-')),dataDir=path.join(root,'data')
process.env.BILI_WHALE_DATA=dataDir
const {createDiaryPublisher,diaryArticles}=await import('../src/diary-publish.mjs')
const {submitDiaryArticle,articlePayload}=await import('../src/bili-article.mjs')
const {createBiliPolicy}=await import('../src/bili-policy.mjs')
const collection={ensure:async()=>({id:'1234',name:'测试日记'}),sync:async()=>[]}
fs.mkdirSync(path.join(root,'words'));fs.mkdirSync(dataDir)
const write=(day,name,cutoff)=>fs.writeFileSync(path.join(root,'words',day+name+'.txt'),`${day} ${name}\n\n${'测试日记的真实事件。'.repeat(450)}\n\n——记录范围——\n截至北京时间${cutoff}`)
let time=Date.parse('2026-10-23T10:00:00+08:00'),mode='ok',calls=0,config={raw:{bili:{dedeUserId:'123'}},diary:{publishEnabled:true,publishGapMinutes:15},cookie:{sessdata:'fixture',bili_jct:'fixture'},cookieHeader:'fixture'}
try {
  write('2026-10-21','完整','23:59:59');write('2026-10-22','半日','12:00:00');write('2026-10-22','完整','23:59:59');write('2026-10-23','今天','09:00:00')
  assert.deepEqual(diaryArticles({root,dataDir,at:time}).map(i=>i.filename),['2026-10-21完整.txt','2026-10-22完整.txt'])
  const brief=path.join(root,'words','2026-10-20简记.txt')
  fs.writeFileSync(brief,'2026-10-20 简记\n\n今日与群友论书，知所未及，不敢妄言。\n\n——记录范围——\n截至北京时间23:59:59，文体：文言；日记格式：2。')
  assert.equal(diaryArticles({root,dataDir,at:time})[0].filename,'2026-10-20简记.txt','新短文可进入专栏队列')
  fs.unlinkSync(brief)
  const item=diaryArticles({root,dataDir,at:time})[0],body=articlePayload(item)
  assert.equal(body.opus_req.scene,12);assert.equal(body.opus_req.option.aigc,1);assert.equal(body.opus_req.option.private_pub,2);assert.equal(body.opus_req.opus.article.category_id,15)
  assert.ok(body.opus_req.opus.content.paragraphs.map(p=>p.text.nodes[0].word.words).join('\n').includes(item.body))
  const requests=[];let dispatched=false
  const request=async(url,options)=>{requests.push({url,options});if(url.includes('init_check'))return Response.json({code:0,data:{verify:{},config:{max_article_len:40000,max_title_len:40}}});assert.ok(dispatched);assert.equal(JSON.parse(options.body).opus_req.scene,12);return Response.json({code:0,data:{dyn_id_str:'987654321'}})}
  assert.equal((await submitDiaryArticle(item,config,{request,mixin:async()=> 'fixture',onDispatch:()=>dispatched=true})).id,'987654321')
  assert.equal(requests.length,2)
  await assert.rejects(submitDiaryArticle(item,config,{request:async()=>Response.json({code:0,data:{verify:{unreal_name:{result:1}}}})}),e=>e.biliNotSent&&/实名/.test(e.message))
  await assert.rejects(submitDiaryArticle(item,config,{request:async url=>url.includes('init_check')?Response.json({code:0,data:{}}):Response.json({code:0,data:{}}),mixin:async()=> 'fixture'}),/回执/)
  const publisher=createDiaryPublisher({root,dataDir,collection,config:()=>config,now:()=>time,submit:async(i,_,opts)=>{calls++;assert.equal(i.collectionId,'1234');await opts.onDispatch();assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,'diary-publish.json'))).entries['123:'+i.day].state,'pending');if(mode==='unknown')throw Error('timeout');return {id:'999',url:'https://www.bilibili.com/opus/999',state:'submitted'}}})
  await Promise.all([publisher.tick(),publisher.tick()]);assert.equal(calls,1)
  await publisher.tick();assert.equal(calls,1,'相隔15分钟才能补发下一篇')
  time+=16*60000;mode='unknown';await publisher.tick();assert.equal(calls,2);assert.equal(publisher.status().items[1].state,'unknown')
  time+=3600000;const restarted=createDiaryPublisher({root,dataDir,collection,config:()=>config,now:()=>time,submit:async()=>{throw Error('不应重发')}});await restarted.tick();assert.equal(calls,2)
  assert.equal(restarted.status().items[0].state,'submitted');assert.equal(restarted.status().items[1].state,'unknown')
  config.diary.publishEnabled=false;await publisher.tick();assert.equal(calls,2)
  // expectedHTML仅用于明确的创作中心文档页；API误返HTML和HTTP风控仍拦截。
  const htmlPolicy=createBiliPolicy({dataDir:path.join(root,'html-policy'),now:()=>time,random:()=>0,fetcher:async()=>new Response('<!doctype html><title>编辑器</title>')})
  await htmlPolicy.request('https://member.bilibili.com/york/read-editor',{expectedHTML:true});assert.ok(!(await htmlPolicy.status()).cooldownUntil)
  time+=30000
  await assert.rejects(htmlPolicy.request('https://api.bilibili.com/x/article/view',{expectedHTML:true}),e=>e.commentRisk)
  console.log('日记专栏通过：完整版/跨日筛选、每日去重、AI标注/全文段落、真实投稿结构、前置权限/容量检查、回执、落盘后发送、并发/重启/未知结果不重发、温和补发间隔、开关、HTML页与API风控区分。')
}finally{fs.rmSync(root,{recursive:true,force:true})}
