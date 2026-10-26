import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wiki-question-'))
process.env.BILI_WHALE_DATA=dir
const {searchIntent,createChatSearch,parseSearchRSS,relevantResults,searchPrompt}=await import('../src/chat-search.mjs')
const {createCommandResearch}=await import('../src/command-research.mjs')
const {prepareDeepReply}=await import('../src/deep-reply.mjs')
const {generateDirectReply}=await import('../src/chat-response.mjs')
try{
  for(const text of ['若娜瓦是谁','@881000004 若娜瓦是谁','介绍一下若娜瓦','你知道若娜瓦吗','若娜瓦的资料','谁是若娜瓦','「若娜瓦」是谁'])assert.equal(searchIntent(text).query,'若娜瓦',text)
  assert.equal(searchIntent('我是谁'),null)
  assert.equal(searchIntent('你知道我的名字吗'),null)
  assert.equal(searchIntent('你知道我是谁吗'),null)
  assert.equal(searchIntent('不要联网，若娜瓦是谁'),null)
  assert.equal(searchIntent('若娜瓦是谁',{enabled:false}),null)
  const apiCalls=[];let videos=0
  const research=createCommandResearch({readPage:async url=>{
    apiCalls.push(url)
    if(new URL(url).searchParams.get('list')==='search')return {ok:true,body:JSON.stringify({query:{search:url.includes('/ys/')?[{title:'若娜瓦',snippet:'若娜瓦人物资料'},{title:'若娜瓦（NPC）',snippet:'若娜瓦'}]:[]}})}
    return {ok:true,url,finalURL:url,title:'若娜瓦',readAt:Date.now(),tier:'wiki',body:'若娜瓦是测试用的原神角色资料，此处仅为离线用例，不代表真实剧情。'.repeat(12)}
  },request:async()=>new Response('<rss><channel></channel></rss>'),researchVideos:async()=>{videos++;throw Error('不应看视频')},parseRSS:parseSearchRSS,relevant:relevantResults})
  const result=await research(searchIntent('若娜瓦是谁'),{})
  assert.ok(result.pages.some(p=>p.ok));assert.equal(videos,0)
  assert.match(searchPrompt(result),/不能在已有相关正文时声称不知道/)
  assert.ok(apiCalls.filter(u=>u.includes('list=search')).every(u=>u.includes('/ys/')))
  apiCalls.length=0;await research(searchIntent('陌生旅客是谁'),{})
  assert.equal(new Set(apiCalls.filter(u=>u.includes('list=search')).map(u=>new URL(u).origin+new URL(u).pathname)).size,4,'未知作品也查四个已配置站点')
  const cfg={chat:{deepReply:{enabled:true},search:{enabled:true}},llm:{}}
  const options={replyConfig:cfg,replyLookup:async i=>{assert.equal(i.source,'research');return result},styleTask:'若娜瓦是谁',system:'自然答复',user:'若娜瓦是谁',maxTokens:200}
  const prepared=await prepareDeepReply({},options);assert.equal(prepared.entityEvidenceAvailable,true)
  const bare=await prepareDeepReply({},{...options,styleTask:'若娜瓦！'});assert.ok(bare.user.includes('若娜瓦人物资料'))
  let attempts=0
  const reply=await generateDirectReply(async()=>({content:++attempts===1?'没查到叫若娜瓦的，给个出处？':'若娜瓦在本次资料中有明确介绍，以下仅概述已读内容。'}),{},options)
  assert.equal(attempts,2);assert.ok(reply.content.includes('明确介绍'))
  let time=0,requests=0
  const lookup=createChatSearch({now:()=>time,request:async()=>{requests++;return new Response('<rss><channel></channel></rss>')}})
  await lookup({source:'web',query:'无结果词'},{});time+=16000;await lookup({source:'web',query:'无结果词'},{});assert.equal(requests,2,'空结果不缓存十分钟')
  console.log('百科问题通过：是谁/介绍/资料/带@直查Wiki、普通称呼不外查、禁网、未知作品四站探查、正文注入、普通百科不耗五视频、已知别名、错误否认单次修订、空结果不缓存。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
