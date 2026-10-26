import fs from 'node:fs'
import path from 'node:path'
import {DATA} from './config.mjs'
import {biliPolicy} from './bili-policy.mjs'
import {collect,toPromptText} from './collect.mjs'
import {readVideoReactions,reactionCounts,reactionScore} from './video-reactions.mjs'
import {chat,parseJSON} from './llm.mjs'
import {generateDirectReply} from './chat-response.mjs'
import {biliPersona} from './bili-identity.mjs'
import {deliverRecommendation,hourlyDeliveryPlan} from './scroll-delivery.mjs'

const HOUR=3600000
export function readHourlyScroll(dataDir=DATA){try{return JSON.parse(fs.readFileSync(path.join(dataDir,'hourly-scroll.json'),'utf8'))}catch{return null}}
export function hourlyScrollSummary(s=readHourlyScroll(),cfg){
 if(!s)return null
 const editable=!['sharing','done'].includes(s.status),keywords=editable?(cfg?.scroll?.reactionKeywords??s.keywords??[]):s.keywords??[]
 return {deliveryVersion:2,biliPrivatePushEnabled:cfg?.scroll?.biliPrivateEnabled===true,deliveries:(s.targets??[]).map(t=>({kind:t.kind,id:t.id,status:s.receipts?.[t.key]?.status||(s.receipts?.[t.key]?'sent':t.kind==='group'&&s.pending?.[t.id]?'pending':'waiting')})),startedAt:s.startedAt,status:s.status,read:s.items?.length??0,target:10,keywords,winner:s.winner??null,errors:s.errors??[],pendingGroups:Object.keys(s.pending??{}),items:(s.items??[]).map(x=>{const counts=editable&&x.reactions.samples?reactionCounts(x.reactions.samples,keywords):x.reactions.counts;return {bvid:x.bvid,title:x.title,score:reactionScore(counts),counts,coverage:x.reactions.coverage,complete:x.reactions.complete}})}
}
export async function runHourlyScroll(cfg,opts,{gather,readSeen=()=>({}),writeSeen=()=>{}}={}) {
 const deps=opts.deps??{},now=deps.now??Date.now,isActive=opts.isActive??(()=>true),log=opts.logger??(()=>{}),dir=deps.dataDir??DATA,file=path.join(dir,'hourly-scroll.json'),lock=file+'.lock'
 if(opts.dry){const s=readHourlyScroll(dir);return {candidates:0,judged:[],sent:[],planned:s?.winner?s.items.filter(x=>x.bvid===s.winner):[],why:'预演只查看当前小时进度，不新增观看或发送'}}
 fs.mkdirSync(dir,{recursive:true});let fd
 try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid))}catch{
  try{const pid=Number(fs.readFileSync(lock,'utf8'));if(pid>0){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')fs.unlinkSync(lock)}}}catch{}
  return {candidates:0,judged:[],sent:[],planned:[],why:'小时比较正在执行或等待释放旧锁',nextAt:now()+60000}
 }
 const save=s=>{const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(s,null,2));fs.renameSync(tmp,file)}
 const result=(s,why,nextAt)=>({candidates:0,judged:[],sent:[],planned:[],batch:{read:s.items.length,target:10,startedAt:s.startedAt,status:s.status},why,nextAt})
 try{
  let s=readHourlyScroll(dir)??{startedAt:now(),items:[],pool:[],status:'collecting'}
  if(s.status==='done')s={startedAt:Math.max(now(),s.startedAt+HOUR),items:[],pool:[],status:'collecting'}
  if(!Array.isArray(s.items)||!Array.isArray(s.pool))throw Error('小时比较记录损坏，未自动清空')
  const keywords=[...new Set((cfg.scroll?.reactionKeywords??['?','？','妈妈']).map(String).map(s=>s.trim()).filter(Boolean))]
  if(!keywords.length)return result(s,'选词列表为空，小时比较已暂停',now()+60000)
  if(s.status!=='sharing'&&JSON.stringify(s.keywords)!==JSON.stringify(keywords)){
   s.keywords=keywords
   for(const item of s.items){if(item.reactions.samples){item.reactions.counts=reactionCounts(item.reactions.samples,keywords);item.reactions.score=reactionScore(item.reactions.counts);item.reactions.keywords=keywords}}
   save(s)
  }
  const status=await (deps.policyStatus??(()=>biliPolicy.status()))()
  if(status.cooldownUntil>now())return result(s,'B站风控冷却中',status.cooldownUntil)
  if(!isActive())return result(s,'已停止',now()+60000)
  if(s.items.length<10){
   if(status.nextWatchAt>now())return result(s,'等待下一个观看时段',status.nextWatchAt)
   if(!s.pool.length){const seen=new Set(s.items.map(x=>x.bvid)),known=readSeen();s.pool=(await gather(cfg,cfg.scroll??{},log,deps)).filter(v=>!seen.has(v.bvid)&&!known[v.bvid]);save(s)}
   const cand=s.pool.shift();if(!cand){save(s);return result(s,'候选不足十个，继续等待新候选',now()+6*60000)}
   save(s)
   const material=await (deps.collect??collect)(cand.bvid,cfg,{isActive})
   let reactions
   try{reactions=await (deps.readReactions??readVideoReactions)(material,cfg,{isActive})}catch(e){if(e.biliPolicy||e.commentRisk)throw e;reactions={score:0,counts:{},complete:false,coverage:{},errors:['互动统计未完成']}}
   if(!isActive())return result(s,'已停止，未继续采集',now()+60000)
   s.items.push({bvid:cand.bvid,title:material.video.title,aid:material.video.aid,mid:String(material.video.ownerMid??''),material:toPromptText(material,cfg.llm).slice(0,6500),reactions,readAt:now()});save(s)
   const known=readSeen();known[cand.bvid]={ts:now(),verdict:'hourly-watched',reason:'已纳入小时互动采样比较'};writeSeen(known)
   log(`小时比较：已读${s.items.length}/10，选词计数 ${JSON.stringify(reactions.counts?.byKeyword??{})}${reactions.complete?'':'（统计不完整）'}`)
   if(s.items.length<10){const p=await (deps.policyStatus??(()=>biliPolicy.status()))();return {...result(s,'已保存本条统计，读满十个后再选',p.nextWatchAt||now()+6*60000),candidates:1,judged:[{bvid:cand.bvid,reactions}]}}
  }
  if(now()<s.startedAt+HOUR){s.status='waiting-hour';save(s);return result(s,'本小时十个已读完，等本轮满一小时后分享',s.startedAt+HOUR)}
  if(s.countedAt&&!s.shareClaimedAt)s.shareClaimedAt=s.countedAt
  if(status.nextShareAt>now()&&(!s.shareClaimedAt||status.share?.some(r=>String(r.bvid)!==String(s.winner))))return result(s,'等待每小时分享额度',status.nextShareAt)
  const comparable=s.items.filter(x=>x.reactions?.complete)
  if(!comparable.length){s.status='done';s.finishedAt=now();s.reason='十个视频均无完整可比较统计，没有把读取失败当成零条，也未随机转发';save(s);return result(s,s.reason,now()+60000)}
  const winner=[...comparable].sort((a,b)=>b.reactions.score-a.reactions.score||a.readAt-b.readAt)[0]
  s.winner=winner.bvid;s.status='sharing';save(s)
  if(!winner.comment){
   const r=await generateDirectReply(deps.chat??chat,cfg.llm,{replyConfig:cfg,replySearchResult:{ok:true,source:'bili',results:s.items.map(x=>({title:x.title,url:`https://www.bilibili.com/video/${x.bvid}`,description:'本小时已实际读取的候选视频资料'}))},styleTask:winner.title,system:biliPersona(cfg)+'本轮已读十个视频文字素材。选中了互动采样中用户选词出现总次数最多的视频，写给QQ群友一到两句具体短评，不捏造画面，不把采样数说成全量，不贴网址。只输出短评正文。',user:'本轮选词：'+JSON.stringify(s.keywords)+'\n'+s.items.map(x=>`${x.title}：${JSON.stringify(x.reactions.counts)}；${x.material.slice(0,600)}`).join('\n')+'\n选中视频实际材料：\n'+winner.material,maxReplyChars:180,maxTokens:4096})
   winner.comment=String(parseJSON(r.content)?.reply??'').trim();if(!winner.comment)throw Error('未生成可用短评，未发送');save(s)
  }
  const plan=hourlyDeliveryPlan(cfg)
  if(!plan.targets.length)return result(s,'没有配置QQ分享群或B站私信接收人',now()+60000)
  s.receipts??={};s.pending??={};s.targets=plan.targets;save(s)
  if(opts.dry)return {...result(s,'预演未发群',now()+60000),planned:[winner]}
  const groupSend=deps.sendGroup??(await import('./qq.mjs')).sendGroup
  const safeDeps={...deps,claimShare:async bvid=>{if(s.shareClaimedAt&&now()-s.shareClaimedAt<HOUR)return;await(deps.claimShare??(id=>biliPolicy.claim('share',id)))(bvid);s.shareClaimedAt=now();save(s)},sendGroup:async(c,id,text)=>{if(s.pending[id])throw Error('上次群回执未确认，不重复发送');s.pending[id]=true;save(s);return groupSend(c,id,text)}}
  const sent=[]
  const delivery=await deliverRecommendation(cfg,winner,{plan,receipts:s.receipts,deps:safeDeps,isActive,onAttempt:async()=>save(s),onReceipt:async(target)=>{if(target.kind==='group')delete s.pending[target.id];if(!s.countedAt){s.countedAt=now();sent.push(winner)}save(s);log(`小时比较投递确认：${target.key}`)}})
  if(delivery.complete){s.status='done';s.finishedAt=now()}
  s.errors=delivery.errors;save(s)
  if(delivery.errors.length)log('小时比较投递待处理：'+delivery.errors.join('；'))
  return {...result(s,delivery.errors.join('；'),now()+60000),sent}
 }catch(e){log('小时比较未完成：'+(e.biliPolicy?e.message:'读取、统计或发送未完成，进度保留'));return {candidates:0,judged:[],sent:[],planned:[],why:e.biliPolicy?e.message:'本轮未完成，已保存进度',nextAt:now()+6*60000}}
 finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock)}}
}
