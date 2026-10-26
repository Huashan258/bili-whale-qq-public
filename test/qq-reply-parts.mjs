import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-parts-'))
process.env.BILI_WHALE_DATA=dir
const {splitQQReply,sendQQTextParts}=await import('../src/qq-reply-parts.mjs')
const {createChat}=await import('../src/chat.mjs')
const prose='本仙读书时爱看人如何相待，言辞不必处处华美，只消落在心上，便胜过许多空话。你若愿意慢慢说，本仙便听着，听见可喜之处自会与你同乐，遇见难处也不会急着搬出道理压人。至于那些一时答不上来的问题，容本仙再翻几页书，想清楚了再答，也好过随口编个漂亮结论来糊弄你。'
let bot
try{
  for(const text of [prose,prose+prose, '你好呀！','天地玄黄'.repeat(50),'```js\n'+prose+'\n```','“'+prose+'”']){
    const p=splitQQReply(text);assert.ok(p.length<=3);assert.equal(p.join(''),text);assert.ok(p.every(Boolean))
  }
  assert.ok(splitQQReply(prose).length>1)
  assert.equal(splitQQReply(prose,{enabled:false}).length,1)
  assert.equal(splitQQReply(prose,{minChars:500}).length,1)
  const order=[],delays=[]
  const result=await sendQQTextParts(prose,{send:async(s,i)=>order.push(s[0].type==='text'?'text'+i:'image'),wait:async ms=>delays.push(ms),chooseSticker:async()=>{order.push('pick');return {segment:{type:'image',data:{file:'fixture'}}}}})
  assert.equal(result.text,prose);assert.equal(result.complete,true)
  assert.equal(order.at(-2),'pick');assert.equal(order.at(-1),'image');assert.ok(delays.every(ms=>ms===800))
  let attempts=0,picks=0
  const partial=await sendQQTextParts(prose,{send:async()=>{if(++attempts===2)throw Error('unknown')},wait:async()=>{},chooseSticker:async()=>picks++})
  assert.equal(attempts,2);assert.equal(picks,0);assert.equal(partial.complete,false);assert.equal(partial.text,splitQQReply(prose)[0])
  const ctl=new AbortController();let sends=0
  await sendQQTextParts(prose,{signal:ctl.signal,wait:async()=>ctl.abort(),send:async()=>sends++});assert.equal(sends,1)
  const stickerFailure=await sendQQTextParts('短答',{send:async seg=>{if(seg[0].type==='image')throw Error('unknown')},wait:async()=>{},chooseSticker:async()=>({segment:{type:'image'}})})
  assert.equal(stickerFailure.text,'短答');assert.equal(stickerFailure.complete,true)

  const sent=[],id='11111111-1111-1111-1111-111111111111'
  const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,voice:{enabled:false},shield:{enabled:true,maxOutputTokens:20000}}}
  let failAt=0
  const transport=async(_,target,segs)=>{sent.push(segs);if(sent.length===failAt)throw Error('unknown')}
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},replySleep:async()=>{},stickerRandom:()=>0,
    stickerStore:{snapshot:()=>({enabled:true,chance:1,cooldownSec:0,items:[{id,name:'开心',description:'轻快感情'}]}),read:()=>({bytes:Buffer.from('fixture')})},
    llmChat:async(_,o)=>({content:o.system.includes('挑一张已有表情包')?JSON.stringify({id}):prose}),say:transport,sayPrivate:transport})
  const ev=(n,priv=false)=>({post_type:'message',message_type:priv?'private':'group',group_id:'123456',user_id:'111111',message_id:n,sender:{nickname:'测试'},message:[{type:'text',data:{text:'你好呀'}}]})
  const r=await bot.handleEvent(ev(1));assert.equal(r.text,prose)
  const count=splitQQReply(prose).length
  assert.equal(sent.length,count+1);assert.equal(sent.at(-1)[0].type,'image')
  assert.equal(sent[0][0].type,'reply');assert.ok(sent.slice(1).every(s=>s[0].type!=='reply'))
  await bot.handleEvent(ev(1));assert.equal(sent.length,count+1,'同一事件不能重发任何分段')
  sent.length=0;await bot.handleEvent(ev(2,true));assert.equal(sent.length,count+1);assert.equal(sent.at(-1)[0].type,'image')
  sent.length=0;failAt=2;const broken=await bot.handleEvent(ev(3));assert.equal(sent.length,2);assert.equal(broken.text,splitQQReply(prose)[0],'上下文只记已确认发送部分')
  console.log('QQ拆句通过：最多三条/无损句意/短答代码保留、顺序与间隔、文字后选图、群私聊集成、只首条引用、部分失败停止/无表情/不重发、取消、表情失败不影响正文。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
