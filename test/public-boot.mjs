import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {setTimeout as pause} from 'node:timers/promises'
const root=path.resolve(import.meta.dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'public-webui-'))
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r))
const child=spawn(process.execPath,['src/server.mjs','--port',String(port),'--no-services'],{cwd:root,env:{...process.env,BILI_WHALE_DATA:dir},stdio:['ignore','pipe','pipe'],windowsHide:true})
let exit;const exited=new Promise(r=>child.once('exit',r));child.once('exit',c=>exit=c)
try{
  const base='http://127.0.0.1:'+port;let ready=false
  for(let i=0;i<50;i++){if(exit!==undefined)throw Error('WebUI exited');try{const r=await fetch(base+'/');if(r.ok){ready=true;const html=await r.text();assert.match(html,/portrait\.svg/);assert.doesNotMatch(html,/portrait\.png/);break}}catch{}await pause(100)}
  assert.ok(ready,'Clean checkout WebUI starts with example fallback')
  const icon=await fetch(base+'/assets/whale/portrait.svg');assert.equal(icon.status,200);assert.match(icon.headers.get('content-type'),/svg/)
  const response=await fetch(base+'/api/settings');assert.equal(response.status,200);const settings=await response.json();assert.deepEqual(settings.values['chat.admins'],[]);assert.equal(settings.values['chat.voice.instruction'],'')
  assert.equal(settings.values['computer.enabled'],false);assert.equal(settings.values['computer.groupResults'],false);assert.equal(settings.values['computer.allowActions'],false);assert.deepEqual(settings.values['computer.fileRoots'],[]);assert.equal(settings.values['scroll.tagCommentEnabled'],false)
  for(const route of ['/computer-lab.html','/bili-lab.html','/chat-lab.html','/memory-lab.html','/diary-lab.html','/system-lab.html','/script-reader.html','/script-reader.js','/script-reader.css']){const r=await fetch(base+route);assert.equal(r.status,200,route);await r.body.cancel()}
  const library=await(await fetch(base+'/api/dice/script-library')).json();assert.deepEqual(library.groups,[]);assert.deepEqual(library.sessions,[])
  assert.equal(fs.existsSync(path.join(root,'config.json')),false)
  console.log('公开版启动通过：无真实配置、仅界面模式、首页/SVG/设置API、空管理员及语气、隔离数据目录。')
}finally{child.kill();await Promise.race([exited,pause(3000)]);fs.rmSync(dir,{recursive:true,force:true})}
