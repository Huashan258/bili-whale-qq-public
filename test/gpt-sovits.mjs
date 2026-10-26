import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gpt-sovits-'));process.env.BILI_WHALE_DATA=dir
const {createGptSovits,localVoiceEndpoint,localVoiceReady}=await import('../src/gpt-sovits.mjs')
const {createQQVoiceSender}=await import('../src/qq-voice.mjs')
const {validatePatch}=await import('../src/settings.mjs')
const wav=Buffer.alloc(244);wav.write('RIFF');wav.writeUInt32LE(236,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(32000,24);wav.writeUInt32LE(64000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(200,40)
for(let p=44;p<wav.length;p+=2)wav.writeInt16LE(1000,p)
const cfg={chat:{voice:{provider:'gpt-sovits',localApiUrl:'http://127.0.0.1:9880',localReferenceAudio:'C:/fixture/ref.wav',localPromptText:'参考原文',localPromptLanguage:'zh',localTextLanguage:'zh',localNormalizeLoudness:false}}}
try{
  assert.equal(localVoiceReady(cfg),true);assert.equal(localVoiceReady({}),false)
  for(const address of ['https://127.0.0.1:9880','http://example.com','http://127.0.0.1:9880/tts','http://user:pass@localhost:9880','http://localhost:9880/?key=secret']){assert.throws(()=>localVoiceEndpoint(address));assert.throws(()=>validatePatch({'chat.voice.localApiUrl':address}))}
  assert.deepEqual(validatePatch({'chat.voice.provider':'gpt-sovits'}),{'chat.voice.provider':'gpt-sovits'})
  let payload,requests=0
  const synth=createGptSovits({dataDir:dir,request:async(url,o)=>{requests++;assert.equal(url,'http://127.0.0.1:9880/tts');assert.equal(o.redirect,'error');assert.equal(o.headers.authorization,undefined);payload=JSON.parse(o.body);return new Response(wav)}})
  const audio=await synth('本仙在此',cfg);assert.deepEqual(audio.bytes,wav,'原始音频不修改');assert.equal(audio.characters,0)
  cfg.chat.voice.localGainDb=5;const louder=await synth('本仙在此',cfg)
  assert.equal(louder.bytes.readInt16LE(44),Math.round(1000*10**(5/20)),'仅放大5dB，不额外归一化')
  assert.equal(louder.loudness.boostDb,5);assert.equal(louder.loudness.gainDb,0);delete cfg.chat.voice.localGainDb
  assert.equal(payload.prompt_text,'参考原文');assert.equal(payload.ref_audio_path,'C:/fixture/ref.wav');assert.equal(payload.streaming_mode,false);assert.equal(payload.batch_size,1);assert.equal(payload.parallel_infer,false);assert.equal(payload.speed_factor,1);assert.equal(payload.instruction,undefined)
  cfg.chat.voice.localNormalizeLoudness=true;assert.notDeepEqual((await synth('测试',cfg)).bytes,wav);cfg.chat.voice.localNormalizeLoudness=false
  const abort=new AbortController();abort.abort();const before=requests;await assert.rejects(synth('测试',cfg,{signal:abort.signal}));assert.equal(requests,before)
  const bad=createGptSovits({dataDir:dir,request:async()=>new Response('<!DOCTYPE html>')});await assert.rejects(bad('测试',cfg),e=>e.voiceNotSent&&/WAV/.test(e.message))
  const denied=createGptSovits({dataDir:dir,request:async()=>new Response('private path or prompt',{status:400})});await assert.rejects(denied('测试',cfg),e=>e.voiceNotSent&&!e.message.includes('private path'))
  const oversized=createGptSovits({dataDir:dir,request:async()=>new Response(wav,{headers:{'content-length':String(21*1024*1024)}})});await assert.rejects(oversized('测试',cfg),e=>e.voiceNotSent)
  let active=0,max=0
  const make=()=>createGptSovits({dataDir:dir,request:async()=>{active++;max=Math.max(max,active);await pause(120);active--;return new Response(wav)}})
  await Promise.all([make()('一',cfg),make()('二',cfg)]);assert.equal(max,1,'独立适配器共享文件锁，串行GPU推理')
  const occupied=path.join(dir,'gpt-sovits-inference.lock');fs.writeFileSync(occupied,JSON.stringify({pid:process.pid,token:'another'}))
  const cancel=new AbortController(),pending=synth('等待',cfg,{signal:cancel.signal});setTimeout(()=>cancel.abort(),25);await assert.rejects(pending,e=>e.voiceNotSent);assert.ok(fs.existsSync(occupied),'取消不能删除其他请求的锁');fs.unlinkSync(occupied)
  let synthesis=0,sends=0,diagnostic
  const sender=createQQVoiceSender({synthesizeLocal:async()=>{synthesis++;return audio},synthesize:async()=>{throw Error('不应调用百炼')},rateSleep:async()=>{},sendAudio:async(_,gid,bytes)=>{assert.equal(gid,'123456');assert.deepEqual(bytes,wav);if(++sends===1)throw Object.assign(Error('rate'),{qqRateLimited:true});return {message_id:123}}})
  await sender('你好','123456',cfg,{onSynthesis:x=>diagnostic=x});assert.equal(synthesis,1);assert.equal(sends,2);assert.equal(diagnostic.provider,'gpt-sovits');assert.equal(diagnostic.characters,0)
  cfg.chat.voice.localGainDb=5
  let actualBytes,stats
  const actual=createQQVoiceSender({synthesizeLocal:synth,sendAudio:async(_,gid,bytes)=>{actualBytes=bytes;return {message_id:1}}})
  const preview=await actual.preview('测试',cfg)
  assert.equal(actualBytes,undefined,'试听不发送QQ')
  assert.equal(preview.senderRevision,2);assert.equal(actual.revision,2)
  await actual('测试','123456',cfg,{onSynthesis:x=>stats=x})
  assert.deepEqual(actualBytes,preview.bytes,'试听与实际record发送出口使用同一处理链')
  assert.equal(actualBytes.readInt16LE(44),Math.round(1000*10**(5/20)))
  assert.equal(stats.outputGainDb,5);assert.ok(Math.abs(stats.actualGainDb-5)<.01)
  assert.ok(!fs.existsSync(path.join(dir,'gpt-sovits-inference.lock')))
  console.log('本地GPT-SoVITS通过：本机地址/设置校验、原始WAV、无情绪改速、非法音频和错误脱敏、并发串行/取消不抢锁、合成一次后等待发送、百炼不参与。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
