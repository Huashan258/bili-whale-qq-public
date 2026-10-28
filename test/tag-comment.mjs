import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tag-comment-'));process.env.BILI_WHALE_DATA=dir
const {matchedCommentTags,maybeTagComment,readTagComments,tryTagComment}=await import('../src/tag-comment.mjs')
const {validatePatch,createSettingsStore}=await import('../src/settings.mjs')
const cfg={scroll:{tagCommentEnabled:true,tagCommentKeywords:['DeepSeek'],tagCommentMaxPerHour:1},share:{biliCommentPerDay:6},llm:{}}
const material={video:{bvid:'BV1234567890',aid:1,title:'实际素材',desc:'测试简介',stat:{}},tags:['AI','deepseek'],subtitle:{lines:[]}}
let state={},calls=0,models=0,time=Date.now()
const deps={dataDir:dir,now:()=>time,loadState:()=>structuredClone(state),saveState:s=>{state=structuredClone(s)},chat:async()=>{models++;return {content:'{"speak":true,"comment":"这段模型对话的处理还挺有意思。"}'}},addComment:async()=>{calls++;return {rpid:'123'}}}
try{
 assert.deepEqual(matchedCommentTags(['DeepSeek','deepseek','DeepSeek-R1','AI']),['DeepSeek','deepseek','DeepSeek-R1'])
 assert.equal((await maybeTagComment({...material,tags:[]},cfg,{deps})).why,'no-matching-tag')
 await maybeTagComment(material,cfg,{deps,dry:true});await maybeTagComment(material,{scroll:{}},{deps});assert.equal(models,0)
 assert.equal((await maybeTagComment(material,cfg,{deps})).sent,true);assert.equal(calls,1);assert.equal(state.commentDaily.total,1);assert.equal(state.commented[material.video.bvid].source,'tag-comment')
 assert.equal((await maybeTagComment(material,cfg,{deps})).why,'already-processed');assert.equal(calls,1)
 const second={...material,video:{...material.video,bvid:'BV1234567891'}}
 assert.equal((await maybeTagComment(second,cfg,{deps})).why,'hourly-cap')
 time+=3600001;state.commentDaily.total=6;assert.equal((await maybeTagComment(second,cfg,{deps})).why,'daily-cap');state.commentDaily.total=1
 assert.equal((await maybeTagComment(second,cfg,{deps,isActive:()=>false})).why,'disabled-or-dry')
 assert.equal((await maybeTagComment(second,cfg,{deps:{...deps,addComment:async()=>{calls++;throw Error('timeout')}}})).why,'unconfirmed')
 assert.equal(readTagComments(dir)[second.video.bvid].status,'unknown');time+=3600001
 assert.equal((await maybeTagComment(second,cfg,{deps})).why,'already-processed');assert.equal(calls,2)
 const third={...material,video:{...material.video,bvid:'BV1234567892'}}
 assert.equal((await maybeTagComment(third,cfg,{deps:{...deps,chat:async()=>({content:'{"speak":false}'})}})).why,'model-declined');assert.equal(calls,2)
 assert.equal((await tryTagComment(third,cfg,{deps:{tagComment:async()=>{throw Error('model offline')}}})).why,'failed')
 await assert.rejects(tryTagComment(third,cfg,{deps:{tagComment:async()=>{throw Object.assign(Error('cooldown'),{biliPolicy:true})}}}),/cooldown/)
 assert.throws(()=>validatePatch({'scroll.tagCommentMaxPerHour':11}));assert.throws(()=>validatePatch({'scroll.tagCommentKeywords':'DeepSeek'}))
 const configFile=path.join(dir,'fixture-config.json');fs.writeFileSync(configFile,JSON.stringify({scroll:{enabled:true},chat:{speakChance:.05}}));const store=createSettingsStore({configFile,overlayFile:path.join(dir,'overlay.json'),backupDir:path.join(dir,'backups')}),snapshot=store.snapshot();store.save({revision:snapshot.revision,patch:{'scroll.tagCommentEnabled':true,'scroll.tagCommentKeywords':['DeepSeek'],'scroll.tagCommentMaxPerHour':1}});const saved=JSON.parse(fs.readFileSync(configFile));assert.equal(saved.scroll.enabled,true);assert.equal(saved.chat.speakChance,.05);assert.equal(store.snapshot().values['scroll.tagCommentEnabled'],true)
 console.log('标签评论验证通过：标签大小写、标题不触发、预演/停用、持久去重、小时/日额度、未知结果不重发、风控传播、配置精确保存。未连接B站或QQ。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
