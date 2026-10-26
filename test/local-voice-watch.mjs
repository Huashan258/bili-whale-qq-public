import assert from 'node:assert/strict'
import {createLocalVoiceWatchdog} from '../src/local-voice-watch.mjs'
let clock=0,online=false,starts=0,selected=true,fail=false
const cfg=()=>({chat:{voice:{provider:selected?'gpt-sovits':'cosyvoice',localAutoStart:true}}})
const watch=createLocalVoiceWatchdog({config:cfg,now:()=>clock,check:async()=>online,ensure:async()=>{starts++;if(fail)throw Error('private path');return {state:'starting'}}})
try{
  await watch.start();assert.equal(starts,1,'不等待消息就启动模型');assert.equal(watch.status().phase,'loading')
  await watch.checkNow();assert.equal(starts,1,'加载期间不重复启动')
  online=true;await watch.checkNow();assert.equal(watch.status().phase,'ready')
  online=false;clock=61000;await watch.checkNow();assert.equal(starts,2,'离线恢复')
  clock=122000;fail=true;await watch.checkNow();assert.equal(watch.status().phase,'unavailable')
  await watch.checkNow();assert.equal(starts,3,'失败退避')
  selected=false;await watch.checkNow();assert.equal(watch.status().phase,'disabled')
  watch.stop();selected=true;clock=200000;await watch.checkNow();assert.equal(starts,3,'卸载不再拉起')
  let resolve;const pending=new Promise(r=>resolve=r);let checks=0
  const concurrent=createLocalVoiceWatchdog({config:cfg,check:()=>{checks++;return pending},ensure:async()=>{throw Error('不应启动')}})
  const a=concurrent.checkNow(),b=concurrent.checkNow();assert.equal(a,b);assert.equal(checks,1);concurrent.stop();resolve(false);await a
  console.log('本地语音随DSH启动通过：无消息预加载、加载去重、离线恢复、失败退避、提供方切换、卸载停止与并发检查合并。')
}finally{watch.stop()}
