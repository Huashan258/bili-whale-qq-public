import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import {createSnowLumaWatchdog} from '../src/snowluma-watch.mjs'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-sl-watch-'))
process.env.BILI_WHALE_DATA=dir
const {oneBotReady}=await import('../src/snowluma.mjs')
let clock=0,healthy=false,starts=0,fail=false
const watch=createSnowLumaWatchdog({now:()=>clock,check:async()=>healthy,ensure:async()=>{starts++;if(fail)return {ok:false,reason:'等待 QQ 登录'};healthy=true;return {ok:true,reason:'started'}}})
const servers=[]
try {
  await watch.checkNow()
  assert.equal(starts,1);assert.equal(watch.status().phase,'ready')
  await watch.checkNow();assert.equal(starts,1)
  clock=61000;healthy=false
  await watch.checkNow();assert.equal(starts,1)
  await watch.checkNow();assert.equal(starts,2)
  clock=122000;healthy=false;fail=true
  await watch.checkNow();await watch.checkNow()
  assert.equal(starts,3);assert.equal(watch.status().phase,'unavailable')
  await watch.checkNow();assert.equal(starts,3)
  clock=183000;fail=false;await watch.checkNow();assert.equal(starts,4)
  watch.stop();healthy=false;clock=300000;await watch.checkNow();assert.equal(starts,4)
  let release,checks=0
  const blocked=new Promise(r=>{release=r})
  const concurrent=createSnowLumaWatchdog({check:async()=>false,ensure:()=>{checks++;return blocked}})
  const a=concurrent.checkNow(),b=concurrent.checkNow()
  assert.equal(a,b)
  await Promise.resolve();concurrent.stop();release({ok:true});await a
  assert.equal(checks,1)
  for(let i=0;i<3;i++){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));servers.push(s)}
  const ports={port:servers[0].address().port,httpPort:servers[1].address().port,wsPort:servers[2].address().port}
  assert.equal(await oneBotReady(ports),true)
  await new Promise(r=>servers.pop().close(r))
  assert.equal(await oneBotReady(ports),false)
  console.log('SnowLuma 监督验证通过：启动自举、运行中断线恢复、瞬断容忍、失败冷却重试、并发去重、卸载停止、HTTP 与 WS 必须同时就绪。')
} finally {
  watch.stop();for(const s of servers)await new Promise(r=>s.close(r))
  fs.rmSync(dir,{recursive:true,force:true})
}
