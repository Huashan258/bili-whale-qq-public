import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import vm from 'node:vm'
import {spawn} from 'node:child_process'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'stickers-ui-'))
let worker
try {
  const seed=http.createServer();await new Promise(r=>seed.listen(0,'127.0.0.1',r));const port=seed.address().port;await new Promise(r=>seed.close(r))
  worker=spawn(process.execPath,['src/server.mjs','--no-services','--port',String(port)],{cwd:new URL('..',import.meta.url),env:{...process.env,BILI_WHALE_DATA:dir,PORT:String(port)},windowsHide:true,stdio:'ignore'})
  const base=`http://127.0.0.1:${port}`
  let response
  for(let i=0;i<60;i++){try{response=await fetch(base+'/api/stickers');if(response.ok)break}catch{}await new Promise(r=>setTimeout(r,100))}
  assert.ok(response?.ok,'隔离WebUI启动')
  let state=await response.json()
  const post=async body=>{const r=await fetch(base+'/api/stickers',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:state.revision,...body})});return {status:r.status,data:await r.json()}}
  let result=await post({action:'upload',name:'开心',description:'欢呼庆祝',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII='})
  assert.equal(result.status,200);state=result.data
  const image=await fetch(base+'/api/stickers/image?id='+state.items[0].id);assert.equal(image.headers.get('content-type'),'image/png');assert.equal((await image.arrayBuffer()).byteLength,state.items[0].bytes)
  assert.equal((await fetch(base+'/api/stickers/image?id=..%2Fconfig.json')).status,404)
  assert.equal((await post({action:'settings',revision:'stale',enabled:false,chance:0,cooldownSec:0})).status,400)
  const html=await(await fetch(base+'/')).text();assert.match(html,/id="stickers-upload"/);assert.match(html,/src="\/stickers.js"/)
  // 执行真实UI脚本，覆盖读取、设置、上传、说明编辑、移除；禁止innerHTML。
  class Element {
    constructor(tag='div'){this.tagName=tag;this.children=[];this.value='';this.checked=false;this.disabled=false;this.files=[]}
    append(...nodes){this.children.push(...nodes)}
    replaceChildren(){this.children=[]}
    setAttribute(key,value){this[key]=value}
    querySelectorAll(){return []}
    click(){this.onclick?.()}
    reset(){this.resetCalled=true}
    set innerHTML(_){throw Error('unsafe HTML')}
  }
  const ids=['.sticker-library','#stickers-status','#stickers-list','#stickers-enabled','#stickers-chance','#stickers-cooldown','#stickers-reload','#stickers-settings','#stickers-upload','#stickers-file','#stickers-name','#stickers-description']
  const elements=new Map(ids.map(id=>[id,new Element()]))
  const document={querySelector:s=>elements.get(s),createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})}
  const uploads=[],sample=structuredClone(state);sample.items[0].name='<script>alert(1)</script>'
  class FileReader {readAsDataURL(){this.result='data:image/png;base64,aGVsbG8=';this.onload()}}
  vm.runInNewContext(fs.readFileSync(new URL('../public/stickers.js',import.meta.url),'utf8'),{document,FileReader,encodeURIComponent,fetch:async(_,opts)=>{if(opts?.body)uploads.push(JSON.parse(opts.body));return {ok:true,json:async()=>structuredClone(sample)}}})
  const flush=()=>new Promise(r=>setImmediate(r));await flush()
  const $=id=>elements.get(id),event={preventDefault(){}}
  assert.equal($('#stickers-list').children[0].children[1].value,'<script>alert(1)</script>','名称只作为值渲染')
  $('#stickers-enabled').checked=false;$('#stickers-chance').value='80';$('#stickers-cooldown').value='30';$('#stickers-settings').onsubmit(event);await flush()
  assert.equal(uploads.at(-1).chance,.8);assert.equal(uploads.at(-1).enabled,false)
  $('#stickers-file').files=[{size:20}];$('#stickers-name').value='招手';$('#stickers-description').value='打招呼';$('#stickers-upload').onsubmit(event);await flush()
  assert.equal(uploads.at(-1).action,'upload');assert.equal(uploads.at(-1).base64,'aGVsbG8=');assert.equal($('#stickers-upload').resetCalled,true)
  $('#stickers-list').children[0].onsubmit(event);await flush();assert.equal(uploads.at(-1).action,'update')
  $('#stickers-list').children[0].children.at(-1).children.at(-1).click();await flush();assert.equal(uploads.at(-1).action,'remove')
  console.log('表情包WebUI通过：真实HTTP上传/预览/路径阻断/版本冲突、真实UI读取/设置/上传/编辑/移除、安全文本渲染；全程隔离数据。')
}finally{if(worker&&!worker.killed){worker.kill();await new Promise(r=>worker.once('exit',r))}fs.rmSync(dir,{recursive:true,force:true})}
