import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

// 诊断只保存阶段、ID和耗时，不复制聊天正文、模型输出或错误响应。
export function readJsonlTail(file, count=80, maxBytes=256*1024) {
  let fd
  try {
    fd=fs.openSync(file,'r')
    const size=fs.fstatSync(fd).size,start=Math.max(0,size-maxBytes)
    const buf=Buffer.alloc(size-start);fs.readSync(fd,buf,0,buf.length,start)
    const lines=buf.toString('utf8').split('\n')
    if(start)lines.shift()
    return lines.filter(Boolean).slice(-count).flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}})
  } catch {return []} finally {if(fd!==undefined)fs.closeSync(fd)}
}

export function createChatDiagnostics({file=null,now=Date.now}={}) {
  const scope=new AsyncLocalStorage(),pending=new Map(),recent=[]
  let serial=0
  const counts={received:0,replied:0,skipped:0,failed:0,fallback:0}
  const phase=stage=>{const r=scope.getStore();if(r)r.stage=stage}
  return {
    begin(ev) {
      const r={traceId:`${process.pid}-${now()}-${++serial}`,channel:ev.message_type,target:String(ev.message_type==='group'?ev.group_id:ev.user_id??ev.sender?.user_id??''),messageId:ev.message_id==null?null:String(ev.message_id),receivedAt:now(),stage:'queued',delivered:0,fallback:false}
      counts.received++;pending.set(r.traceId,r);return r
    },
    run:(r,fn)=>scope.run(r,fn),phase,
    fallback(reason='empty-reply'){const r=scope.getStore();if(r){r.fallback=true;r.fallbackReason=reason}},
    searchResult(fields){const r=scope.getStore();if(r)r.search={...fields}},
    selectionResult(fields){const r=scope.getStore();if(r)r.selection={...fields}},
    forwardResult(fields){const r=scope.getStore();if(r)r.forward={...fields}},
    repeatResult(fields){const r=scope.getStore();if(r)r.repeat={...fields}},
    voiceResult(fields){const r=scope.getStore();if(r){r.voice={...r.voice,format:fields.format,reason:fields.reason,...(fields.provider?{provider:fields.provider}:{})};for(const k of ['characters','senderRevision','audioBytes','outputGainDb','actualGainDb','peak'])if(Number.isFinite(fields[k]))r.voice[k]=fields[k]}},
    partsResult({parts,planned,complete}){const r=scope.getStore();if(r)r.replyParts={sent:parts,planned,complete}},
    stickerResult(fields){const r=scope.getStore();if(r)r.sticker={...r.sticker,...fields}},
    modelResult(fields){const r=scope.getStore();if(r)r.modelResult={...fields}},
    skip(reason){const r=scope.getStore();if(r)r.skipReason=reason},
    async model(fn) {phase('model');const r=scope.getStore(),at=now();try{return await fn()}finally{if(r)r.modelMs=(r.modelMs??0)+now()-at}},
    async send(fn) {phase('sending');const r=scope.getStore();try{const value=await fn();if(r)r.delivered++;return value}catch(e){if(r)r.sendFailed=true;throw e}},
    start(r){r.startedAt=now();r.waitMs=r.startedAt-r.receivedAt;r.stage='processing'},
    finish(r,result,error) {
      r.finishedAt=now();r.totalMs=r.finishedAt-r.receivedAt
      r.stage=r.delivered||result?.spoke?'replied':error||r.sendFailed?'failed':'skipped'
      // 原始异常可能包含密钥、私聊正文或上游HTML；只保留固定原因。
        r.reason=r.stage==='replied'?(r.replyParts?.complete===false?'部分回复已发，后续停止':r.fallback?'本地回执':'发送成功'):r.sendFailed?'发送失败或未确认':error?'处理异常':r.skipReason??(result?.why==='已停止'?'已停止':result?.why==='已暂停'?'已暂停':'规则跳过或未发送')
      counts[r.stage]++;if(r.fallback&&r.stage==='replied')counts.fallback++
      pending.delete(r.traceId);recent.push({...r});if(recent.length>80)recent.shift()
      if(file)try {
        fs.mkdirSync(path.dirname(file),{recursive:true})
        if(fs.existsSync(file)&&fs.statSync(file).size>512*1024)fs.writeFileSync(file,readJsonlTail(file).map(x=>JSON.stringify(x)).join('\n')+'\n')
        fs.appendFileSync(file,JSON.stringify(r)+'\n')
      }catch{/* 诊断落盘失败不能影响回复 */}
    },
    status(){
      const list=[...pending.values()]
      const finished=recent.filter(r=>r.stage==='replied'),latencies=finished.map(r=>r.totalMs).sort((a,b)=>a-b)
      return {counts:{...counts},pending:list.length,oldestMs:list.length?Math.max(0,now()-Math.min(...list.map(r=>r.receivedAt))):0,p95Ms:latencies.length?latencies[Math.ceil(latencies.length*.95)-1]:0,recent:[...recent.slice(-40),...list.slice(-40)].map(r=>({...r}))}
    },
  }
}

// 仅在发送前因本地额度拒绝时等待；网络超时/未知回执绝不重发，避免双发。
export async function sendWhenAvailable(send,{signal,onWait=()=>{},sleep=(ms)=>new Promise((resolve,reject)=>{
  const cancel=()=>{clearTimeout(timer);reject(signal.reason??Error('已停止'))}
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve()},ms)
  signal?.addEventListener('abort',cancel,{once:true})
})}={}) {
  for(;;) {
    signal?.throwIfAborted()
    try{return await send()}catch(e) {
      if(!e.qqRateLimited)throw e
      onWait()
      await sleep(Math.min(60000,Math.max(50,Number(e.retryAfterMs)||250)))
    }
  }
}
// Trace persistence intentionally excludes message bodies and provider responses.
// Reply-format diagnostics retain lengths and fixed reason codes, never generated text.
// Fallback counts represent actual delivered receipts; format metadata stays content-free.

// Explicit QQ search supplies verified source summaries before reply generation.
