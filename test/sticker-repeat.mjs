import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createHash} from 'node:crypto'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sticker-repeat-'))
process.env.BILI_WHALE_DATA=dir
const {createStickerStore,createStickerPicker}=await import('../src/qq-stickers.mjs')
const {sendQQTextParts}=await import('../src/qq-reply-parts.mjs')
const {sendGroup,sendPrivate}=await import('../src/qq.mjs')
const oldFetch=globalThis.fetch,png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=','base64')
let now=1000000
try{
  const options={dir:path.join(dir,'metadata'),sourceDir:path.join(dir,'images'),now:()=>now},store=createStickerStore(options)
  let s=store.snapshot();assert.equal(s.repeatMinutes,5)
  s=store.save({action:'upload',revision:s.revision,name:'开心',description:'开心',base64:png.toString('base64')})
  s=store.save({action:'settings',revision:s.revision,enabled:true,chance:1,cooldownSec:0,repeatMinutes:5})
  const id=s.items[0].id,cfg={llm:{},qq:{onebotHttp:'http://local.invalid'},chat:{admins:['111111']}}
  const picker=()=>createStickerPicker({store,now:()=>now,llmChat:async()=>({content:JSON.stringify({id})})})
  const request=pick=>pick({cfg,text:'发一张表情包',reply:'看看这张',key:'group',force:true})
  const first=await request(picker()),racing=await request(picker());assert.ok(first&&racing,'发送前两个会话都可能选中同图')
  const sent=[]
  globalThis.fetch=async(_,o)=>{sent.push(JSON.parse(o.body));return Response.json({status:'ok',retcode:0,data:{message_id:sent.length}})}
  const deliver=(sticker,priv=false)=>sendQQTextParts('看看这张',{wait:async()=>{},chooseSticker:async()=>sticker,
    send:(segments,index,ctx)=>priv?sendPrivate(cfg,'111111',segments,ctx):sendGroup(cfg,'123456',segments,{replyToUserId:'111111',...ctx})})
  await deliver(first);assert.equal(sent.filter(r=>r.params.message[0].type==='image').length,1)
  await deliver(racing,true);assert.equal(sent.filter(r=>r.params.message[0].type==='image').length,1,'私聊共享已用次数，真实出口阻止预选图竞态')
  assert.equal(createStickerStore(options).isAvailable(id),false,'重建store仍记住使用记录')
  let reason='';assert.equal(await picker()({cfg,text:'再发一张',reply:'好',key:'private',force:true,onDecision:d=>reason=d.reason}),null)
  assert.equal(reason,'repeat-cooldown','明确点图也不绕过同图间隔')
  const hash=createHash('sha256').update(png).digest('hex')
  assert.throws(()=>store.reserveUse('22222222-2222-2222-2222-222222222222',hash),e=>e.stickerRepeatLimited,'同内容不同文件也不可重发')
  now+=299999;assert.equal(store.isAvailable(id),false)
  now++;assert.equal(store.isAvailable(id),true)
  s=store.snapshot();s=store.save({action:'settings',revision:s.revision,enabled:true,chance:1,cooldownSec:0,repeatMinutes:10})
  assert.equal(store.isAvailable(id),false,'修改间隔立即生效')
  assert.throws(()=>store.save({action:'settings',revision:s.revision,enabled:true,chance:1,cooldownSec:0,repeatMinutes:-1}),/间隔/)
  s=store.save({action:'settings',revision:s.revision,enabled:true,chance:1,cooldownSec:0,repeatMinutes:0})
  assert.equal(store.isAvailable(id),true);store.reserveUse(id,hash);store.reserveUse(id,hash)
  console.log('同图间隔通过：默认5分钟/可设0/实时改值/持久重载/跨群私聊共享/预选竞态真实出口拦截/内容相同不同文件/明确点图不豁免/五分钟边界/非法值。')
}finally{globalThis.fetch=oldFetch;fs.rmSync(dir,{recursive:true,force:true})}
