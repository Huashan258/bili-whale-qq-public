import {spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..')
const tests=['public-release','public-boot','settings','cosyvoice','qq-voice','voice-stickers','qq-reply-parts','sticker-repeat','sticker-request','hourly-scroll','scroll-delivery','wiki-question','chat-reliability','overview','webui-host']
for(const name of tests){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-smoke-'))
  try{const r=spawnSync(process.execPath,['test/'+name+'.mjs'],{cwd:root,env:{...process.env,BILI_WHALE_DATA:dir},stdio:'inherit',windowsHide:true,timeout:60000});if(r.error||r.status!==0){console.error('FAILED: '+name);process.exitCode=1;break}}
  finally{fs.rmSync(dir,{recursive:true,force:true})}
}
