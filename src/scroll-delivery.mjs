import { biliPolicy, BILI_LIMITS } from './bili-policy.mjs'
import { addComment } from './bili-comment.mjs'
import { sendPrivate, sendGroup } from './qq.mjs'
import { sendPrivateMessage, listPrivateMessages, privateText, privateMessageText } from './bili-private.mjs'
import { createHash } from 'node:crypto'

const hash=value=>createHash('sha256').update(value).digest('hex')

const ids = values => [...new Set((values ?? []).map(String).map(v=>v.trim()).filter(Boolean))]
export function biliPrivateTargets(cfg,sc=cfg.scroll??{}) {
  if(sc.biliPrivateEnabled!==true)return []
  const users=ids(sc.biliPrivateUsers?.length?sc.biliPrivateUsers:cfg.biliInbox?.privateUsers?.length?cfg.biliInbox.privateUsers:(cfg.masters??[]).map(m=>m.mid))
    .filter(id=>id!==String(cfg.raw?.bili?.dedeUserId??''))
  if(!users.length||users.some(id=>!/^\d+$/.test(id)))throw Error('B站私信推送缺少有效的接收 UID')
  return users.map(id=>({key:`bili-private:${id}`,kind:'bili-private',id}))
}
export function hourlyDeliveryPlan(cfg) {
  const groups=ids(cfg.scroll?.groupIds?.length?cfg.scroll.groupIds:cfg.qq?.groupIds).filter(id=>/^\d+$/.test(id))
  return {mode:'group',targets:[...groups.map(id=>({kind:'group',id,key:'group:'+id})),...biliPrivateTargets(cfg)]}
}
export function deliveryPlan(cfg, sc = cfg.scroll ?? {}) {
  const mode = sc.deliveryMode ?? 'private'
  if (!['private','comment'].includes(mode)) throw new Error('刷B站分享方式无效，请选择私聊分享或评论区 @')
  const targets=[]
  if (mode === 'comment') targets.push({key:'comment',kind:'comment'})
  else {
    const users=ids(sc.privateUsers?.length ? sc.privateUsers : cfg.chat?.admins)
    if (!users.length&&!sc.biliPrivateEnabled) throw new Error('私聊分享缺少接收 QQ，请配置私聊接收 QQ 或管理员名单')
    if (users.some(v=>!/^\d{5,}$/.test(v))) throw new Error('私聊接收 QQ 格式不正确')
    targets.push(...users.map(id=>({key:`private:${id}`,kind:'private',id})))
  }
  targets.push(...biliPrivateTargets(cfg,sc))
  if (sc.syncGroups !== false) {
    const groups=ids(sc.groupIds?.length ? sc.groupIds : cfg.qq?.groupIds)
    if (!groups.length) throw new Error('同步群聊已开启，但没有配置 QQ 群号')
    if (groups.some(v=>!/^\d{5,}$/.test(v))) throw new Error('同步群号格式不正确')
    targets.push(...groups.map(id=>({key:`group:${id}`,kind:'group',id})))
  }
  return {mode,targets}
}

export function shareText(item, mentionName = '') {
  let text=String(item.comment ?? '').trim()
  if (mentionName) {
    const name=String(mentionName).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')
    text=text.replace(new RegExp(`^@${name}\\s*`),'').trim()
  }
  return `《${item.title || item.bvid}》\n${text}\nhttps://www.bilibili.com/video/${item.bvid}`
}

