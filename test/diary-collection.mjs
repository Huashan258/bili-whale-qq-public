import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'diary-collection-'));process.env.BILI_WHALE_DATA=dir
const {createDiaryCollection}=await import('../src/diary-collection.mjs')
const {articlePayload}=await import('../src/bili-article.mjs')
try {
  const cfg={cookie:{sessdata:'fixture',bili_jct:'fixture'}},name='青娥鱼的日记'
  let saved,created=0,updated=0,existing=[{id:1,title:'手动保留的文章'}],lists=[]
  const request=async(url,opts)=>{
    if(url.endsWith('/all')&&!url.includes('/articles/'))return Response.json({code:0,data:{lists}})
    if(url.endsWith('/add')){created++;assert.equal(saved.state,'creating','建文集前先落盘');assert.equal(opts.body.get('name'),name);lists=[{id:42,name}];return Response.json({code:0,data:{id:42}})}
    if(url.includes('/articles/all?'))return Response.json({code:0,data:{list:{id:42,name,summary:'保留介绍',image_url:'https://fixture/image'},articles:existing,limit:500}})
    if(url.includes('/articles/can_add'))return Response.json({code:0,data:{articles:[{id:3,title:'日记一',dyn_id_str:'90001'}]}})
    if(url.endsWith('/update')){updated++;assert.equal(opts.body.get('ids'),'1,3');assert.equal(opts.body.get('summary'),'保留介绍');assert.equal(opts.body.get('image_url'),'https://fixture/image');existing.push({id:3,title:'日记一'});throw Error('写入完成但网络回执丢失')}
    throw Error('unexpected request')
  }
  const manager=createDiaryCollection({request}),save=v=>saved=v
  const target=await manager.ensure(cfg,{name,save});assert.equal(target.id,'42');assert.equal(created,1)
  await manager.ensure(cfg,{name,known:target,save});assert.equal(created,1,'重启复用ID，不重复建立文集')
  const recovered=await manager.ensure(cfg,{name,known:{name,state:'creating'},save});assert.equal(recovered.id,'42','创建回执丢失时从自己的列表恢复')
  const entries=[{state:'submitted',day:'2026-10-19',id:'90001',title:'日记一'}]
  await assert.rejects(manager.sync(cfg,{collection:target,entries}),/回执/)
  assert.deepEqual(await manager.sync(cfg,{collection:target,entries}),['2026-10-19']);assert.equal(updated,1,'先查远端已有成员，未知回执不重复写入')
  assert.equal(articlePayload({title:'标题',body:'正文',collectionId:'42'}).opus_req.opus.article.list_id,42)
  lists=[];await assert.rejects(manager.ensure(cfg,{name,known:{name,state:'creating'},save}),/停止重复创建/);assert.equal(created,1)
  console.log('日记文集通过：创建前落盘、复用和重启恢复、未知创建不重试、旧文归集、保留原成员/封面/介绍、未知写回执先核对、新文携带文集ID。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
