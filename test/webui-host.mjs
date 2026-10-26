import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createWebUiHost } from '../dsh-plugin/lib/webui-host.mjs'
import { probeConsole } from '../dsh-plugin/lib/webui-probe.mjs'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-webui-host-'))
const until=async fn=>{const end=Date.now()+8000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,40))}throw new Error('等待进程状态超时')}
const tempServer=async app=>{const s=http.createServer((_req,res)=>res.end(JSON.stringify({app})));await new Promise(r=>s.listen(0,'127.0.0.1',r));return s}
const seed=await tempServer('other'), port=seed.address().port
await new Promise(r=>seed.close(r))
fs.mkdirSync(path.join(dir,'src'))
fs.writeFileSync(path.join(dir,'src','server.mjs'),"import http from 'node:http';http.createServer((q,r)=>r.end(JSON.stringify({app:'bili-whale-qq'}))).listen(Number(process.env.PORT),'127.0.0.1')")
const host=createWebUiHost({root:dir,dataDir:dir,intervalMs:80})
let external
try {
  host.configure({enabled:true,port})
  await until(async()=>host.status().pid && await probeConsole(port)==='ours')
  const first=host.status().pid
  process.kill(first)
  await until(async()=>host.status().pid && host.status().pid!==first && await probeConsole(port)==='ours')
  const second=host.status().pid
  assert.notEqual(second,first)
  host.configure({enabled:false,port})
  await until(async()=>await probeConsole(port)==='free')
  external=await tempServer('bili-whale-qq')
  const externalPort=external.address().port
  host.configure({enabled:true,port:externalPort})
  await until(()=>host.status().external)
  assert.equal(host.status().pid,null)
  await new Promise(r=>external.close(r));external=null
  await until(async()=>host.status().pid && await probeConsole(externalPort)==='ours')
  host.stop()
  await until(async()=>await probeConsole(externalPort)==='free')
  console.log('WebUI 托管验证通过：自动启动真实 Node、子进程退出后重启、关闭释放端口、复用现有服务、现有服务退出后自动接管、卸载清理。')
} finally {
  host.stop();if(external)await new Promise(r=>external.close(r))
  fs.rmSync(dir,{recursive:true,force:true})
}
