import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-mention-queue-'));process.env.BILI_WHALE_DATA=dir
const {runBiliMentions,verifyMentionTarget,listBiliMentionPage,mentionInitialDelay}=await import('../src/bili-mentions.mjs')
const cfg={raw:{bili:{dedeUserId:'999'}},masters:[{mid:'123'}],llm:{provider:'fixture',apiKey:'fixture'},share:{biliCommentPerDay:60,masterReplyPerDay:20}}
let time=Date.now(),state={},lists=0,failed=false
const rows=['700','701'].map(id=>({user:{mid:'123'},at_time:time/1000,item:{business_id:1,type:'reply',uri:'https://www.bilibili.com/video/BV1b7nk6WExb',subject_id:'456',source_id:id,root_id:0,source_content:'@鱼 在吗',at_details:[{mid:'999',nickname:'鱼'}]}}))
const sent=[]
const deps={dataDir:dir,now:()=>time,load:()=>structuredClone(state),save:s=>state=s,
 list:async()=>++lists===1?rows:[],verify:async target=>{if(target.rpid==='700'&&!failed){failed=true;throw Object.assign(Error('下一页'),{mentionNextPage:2})}if(target.rpid==='700')assert.equal(target.verifyPage,2);return target},
 info:async()=>({aid:'456'}),readVideo:async()=>('已取得的标题简介'),compose:async()=>('本仙在。'),send:async(_,target)=>{sent.push(target.parent);return {rpid:String(900+sent.length)}}}
try{
 const first=await runBiliMentions(cfg,deps);assert.equal(first.sent,0);assert.equal(first.queued,2)
 assert.match(first.why,/下一页/)
 time+=301000;assert.equal((await runBiliMentions(cfg,deps)).sent,1);assert.deepEqual(sent,['701'],'一个核对失败不能饿死其他同级待办')
 time+=301000;assert.equal((await runBiliMentions(cfg,deps)).sent,1);assert.deepEqual(sent,['701','700'],'离开提醒第一页后仍从持久队列处理')
 const snapshot=JSON.parse(fs.readFileSync(path.join(dir,'bili-mentions.json')));assert.equal(Object.keys(snapshot['999'].queue).length,0)
 time+=301000;await runBiliMentions(cfg,deps);assert.equal(sent.length,2)
 const target={aid:'456',root:'100',rpid:'200',mid:'123',verifyPage:1}
 await assert.rejects(verifyMentionTarget(target,cfg,{request:async url=>{assert.match(url,/pn=1/);return {page:{count:41},replies:[]}}}),e=>e.mentionNextPage===2)
 const verified=await verifyMentionTarget({...target,verifyPage:2},cfg,{request:async url=>{assert.match(url,/pn=2/);return {replies:[{rpid:'200',root:'100',mid:'123',oid:'456',content:{message:'真实内容'}}]}}})
 assert.equal(verified.text,'真实内容')
 await assert.rejects(verifyMentionTarget(target,cfg,{request:async()=>({root:{rpid:'200',mid:'666',oid:'456'}})}),/不匹配/)
 const page=await listBiliMentionPage(cfg,{cursor:{id:'12345',time:'12345678'},request:async url=>{assert.match(url,/id=12345/);assert.match(url,/time=12345678/);return {items:[],cursor:{id:23456,time:23456789,is_end:false}}}})
 assert.deepEqual(page.cursor,{id:'23456',time:'23456789'})
 assert.equal(mentionInitialDelay(cfg,{dataDir:dir,now:()=>time+999999}),1000,'重新加载不能重置成又等五分钟')
 const dryDir=path.join(dir,'dry');const dry=await runBiliMentions(cfg,{...deps,dataDir:dryDir,dry:true,list:async()=>[rows[0]],verify:async t=>t,load:()=>({})})
 assert.equal(dry.sent,0);assert.deepEqual(dry.planned,['700']);assert.equal(sent.length,2);assert.equal(fs.existsSync(path.join(dryDir,'bili-mentions.json')),false)
 const retryDir=path.join(dir,'retry');let writes=0
 const retry={...deps,dataDir:retryDir,list:async()=>[rows[0]],verify:async t=>t,load:()=>({}),send:async()=>{if(++writes===1)throw Object.assign(Error('明确未发出'),{biliNotSent:true});return {rpid:'1000'}}}
 await assert.rejects(runBiliMentions(cfg,retry),/明确未发出/)
 const retryLedger=JSON.parse(fs.readFileSync(path.join(retryDir,'bili-mentions.json')))
 assert.equal(retryLedger['999'].entries['700'].status,'retry');assert.ok(retryLedger['999'].queue['700'])
 time+=301000;assert.equal((await runBiliMentions(cfg,retry)).sent,1);assert.equal(writes,2)
 console.log('mentions-queue: 待办持久化/第一页之外继续处理/失败公平轮转/分页核验/真实UID/游标/热重载不重置检查时间/预演无写通过')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
