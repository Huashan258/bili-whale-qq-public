import {setTimeout as pause} from 'node:timers/promises'

// 仅在语句/分句边界分组，不删字、不替模型改写。代码和表格保留整条。
export function splitQQReply(text,{enabled=true,minChars=90}={}) {
  const value=String(text),threshold=Math.max(40,Number(minChars)||90)
  if(!enabled||Array.from(value).length<threshold||/```|`[^`\n]+`|^\s*\|/m.test(value))return [value]
  const boundaries=[],clauses=[],stack=[],pairs={'“':'”','「':'」','『':'』','（':'）','(' : ')','【':'】','[':']','《':'》'},links=[...value.matchAll(/https?:\/\/[^\s<>，。！？；]+/g)].map(m=>[m.index,m.index+m[0].length])
  for(let i=0;i<value.length;i++){
    const ch=value[i]
    if(links.some(([start,end])=>i>=start&&i<end))continue
    if(pairs[ch])stack.push(pairs[ch])
    else if(ch===stack.at(-1))stack.pop()
    if(stack.length)continue
    if(/[。！？!?；;\n]/.test(ch)){
      let end=i+1
      while(end<value.length&&/[。！？!?；;\n”」』]/.test(value[end]))end++
      boundaries.push(end);i=end-1
    }else if(/[，,]/.test(ch))clauses.push(i+1)
  }
  const usable=positions=>[...new Set(positions)].filter(i=>value.slice(0,i).trim().length>=15&&value.slice(i).trim().length>=15)
  const ends=usable(boundaries),points=ends.length?ends:usable(clauses)
  const wanted=Math.min(3,Math.max(2,Math.ceil(Array.from(value).length/120))),cuts=[]
  let last=0
  for(let part=1;part<wanted;part++){
    const available=points.filter(i=>i-last>=15&&value.length-i>=15)
    if(!available.length)break
    const target=last+(value.length-last)/(wanted-part+1)
    const cut=available.reduce((a,b)=>Math.abs(a-target)<=Math.abs(b-target)?a:b)
    cuts.push(cut);last=cut
  }
  const parts=[];last=0
  for(const end of [...cuts,value.length]){parts.push(value.slice(last,end));last=end}
  return parts
}

// Shared by confirmed text and voice replies; sticker failure never retries the reply.
export async function sendQQReplySticker({send,chooseSticker,signal,isActive=()=>true,wait=(ms)=>pause(ms,undefined,{signal}),onError=()=>{},onSticker=()=>{},index=0}={}) {
  if(!chooseSticker||signal?.aborted||!isActive())return
  try {
    const sticker=await chooseSticker()
    if(!sticker||signal?.aborted||!isActive())return
    await wait(800)
    if(signal?.aborted||!isActive())return
    await send([sticker.segment],index,{beforeDispatch:sticker.claim})
    onSticker({reason:'sent'})
  }catch(e){onSticker({reason:e.stickerRepeatLimited?'repeat-cooldown':'send-unconfirmed'});onError(e,index)}
}

// 每条都走原限频出口；只重试调用者明确确认未发出的引用拒绝，未知回执不重发。
export async function sendQQTextParts(text,{config={},send,chooseSticker,signal,isActive=()=>true,wait=(ms)=>pause(ms,undefined,{signal}),onError=()=>{},onSticker=()=>{}}={}) {
  const parts=splitQQReply(text,{enabled:config.splitReplies!==false,minChars:config.splitReplyChars??90}),sent=[]
  for(let i=0;i<parts.length;i++){
    try{
      if(signal?.aborted||!isActive())break
      if(i)await wait(800)
      if(signal?.aborted||!isActive())break
      await send([{type:'text',data:{text:parts[i]}}],i)
      sent.push(parts[i])
    }catch(e){onError(e,i);return {text:sent.join(''),complete:false,parts:sent.length,planned:parts.length}}
  }
  const complete=sent.length===parts.length
  if(complete)await sendQQReplySticker({send,chooseSticker,signal,isActive,wait,onError,onSticker,index:parts.length})
  return {text:sent.join(''),complete,parts:sent.length,planned:parts.length}
}
