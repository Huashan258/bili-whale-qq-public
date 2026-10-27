import {normalizeVoiceWav} from './voice-loudness.mjs'
export const DEFAULT_VOICE_INSTRUCTION='语气温暖灵动，略带笑意和自信，像熟人聊天，重音和停顿自然，不要冷淡平读。'
const MODELS=new Set(['cosyvoice-v3.5-flash','cosyvoice-v3.5-plus','cosyvoice-v3-flash','cosyvoice-v3-plus','cosyvoice-v2'])
const fail=(message,reason='synthesis-failed')=>Object.assign(Error(message),{voiceNotSent:true,voiceReason:reason})
export function cosyEndpoint(voice,operation='SpeechSynthesizer') {
  const workspace=String(voice.workspaceId||'').trim()
  if(workspace&&!/^[a-zA-Z0-9_-]+$/.test(workspace))throw fail('CosyVoice工作空间ID格式不正确','configuration')
  const singapore=voice.region==='singapore'
  const host=workspace?`${workspace}.${singapore?'ap-southeast-1':'cn-beijing'}.maas.aliyuncs.com`:singapore?'dashscope-intl.aliyuncs.com':'dashscope.aliyuncs.com'
  return `https://${host}/api/v1/services/audio/tts/${operation}`
}
export function cosyReady(cfg) {
  const v=cfg.chat?.voice??{},key=String(v.apiKey||'')
  return Boolean((key.startsWith('env:')?process.env[key.slice(4)]:key)&&v.voiceId&&MODELS.has(v.model||'cosyvoice-v3.5-flash'))
}
export function createCosyVoice({request=fetch}={}) {
  return async function synthesize(text,cfg,{signal}={}) {
    const v=cfg.chat?.voice??{},key=String(v.apiKey||''),apiKey=key.startsWith('env:')?process.env[key.slice(4)]:key
    if(!apiKey||!v.voiceId)throw fail('请先配置CosyVoice密钥及自定义音色ID','configuration')
    const model=v.model||'cosyvoice-v3.5-flash'
    if(!MODELS.has(model))throw fail('CosyVoice模型不受支持','configuration')
    const configuredVolume=Number(v.volume??50),volume=Number.isFinite(configuredVolume)?Math.min(100,Math.max(0,Math.round(configuredVolume))):50
    const instruction=String(v.instruction??DEFAULT_VOICE_INSTRUCTION).trim()
    const instructionLength=[...instruction].reduce((n,c)=>n+(/\p{Script=Han}/u.test(c)?2:1),0)
    if(instructionLength>100)throw fail('语气指令超过100字符（汉字按2字符计算）','configuration')
    const style=instruction&&['cosyvoice-v3.5-flash','cosyvoice-v3.5-plus','cosyvoice-v3-flash'].includes(model)?{instruction}:{}
    const input=String(text).trim()
    if(!input||[...input].length>200)throw fail('语音试听或短回复须为1至200字','configuration')
    const active=signal?AbortSignal.any([signal,AbortSignal.timeout(60000)]):AbortSignal.timeout(60000)
    try {
      active.throwIfAborted()
      const response=await request(cosyEndpoint(v),{method:'POST',headers:{authorization:'Bearer '+apiKey,'content-type':'application/json'},redirect:'error',signal:active,body:JSON.stringify({model,input:{text:input,voice:v.voiceId,format:'wav',sample_rate:24000,volume,...style}})})
      let data;try{data=await response.json()}catch{throw fail('CosyVoice返回无效响应')}
      if(!response.ok||!data.output?.audio?.url){const code=/^[\w.:-]{1,80}$/.test(data.code||'')?data.code:'unknown';throw fail(`CosyVoice合成失败：HTTP ${response.status} / ${code}`)}
      const url=new URL(data.output.audio.url)
      if(!['https:','http:'].includes(url.protocol)||!url.hostname.endsWith('.aliyuncs.com')||url.username||url.password||url.port)throw fail('CosyVoice音频地址不受支持')
      url.protocol='https:'
      const audio=await request(url.href,{signal:active,redirect:'error'}) // 下载不携带API密钥。
      if(!audio.ok||Number(audio.headers.get('content-length'))>20*1024*1024)throw fail('CosyVoice音频下载失败')
      const chunks=[];let size=0
      for await(const chunk of audio.body){size+=chunk.byteLength;if(size>20*1024*1024)throw fail('CosyVoice音频超出短语音范围');chunks.push(Buffer.from(chunk))}
      const bytes=Buffer.concat(chunks)
      if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw fail('CosyVoice未返回有效WAV音频')
      active.throwIfAborted()
      const processed=v.normalizeLoudness===false?{bytes,stats:null}:normalizeVoiceWav(bytes,{volume,targetDbfs:v.loudnessTarget??-16,boostDb:v.boostDb??0})
      return {bytes:processed.bytes,loudness:processed.stats,characters:Number(data.usage?.characters)||0,mime:'audio/wav',model}
    }catch(e){if(e.voiceNotSent)throw e;throw fail(signal?.aborted?'语音任务已取消':'CosyVoice请求或音频下载未完成')}
  }
}
