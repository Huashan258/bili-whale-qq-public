import { sendAIVoice,sendAudioRecord } from './qq.mjs'
import {createCosyVoice} from './cosyvoice.mjs'
import {createGptSovits} from './gpt-sovits.mjs'
import {sendWhenAvailable} from './chat-diagnostics.mjs'
import {QQ_REPLY_PART_LIMIT} from './qq-reply-parts.mjs'
import {createVoiceLab} from './voice-lab.mjs'

// Boundaries outside paired quotations only; never drop words or exceed the shared limit.
export function splitVoiceReply(text,settings={}) {
  const value=String(text??'').trim(),chars=[...value],size=s=>[...s.replace(/\s/g,'')].length
  const max=Math.max(5,Math.min(200,Number(settings.maxChars)||80))
  if(!value||!/[\p{L}\p{N}]/u.test(value)||/https?:\/\/|www\.|BV[1-9A-HJ-NP-Za-km-z]{10}|```|[|]|\[CQ:|^\s*(?:[-*#]|\d+[.、])/m.test(value))return []
  if(size(value)<=max)return [value]
  if(settings.splitLong===false||size(value)>max*QQ_REPLY_PART_LIMIT)return []
  const points=[],stack=[],pairs={'“':'”','「':'」','『':'』','（':'）','(' : ')','《':'》'}
  for(let i=0;i<chars.length;i++){
    const ch=chars[i]
    if(pairs[ch])stack.push(pairs[ch]);else if(ch===stack.at(-1))stack.pop()
    if(!stack.length&&(/[。！？!?；;，,\n]/.test(ch)||/[”」』]/.test(ch)&&/[。！？!?；;]/.test(chars[i-1]??'')))points.push(i+1)
  }
  points.push(chars.length)
  const parts=[];let start=0
  while(start<chars.length&&parts.length<QQ_REPLY_PART_LIMIT){
    const candidates=points.filter(end=>end>start&&size(chars.slice(start,end).join(''))<=max)
    if(!candidates.length)return []
    const end=candidates.at(-1);parts.push(chars.slice(start,end).join(''));start=end
  }
  return start===chars.length&&parts.join('')===value?parts:[]
}
export function voiceEligible(text,settings={},random=Math.random) {
  if(settings?.enabled!==true)return false
  if(!splitVoiceReply(text,settings).length)return false
  const chance=Math.max(0,Math.min(1,Number(settings.chance??.35)))
  return chance>0 && random()<chance
}

export function createQQVoiceSender({send=sendAIVoice,synthesize=createCosyVoice(),synthesizeLocal=createGptSovits(),sendAudio=sendAudioRecord,rateSleep,lab=createVoiceLab()}={}) {
  const audit=(method,...args)=>{try{return lab[method](...args)}catch{return null}}
  const preview=async(text,cfg,{signal,mode='preview',turnId=null,partIndex=0,partCount=1,groupId='',replyToUserId='',parameters}={})=>{
    const provider=cfg.chat?.voice?.provider
    if(!['cosyvoice','gpt-sovits'].includes(provider))throw Object.assign(Error('QQ原生音色不支持本地试听'),{voiceNotSent:true})
    const id=audit('begin',{text:String(text).slice(0,200),provider,mode,turnId,partIndex,partCount,target:groupId?`群…${String(groupId).slice(-4)} / 用户…${String(replyToUserId).slice(-4)}`:'本地试听'}),at=Date.now()
    try{const audio=await (provider==='gpt-sovits'?synthesizeLocal:synthesize)(text,cfg,{signal,parameters});audit('audio',id,audio.bytes,audio.rawBytes);audit('update',id,{state:mode==='send'?'sending':'ready',synthesisMs:Date.now()-at,loudness:audio.loudness??null,request:audio.requestInfo??null});audit('prune');return {...audio,provider,senderRevision:2,traceId:id}}
    catch(e){audit('update',id,{state:'synthesis-failed',reason:e.voiceReason||'synthesis-failed',synthesisMs:Date.now()-at});throw e}
  }
  const voice=async function(text,groupId,cfg,{signal,replyToUserId='',onSynthesis=()=>{},turnId=null,partIndex=0,partCount=1}={}) {
    signal?.throwIfAborted()
    const provider=cfg.chat?.voice?.provider
    if(['cosyvoice','gpt-sovits'].includes(provider)){
      const audio=await preview(text,cfg,{signal,mode:'send',groupId,replyToUserId,turnId,partIndex,partCount})
      const s=audio.loudness
      onSynthesis({provider,characters:audio.characters,senderRevision:2,audioBytes:audio.bytes.length,outputGainDb:s?.boostDb??0,actualGainDb:s?.rmsBefore>0?20*Math.log10(s.rmsAfter/s.rmsBefore):0,peak:s?.peakAfter})
      signal?.throwIfAborted()
      try{const receipt=await sendWhenAvailable(()=>sendAudio(cfg,groupId,audio.bytes,{signal,replyToUserId,scriptText:text}),{signal,sleep:rateSleep});audit('update',audio.traceId,{state:'sent',sentAt:Date.now(),messageId:String(receipt?.message_id??'')});audit('prune');return receipt}
      catch(e){audit('update',audio.traceId,{state:'send-unconfirmed',reason:signal?.aborted?'cancelled':'send-unconfirmed'});throw e}
    }
    const character=cfg.chat?.voice?.character||'lucy-voice-xueling'
    // 原生AI语音接口同时合成并发布；即使服务端报错，也可能已经发布。
    return await send(cfg,groupId,character,text,{signal,replyToUserId})
  }
  return Object.assign(voice,{preview,revision:2})
}
