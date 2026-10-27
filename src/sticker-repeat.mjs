import fs from 'node:fs'
import path from 'node:path'

// 群聊与私聊共享，发送前占位；未知回执保留记录，不因重启重复发同图。
export function createStickerRepeatLimit({dir,now=Date.now}) {
  const file=path.join(dir,'usage.json'),lock=file+'.lock'
  const read=()=>{try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return {ids:{},hashes:{}};throw Error('表情使用记录读取失败')}}
  const recent=(at,minutes)=>minutes>0&&Number.isFinite(at)&&now()-at<minutes*60000
  return {
    available(id,minutes){const s=read();return !recent(s.ids?.[id],minutes)},
    claim(id,hash,minutes,aliases=[]){
      fs.mkdirSync(dir,{recursive:true});let fd
      for(let attempt=0;attempt<2;attempt++){
        try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,String(process.pid));break}catch(e){
          if(e.code!=='EEXIST')throw e
          let stale=false
          try{const pid=Number(fs.readFileSync(lock,'utf8'));if(pid>0)try{process.kill(pid,0)}catch(e){stale=e.code==='ESRCH'}}catch{}
          if(stale){try{fs.unlinkSync(lock)}catch{}}else break
        }
      }
      if(fd===undefined)throw Object.assign(Error('表情使用记录正忙'),{stickerRepeatLimited:true})
      try{
        const s=read();s.ids??={};s.hashes??={}
        const hashes=[hash,...aliases].filter(Boolean)
        if(hashes.some(h=>recent(s.hashes[h],minutes)))throw Object.assign(Error('同一张表情包仍在重复使用间隔内'),{stickerRepeatLimited:true})
        s.ids[id]=now();for(const h of hashes)s.hashes[h]=now()
        for(const map of [s.ids,s.hashes])for(const key of Object.keys(map))if(now()-map[key]>7*86400000)delete map[key]
        const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(s));fs.renameSync(temp,file)
      }finally{fs.closeSync(fd);fs.unlinkSync(lock)}
    },
  }
}
