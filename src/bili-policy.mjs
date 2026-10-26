import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './config.mjs'

const HOUR = 3600000
export const BILI_LIMITS = Object.freeze({ videosPerHour:10, sharesPerHour:1, videoGapMs:6*60000, requestGapMs:20000, writeGapMs:120000, requestsPerHour:120, deliveryGapMs:30000 })
export function isClosedComment(data) {
  return Number(data?.code) === 12002 && /关闭|不存在|删除|closed|disabled/i.test(String(data?.message ?? ''))
}
export function isBiliRisk(data) {
  return !isClosedComment(data) && [-352,-412,-509,12002,12015].includes(Number(data?.code))
}
const denied = (message, ms) => Object.assign(new Error(message), {biliPolicy:true,retryAfterMs:Math.max(1,ms)})

// 所有入口、所有进程共用账本；预留发生在网络请求/发送之前，失败也不退回，避免重试连发。
export function createBiliPolicy({dataDir=DATA,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),fetcher=(...args)=>fetch(...args),random=Math.random}={}) {
  const file=path.join(dataDir,'bili-policy.json'), lock=file+'.lock'
  let tail=Promise.resolve()
  async function transaction(fn) {
    fs.mkdirSync(dataDir,{recursive:true})
    let handle
    for (let i=0;i<100;i++) {
      try {handle=fs.openSync(lock,'wx');fs.writeFileSync(handle,String(process.pid));break}
      catch(e) {
        if(e.code!=='EEXIST')throw e
        try {const pid=Number(fs.readFileSync(lock,'utf8'));if(pid>0){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH')fs.unlinkSync(lock)}}}catch{}
        await sleep(50)
      }
    }
    if(handle===undefined)throw denied('B站节流账本正忙，稍后再试',60000)
    try {
      let state={}
      try {state=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code!=='ENOENT')throw new Error('B站节流账本损坏，已停止访问，需检查 bili-policy.json')}
      for(const key of ['requests','watch','share'])state[key]=(state[key]??[]).filter(v=>v.at>now()-HOUR)
      const result=fn(state)
      const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,file)
      return result
    } finally {fs.closeSync(handle);fs.unlinkSync(lock)}
  }
  function check(state) {
    if(state.cooldownUntil>now())throw denied(`B站全局冷却中，至 ${new Date(state.cooldownUntil).toLocaleString('zh-CN')}`,state.cooldownUntil-now())
  }
  async function status() {return transaction(s=>({...s,limits:BILI_LIMITS,
    nextWatchAt:Math.max(s.watch.length>=10?s.watch[0].at+HOUR:0,(s.watch.at(-1)?.at??-Infinity)+6*60000),
    nextShareAt:Math.max(s.share.length>=1?s.share[0].at+HOUR:0,(s.share.at(-1)?.at??-Infinity)+HOUR),
  }))}
  async function claim(kind,bvid,{commandRead=false}={}) {
    return transaction(s=>{
      check(s)
      const entries=s[kind], cap=kind==='watch'?10:1, gap=kind==='watch'?6*60000:HOUR
      const until=Math.max(entries.length>=cap?entries[0].at+HOUR:0,(entries.at(-1)?.at??-Infinity)+gap)
      if(until>now()&&!(kind==='watch'&&commandRead))throw Object.assign(denied(kind==='watch'?'每小时最多看10个视频，且相邻视频至少间隔6分钟':'每小时最多分享1个视频，本小时已预留分享额度',until-now()),{biliWatchLimited:kind==='watch'})
      entries.push({at:now(),bvid:String(bvid)})
      return true
    })
  }
  async function block(ms=HOUR) {
    return transaction(s=>{s.strikes=Math.min(3,(s.strikes??0)+1);s.cooldownUntil=Math.max(s.cooldownUntil??0,now()+Math.max(ms,HOUR*2**(s.strikes-1)));return s.cooldownUntil})
  }
  async function request(url,options={}) {
    const execute=async()=>{
      const write=!['GET','HEAD'].includes(String(options.method??'GET').toUpperCase())
      const commandRead=options.commandRead===true&&!write
      for(;;) {
        const wait=await transaction(s=>{
          check(s)
          if(s.requests.length>=120&&!commandRead)throw denied('B站每小时请求上限120次，已停止访问',s.requests[0].at+HOUR-now())
          const wait=commandRead?0:Math.max(0,(s.nextRequestAt??0)-now(),write?(s.nextWriteAt??0)-now():0)
          if(wait)return wait
          s.requests.push({at:now()});s.nextRequestAt=now()+20000+Math.floor(random()*10000)
          if(write)s.nextWriteAt=now()+120000
          return 0
        })
        if(!wait)break
        await sleep(Math.min(wait,30000))
      }
      // 超时从真正发请求开始计算，排队时间不吃掉请求本身的超时。
      if(options.isActive&&!options.isActive())throw Object.assign(Error('B站任务已停止，未发送请求'),{biliNotSent:true})
      const {isActive,expectedHTML,commandRead:ignoredCommandRead,...requestOptions}=options
      const response=await fetcher(url,{...requestOptions,signal:options.signal?.aborted?AbortSignal.timeout(20000):options.signal})
      const raw=await response.clone().text()
      let data;try{data=JSON.parse(raw)}catch{}
      const html=/^\s*(?:<!doctype html|<html)/i.test(raw)
      const pageURL=new URL(url)
      const creatorPage=expectedHTML===true&&pageURL.origin==='https://member.bilibili.com'&&(/^\/platform\/upload\/text(?:\/|$)/.test(pageURL.pathname)||['/york/read-editor','/york/read-draft'].includes(pageURL.pathname))
      if([403,412,429].includes(response.status)||isBiliRisk(data)||html&&!creatorPage) {
        const retry=response.headers.get('retry-after')
        const retryMs=retry?(/^\d+$/.test(retry)?Number(retry)*1000:Date.parse(retry)-now()):0
        const until=await block(Math.max(HOUR,retryMs||0))
        throw Object.assign(denied(`B站 HTTP ${response.status}${data?.code?` code=${data.code}`:''}，已暂停所有B站访问`,until-now()),{commentRisk:true})
      }
      return response
    }
    const result=tail.then(execute);tail=result.catch(()=>{});return result
  }
  return {request,claim,status,block}
}
export const biliPolicy=createBiliPolicy()
export const biliFetch=(...args)=>biliPolicy.request(...args)
// Bilibili conversation integration: shared gentle policy and persistent reply tracking.
