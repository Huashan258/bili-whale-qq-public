import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './config.mjs'

export const QQ_OUTPUT_PER_MINUTE=60
// 普通群聊、私聊、通知与推荐共用滚动60秒账本（管理员回复在出口豁免）；占位在发送前，避免并发和重启超发。
export function createQqOutputLimit({dataDir=DATA,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const file=path.join(dataDir,'qq-output-rate.json'),lock=file+'.lock'
  function read(){try{const s=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(s.sent))throw Error('invalid ledger');return s.sent.filter(at=>Number.isFinite(at)&&at>now()-60000)}catch(e){if(e.code==='ENOENT')return [];throw e}}
  return {
    status(){const sent=read();return {used:sent.length,limit:QQ_OUTPUT_PER_MINUTE,adminExempt:true,resetAt:sent.length?sent[0]+60000:0}},
    async reserve(){
      fs.mkdirSync(dataDir,{recursive:true})
      let handle
      for(let i=0;i<100;i++){
        try{handle=fs.openSync(lock,'wx');fs.writeFileSync(handle,String(process.pid));break}catch(e){
          if(e.code!=='EEXIST')throw e
          try{const pid=Number(fs.readFileSync(lock,'utf8'));if(pid>0){try{process.kill(pid,0)}catch(err){if(err.code==='ESRCH')fs.unlinkSync(lock)}}}catch{}
          await sleep(20)
        }
      }
      if(handle===undefined)throw Object.assign(Error('QQ发送账本正忙'),{qqRateLimited:true})
      try{
        const sent=read()
        if(sent.length>=QQ_OUTPUT_PER_MINUTE)throw Object.assign(Error('QQ普通输出达到每分钟60条，稍后再说'),{qqRateLimited:true,retryAfterMs:sent[0]+60000-now()})
        sent.push(now())
        const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify({sent}));fs.renameSync(tmp,file)
      }finally{fs.closeSync(handle);fs.unlinkSync(lock)}
    },
  }
}
export const qqOutputLimit=createQqOutputLimit()

// Administrator exemption is decided from configured QQ IDs at the transport layer.
