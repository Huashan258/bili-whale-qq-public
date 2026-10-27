import fs from 'node:fs'
import path from 'node:path'
import {randomUUID,createHash} from 'node:crypto'
import {DATA} from './config.mjs'
const valid=id=>/^[a-f0-9-]{36}$/.test(String(id))
export const audioHash=bytes=>createHash('sha256').update(bytes).digest('hex')
export function wavInfo(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')return null
  let rate=0,channels=0,bits=0,data=0,offset=0
  for(let p=12;p+8<=bytes.length;){const type=bytes.toString('ascii',p,p+4),n=bytes.readUInt32LE(p+4);if(type==='fmt '&&p+24<=bytes.length){channels=bytes.readUInt16LE(p+10);rate=bytes.readUInt32LE(p+12);bits=bytes.readUInt16LE(p+22)}if(type==='data'){data=Math.min(n,bytes.length-p-8);offset=p+8;break}p+=8+n+(n%2)}
  const duration=rate&&channels&&bits?data/(rate*channels*bits/8):0
  let power=0,peak=0
  if(bits===16)for(let i=offset;i+1<offset+data;i+=2){const s=bytes.readInt16LE(i)/32768;power+=s*s;peak=Math.max(peak,Math.abs(s))}
  return {sampleRate:rate,channels,bits,durationSec:Number(duration.toFixed(3)),rms:bits===16?Math.sqrt(power/Math.max(1,data/2)):null,peak:bits===16?peak:null}
}
export function createVoiceLab({dir=path.join(DATA,'voice-lab'),keep=20,maxBytes=96*1024*1024}={}){
  const file=(id,ext)=>{if(!valid(id))throw Error('无效语音记录');return path.join(dir,id+ext)}
  function list(){try{return fs.readdirSync(dir).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).flatMap(n=>{try{return [JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'))]}catch{return []}}).sort((a,b)=>b.at-a.at)}catch{return []}}
  function write(row){fs.mkdirSync(dir,{recursive:true});const dest=file(row.id,'.json'),tmp=dest+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(row));fs.renameSync(tmp,dest);return row}
  function remove(id){for(const ext of ['.json','.wav','.raw.wav'])try{fs.unlinkSync(file(id,ext))}catch{}}
  function prune(){const rows=list();let count=0,total=0;for(const r of rows){if(['queued','synthesizing','sending'].includes(r.state)&&Date.now()-r.at<3600000)continue;count++;total+=(r.bytes??0)+(r.rawBytes??0);if(count>keep||total>maxBytes)remove(r.id)}}
  function begin(fields){const row=write({id:randomUUID(),at:Date.now(),state:'synthesizing',...fields});prune();return row.id}
  function update(id,fields){try{return write({...JSON.parse(fs.readFileSync(file(id,'.json'),'utf8')),...fields,updatedAt:Date.now()})}catch{return null}}
  function audio(id,bytes,rawBytes){fs.writeFileSync(file(id,'.wav'),bytes,{flag:'wx'});const raw=rawBytes??bytes;fs.writeFileSync(file(id,'.raw.wav'),raw,{flag:'wx'});const info=wavInfo(bytes);return update(id,{bytes:bytes.length,rawBytes:raw.length,rawCaptured:Boolean(rawBytes),audioSHA256:audioHash(bytes),rawSHA256:audioHash(raw),wave:info,warnings:[...(info?.rms!==null&&info?.rms<.0001?['近乎静音，建议人工听检']:[]),...(!info?.durationSec?['音频时长无效']:[])]})}
  return {begin,update,audio,list,prune,clear(){for(const r of list())if(!['queued','synthesizing','sending'].includes(r.state))remove(r.id)},readAudio(id,raw=false){return fs.readFileSync(file(id,raw?'.raw.wav':'.wav'))}}
}
