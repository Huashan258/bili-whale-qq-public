import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-dm-share-'))
process.env.BILI_WHALE_DATA=dir
const {deliveryPlan,deliverRecommendation}=await import('../src/scroll-delivery.mjs')
const {privateMessageText}=await import('../src/bili-private.mjs')
const cfg={raw:{bili:{dedeUserId:'887000005'}},chat:{admins:['123456'],outputRateOnly:true},qq:{groupIds:['234567']},masters:[{mid:'887000007'},{mid:'887000011'}],biliInbox:{privateUsers:['887000007']},scroll:{biliPrivateEnabled:true}}
const item={bvid:'BV1pjwazUET1',title:'测试视频',comment:'这条有趣的细节值得一看。',aid:'116229364777417'}
try {
  const plan=deliveryPlan(cfg)
  assert.deepEqual(plan.targets.map(t=>t.key),['private:123456','bili-private:887000007','group:234567'])
  assert.throws(()=>deliveryPlan({...cfg,biliInbox:{privateUsers:[]},masters:[],chat:{admins:[]}}),/B站私信/)
  const calls=[],attempts=[],receipts={};let claims=0,mode='ok',message=''
  const deps={claimShare:async()=>claims++,sendPrivate:async()=>calls.push('qq-private'),sendGroup:async()=>calls.push('qq-group'),sendBiliPrivate:async(_,id,text)=>{assert.equal(attempts.at(-1).status,'pending','发请求前已持久化待确认标记');calls.push('bili-private');message=text;if(mode==='unknown')throw Error('timeout');if(mode==='reject')throw Object.assign(Error('拒收'),{biliNotSent:true,biliPrivateCode:21047});return {msg_key:'7699452245835955540'}},listBiliPrivate:async()=>[]}
  const options={plan,receipts,deps,onAttempt:async(_,record)=>attempts.push({...record})}
  assert.equal((await deliverRecommendation(cfg,item,options)).complete,true)
  assert.deepEqual(calls,['qq-private','bili-private','qq-group']);assert.equal(claims,1,'多目的地只预留一个视频分享额度')
  assert.match(message,/https:\/\/www.bilibili.com\/video\/BV1pjwazUET1/)
  assert.equal(receipts['bili-private:887000007'].msgKey,'7699452245835955540')
  calls.length=0;await deliverRecommendation(cfg,item,options);assert.equal(calls.length,0)
  mode='unknown';const uncertain={};const pending={...options,receipts:uncertain}
  await deliverRecommendation(cfg,item,pending);assert.equal(uncertain['bili-private:887000007'].status,'pending')
  calls.length=0;await deliverRecommendation(cfg,item,pending);assert.equal(calls.length,0,'未知结果不能重复推送')
  deps.listBiliPrivate=async()=>[{sender_uid:'887000005',receiver_id:'887000007',receiver_type:1,msg_type:1,msg_status:0,timestamp:Math.floor(Date.now()/1000),msg_key:'matched-receipt',content:JSON.stringify({content:privateMessageText(message)})}]
  assert.equal((await deliverRecommendation(cfg,item,pending)).complete,true)
  assert.equal(uncertain['bili-private:887000007'].msgKey,'matched-receipt');assert.equal(calls.length,0,'通过实际消息核对回执，不重发')
  mode='reject';const rejected={};await deliverRecommendation(cfg,item,{...options,receipts:rejected});calls.length=0;const old=claims
  await deliverRecommendation(cfg,item,{...options,receipts:rejected});assert.equal(calls.length,0);assert.equal(claims,old,'拒收需等待，不能重复预留或发送')
  assert.equal(rejected['bili-private:887000007'].status,'rejected')
  assert.equal((await deliverRecommendation(cfg,item,{...options,receipts:{},isActive:()=>false})).complete,false)
  assert.equal(calls.length,0)
  console.log('B站视频私信通过：QQ和B站UID独立、多目的地共用一次小时分享预留、私信链接、发送前持久化、回执保存、未知结果核对不重发、明确拒收退避、停机不发送。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
