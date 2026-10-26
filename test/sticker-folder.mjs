import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sticker-folder-'))
process.env.BILI_WHALE_DATA=path.join(dir,'data')
const {createStickerStore,createStickerPicker}=await import('../src/qq-stickers.mjs')
const sourceDir=path.join(dir,'biaoqingbao'),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=','base64')
try{
  fs.mkdirSync(path.join(sourceDir,'子目录'),{recursive:true})
  const big=Buffer.concat([png,Buffer.alloc(3*1024*1024)])
  fs.writeFileSync(path.join(sourceDir,'子目录','豪气.png'),big)
  for(let i=0;i<75;i++)fs.writeFileSync(path.join(sourceDir,`喜悦${i}.png`),png)
  fs.writeFileSync(path.join(sourceDir,'假图.jpg'),'<svg>not a raster</svg>')
  const store=createStickerStore({dir:path.join(dir,'metadata'),sourceDir})
  let state=store.snapshot();assert.equal(state.items.length,76)
  const item=state.items.find(i=>i.name==='豪气');assert.ok(item.bytes>1024*1024);assert.deepEqual(store.read(item.id).bytes,big)
  assert.equal(store.snapshot().revision,state.revision)
  assert.equal(createStickerStore({dir:path.join(dir,'metadata'),sourceDir}).snapshot().items.find(i=>i.name==='豪气').id,item.id)
  state=store.save({action:'update',revision:state.revision,id:item.id,name:'豪迈',description:'得意时使用',enabled:false})
  assert.equal(store.snapshot().items.find(i=>i.id===item.id).description,'得意时使用')
  const stale=state.revision;fs.writeFileSync(path.join(sourceDir,'新增.png'),png)
  assert.throws(()=>store.save({action:'settings',revision:stale,enabled:true,chance:1,cooldownSec:0}),/更新/)
  state=store.snapshot();state=store.save({action:'upload',revision:state.revision,name:'大图上传',description:'大于1MB且已超过60张的上传',base64:big.toString('base64')})
  assert.equal(state.items.length,78)
  const uploaded=state.items.find(i=>i.name==='大图上传');assert.deepEqual(store.read(uploaded.id).bytes,big);assert.ok(fs.existsSync(path.join(sourceDir,uploaded.relativePath)))
  state=store.save({action:'remove',revision:state.revision,id:item.id});assert.equal(state.items.length,77)
  assert.ok(fs.existsSync(path.join(sourceDir,'子目录','豪气.png')),'移出不删除原图')
  assert.ok(!store.snapshot().items.some(i=>i.id===item.id),'自动扫描不会恢复已排除的图片')
  assert.throws(()=>store.read(item.id));assert.throws(()=>store.read('../outside.png'))
  state=store.save({action:'settings',revision:state.revision,enabled:true,chance:1,cooldownSec:0})
  let candidates=0
  const picker=createStickerPicker({store,random:()=>0,llmChat:async(_,o)=>{candidates=JSON.parse(o.user).stickers.length;return {content:JSON.stringify({id:uploaded.id})}}})
  const selected=await picker({cfg:{llm:{}},text:'好开心',reply:'本仙心情不错',key:'fixture'})
  assert.equal(candidates,77);assert.ok(selected.segment.data.file.length>4*1024*1024,'大图可进入QQ图片段，不作1MB截断')
  console.log('目录表情通过：递归自动发现/76张不截断/大于1MB读取与上传/原名语境/稳定ID与修订/文件变化冲突/排除不回归/原图保留/路径限制/全库选图/大图投递结构。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
