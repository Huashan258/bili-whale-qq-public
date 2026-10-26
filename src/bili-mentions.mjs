import fs from 'node:fs'
import path from 'node:path'
import {DATA,loadState,saveState} from './config.mjs'
import {biliFetch} from './bili-policy.mjs'
import {createQQVideoReader,videoReference} from './qq-video.mjs'
import {videoInfo} from './collect.mjs'
import {composePatrolReply} from './bili-patrol.mjs'
import {addComment} from './bili-comment.mjs'
import {biliIdentity} from './bili-identity.mjs'
import {quotaOf,noteComment,noteWrite} from './quota.mjs'
import {hasLLM} from './llm.mjs'

const reader=createQQVideoReader(),digits=v=>/^[1-9]\d*$/.test(String(v??''))?String(v):''
const headers=cfg=>({cookie:cfg.cookieHeader,'user-agent':'Mozilla/5.0',referer:'https://message.bilibili.com/'})
async function api(url,cfg,isActive){const r=await biliFetch(url,{headers:headers(cfg),isActive,signal:AbortSignal.timeout(20000)});const j=await r.json();if(!r.ok||j.code!==0)throw Error(`B站@提醒读取失败（${j.code??r.status}）：${j.message||'接口异常'}`);return j.data}
export async function listBiliMentionPage(cfg,{isActive=()=>true,cursor,request=api}={}){
  const query=new URLSearchParams({build:'0',mobi_app:'web'})
  if(digits(cursor?.id)&&digits(cursor?.time)){query.set('id',String(cursor.id));query.set('time',String(cursor.time))}
  const data=await request('https://api.bilibili.com/x/msgfeed/at?'+query,cfg,isActive)
  const next=data?.cursor
  return {items:data?.items||[],cursor:next&&(next.is_end===false||next.is_end===0)&&digits(next.id)&&digits(next.time)?{id:String(next.id),time:String(next.time)}:null}
}
export async function listBiliMentions(cfg,options){return (await listBiliMentionPage(cfg,options)).items}

