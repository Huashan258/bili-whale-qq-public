import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { DATA, loadConfig } from './config.mjs'
import { diaryDay } from './diary.mjs'

const readJSON=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return {}}}
export async function diaryRecordDays({dataDir=DATA,at=Date.now()}={}) {
  const days=new Set()
  const add=value=>{const t=typeof value==='number'?(value<1e12?value*1000:value):Date.parse(value);if(Number.isFinite(t)&&t>0&&t<=at)days.add(diaryDay(t))}
  if(!fs.existsSync(dataDir))return []
  for(const name of fs.readdirSync(dataDir)){
    if(!/^(?:chat|comment|dsh-plugin|agent-error)\.log(?:\.\d+)?$/.test(name))continue
    const reader=readline.createInterface({input:fs.createReadStream(path.join(dataDir,name)),crlfDelay:Infinity})
    try{for await(const line of reader){
      if(name.startsWith('chat.log')){try{const r=JSON.parse(line);if(r.channel==='group'&&['in','out','error','video-request'].includes(r.type))add(r.ts)}catch{}}
      else if(name.startsWith('comment.log')){try{const r=JSON.parse(line);if(r.ok)add(r.ts)}catch{}}
      else {const m=line.match(/^(\d{4}-\d\d-\d\dT\S+)\s+([\s\S]*)$/);if(m&&!/\[chat\]/.test(m[2])&&/B站|评论|巡检|刷站|BV[A-Za-z0-9]{10}/.test(m[2]))add(m[1])}
    }}finally{reader.close()}
  }
  const state=readJSON(path.join(dataDir,'state.json'))
  for(const r of [...Object.values(state.commented??{}),...Object.values(state.replied??{})])add(r.at)
  for(const threads of Object.values(state.ownCommentThreads??{}))for(const r of Object.values(threads??{}))add(r.ctime)
  for(const r of Object.values(readJSON(path.join(dataDir,'scroll-seen.json'))))add(r.ts)
  for(const r of Object.values(readJSON(path.join(dataDir,'bili-private.json')).peers??{}))add(r.lastSentAt)
  const history=path.join(dataDir,'history')
  if(fs.existsSync(history))for(const name of fs.readdirSync(history).filter(n=>/^BV[A-Za-z0-9]{10}\.json$/.test(n))){const r=readJSON(path.join(history,name));add(r.collectedAt);add(r.composedAt)}
  return [...days].sort()
}

// 应用内部定时器；不依赖浏览器页面打开，也不创建系统计划任务或额外Agent。
export function createDiaryScheduler({service,dataDir=DATA,config=loadConfig,now=Date.now,intervalMs=60000,startupDelayMs=5000,timers={setTimeout,clearTimeout,setInterval,clearInterval}}={}) {
  const file=path.join(dataDir,'diary-auto.json')
  let timer=null,first=null,checking=false,stopped=false,dates=[],scannedDay='',wasEnabled=false,nextScan=0
  const enabled=()=>config().diary?.autoEnabled!==false
  function status(){const saved=readJSON(file);let active=Boolean(saved.active);try{if(!saved.pid)active=false;else process.kill(Number(saved.pid),0)}catch(e){if(e.code==='ESRCH'||e.code==='ERR_INVALID_ARG_TYPE')active=false}const retryTimes=(saved.pending??[]).map(day=>service.retryAt(day)).filter(t=>t>now());return {...saved,active,enabled:enabled(),nextRetryAt:retryTimes.length?Math.min(...retryTimes):null,intervalSec:intervalMs/1000}}
  const save=extra=>{fs.mkdirSync(dataDir,{recursive:true});const temp=file+`.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify({...readJSON(file),...extra,pid:process.pid},null,2));fs.renameSync(temp,file)}
  async function tick(){
    if(checking||stopped)return
    checking=true
    try {
      if(!enabled()){wasEnabled=false;save({active:false,pending:[],checkedAt:now()});return}
      const today=diaryDay(now())
      if(!wasEnabled||scannedDay!==today||now()>=nextScan){dates=await diaryRecordDays({dataDir,at:now()});scannedDay=today;nextScan=now()+5*60000}
      wasEnabled=true
      const pending=dates.filter(day=>!service.saved(day,day<today))
      save({active:true,pending,checkedAt:now(),error:null,generating:service.status().status==='running'?service.status().day:null})
      if(service.status().status==='running')return
      const day=pending.find(d=>service.retryAt(d)<=now())
      if(day){
        const result=service.start({day,automatic:true,reason:day<today?'missing-closed-day':'startup-missing-today'})
        if(!result.alreadyRunning&&!result.skipped)save({active:true,pending,checkedAt:now(),generating:day})
      }
    }catch(e){try{save({error:'自动日记暂未启动：'+(e.code?.startsWith?.('MODEL_')?'模型暂不可用':e.message).slice(0,120),checkedAt:now()})}catch{}}
    finally{checking=false}
  }
  return {
    status,tick,
    start(){if(timer||stopped)return;first=timers.setTimeout(()=>{first=null;tick().catch(()=>{})},startupDelayMs);first?.unref?.();timer=timers.setInterval(()=>{tick().catch(()=>{})},intervalMs);timer?.unref?.()},
    stop(){stopped=true;if(first)timers.clearTimeout(first);if(timer)timers.clearInterval(timer);timer=first=null},
  }
}
