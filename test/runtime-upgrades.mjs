import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-upgrade-'))
process.env.BILI_WHALE_DATA=dir
const {createMeter}=await import('../src/shield.mjs')
const {chat}=await import('../src/llm.mjs')
const {parseListeningPorts,createDshLink}=await import('../src/dsh-link.mjs')
const {gather,retryCandidate,runScroll,scrollDayUsage}=await import('../src/scroll-duty.mjs')
const {buildDialogue,runPatrol}=await import('../src/bili-patrol.mjs')
const {validatePatch,createSettingsStore}=await import('../src/settings.mjs')
const originalNow=Date.now, originalFetch=globalThis.fetch
try {
  let now=originalNow(); Date.now=()=>now
  const cfg={chat:{shield:{dailyTokens:0,guestHourlyTokens:400000,perCallTokens:0,userWindowTokens:0}}}
  const meter=createMeter(cfg)
  meter.note('a',{total:200000});meter.note('b',{total:200000})
  assert.equal(meter.check('c').ok,false)
  assert.equal(meter.check('admin',{isAdmin:true}).ok,true)
  assert.equal(meter.stats().guestHourlyTokens,400000)
  now+=3600001;assert.equal(meter.check('c').ok,true)
  meter.note('admin',{total:500000},{isAdmin:true});assert.equal(meter.stats().guestHourlyTokens,0)
  cfg.chat.shield.guestHourlyTokens=100;meter.note('c',{total:100});assert.equal(meter.check('d').ok,false)
  cfg.chat.shield.guestHourlyTokens=0;assert.equal(meter.check('d').ok,true)
  Date.now=originalNow
  assert.equal(validatePatch({'chat.shield.maxOutputTokens':20000})['chat.shield.maxOutputTokens'],20000)
  assert.throws(()=>validatePatch({'chat.shield.maxOutputTokens':20001}))
  let body
  globalThis.fetch=async(_url,opts)=>{body=JSON.parse(opts.body);return {ok:true,text:async()=>JSON.stringify({choices:[{message:{content:'ok'}}]})}}
  await chat({provider:'openai',apiKey:'fixture',baseUrl:'http://fixture',model:'fixture'},{user:'hi',maxTokens:20000})
  assert.equal(body.max_tokens,20000)
  globalThis.fetch=originalFetch

  assert.deepEqual(parseListeningPorts(' TCP 127.0.0.1:1685 0.0.0.0:0 LISTENING 123\n TCP 127.0.0.1:1686 0.0.0.0:0 LISTENING 456',123),[1685])
  fs.writeFileSync(path.join(dir,'dsh-plugin.json'),JSON.stringify({running:true,pid:123,host:'dsh-plugin',heartbeat:Date.now()}))
  let probed=0
  const link=createDshLink({dataDir:dir,listPorts:async()=>[999,1685],fetcher:async url=>({ok:true,json:async()=>url.includes('/status')?{ok:true,pid:url.includes(':999')?999:123,running:true}:{ok:true,config:{temperature:1.5}}})})
  const dsh=await link.read();assert.equal(dsh.port,1685)
  const configFile=path.join(dir,'config.json'),overlayFile=path.join(dir,'whale-ui.json')
  fs.writeFileSync(configFile,JSON.stringify({chat:{temperature:0.8},llm:{apiKey:'private-fixture'}}))
  const store=createSettingsStore({configFile,overlayFile,backupDir:path.join(dir,'backup')})
  assert.equal(store.snapshot(dsh).values['chat.temperature'],1.5)
  assert.equal(store.snapshot(dsh).source.kind,'dsh')
  assert.equal(JSON.stringify(store.snapshot(dsh)).includes('private-fixture'),false)
  fs.writeFileSync(path.join(dir,'dsh-plugin.json'),JSON.stringify({running:true,pid:123,host:'dsh-plugin',heartbeat:Date.now()-100000}))
  assert.equal(await link.read(),null)

  let discoverCalls=0
  const deps={sleep:async()=>{},search:async(_c,{keyword})=>[1,2].map(i=>({bvid:`${keyword}${i}`,pubdate:Date.now()/1000,duration:90})),discover:async()=>{discoverCalls++;return []},upLatest:async()=>[{bvid:'up1',created:Date.now()/1000,length:'00:10'},{bvid:'up2',created:Date.now()/1000,length:'01:00'}]}
  const candidates=await gather({masters:[{mid:'1234'}]},{tags:['a','b'],useDiscover:true,useMasters:true,minDurationSec:30,maxAgeDays:3},()=>{},deps)
  assert.ok(candidates.length>0 && candidates.length<=2)
  assert.equal(new Set(candidates.map(v=>v.source)).size,1,'一轮只读一路来源')
  assert.equal(discoverCalls,0)
  assert.equal(retryCandidate({verdict:'judge-failed',ts:Date.now()-1800001}),true)
  assert.equal(retryCandidate({verdict:'judge-failed',ts:Date.now()}),false)
  assert.equal(retryCandidate({verdict:'worth',ts:0}),false)
  assert.equal(scrollDayUsage({date:'2026-10-20',sent:3},'2026-10-20'),3)
  assert.equal(scrollDayUsage({date:'2026-10-19',sent:3},'2026-10-20'),0)
  const business={llm:{provider:'openai',apiKey:'fixture'},scroll:{deliveryMode:'comment',syncGroups:false,tags:['a'],maxCandidates:5,perDay:10,mentionPerDay:10,minDurationSec:30,useMasters:false,gapSec:0},share:{biliCommentPerDay:300},masters:[]}
  let sends=0, saves=0; const state={commented:{}}
  Object.assign(deps,{collect:async bv=>({video:{title:bv,aid:'123',ownerMid:'4444',stat:{}}}),chat:async()=>({content:JSON.stringify({worth:true,comment:'fixture comment'})}),addComment:async()=>{sends++;return {rpid:'123456',aid:'123'}},loadState:()=>state,saveState:()=>saves++})
  const dry=await runScroll(business,{dry:true,deps,sentToday:9})
  assert.equal(dry.planned.length,1);assert.equal(sends,0);assert.equal(saves,0)
  assert.equal(fs.existsSync(path.join(dir,'scroll-seen.json')),false)
  const live=await runScroll(business,{dry:false,deps,sentToday:9})
  assert.equal(live.sent.length,1);assert.equal(sends,1)
  assert.equal(state.commented.a1.rpid,'123456')
  assert.equal(state.commented.a1.text,'fixture comment')

  const target={rpid:'target',mid:'4444',uname:'主人',text:'oi',ctime:2}
  const dialogue=buildDialogue({rootComment:{rpid:'root',text:'根评论'},floors:[target,{rpid:'later',mid:'9',text:'别的话题',ctime:3}],target})
  assert.match(dialogue.text,/oi/);assert.doesNotMatch(dialogue.text,/别的话题/)
  assert.equal(dialogue.lines.at(-1).rpid,'target')
  console.log('运行升级验证通过：20K 请求、路人共享小时账本与过期/管理员例外、DSH 身份发现/回退/脱敏、题材轮询、失败重试、当日剩余量、预演不发送、评论入巡检表、回复目标准确。')
} finally {
  Date.now=originalNow;globalThis.fetch=originalFetch
  fs.rmSync(dir,{recursive:true,force:true})
}