export function mentionInitialDelay(cfg,{dataDir=DATA,now=Date.now,defaultMs=300000}={}){
  if(cfg.biliInbox?.mentionsEnabled===false)return defaultMs
  try{const next=JSON.parse(fs.readFileSync(path.join(dataDir,'bili-mentions.json'),'utf8'))[digits(cfg.raw?.bili?.dedeUserId)]?.nextAt
    return Number.isFinite(next)?Math.min(defaultMs,Math.max(1000,next-now())):defaultMs
  }catch{return defaultMs}
}
export function mentionTarget(row,cfg,at=Date.now()) {
  const item=row?.item,self=digits(cfg.raw?.bili?.dedeUserId),uid=digits(row?.user?.mid),reference=videoReference(item?.uri),when=Number(row?.at_time)*1000
  if(!self||!uid||uid===self||item?.business_id!==1||item?.type!=='reply'||!reference?.bvid||!digits(item.source_id)||!digits(item.subject_id)||!Number.isFinite(when)||when<at-7*86400000||when>at+60000)return null
  if(!item.at_details?.some(a=>String(a.mid)===self))return null
  return {bvid:reference.bvid,aid:digits(item.subject_id),rpid:digits(item.source_id),root:digits(item.root_id)||digits(item.source_id),mid:uid,uname:String(row.user.nickname||''),selfName:String(item.at_details.find(a=>String(a.mid)===self)?.nickname||''),text:String(item.source_content||''),title:String(item.title||''),time:when}
}
export async function verifyMentionTarget(target,cfg,{isActive,request=api}) {
  const page=Math.min(50,Math.max(1,Number(target.verifyPage)||1))
  const data=await request(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${target.aid}&root=${target.root}&ps=20&pn=${page}`,cfg,isActive)
  const replies=[data?.root,...(data?.replies||[])].filter(Boolean)
  const reply=replies.find(r=>String(r.rpid)===target.rpid)
  if(!reply){const more=Number(data?.page?.count)>page*20||(data?.replies?.length===20&&!data?.page);throw Object.assign(Error('本页未找到被@楼层，已保留待处理'),{mentionNextPage:more&&page<50?page+1:1})}
  if(String(reply.mid??reply.member?.mid)!==target.mid||String(reply.oid)!==target.aid)throw Error('被@评论的作者或视频不匹配，暂不发送')
  return {...target,text:String(reply.content?.message||''),root:digits(reply.root)||target.rpid}
}

export async function runBiliMentions(cfg,{dataDir=DATA,now=Date.now,dry=false,isActive=()=>true,list=listBiliMentionPage,verify=verifyMentionTarget,info=videoInfo,readVideo=reader,compose=composePatrolReply,send=addComment,load=loadState,save=saveState}={}) {
  if(cfg.biliInbox?.mentionsEnabled===false)return {sent:0,why:'@提醒已关闭'}
  if(!hasLLM(cfg.llm))return {sent:0,why:'模型未配置，暂不读取@提醒'}
  const file=path.join(dataDir,'bili-mentions.json'),lock=file+'.lock'
  fs.mkdirSync(dataDir,{recursive:true});let owned=false
  const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return {};throw Error('@提醒账本读取失败，停止以免重复回复')}}
  const write=s=>{const temp=file+'.'+process.pid+'.tmp';fs.writeFileSync(temp,JSON.stringify(s,null,2));fs.renameSync(temp,file)}
  try {
    try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true}catch(e){if(e.code!=='EEXIST')throw e;try{process.kill(Number(fs.readFileSync(lock,'utf8')),0)}catch(e){if(e.code==='ESRCH')fs.unlinkSync(lock)}return {sent:0,why:'已有@提醒任务在执行'}}
    const ledger=read(),self=digits(cfg.raw?.bili?.dedeUserId)
    if(!self)return {sent:0,why:'缺少B站账号UID'}
    const account=ledger[self]??={entries:{}}
    account.entries??={};account.queue??={}
    if(account.nextAt>now()||!isActive())return {sent:0,why:'@提醒每五分钟检查一次'}
    if(!dry){account.nextAt=now()+300000;write(ledger)}
    const cursor=account.scanOlder?account.cursor:null
    const page=await list(cfg,{isActive,cursor}),rows=Array.isArray(page)?page:page.items||[],state=load()
    const incoming=rows.map(r=>mentionTarget(r,cfg,now())).filter(Boolean)
    for(const target of incoming){const previous=account.queue[target.rpid]||{};account.queue[target.rpid]={...previous,...target,verifyPage:previous.verifyPage||1}}
    const oldPage=rows.some(row=>Number(row.at_time)*1000<now()-7*86400000)
    if(cursor){account.cursor=oldPage?null:page.cursor||null;account.scanOlder=false}
    else {if(!account.cursor&&!oldPage)account.cursor=page.cursor||null;account.scanOlder=Boolean(account.cursor)}
    for(const [id,target] of Object.entries(account.queue))if(target.time<now()-7*86400000||state.replied?.[id]||['pending','sent','unknown'].includes(account.entries[id]?.status))delete account.queue[id]
    if(!dry)write(ledger)
    const queued=Object.keys(account.queue).length
    const targets=Object.values(account.queue).filter(t=>!(t.nextAt>now())).sort((a,b)=>Number(biliIdentity(cfg,b.mid).master)-Number(biliIdentity(cfg,a.mid).master)||(a.lastTriedAt||0)-(b.lastTriedAt||0)||a.time-b.time)
    if(!targets.length){const uncertain=incoming.filter(t=>['pending','unknown'].includes(account.entries[t.rpid]?.status)).length;return {sent:0,queued,read:rows.length,eligible:incoming.length,uncertain,why:queued?`还有${queued}条@提醒待重试，保留在队列中`:`读到${rows.length}条提醒，其中近七天有效视频@${incoming.length}条，没有新的待回复留言${uncertain?`；${uncertain}条发送结果待核对，不重复发送`:''}`}}
    let target=targets[0]
    const defer=why=>{account.queue[target.rpid]={...account.queue[target.rpid],lastTriedAt:now(),nextAt:now()+300000,reason:String(why).slice(0,240)};if(!dry)write(ledger);return {sent:0,queued,read:rows.length,bvid:target.bvid,target:target.rpid,why:`${target.bvid} @提醒待处理：${why}`}}
    let dispatched=false
    try{
    const identity=biliIdentity(cfg,target.mid),quota=quotaOf(cfg,state,target.mid,'reply',{master:identity.master})
    if(!quota.ok)return defer(quota.why)
    target=await verify(target,cfg,{isActive})
    if(target.selfName){const escaped=target.selfName.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');target.text=target.text.replace(new RegExp('^\\s*@'+escaped+'\\s*[:：]?\\s*'),'')}
    const video=await info(target.bvid,cfg,{isActive})
    if(String(video.aid)!==target.aid)throw Error('@提醒与视频ID不一致，未回复')
    const material=await readVideo({bvid:target.bvid},cfg,{isActive})
    if(!material||material.includes('【指定视频尚未读取成功】'))return defer('视频尚未读取成功，保留待下次处理')
    if(!isActive())return {sent:0,why:'@提醒任务已停止'}
    const text=await compose(cfg,{dialogue:`视频《${video.title||target.title}》；对方在此@你，请结合真实素材回答。`,target,mentioned:true,videoContext:material.replace('本条QQ消息','本条B站@留言'),isActive})
    if(!text)return defer('@回复未生成可用正文，保留待处理')
    if(dry)return {sent:0,why:'预演：已读取视频并生成@回复，未发布',planned:[target.rpid]}
    if(!isActive())return {sent:0,why:'@提醒任务已停止'}
    dispatched=true;account.entries[target.rpid]={status:'pending',bvid:target.bvid,at:now()};delete account.queue[target.rpid];write(ledger)
    try {
      const receipt=await send(cfg,{bvid:target.bvid,aid:target.aid,root:target.root,parent:target.rpid,text,isActive})
      if(!digits(receipt?.rpid))throw Error('@评论发送缺少回执，不自动重发')
      account.entries[target.rpid]={status:'sent',bvid:target.bvid,rpid:String(receipt.rpid),at:now()};write(ledger)
      const latest=load();latest.replied??={};latest.replied[target.rpid]={at:new Date(now()).toISOString(),rpid:String(receipt.rpid),bvid:target.bvid,root:target.root,mid:target.mid,text,mention:true};noteComment(cfg,latest,target.mid,'reply');noteWrite(latest);save(latest)
      return {sent:1,queued:queued-1,read:rows.length,why:`已读取 ${target.bvid} 素材并回复评论区@提醒`,bvid:target.bvid,target:target.rpid,rpid:String(receipt.rpid)}
    }catch(e){account.entries[target.rpid].status=e.biliNotSent?'retry':'unknown';if(e.biliNotSent)account.queue[target.rpid]={...target,lastTriedAt:now(),nextAt:now()+300000,reason:e.message};write(ledger);throw e}
    }catch(e){
      if(dispatched||e.biliPolicy||e.commentRisk)throw e
      if(e.mentionNextPage)account.queue[target.rpid].verifyPage=e.mentionNextPage
      return defer(e.message||'本轮未完成，稍后重试')
    }
  }finally{if(owned)fs.unlinkSync(lock)}
}
