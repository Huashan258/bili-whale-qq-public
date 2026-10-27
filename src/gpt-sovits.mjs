import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {setTimeout as pause} from 'node:timers/promises'
import {DATA} from './config.mjs'
import {normalizeVoiceWav} from './voice-loudness.mjs'
import {readStudioParameters,validateStudioParameters,trainingPaused} from './voice-studio-config.mjs'

const fail=(message,reason='local-synthesis-failed')=>Object.assign(Error(message),{voiceNotSent:true,voiceReason:reason})
export function localVoiceEndpoint(value='http://127.0.0.1:9880'){
  const u=new URL(value)
  if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))throw fail('本地语音API须为本机HTTP地址，不含路径或凭据','configuration')
  return u.origin
}
export function localVoiceReady(cfg){const v=cfg.chat?.voice??{};try{return Boolean(localVoiceEndpoint(v.localApiUrl)&&v.localReferenceAudio&&v.localPromptText?.trim())}catch{return false}}

export async function reserveLocalVoiceSlot(file,signal){
  fs.mkdirSync(path.dirname(file),{recursive:true});const token=randomUUID()
  while(true){
    signal.throwIfAborted()
    try{
      const fd=fs.openSync(file,'wx')
      try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}))}finally{fs.closeSync(fd)}
      return ()=>{try{if(JSON.parse(fs.readFileSync(file,'utf8')).token===token)fs.unlinkSync(file)}catch{}}
    }catch(e){
      if(e.code!=='EEXIST')throw e
      try{const {pid}=JSON.parse(fs.readFileSync(file,'utf8'));if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')fs.unlinkSync(file)}}}catch{}
      await pause(100,undefined,{signal})
    }
  }
}

export function createGptSovits({request=fetch,dataDir=DATA}={}){
  return async(text,cfg,{signal,parameters}={})=>{
    if(trainingPaused(dataDir))throw fail('训练模式已暂停机器人推理，请先在语音工作台恢复对话模式','training-paused')
    let inference;try{inference={...readStudioParameters(dataDir),...validateStudioParameters(parameters)}}catch{throw fail('语音工作台推理参数无效，请恢复默认值','configuration')}
    const v=cfg.chat?.voice??{},input=String(text??'').trim()
    if(!input||[...input].length>200||!localVoiceReady(cfg))throw fail('请配置本地语音API、参考音频与对应文字；文本须为1至200字','configuration')
    const timeout=Math.max(10,Math.min(600,Number(v.localTimeoutSec)||180))*1000
    const active=signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)
    const language=v.localTextLanguage||'zh',promptLanguage=v.localPromptLanguage||'zh'
    if(![language,promptLanguage].every(l=>['zh','en','ja','ko','yue','auto','all_zh','all_ja','all_ko','all_yue'].includes(l)))throw fail('本地语音语言设置不受支持','configuration')
    let release
    try{
      release=await reserveLocalVoiceSlot(path.join(dataDir,'gpt-sovits-inference.lock'),active)
      if(trainingPaused(dataDir))throw fail('训练模式已暂停机器人推理，请先在语音工作台恢复对话模式','training-paused')
      if(v.localAutoStart===true){const {ensureLocalVoice}=await import('./local-voice-host.mjs');await ensureLocalVoice(cfg,{signal:active,dataDir})}
      const r=await request(localVoiceEndpoint(v.localApiUrl)+'/tts',{method:'POST',redirect:'error',signal:active,headers:{'content-type':'application/json'},body:JSON.stringify({...inference,text:input,text_lang:language,ref_audio_path:v.localReferenceAudio,prompt_text:v.localPromptText,prompt_lang:promptLanguage,media_type:'wav',streaming_mode:false})})
      if(!r.ok)throw fail('本地语音服务合成失败：HTTP '+r.status)
      const parts=[];let length=0
      if(Number(r.headers.get('content-length'))>20*1024*1024)throw fail('本地语音超出短回复音频范围')
      for await(const part of r.body){length+=part.byteLength;if(length>20*1024*1024)throw fail('本地语音超出短回复音频范围');parts.push(Buffer.from(part))}
      const bytes=Buffer.concat(parts)
      if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw fail('本地语音服务未返回WAV音频')
      active.throwIfAborted()
      let processed=v.localNormalizeLoudness===true?normalizeVoiceWav(bytes,{volume:v.volume??100,targetDbfs:v.loudnessTarget??-16,boostDb:v.boostDb??0}):{bytes,stats:null}
      if(Number(v.localGainDb??0)>0)processed=normalizeVoiceWav(processed.bytes,{normalize:false,boostDb:Number(v.localGainDb)})
      return {bytes:processed.bytes,rawBytes:bytes,loudness:processed.stats,characters:0,mime:'audio/wav',model:'gpt-sovits',provider:'gpt-sovits',requestInfo:{endpoint:localVoiceEndpoint(v.localApiUrl)+'/tts',referenceAudio:v.localReferenceAudio,textLanguage:language,promptLanguage,streaming:false,parallel:inference.parallel_infer,speed:inference.speed_factor,parameters:inference}}
    }catch(e){if(e.voiceNotSent)throw e;throw fail(signal?.aborted?'本地语音任务已取消':'本地语音排队、合成或读取失败，请检查API运行状态')}
    finally{release?.()}
  }
}
