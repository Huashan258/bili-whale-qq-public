import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-bili-inbox-'))
process.env.BILI_WHALE_DATA=dir
const {runPrivateInbox,pendingPrivate,parsePrivateJSON,sendPrivateMessage}=await import('../src/bili-private.mjs')
const {runPatrol}=await import('../src/bili-patrol.mjs')
const SELF='887000005',PEER='887000007',bv='BV1pjwazUET1'
let clock=Date.now()
const cfg={raw:{bili:{dedeUserId:SELF}},cookie:{sessdata:'secret-session',bili_jct:'secret-jct'},cookieHeader:'secret-cookie',llm:{provider:'fixture',apiKey:'fixture'},masters:[{mid:PEER,name:'主人'}],biliInbox:{enabled:true,privateUsers:[PEER],pollMinutes:5,lookbackHours:48},share:{ownVideoReplies:true,replyWatchVideos:[bv],masterReplyPerVideo:2,biliGapSec:0,biliCommentPerDay:300}}
const msg=(n,text='PRIVATE INPUT',sender=PEER)=>({sender_uid:sender,receiver_id:sender===PEER?SELF:PEER,receiver_type:1,msg_seqno:String(n),msg_key:'69843934917676690'+String(n),msg_type:1,msg_status:0,timestamp:Math.floor(clock/1000),content:JSON.stringify({content:text})})
try {
  assert.equal(parsePrivateJSON('{"msg_key":6984393491767669026}').msg_key,'6984393491767669026')
  assert.deepEqual(pendingPrivate([msg(1),msg(2)],{self:SELF,peer:PEER}).map(m=>m.msg_seqno),['2'])
  assert.equal(pendingPrivate([msg(1),msg(3,'own',SELF)],{self:SELF,peer:PEER}).length,0)
  assert.equal(pendingPrivate([{...msg(1),msg_status:1}],{self:SELF,peer:PEER}).length,0)
  assert.deepEqual(pendingPrivate([msg(3),msg(2)],{self:SELF,peer:PEER,cursor:'1'}).map(m=>m.msg_seqno),['2','3'])
  const sent=[]
  const options={dataDir:path.join(dir,'live'),now:()=>clock,list:async()=>[msg(1),msg(2)],compose:async()=> 'PRIVATE OUTPUT',send:async(_c,p,t)=>{sent.push({p,t});return {msg_key:'9999999999999999999'}}}
  assert.equal((await runPrivateInbox(cfg,options)).sent,1)
  assert.equal((await runPrivateInbox(cfg,options)).sent,0,'重载不能清空五分钟间隔')
  clock+=300001
  assert.equal((await runPrivateInbox(cfg,options)).sent,0,'重启不能重复回同一条')
  assert.equal(sent.length,1)
  const ledger=fs.readFileSync(path.join(options.dataDir,'bili-private.json'),'utf8')
  assert.doesNotMatch(ledger,/PRIVATE INPUT|PRIVATE OUTPUT|secret-cookie|secret-session/)
  clock+=300001
  assert.equal((await runPrivateInbox(cfg,{...options,list:async()=>[msg(3),msg(4)]})).sent,1)
  clock+=300001
  assert.equal((await runPrivateInbox(cfg,{...options,list:async()=>[msg(3),msg(4)]})).sent,1,'新消息按游标逐条，不因自己的回复覆盖剩余入站')

  const uncertain={...options,dataDir:path.join(dir,'uncertain'),send:async()=>{throw Error('unknown transport result')}}
  await assert.rejects(()=>runPrivateInbox(cfg,uncertain),/unknown/)
  clock+=300001
  const blocked=await runPrivateInbox(cfg,uncertain)
  assert.equal(blocked.uncertain,true,'不明发送结果不能盲目重发')
  clock+=300001
  const recovered=await runPrivateInbox(cfg,{...uncertain,list:async()=>[msg(1),msg(2),msg(3,'PRIVATE OUTPUT',SELF)]})
  assert.equal(recovered.sent,0);assert.equal(recovered.uncertain,undefined,'通过真实已发消息散列确认不明回执')

  let refused=0
  const rejectOptions={...options,dataDir:path.join(dir,'rejected'),send:async()=>{refused++;throw Object.assign(Error('rejected'),{biliNotSent:true,biliPrivateCode:21047})}}
  await assert.rejects(()=>runPrivateInbox(cfg,rejectOptions),/rejected/)
  clock+=300001
  assert.equal((await runPrivateInbox(cfg,rejectOptions)).sent,0)
  assert.equal(refused,1,'明确被拒绝也需等待，不应每轮撞相同限制')
  let releaseList,announceList
  const started=new Promise(r=>announceList=r),hold=new Promise(r=>releaseList=r)
  const concurrent={...options,dataDir:path.join(dir,'concurrent'),list:async()=>{announceList();await hold;return [msg(2)]}}
  const first=runPrivateInbox(cfg,concurrent);await started
  assert.match((await runPrivateInbox(cfg,concurrent)).why,/正在执行/)
  releaseList();assert.equal((await first).sent,1,'重叠巡检只能有一条真正发送')
  const dryDir=path.join(dir,'dry')
  assert.equal((await runPrivateInbox(cfg,{...options,dataDir:dryDir,dry:true})).planned,1)
  assert.equal(fs.existsSync(path.join(dryDir,'bili-private.json')),false)
  assert.equal((await runPrivateInbox(cfg,{...options,dataDir:path.join(dir,'stopped'),isActive:()=>false})).sent,0)

  let wire
  const ack=await sendPrivateMessage(cfg,PEER,'你好',{deviceId:'device-uuid',mixin:async()=> 'mixin',request:async(url,opts)=>{wire={url,opts};return {ok:true,text:async()=>'{"code":0,"data":{"msg_key":6984393491767669026}}'}}})
  assert.equal(ack.msg_key,'6984393491767669026');assert.match(wire.url,/w_rid=/)
  assert.equal(wire.opts.method,'POST');assert.equal(wire.opts.body.get('msg[receiver_id]'),PEER)
  assert.equal(wire.opts.body.get('csrf'),'secret-jct');assert.equal(wire.opts.body.get('csrf_token'),'secret-jct')
  assert.deepEqual(JSON.parse(wire.opts.body.get('msg[content]')),{content:'你好'})

  // 自己投稿下，用户根评论的count=0也能回；真实root/parent正确，不伪造自己根评论。
  const state={commented:{},replied:{}}
  const roots=[{rpid:'321369068576',mid:PEER,uname:'主人',text:'鱼',ctime:Math.floor(Date.now()/1000),count:0},{rpid:'ancient',mid:PEER,text:'旧的@别人',ctime:1,count:0}]
  const deliveries=[],hooks={info:async()=>({aid:'116229364777417',ownerMid:SELF,title:'自己的投稿'}),listComments:async()=>roots,listReplies:async()=>[],compose:async(_c,p)=>{assert.equal(p.ownVideo,true);assert.match(p.dialogue.text,/【主人】主人：鱼/);return '在呢'},send:async(_c,p)=>{deliveries.push(p);return {rpid:'bot-reply'}},save:()=>{},logger:()=>{}}
  const own=await runPatrol(cfg,state,hooks)
  assert.equal(own.sent,1);assert.equal(deliveries[0].root,'321369068576');assert.equal(deliveries[0].parent,'321369068576')
  assert.equal(state.commented[bv],undefined,'不能把用户评论写成机器人发过的根评论')
  assert.equal((await runPatrol(cfg,state,hooks)).sent,0)
  const nested=await runPatrol(cfg,state,{...hooks,listReplies:async()=>[{rpid:'nested',mid:PEER,uname:'主人',text:'还在吗',ctime:Math.floor(Date.now()/1000)}]})
  assert.equal(nested.sent,1);assert.equal(deliveries.at(-1).root,'321369068576');assert.equal(deliveries.at(-1).parent,'nested')
  assert.equal(state.replied.ancient,undefined,'不补发几个月前的旧留言')
  const pv='BV1tCn36NEZR',bg='BV1KEpn6cEf1',visited=[]
  const focusCfg={...cfg,share:{...cfg.share,ownVideoReplies:false,replyWatchVideos:[],replyFocusVideos:[pv,bv]}}
  const focusState={commented:Object.fromEntries([pv,bv,bg].map((id,i)=>[id,{aid:String(100+i),rpid:String(1234567+i)}])),replied:{}}
  const quietHooks={...hooks,listReplies:async(_cfg,p)=>{visited.push(p.bvid);return []}}
  await runPatrol(focusCfg,focusState,quietHooks);await runPatrol(focusCfg,focusState,quietHooks)
  assert.ok(visited.includes(pv)&&visited.includes(bv)&&visited.includes(bg),'关注视频轮巡不能饿死其他视频')
  console.log('B站接话验证通过：私信大整数/初次只接最近未回/撤回与自己排除/游标逐条/重启判重/5分钟下限/隐私不落正文/未知回执核对/明确拒绝冷却/预演与卸载、签名和双CSRF；自己的投稿一级零回复根楼/嵌套回复/身份/判重/旧留言不重放。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
