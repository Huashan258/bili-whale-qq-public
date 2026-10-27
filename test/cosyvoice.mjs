import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cosyvoice-'));process.env.BILI_WHALE_DATA=dir
const {createCosyVoice,cosyEndpoint}=await import('../src/cosyvoice.mjs')
const {createQQVoiceSender}=await import('../src/qq-voice.mjs')
const {createChat}=await import('../src/chat.mjs')
const wav=Buffer.alloc(4044);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(24000,24);wav.writeUInt32LE(48000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(4000,40)
for(let i=44;i<wav.length;i+=2)wav.writeInt16LE(Math.round(2000*Math.sin(i/13)),i)
const {normalizeVoiceWav}=await import('../src/voice-loudness.mjs')
const boosted=normalizeVoiceWav(wav)
assert.ok(boosted.stats.rmsAfter>boosted.stats.rmsBefore*3)
assert.ok(Math.abs(boosted.stats.rmsAfter-10**(-16/20))<.0001)
assert.ok(boosted.stats.peakAfter<.892)
const extra=normalizeVoiceWav(wav,{boostDb:10})
assert.ok(20*Math.log10(extra.stats.rmsAfter/boosted.stats.rmsAfter)>9,'额外10dB明显提高响度')
assert.ok(extra.stats.peakAfter<.892)
assert.equal(normalizeVoiceWav(wav,{volume:0,boostDb:10}).stats.rmsAfter,0)
assert.throws(()=>normalizeVoiceWav(wav,{boostDb:Infinity}))
assert.deepEqual(boosted.bytes.subarray(0,44),wav.subarray(0,44))
assert.equal(normalizeVoiceWav(wav,{volume:0}).stats.rmsAfter,0)
const silent=Buffer.from(wav);silent.fill(0,44);assert.equal(normalizeVoiceWav(silent).stats.rmsAfter,0)
const loud=Buffer.from(wav);loud.writeInt16LE(32767,44);assert.ok(normalizeVoiceWav(loud).stats.peakAfter<.892)
assert.throws(()=>normalizeVoiceWav(Buffer.alloc(44)))
const streaming=Buffer.from(wav);streaming.writeUInt32LE(0x7fffffbf,4);streaming.writeUInt32LE(0x7fffff9b,40)
assert.deepEqual(normalizeVoiceWav(streaming).bytes,boosted.bytes,'云端流式长度占位修复为真实长度')
const truncated=Buffer.from(wav);truncated.writeUInt32LE(9000,40);assert.throws(()=>normalizeVoiceWav(truncated),/不完整/)
const cfg={llm:{provider:'fixture',apiKey:'fixture'},qq:{groupIds:['123456'],onebotHttp:'http://fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,voice:{provider:'cosyvoice',volume:85,apiKey:'secret-fixture',model:'cosyvoice-v3.5-flash',voiceId:'cosyvoice-v3.5-flash-test',enabled:true,chance:1,maxChars:80},shield:{enabled:false}}}
const oldFetch=globalThis.fetch;let bot
try{
  const calls=[]
  const synth=createCosyVoice({request:async(url,o)=>{calls.push({url,o});return calls.length%2?Response.json({output:{audio:{url:'https://result.oss-cn-beijing.aliyuncs.com/sample.wav'}},usage:{characters:6}}):new Response(wav)}})
  const audio=await synth('你好呀',cfg);assert.ok(audio.loudness.rmsAfter>audio.loudness.rmsBefore);assert.equal(audio.characters,6)
  assert.match(JSON.parse(calls[0].o.body).input.instruction,/温暖/)
  assert.equal(JSON.parse(calls[0].o.body).input.volume,85)
  assert.ok(calls[0].o.headers.authorization);assert.equal(calls[1].o.headers,undefined,'音频下载不传密钥')
  assert.equal(JSON.parse(calls[0].o.body).input.voice,cfg.chat.voice.voiceId)
  assert.match(cosyEndpoint({workspaceId:'workspace',region:'beijing'}),/^https:\/\/workspace\.cn-beijing/)
  assert.throws(()=>cosyEndpoint({workspaceId:'bad/host'}),/格式/)
  cfg.chat.voice.volume=0;assert.equal((await synth('你好',cfg)).loudness.rmsAfter,0);assert.equal(JSON.parse(calls.at(-2).o.body).input.volume,0);cfg.chat.voice.volume=85
  cfg.chat.voice.normalizeLoudness=false;assert.deepEqual((await synth('你好',cfg)).bytes,wav);delete cfg.chat.voice.normalizeLoudness
  cfg.chat.voice.instruction='汉'.repeat(51);await assert.rejects(synth('你好',cfg),/100字符/);delete cfg.chat.voice.instruction
  assert.match(fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),/id="bailian-console-link" href="https:\/\/bailian.console.aliyun.com\/" target="_blank" rel="noopener noreferrer"/)
  const rejected=createCosyVoice({request:async()=>Response.json({code:'InvalidApiKey',message:'secret-fixture'},{status:401})})
  await assert.rejects(rejected('你好',cfg),e=>e.voiceNotSent&&!e.message.includes('secret-fixture'))
  const ssrf=createCosyVoice({request:async()=>Response.json({output:{audio:{url:'http://127.0.0.1/secret'}}})})
  await assert.rejects(ssrf('你好',cfg),e=>e.voiceNotSent)
  let synthCalls=0,sends=0,waits=0
  const sender=createQQVoiceSender({synthesize:async()=>{synthCalls++;return audio},rateSleep:async()=>waits++,sendAudio:async()=>{if(++sends===1)throw Object.assign(Error('limit'),{qqRateLimited:true});return {message_id:42}}})
  assert.equal((await sender('你好','123456',cfg)).message_id,42);assert.equal(synthCalls,1);assert.equal(waits,1,'分钟额度等待不重复计费合成')
  const requests=[]
  globalThis.fetch=async(_,o)=>{requests.push(JSON.parse(o.body));return Response.json({status:'ok',retcode:0,data:{message_id:9}})}
  const actual=createQQVoiceSender({synthesize:async()=>audio})
  await actual('你好','123456',cfg,{replyToUserId:'111111'})
  assert.equal(requests.length,1);assert.equal(requests[0].action,'send_group_msg');assert.equal(requests[0].params.message[0].type,'record')
  assert.ok(requests[0].params.message[0].data.file.startsWith('base64://'))
  let textSends=0
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async()=>({content:'你好呀'}),sendVoice:async()=>{throw Object.assign(Error('synthesis'),{voiceNotSent:true})},say:async()=>textSends++})
  await bot.handleEvent({post_type:'message',message_type:'group',group_id:'123456',user_id:'111111',message_id:1,message:[{type:'text',data:{text:'你好'}}]})
  assert.equal(textSends,1,'仅尚未QQ发送的合成错误可回文字')
  console.log('CosyVoice通过：接口/模型音色参数/下载不携密钥/配置与错误脱敏/地址限制/WAV校验、合成一次后限频等待、单条record而非原生AI接口、未发送合成失败回文字。')
}finally{bot?.stop();globalThis.fetch=oldFetch;fs.rmSync(dir,{recursive:true,force:true})}
