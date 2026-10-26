import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-overview-'))
process.env.BILI_WHALE_DATA=dir
const {buildOverview}=await import('../src/overview.mjs')
try {
  const now=Date.now()
  const cfg={cookie:{sessdata:'do-not-return-cookie',bili_jct:'secret'},llm:{apiKey:'do-not-return-key'},scroll:{enabled:true},share:{replyPatrolMinutes:5}}
  const result=buildOverview({cfg,now,state:{commented:{BV1:{}},replied:{one:{}}},policy:{watch:[{at:now-100},{at:now-7200000}],share:[],requests:[],cooldownUntil:now+60000,nextWatchAt:now+60000},dsh:{pid:123,status:{running:true,chat:{connected:false}}},activity:['first','second']})
  assert.equal(result.usage.videos,1)
  assert.equal(result.runtime.source,'dsh')
  assert.equal(result.runtime.qqConnected,false)
  assert.equal(result.issues[0].title,'B站正在冷却')
  assert.deepEqual(result.activity,['second','first'])
  assert.doesNotMatch(JSON.stringify(result),/do-not-return|sessdata|apiKey/)
  const offline=buildOverview({cfg,heartbeat:{running:true,heartbeat:1},now})
  assert.equal(offline.runtime.running,false,'旧心跳不能被当作运行中')
  assert.equal(offline.runtime.qqConnected,null,'未连接信息不能伪装为在线')

  // 在无浏览器、无网络的 DOM 桩中运行实际页面脚本，核对交互和竞态。
  class Element {
    constructor(){this.dataset={};this.children=[];this.attributes={};this.hidden=false;this.disabled=false;this.events={};this.textContent='';this.classes=new Set();this.classList={toggle:(name,on)=>{on?this.classes.add(name):this.classes.delete(name)}}}
    append(...children){this.children.push(...children)}
    replaceChildren(...children){this.children=children}
    setAttribute(k,v){this.attributes[k]=v}
    addEventListener(k,fn){this.events[k]=fn}
    set innerHTML(_){throw Error('页面不可把动态状态写成 HTML')}
  }
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8')
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1])
  assert.equal(new Set(ids).size,ids.length,'HTML id 不重复')
  const elements=new Map(ids.map(id=>['#'+id,new Element()]))
  const events={},go=new Element();go.dataset.go='review'
  const document={hidden:false,documentElement:new Element(),querySelector:s=>{assert.ok(elements.has(s),`缺少元素 ${s}`);return elements.get(s)},querySelectorAll:()=>[go],createElement:()=>new Element(),addEventListener:(k,fn)=>{events[k]=fn},dispatchEvent:e=>events[e.type]?.(e)}
  const response=()=>({...buildOverview({cfg,now,policy:{watch:[{at:now-1}],nextWatchAt:now+60000},dsh:{pid:123,status:{running:true,chat:{connected:true}}}}),revision:'fixture-revision'})
  let data=response(),fail=false,posts=[]
  const context=vm.createContext({document,Date,Boolean,Number,String,Math,Error,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail}},localStorage:{getItem:()=>null,setItem:()=>{}},setInterval:()=>0,fetch:async(_url,options)=>{
    if(fail)throw Error('fixture offline')
    if(options?.method==='POST'){const body=JSON.parse(options.body);posts.push(body);data.automation.scrollEnabled=body.patch['scroll.enabled'];return {ok:true,json:async()=>({revision:'next',values:{'scroll.enabled':data.automation.scrollEnabled}})}}
    return {ok:true,json:async()=>structuredClone(data)}
  }})
  vm.runInContext(fs.readFileSync(new URL('../public/overview.js',import.meta.url),'utf8'),context)
  const settle=()=>new Promise(r=>setImmediate(r))
  await settle()
  assert.equal(elements.get('#overview-runtime').textContent,'跟随 DSH')
  assert.equal(elements.get('#overview-watches').textContent,1)
  assert.equal(elements.get('#overview-qq').textContent,'已连接')
  assert.match(elements.get('#watch-next').textContent,/后可继续/)
  await Promise.all([elements.get('#overview-scroll-toggle').onclick(),elements.get('#overview-scroll-toggle').onclick()])
  assert.equal(posts.length,1,'连点不能重复提交')
  assert.deepEqual(posts[0].patch,{'scroll.enabled':false})
  assert.equal(posts[0].revision,'fixture-revision')
  assert.equal(elements.get('#overview-scroll-toggle').textContent,'开启刷站')
  elements.get('#theme-toggle').onclick()
  assert.equal(document.documentElement.dataset.theme,'dark')
  fail=true
  await elements.get('#overview-refresh').onclick()
  assert.equal(elements.get('#overview-error').hidden,false)
  assert.equal(elements.get('#overview-watches').textContent,1,'断线保留原状态')
  console.log('总览验证通过：滚动额度、真实离线/断线、冷却优先级、脱敏、DOM引用、实际脚本渲染、暂停刷站的精确补丁/防连点、主题切换、断线保留状态。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
