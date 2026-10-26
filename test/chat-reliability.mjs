import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-reliability-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {chat:llm}=await import('../src/llm.mjs')
const {createChatDiagnostics,readJsonlTail,sendWhenAvailable}=await import('../src/chat-diagnostics.mjs')
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'SECRET-KEY'},chat:{replyEveryMessage:true,outputRateOnly:true,admins:['999999'],private:{enabled:true,mode:'all'},shield:{enabled:false}}}
const event=(id=1)=>({post_type:'message',message_type:'group',group_id:'123456',user_id:'111111',message_id:id,message:[{type:'text',data:{text:'PRIVATE-INPUT'}}]})
const settle=()=>new Promise(r=>setImmediate(r))
try {
  let attempts=0,delivered=0,waits=0
  const file=path.join(dir,'traces.jsonl')
  const bot=createChat(cfg,{stateFile:null,logFile:null,diagnosticsFile:file,logger:{},privateDir:dir,
    llmChat:async()=>({content:'{"speak":true,"reply":"PRIVATE-OUTPUT"}'}),
    say:async()=>{if(attempts++===0)throw Object.assign(Error('full'),{qqRateLimited:true,retryAfterMs:15});delivered++},
    rateSleep:async()=>{waits++;assert.equal(bot.status().diagnostics.recent.find(r=>r.messageId==='1').stage,'rate-wait');await settle()},
  })
  await Promise.all([bot.handleEvent(event(1)),bot.handleEvent(event(2))])
  assert.equal(delivered,2);assert.equal(waits,1);assert.equal(attempts,3)
  const stat=bot.status().diagnostics
  assert.equal(stat.counts.received,2);assert.equal(stat.counts.replied,2);assert.equal(stat.pending,0)
  const records=readJsonlTail(file)
  assert.equal(records.length,2);assert.ok(records.every(r=>r.stage==='replied'&&r.waitMs>=0&&r.modelMs>=0))
  assert.doesNotMatch(fs.readFileSync(file,'utf8'),/PRIVATE-INPUT|PRIVATE-OUTPUT|SECRET-KEY/)
  bot.stop()

  // Administrator replies must not sit behind a guest waiting for ordinary quota.
  let releaseWait,waitStarted
  const waitingStarted=new Promise(r=>waitStarted=r),gate=new Promise(r=>releaseWait=r)
  const order=[];let full=true
  const lanes=createChat(cfg,{stateFile:null,logFile:null,logger:{},llmChat:async()=>({content:'{"speak":true,"reply":"ok"}'}),
    say:async(_cfg,_gid,_msg,context)=>{if(context.replyToUserId!=='999999'&&full)throw Object.assign(Error('full'),{qqRateLimited:true});order.push(context.replyToUserId)},
    rateSleep:async()=>{waitStarted();await gate},
  })
  const guestTask=lanes.handleEvent(event(90));await waitingStarted
  await lanes.handleEvent({...event(91),user_id:'999999'})
  assert.deepEqual(order,['999999'],'管理员独立队列不被普通额度等待堵住')
  full=false;releaseWait();await guestTask
  assert.deepEqual(order,['999999','111111']);lanes.stop()

  let sends=0
  const failed=createChat(cfg,{stateFile:null,logFile:null,logger:{},llmChat:async()=>({content:'{"speak":true,"reply":"ok"}'}),say:async()=>{sends++;throw Error('unknown network timeout')}})
  await failed.handleEvent(event())
  assert.equal(sends,1,'发送回执不明不能换纯文本再发一次')
  assert.equal(failed.status().diagnostics.counts.failed,1)
  failed.stop()

  const controller=new AbortController()
  let tries=0
  const waiting=sendWhenAvailable(async()=>{tries++;throw Object.assign(Error('full'),{qqRateLimited:true,retryAfterMs:60000})},{signal:controller.signal})
  await settle();controller.abort(Error('stop'))
  await assert.rejects(waiting,/stop/);assert.equal(tries,1,'停止立即取消额度等待')
  await assert.rejects(()=>sendWhenAvailable(async()=>{throw Error('uncertain')}),/uncertain/)

  // Metadata is bounded and raw exceptions are never persisted.
  const diag=createChatDiagnostics({file:path.join(dir,'private-trace')})
  for(let i=0;i<100;i++){const r=diag.begin(event(i));diag.start(r);diag.finish(r,null,Error('SECRET-KEY PRIVATE-INPUT'))}
  assert.equal(diag.status().recent.length,40)
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'private-trace'),'utf8'),/SECRET-KEY|PRIVATE-INPUT/)
  assert.ok(readJsonlTail(path.join(dir,'private-trace'),10,1024).length<=10)

  // No external requests: injected model transport and virtual time.
  const options={system:'x',user:'x'}
  const response=(status,body,after)=>({ok:status===200,status,headers:{get:()=>after??null},text:async()=>body})
  let clock=0,calls=0,delays=[]
  const runtime={now:()=>clock,random:()=>0,sleep:async ms=>{delays.push(ms);clock+=ms},fetch:async()=>{calls++;return calls===1?response(429,'SECRET-KEY','2'):response(200,'{"choices":[{"message":{"content":"ok"}}]}')}}
  assert.equal((await llm(cfg.llm,options,runtime)).content,'ok')
  assert.equal(calls,2);assert.deepEqual(delays,[2000])
  calls=0
  await assert.rejects(()=>llm(cfg.llm,options,{fetch:async()=>{calls++;return response(401,'SECRET-KEY PRIVATE-INPUT')}}),e=>e.code==='MODEL_HTTP_401'&&!e.message.includes('SECRET'))
  assert.equal(calls,1)
  calls=0
  await assert.rejects(()=>llm(cfg.llm,options,{fetch:async()=>{calls++;return response(200,'<!DOCTYPE html>SECRET')}}),e=>e.code==='MODEL_RESPONSE')
  assert.equal(calls,1)
  calls=0;clock=0
  await assert.rejects(()=>llm({...cfg.llm,requestTimeoutSec:10},options,{...runtime,fetch:async()=>{calls++;clock+=11000;throw Object.assign(Error('timeout'),{name:'TimeoutError'})}}),e=>e.code==='MODEL_TIMEOUT')
  assert.equal(calls,1)
  calls=0;clock=0
  await assert.rejects(()=>llm({...cfg.llm,maxRetries:0},options,{...runtime,fetch:async()=>{calls++;return response(503,'secret')}}),e=>e.code==='MODEL_HTTP_503')
  assert.equal(calls,1)
  calls=0
  await assert.rejects(()=>llm(cfg.llm,{...options,signal:AbortSignal.abort(Error('cancelled'))},{fetch:async()=>{calls++}}),/cancelled/)
  assert.equal(calls,0)

  const sockets=[],timers=[]
  const reconnect=createChat({...cfg,chat:{...cfg.chat,historyRestore:0}},{stateFile:null,logFile:null,logger:{},
    webSocketFactory:()=>{const s={readyState:0,listeners:{},addEventListener(k,f){this.listeners[k]=f},close(){this.readyState=3;this.listeners.close?.()}};sockets.push(s);return s},
    reconnectTimers:{set(fn,ms){const t={fn,ms};timers.push(t);return t},clear(t){t.cancelled=true}},
  })
  reconnect.start();sockets[0].close();assert.equal(timers[0].ms,2000)
  timers[0].fn();sockets[1].close();assert.equal(timers[1].ms,4000)
  timers[1].fn();sockets[2].readyState=1;sockets[2].listeners.open()
  assert.equal(reconnect.ws,sockets[2]);assert.equal(reconnect.status().connected,true)
  sockets[0].listeners.close();assert.equal(timers.length,2,'旧连接回调不能重复安排重连')
  sockets[2].close();assert.equal(timers[2].ms,2000,'成功后重置退避')
  reconnect.stop();assert.equal(timers[2].cancelled,true);timers[2].fn();assert.equal(sockets.length,3)

  // Run the actual diagnostics UI without a browser; text-only cells prevent XSS.
  class Element{constructor(){this.children=[];this.dataset={};this.value='all'}append(x){this.children.push(x)}replaceChildren(){this.children=[]}set innerHTML(_){throw Error('unsafe HTML')}}
  const elements=new Map(['#chat-diagnostics-summary','#chat-connection-detail','#chat-trace-filter','#chat-traces'].map(k=>[k,new Element()]))
  const document={querySelector:s=>elements.get(s),createElement:()=>new Element()}
  const window={}
  vm.runInNewContext(fs.readFileSync(new URL('../public/chat-diagnostics.js',import.meta.url),'utf8'),{document,window,Date,Number,Map})
  window.renderChatDiagnostics({diagnostics:stat,traces:[{...records[0],traceId:'xss',target:'<img onerror=x>',stage:'failed'}],connected:true})
  assert.equal(elements.get('#chat-traces').children.length,3)
  elements.get('#chat-trace-filter').value='failed';elements.get('#chat-trace-filter').onchange()
  assert.equal(elements.get('#chat-traces').children.length,1)
  assert.match(elements.get('#chat-traces').children[0].children[0].textContent,/<img onerror=x>/)
  console.log('可靠性验证通过：分钟满额等待不丢消息、取消等待、发送回执不明不重发、阶段与耗时、诊断脱敏/容量、429退避/401与HTML不重试/总时限/零重试/取消、重连退避/当前连接/旧回调/卸载清理、真实诊断UI筛选与安全文本渲染。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
