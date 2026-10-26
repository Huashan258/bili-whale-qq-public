import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-delivery-'))
process.env.BILI_WHALE_DATA=dir
const {deliveryPlan,deliverRecommendation}=await import('../src/scroll-delivery.mjs')
const {runScroll,hasPendingDeliveries}=await import('../src/scroll-duty.mjs')
const {validatePatch}=await import('../src/settings.mjs')
try {
  const cfg={llm:{provider:'openai',apiKey:'fixture'},chat:{admins:['123456','123456']},qq:{groupIds:['234567','345678']},scroll:{tags:['test'],minDurationSec:0,perDay:2,mentionPerDay:0,gapSec:0,useMasters:false},share:{biliCommentPerDay:0}}
  const plan=deliveryPlan(cfg)
  assert.equal(plan.mode,'private')
  assert.deepEqual(plan.targets.map(t=>t.key),['private:123456','group:234567','group:345678'])
  assert.throws(()=>deliveryPlan({...cfg,chat:{admins:[]}}),/接收 QQ/)
  assert.throws(()=>deliveryPlan({...cfg,qq:{groupIds:[]}}),/没有配置 QQ 群号/)
  assert.throws(()=>validatePatch({'scroll.deliveryMode':'unknown'}))
  assert.deepEqual(validatePatch({'scroll.deliveryMode':'private','scroll.syncGroups':true}),{'scroll.deliveryMode':'private','scroll.syncGroups':true})
  const item={bvid:'BV1KEpn6cEf1',title:'测试视频',comment:'有趣的细节',aid:'123'}
  const calls=[], receipts={}
  let failGroup=true
  const deps={claimShare:async()=>{},policyStatus:async()=>({}),sleep:async()=>{},addComment:async()=>{calls.push('comment');return {rpid:'123456',aid:'123'}},sendPrivate:async(_c,uid,msg)=>{calls.push(`private:${uid}`);assert.match(msg,/https:\/\/www.bilibili.com\/video\/BV1KEpn6cEf1/)},sendGroup:async(_c,gid,msg)=>{calls.push(`group:${gid}`);assert.match(msg,/测试视频/);if(gid==='345678'&&failGroup)throw new Error('模拟群发送失败')}}
  const partial=await deliverRecommendation(cfg,item,{plan,receipts,deps})
  assert.equal(partial.complete,false);assert.equal(partial.errors.length,1)
  assert.equal(calls.includes('comment'),false)
  assert.equal(Object.keys(receipts).length,2)
  failGroup=false;calls.length=0
  assert.equal((await deliverRecommendation(cfg,item,{plan,receipts,deps})).complete,true)
  assert.deepEqual(calls,['group:345678'])
  calls.length=0
  const publicPlan=deliveryPlan(cfg,{...cfg.scroll,deliveryMode:'comment',syncGroups:true})
  await deliverRecommendation(cfg,item,{plan:publicPlan,deps})
  assert.deepEqual(calls,['comment','group:234567','group:345678'])
  calls.length=0
  const customPlan=deliveryPlan(cfg,{...cfg.scroll,privateUsers:['456789'],groupIds:['567890']})
  assert.deepEqual(customPlan.targets.map(t=>t.key),['private:456789','group:567890'])
  assert.deepEqual(deliveryPlan({...cfg,qq:{groupIds:[]}}, {...cfg.scroll,syncGroups:false}).targets.map(t=>t.key),['private:123456'])
  const originalFetch=globalThis.fetch, requests=[]
  try {
    globalThis.fetch=async(_url,opts)=>{requests.push(JSON.parse(opts.body));return {text:async()=>JSON.stringify({status:'ok',retcode:0})}}
    await deliverRecommendation({...cfg,qq:{...cfg.qq,onebotHttp:'http://fixture'}},item,{deps:{claimShare:async()=>{},sleep:async()=>{}}})
    assert.deepEqual(requests.map(r=>r.action),['send_private_msg','send_group_msg','send_group_msg'])
    assert.equal(requests[0].params.user_id,123456)
    assert.match(requests[0].params.message[0].data.text,/https:\/\/www.bilibili.com/)
  } finally {globalThis.fetch=originalFetch}

  let judges=0, stateWrites=0
  const runDeps={...deps,sleep:async()=>{},search:async()=>[{bvid:item.bvid,title:item.title,duration:90,pubdate:Date.now()/1000}],collect:async()=>({video:{title:item.title,aid:'123',stat:{}}}),chat:async()=>{judges++;return {content:JSON.stringify({worth:true,comment:item.comment})}},loadState:()=>{throw new Error('私聊不应读 B站额度账本')},saveState:()=>stateWrites++}
  const dry=await runScroll(cfg,{dry:true,deps:runDeps})
  assert.equal(dry.planned.length,1);assert.equal(dry.planned[0].mode,'private')
  assert.equal(calls.length,0);assert.equal(fs.existsSync(path.join(dir,'scroll-seen.json')),false)
  judges=0;failGroup=true
  const first=await runScroll(cfg,{deps:runDeps})
  assert.equal(first.sent.length,1);assert.match(first.why,/模拟群发送失败/)
  assert.equal(stateWrites,0);assert.equal(judges,1)
  const seenFile=path.join(dir,'scroll-seen.json'), seen=JSON.parse(fs.readFileSync(seenFile,'utf8'))
  seen[item.bvid].ts=Date.now()-1800001
  fs.writeFileSync(seenFile,JSON.stringify(seen))
  assert.equal(hasPendingDeliveries(),true)
  calls.length=0;failGroup=false
  const retry=await runScroll(cfg,{deps:runDeps,sentToday:2})
  assert.deepEqual(calls,['group:345678'])
  assert.equal(retry.sent.length,0);assert.equal(judges,1)
  assert.equal(hasPendingDeliveries(),false)
  assert.equal(JSON.parse(fs.readFileSync(seenFile,'utf8'))[item.bvid].verdict,'worth')
  console.log('分享方式验证通过：默认 QQ 私聊、群同步、评论区模式、自定义接收人、无 B站额度依赖、预演零发送、失败只补发缺失目的地、日上限后可补群、重试不重复判断。')
} finally {fs.rmSync(dir,{recursive:true,force:true})}
