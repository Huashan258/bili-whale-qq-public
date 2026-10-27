import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as pause} from 'node:timers/promises'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-lab-'));process.env.BILI_WHALE_DATA=dir
const {createVoiceLab,audioHash,wavInfo}=await import('../src/voice-lab.mjs')
const {createQQVoiceSender}=await import('../src/qq-voice.mjs')
const {createChat}=await import('../src/chat.mjs')
const wav=Buffer.alloc(684);wav.write('RIFF');wav.writeUInt32LE(676,4);wav.write('WAVE',8);wav.write('fmt ',12);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(32000,24);wav.writeUInt32LE(64000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(640,40);for(let i=44;i<wav.length;i+=2)wav.writeInt16LE(1000,i)
let bot
try{
 const lab=createVoiceLab({dir:path.join(dir,'records'),keep:2}),cfg={chat:{voice:{provider:'gpt-sovits'}}}
 assert.equal(wavInfo(wav).durationSec,.01)
 const sender=createQQVoiceSender({lab,synthesizeLocal:async()=>({bytes:wav,rawBytes:wav,loudness:{boostDb:5}}),sendAudio:async(_,__,bytes)=>{assert.equal(audioHash(bytes),audioHash(wav));return {message_id:8}}})
 const a=await sender.preview('固定试听文本',cfg);let row=lab.list()[0];assert.equal(row.mode,'preview');assert.equal(row.state,'ready');assert.equal(row.audioSHA256,audioHash(wav));assert.deepEqual(lab.readAudio(a.traceId),wav)
 await sender('实际一段','123456',cfg,{turnId:'turn-a',partIndex:1,partCount:3,replyToUserId:'222222'});row=lab.list().find(r=>r.mode==='send');assert.equal(row.state,'sent');assert.equal(row.partIndex,1);assert.equal(row.partCount,3);assert.equal(row.messageId,'8')
 const failed=createQQVoiceSender({lab,synthesizeLocal:async()=>({bytes:wav}),sendAudio:async()=>{throw Error('unconfirmed')}});await assert.rejects(failed('未知回执','123456',cfg));assert.ok(lab.list().some(r=>r.state==='send-unconfirmed'))
 assert.throws(()=>lab.readAudio('../../config'));lab.clear();assert.equal(lab.list().length,0)
 const events=[],texts={111111:'甲这段是第一句话，慢慢说来。甲接着说第二句话，仍不着急。甲最后说第三句话，暂且收住。',222222:'乙这段是第一句话，慢慢说来。乙接着说第二句话，仍不着急。乙最后说第三句话，暂且收住。'}
 bot=createChat({qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,shield:{enabled:false},voice:{enabled:true,chance:1,maxChars:20}}},{stateFile:null,logFile:null,privateDir:dir,logger:{},replySleep:async()=>{},voiceRandom:()=>0,stickerStore:{snapshot:()=>({enabled:false,items:[]})},llmChat:async(_,o)=>({content:texts[o.replyActor.uid]}),sendVoice:async(_,gid,c,{replyToUserId,turnId,partIndex,partCount})=>{await pause(10);events.push({uid:replyToUserId,turnId,partIndex,partCount});return {message_id:events.length}},say:async()=>{throw Error('不应回退文字')}})
 const ev=(id,uid)=>({post_type:'message',message_type:'group',group_id:'123456',user_id:uid,message_id:id,message:[{type:'text',data:{text:'正常聊两句'}}]})
 await Promise.all([bot.handleEvent(ev(1,'111111')),bot.handleEvent(ev(2,'222222'))])
 assert.equal(events.length,6);assert.deepEqual(events.map(r=>r.uid),['111111','111111','111111','222222','222222','222222']);assert.deepEqual(events.map(r=>r.partIndex),[0,1,2,0,1,2]);assert.notEqual(events[0].turnId,events[3].turnId)
 console.log('语音检测通过：试听零发送/逐段文本与原始和发送音频哈希对齐/真实回执/未知状态保留/安全文件ID/清除记录；同群管理员与群友并发六段不交错。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
