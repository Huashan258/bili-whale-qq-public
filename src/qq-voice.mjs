import { sendAIVoice,sendAudioRecord } from './qq.mjs'
import {createCosyVoice} from './cosyvoice.mjs'
import {createGptSovits} from './gpt-sovits.mjs'
import {sendWhenAvailable} from './chat-diagnostics.mjs'

export function voiceEligible(text,settings={},random=Math.random) {
  if(settings?.enabled!==true)return false
  const value=String(text??'').trim(),length=[...value.replace(/\s/g,'')].length
  const max=Math.max(5,Math.min(200,Number(settings.maxChars)||80))
  if(!length||length>max||!/[\p{L}\p{N}]/u.test(value))return false
  // 链接、代码、表格、列表和长文保留可复制的文字形式。
  if(/https?:\/\/|www\.|BV[1-9A-HJ-NP-Za-km-z]{10}|```|[|]|\[CQ:|^\s*(?:[-*#]|\d+[.、])/m.test(value))return false
  const chance=Math.max(0,Math.min(1,Number(settings.chance??.35)))
  return chance>0 && random()<chance
}

export function createQQVoiceSender({send=sendAIVoice,synthesize=createCosyVoice(),synthesizeLocal=createGptSovits(),sendAudio=sendAudioRecord,rateSleep}={}) {
  const preview=async(text,cfg,{signal}={})=>{
    const provider=cfg.chat?.voice?.provider
    if(!['cosyvoice','gpt-sovits'].includes(provider))throw Object.assign(Error('QQ原生音色不支持本地试听'),{voiceNotSent:true})
    const audio=await (provider==='gpt-sovits'?synthesizeLocal:synthesize)(text,cfg,{signal})
    return {...audio,provider,senderRevision:2}
  }
  const voice=async function(text,groupId,cfg,{signal,replyToUserId='',onSynthesis=()=>{}}={}) {
    signal?.throwIfAborted()
    const provider=cfg.chat?.voice?.provider
    if(['cosyvoice','gpt-sovits'].includes(provider)){
      const audio=await preview(text,cfg,{signal})
      const s=audio.loudness
      onSynthesis({provider,characters:audio.characters,senderRevision:2,audioBytes:audio.bytes.length,outputGainDb:s?.boostDb??0,actualGainDb:s?.rmsBefore>0?20*Math.log10(s.rmsAfter/s.rmsBefore):0,peak:s?.peakAfter})
      signal?.throwIfAborted()
      return await sendWhenAvailable(()=>sendAudio(cfg,groupId,audio.bytes,{signal,replyToUserId}),{signal,sleep:rateSleep})
    }
    const character=cfg.chat?.voice?.character||'lucy-voice-xueling'
    // 原生AI语音接口同时合成并发布；即使服务端报错，也可能已经发布。
    return await send(cfg,groupId,character,text,{signal,replyToUserId})
  }
  return Object.assign(voice,{preview,revision:2})
}
