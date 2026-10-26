import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {setTimeout as pause} from 'node:timers/promises'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sticker-http-')),probe=net.createServer()
await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port
await new Promise(resolve=>probe.close(resolve))
const server=spawn(process.execPath,['src/server.mjs','--no-services','--port',String(port)],{cwd:new URL('..',import.meta.url),env:{...process.env,BILI_WHALE_DATA:dir},windowsHide:true,stdio:'ignore'})
try{
  const base=`http://127.0.0.1:${port}`;let state
  for(let i=0;i<100;i++){
    try{state=await(await fetch(base+'/api/stickers')).json();break}catch{await pause(100)}
  }
  assert.ok(state?.revision,'隔离WebUI应可启动')
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=','base64'),bytes=Buffer.concat([png,Buffer.alloc(3*1024*1024)])
  const response=await fetch(base+'/api/stickers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'upload',revision:state.revision,name:'大图',description:'隔离测试',base64:bytes.toString('base64')})})
  assert.equal(response.status,200)
  const result=await response.json();assert.equal(result.items.length,1);assert.equal(result.items[0].bytes,bytes.length)
  const image=await fetch(base+'/api/stickers/image?id='+result.items[0].id)
  assert.equal(image.status,200);assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes)
  const saved=await fetch(base+'/api/stickers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'settings',revision:result.revision,enabled:true,chance:.35,cooldownSec:60,repeatMinutes:2.5})})
  assert.equal(saved.status,200);assert.equal((await saved.json()).repeatMinutes,2.5)
  assert.equal((await(await fetch(base+'/api/stickers')).json()).repeatMinutes,2.5)
  const html=await(await fetch(base+'/')).text();assert.ok(html.includes('id="stickers-repeat"'))
  console.log('表情HTTP通过：隔离WebUI接收超过2MB请求体及3MB图片，预览原字节一致，无真实QQ发送。')
}finally{
  const exited=once(server,'exit');server.kill();await exited
  fs.rmSync(dir,{recursive:true,force:true})
}
