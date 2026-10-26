import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-gentle-'))
process.env.BILI_WHALE_DATA=dir
const {createBiliPolicy,BILI_LIMITS}=await import('../src/bili-policy.mjs')
const {runScroll}=await import('../src/scroll-duty.mjs')
const hour=3600000
try {
  let time=10*hour
  const options={dataDir:path.join(dir,'watch'),now:()=>time,sleep:async ms=>{time+=ms},random:()=>0}
  const p=createBiliPolicy(options)
  for(let i=0;i<10;i++) {
    await p.claim('watch',`v${i}`)
    if(i<9)time+=6*60000
  }
  await assert.rejects(()=>p.claim('watch','eleventh'),/每小时最多看10/)
  await assert.rejects(()=>createBiliPolicy(options).claim('watch','restart'),/每小时最多看10/)
  time+=6*60000
  await p.claim('watch','new-hour')
  await p.claim('share','one')
  await assert.rejects(()=>createBiliPolicy(options).claim('share','two'),/最多分享1/)
  time+=hour;await p.claim('share','after-hour')

  const starts=[]
  const requests=createBiliPolicy({...options,dataDir:path.join(dir,'requests'),fetcher:async()=>{starts.push(time);return Response.json({code:0})}})
  await Promise.all([requests.request('https://api.bilibili.com/read'),requests.request('https://api.bilibili.com/read2'),requests.request('https://api.bilibili.com/write',{method:'POST'}),requests.request('https://api.bilibili.com/write2',{method:'POST'})])
  assert.ok(starts[1]-starts[0]>=BILI_LIMITS.requestGapMs)
  assert.ok(starts[3]-starts[2]>=BILI_LIMITS.writeGapMs)
  let attempted=0
  const blocked=createBiliPolicy({...options,dataDir:path.join(dir,'blocked'),fetcher:async()=>{attempted++;return new Response('<!DOCTYPE html>',{status:412,headers:{'retry-after':'7200'}})}})
  await assert.rejects(()=>blocked.request('https://api.bilibili.com/'),e=>e.commentRisk&&e.retryAfterMs>=2*hour)
  await assert.rejects(()=>blocked.request('https://api.bilibili.com/'),/全局冷却/)
  assert.equal(attempted,1)
  const closed=createBiliPolicy({...options,dataDir:path.join(dir,'closed'),fetcher:async()=>Response.json({code:12002,message:'当前页面评论功能已关闭'})})
  await closed.request('https://api.bilibili.com/')
  assert.equal((await closed.status()).cooldownUntil,undefined,'单视频关闭不得封锁其他视频')

  // 两个真实 Node 进程争同一小时分享额度，只能一个成功。
  const moduleUrl=new URL('../src/bili-policy.mjs',import.meta.url).href
  const script=`import {createBiliPolicy} from ${JSON.stringify(moduleUrl)};try{await createBiliPolicy({dataDir:process.argv[1]}).claim('share','race');console.log('reserved')}catch{console.log('denied')}`
  const results=await Promise.all([1,2].map(()=>promisify(execFile)(process.execPath,['--input-type=module','-e',script,path.join(dir,'race')],{windowsHide:true})))
  assert.deepEqual(results.map(r=>r.stdout.trim()).sort(),['denied','reserved'])

  let collections=0,sends=0,searches=0
  const cfg={llm:{provider:'openai',apiKey:'fixture'},chat:{admins:['123456']},scroll:{tags:['fixture'],useMasters:false,syncGroups:false,perDay:24,maxCandidates:100,gapSec:0}}
  const deps={sleep:async()=>{},search:async()=>{searches++;return Array.from({length:10},(_,i)=>({bvid:`BVfixture${i}`,duration:60}))},collect:async bvid=>{collections++;return {video:{title:bvid,aid:'123',stat:{}}}},chat:async()=>({content:JSON.stringify({worth:true,comment:'fixture'})}),sendPrivate:async()=>{sends++}}
  const first=await runScroll(cfg,{deps})
  assert.equal(first.sent.length,1);assert.equal(collections,1);assert.equal(sends,1)
  const second=await runScroll(cfg,{deps})
  assert.match(second.why,/每小时/);assert.equal(searches,1);assert.equal(sends,1)
  console.log('温和策略通过：10视频/小时及6分钟间隔、1分享/小时、重启与跨进程共享额度、串行请求/写入间隔、风控全局停手、关闭评论例外、10候选只读1条且小时内不再搜索或发送。')
} finally {fs.rmSync(dir,{recursive:true,force:true})}