// 每个目的地单独记回执；某个群失败时，重试只补该群，避免重复私聊或重复评论。
export async function deliverRecommendation(cfg, item, {plan=deliveryPlan(cfg),receipts={},onReceipt=()=>{},onAttempt=()=>{},deps={},isActive=()=>true} = {}) {
  const comment=deps.addComment ?? addComment, privateSend=deps.sendPrivate ?? sendPrivate, groupSend=deps.sendGroup ?? sendGroup
  const biliSend=deps.sendBiliPrivate??sendPrivateMessage,biliList=deps.listBiliPrivate??listPrivateMessages
  const message=shareText(item,cfg.scroll?.mentionName)
  const errors=[]
  if(!isActive())return {complete:false,receipts,errors:['运行已停止，未投递推荐']}
  const confirmed=target=>Boolean(receipts[target.key])&&!['pending','rejected'].includes(receipts[target.key].status)
  const pending=plan.targets.filter(target=>!receipts[target.key]||receipts[target.key].status==='rejected'&&Number(receipts[target.key].retryAt??0)<=Date.now())
  if(pending.length)await (deps.claimShare ?? (bvid=>biliPolicy.claim('share',bvid)))(item.bvid)
  const pause=deps.sleep ?? (ms=>new Promise(r=>setTimeout(r,ms)))
  let attempted=false
  for (const target of plan.targets) {
    if(!isActive()){errors.push('运行已停止，剩余推荐未发送');break}
    if (confirmed(target)) continue
    const previous=receipts[target.key]
    if(target.kind==='bili-private'&&previous?.status==='pending') {
      try {
        const rows=await biliList(cfg,target.id,{isActive})
        const match=rows.find(m=>String(m.sender_uid)===String(cfg.raw?.bili?.dedeUserId)&&String(m.receiver_id)===target.id&&Number(m.receiver_type)===1&&Number(m.timestamp)*1000>=previous.at-5000&&hash(privateText(m))===previous.hash)
        if(match){receipts[target.key]={kind:target.kind,id:target.id,at:new Date().toISOString(),msgKey:String(match.msg_key),status:'sent'};await onReceipt(target,receipts[target.key]);continue}
      }catch(e){errors.push(`${target.key}：核对上次私信回执失败`);if(e.biliPolicy||e.commentRisk)break}
      errors.push(`${target.key}：上次私信回执未确认，暂停重复发送`);continue
    }
    if(previous?.status==='rejected'&&Number(previous.retryAt)>Date.now()){errors.push(`${target.key}：B站拒收退避中，稍后再试`);continue}
    if(attempted && !cfg.chat?.outputRateOnly)await pause(BILI_LIMITS.deliveryGapMs)
    if(!isActive()){errors.push('运行已停止，剩余推荐未发送');break}
    attempted=true
    let result
    if(target.kind==='bili-private') {
      receipts[target.key]={kind:target.kind,id:target.id,status:'pending',at:Date.now(),hash:hash(privateMessageText(message))}
      await onAttempt(target,receipts[target.key])
    }
    try {
      if (target.kind === 'comment') {
        const who=String(cfg.scroll?.mentionName ?? '').trim()
        const text=who && !item.comment.startsWith(`@${who}`) ? `@${who} ${item.comment}` : item.comment
        result=await comment(cfg,{bvid:item.bvid,aid:item.aid,text,isActive})
      }
      else if (target.kind === 'private') result=await privateSend(cfg,target.id,message)
      else if (target.kind === 'bili-private') result=await biliSend(cfg,target.id,message,{isActive})
      else result=await groupSend(cfg,target.id,message)
    } catch(e) {
      if(target.kind==='bili-private'&&(e.biliNotSent||e.biliPolicy&&!e.commentRisk)) {
        receipts[target.key]={kind:target.kind,id:target.id,status:'rejected',retryAt:Date.now()+([21046,21047,25003,25005].includes(e.biliPrivateCode)?86400000:1800000),code:e.biliPrivateCode??0}
        await onAttempt(target,receipts[target.key])
      }
      errors.push(`${target.key}：${e.message}`);if(e.biliPolicy||e.commentRisk)break;continue
    }
    receipts[target.key]={kind:target.kind,id:target.id,at:new Date().toISOString(),...(target.kind==='comment'?{rpid:String(result.rpid),aid:String(result.aid ?? item.aid)}:target.kind==='bili-private'?{msgKey:String(result.msg_key),status:'sent'}:{})}
    // 持久化失败必须停止，不能继续发送其他目的地。
    await onReceipt(target,receipts[target.key])
  }
  return {complete:plan.targets.every(confirmed),receipts,errors}
}
