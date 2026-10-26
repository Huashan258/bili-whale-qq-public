import fs from 'node:fs'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {ROOT,DATA,loadConfig} from './config.mjs'
import {diaryDay,validSavedDiary,diaryText} from './diary.mjs'
import {submitDiaryArticle} from './bili-article.mjs'
import {createDiaryCollection} from './diary-collection.mjs'

function json(file,fallback={}){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return fallback;throw Error('专栏记录读取失败，已停止发布以免重复')}}
export function diaryArticles({root=ROOT,dataDir=DATA,at=Date.now()}={}) {
  const words=path.join(root,'words'),today=diaryDay(at),manifest=json(path.join(dataDir,'diary-days.json')),days=new Map()
  if(!fs.existsSync(words))return []
  if(fs.lstatSync(words).isSymbolicLink())throw Error('日记目录不能是链接')
  for(const filename of fs.readdirSync(words).sort()) {
    const day=filename.slice(0,10)
    if(!/^\d{4}-\d\d-\d\d.+\.txt$/.test(filename)||day>=today||!fs.lstatSync(path.join(words,filename)).isFile())continue
    const text=fs.readFileSync(path.join(words,filename),'utf8'),entry=manifest[day],cutoff=text.match(/截至北京时间(\d\d:\d\d:\d\d)/)?.[1]
    if(cutoff&&cutoff!=='23:59:59'||entry?.filename===filename&&entry.complete===false)continue
    const content=text.split('——记录范围——')[0].trim(),lines=content.split('\n'),body=diaryText(lines.slice(1).join('\n').trim())
    if(!validSavedDiary(body,text))continue
    const title=(day+'｜'+filename.slice(10,-4)).slice(0,40),hash=createHash('sha256').update(body).digest('hex')
    const candidate={day,filename,title,body,hash}
    if(!days.has(day)||entry?.filename===filename)days.set(day,candidate)
  }
  return [...days.values()].sort((a,b)=>a.day.localeCompare(b.day))
}

export function createDiaryPublisher({root=ROOT,dataDir=DATA,config=loadConfig,now=Date.now,submit=submitDiaryArticle,collection=createDiaryCollection(),timers={setInterval,clearInterval,setTimeout,clearTimeout},intervalMs=60000,startupDelayMs=8000}={}) {
  const file=path.join(dataDir,'diary-publish.json'),lock=file+'.lock'
  let timer,first,busy=false,stopped=false,error=null
  const enabled=()=>config().diary?.publishEnabled===true
  const gap=()=>Math.max(120000,(Number(config().diary?.publishGapMinutes)||15)*60000)
  const account=cfg=>String(cfg.raw?.bili?.dedeUserId??'')
  const save=state=>{const temp=file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(state,null,2));fs.renameSync(temp,file)}
  function status() {
    try {
      const state=json(file),uid=account(config()),items=diaryArticles({root,dataDir,at:now()}).map(({body,...item})=>({...item,...state.entries?.[`${uid}:${item.day}`]}))
      return {enabled:enabled(),active:Boolean(timer),busy,gapMinutes:gap()/60000,nextAt:state.nextAt||null,error:error||state.collectionError,collection:state.collections?.[uid],items}
    }catch(e){return {enabled:enabled(),active:Boolean(timer),busy,error:e.message,items:[]}}
  }
  async function tick() {
    if(busy||stopped||!enabled())return
    busy=true;let owned=false
    try {
      fs.mkdirSync(dataDir,{recursive:true})
      try{fs.writeFileSync(lock,String(process.pid),{flag:'wx'});owned=true}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(fs.readFileSync(lock,'utf8'));try{process.kill(pid,0);return}catch(e){if(e.code!=='ESRCH')return}fs.unlinkSync(lock);return}
      const state=json(file);state.entries??={}
      const cfg=config(),uid=account(cfg)
      if(!/^[1-9]\d*$/.test(uid))throw Error('B站账号UID不可用，请先扫码登录')
      const isActive=()=>!stopped&&enabled()
      state.collections??={}
      if((state.collectionRetryAt||0)>now())return
      try {
        const name=String(cfg.diary?.collectionName||'青娥鱼的日记').trim().slice(0,20)
        const target=await collection.ensure(cfg,{name,known:state.collections[uid],isActive,save:value=>{state.collections[uid]=value;save(state)}})
        state.collections[uid]=target
        if((state.collectionSyncAt||0)<=now()){
          const days=await collection.sync(cfg,{collection:target,entries:Object.values(state.entries).filter(e=>e.account===uid),isActive})
          for(const day of days){state.entries[`${uid}:${day}`].collectionId=target.id}
          state.collectionSyncAt=now()+15*60000;save(state)
        }
        error=null
      }catch(e){state.collectionRetryAt=now()+Math.max(e.retryAfterMs||0,15*60000);state.collectionError=diaryText(e.message).slice(0,220);save(state);throw e}
      if(state.collectionError){delete state.collectionError;delete state.collectionRetryAt;save(state)}
      if(state.nextAt>now())return
      const items=diaryArticles({root,dataDir,at:now()})
      const item=items.find(i=>{const r=state.entries[`${uid}:${i.day}`];return !r||r.state==='preparing'||r.state==='retry'&&r.retryAt<=now()})
      if(!item)return
      const key=`${uid}:${item.day}`,previous=state.entries[key],entry={day:item.day,filename:item.filename,title:item.title,hash:item.hash,account:uid,state:'preparing',startedAt:now()}
      // preparing仅含读取校验，重启可恢复；pending表示可能已交给平台，绝不盲目重发。
      state.entries[key]=entry;save(state)
      try {
        const receipt=await submit({...item,collectionId:state.collections[uid].id},cfg,{isActive,onDispatch:()=>{entry.state='pending';state.nextAt=now()+gap();save(state)}})
        Object.assign(entry,receipt,{finishedAt:now()});state.nextAt=now()+gap();save(state);error=null
      }catch(e) {
        if(e.biliNotSent||e.articleRejected){entry.state='retry';entry.retryAt=now()+Math.max(e.retryAfterMs||0,e.biliPolicy?60000:6*3600000);entry.failures=(previous?.failures||0)+1}
        else entry.state='unknown'
        entry.error=diaryText(e.message).slice(0,220);state.nextAt=Math.max(state.nextAt||0,now()+Math.max(e.retryAfterMs||0,60000));save(state);error=entry.error
      }
    }catch(e){error=diaryText(e.message).slice(0,220)}
    finally{if(owned)try{fs.unlinkSync(lock)}catch{}busy=false}
  }
  return {status,tick,start(){if(timer||stopped)return;first=timers.setTimeout(()=>{first=null;tick()},startupDelayMs);first?.unref?.();timer=timers.setInterval(()=>tick(),intervalMs);timer?.unref?.()},stop(){stopped=true;if(first)timers.clearTimeout(first);if(timer)timers.clearInterval(timer);timer=null}}
}
