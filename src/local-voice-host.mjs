import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import {spawn} from 'node:child_process'
import {setTimeout as pause} from 'node:timers/promises'
import {DATA} from './config.mjs'
import {localVoiceEndpoint,reserveLocalVoiceSlot} from './gpt-sovits.mjs'
import {trainingPaused} from './voice-studio-config.mjs'

export async function localVoiceOnline(cfg){
  try{const r=await fetch(localVoiceEndpoint(cfg.chat?.voice?.localApiUrl)+'/openapi.json',{signal:AbortSignal.timeout(2000),redirect:'error'});const api=await r.json();return Boolean(r.ok&&api.paths?.['/tts'])}catch{return false}
}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
const listening=(port,host)=>new Promise(resolve=>{const s=net.connect({port,host});let done=false;const finish=v=>{if(done)return;done=true;s.destroy();resolve(v)};s.setTimeout(500);s.once('connect',()=>finish(true));s.once('error',()=>finish(false));s.once('timeout',()=>finish(false))})

async function startOnce(cfg,{dataDir=DATA}={}){
  if(await localVoiceOnline(cfg))return {ok:true,state:'online'}
  const v=cfg.chat?.voice??{},url=new URL(localVoiceEndpoint(v.localApiUrl)),dir=path.resolve(v.localInstallDir||'')
  if(!v.localInstallDir)throw Error('请先填写GPT-SoVITS安装目录')
  const python=path.join(dir,'runtime','python.exe'),entry=path.join(dir,'api_v2.py'),config=fs.existsSync(path.join(dataDir,'gpt-sovits-studio.yaml'))?path.join(dataDir,'gpt-sovits-studio.yaml'):path.join(dir,'GPT_SoVITS','configs','tts_infer.yaml')
  if(![python,entry,config].every(f=>fs.existsSync(f)))throw Error('本地语音目录缺少整合包运行时、api_v2.py或推理配置')
  fs.mkdirSync(dataDir,{recursive:true});const receipt=path.join(dataDir,'gpt-sovits-api.json')
  try{const s=JSON.parse(fs.readFileSync(receipt,'utf8'));if(s.dir===dir&&s.endpoint===url.origin&&Number.isInteger(s.pid)&&alive(s.pid))return {ok:true,state:'starting',pid:s.pid}}catch{}
  const host=url.hostname==='[::1]'?'::1':url.hostname,port=Number(url.port)||80
  if(await listening(port,host))throw Error('本地语音端口被其他服务占用，请检查API地址')
  const out=fs.openSync(path.join(dataDir,'gpt-sovits-api.out.log'),'a'),err=fs.openSync(path.join(dataDir,'gpt-sovits-api.err.log'),'a')
  try{
    const child=spawn(python,['-I',entry,'-a',host,'-p',String(port),'-c',config],{cwd:dir,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1'}})
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
    child.unref();fs.writeFileSync(receipt,JSON.stringify({pid:child.pid,dir,endpoint:url.origin,startedAt:new Date().toISOString()}))
    return {ok:true,state:'starting',pid:child.pid}
  }finally{fs.closeSync(out);fs.closeSync(err)}
}

export async function startLocalVoice(cfg,{dataDir=DATA}={}){
  if(trainingPaused(dataDir))throw Error('训练模式下暂停自动启动API，请先恢复对话模式')
  if(await localVoiceOnline(cfg))return {ok:true,state:'online'}
  const release=await reserveLocalVoiceSlot(path.join(dataDir,'gpt-sovits-start.lock'),AbortSignal.timeout(10000))
  try{return await startOnce(cfg,{dataDir})}finally{release()}
}

export async function ensureLocalVoice(cfg,{signal,dataDir=DATA}={}){
  signal?.throwIfAborted()
  await startLocalVoice(cfg,{dataDir})
  while(!await localVoiceOnline(cfg)){signal?.throwIfAborted();await pause(500,undefined,{signal})}
}
