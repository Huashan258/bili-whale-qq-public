import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-search-'))
process.env.BILI_WHALE_DATA=dir
const {searchIntent,createChatSearch,parseSearchRSS,relevantResults,groundedSearchReply,searchFallback}=await import('../src/chat-search.mjs')
const {createChat}=await import('../src/chat.mjs')
const {generateDirectReply}=await import('../src/chat-response.mjs')
const row={bvid:'BV1a4Jy6wEHP',title:'杀阶戴冠战攻略/组队思路/速刷作业【FGO】',author:'fixture',desc:'请先核对具体关卡与队伍配置。',pubdate:1792590000}
let bot
try {
  const intent=searchIntent('查询b站杀阶戴冠战的作业')
  assert.deepEqual(intent,{source:'bili',query:'杀阶戴冠战 作业'})
  assert.equal(searchIntent('你好'),null)
  assert.equal(searchIntent('不要联网搜索这个问题'),null)
  assert.equal(searchIntent('查询b站杀阶戴冠战',{enabled:false}),null)
  assert.deepEqual(searchIntent('网页搜索杭州天气'),{source:'web',query:'杭州天气'})
  const currentTask='锐评三角洲行动这次的渡鸦活动'
  assert.deepEqual(searchIntent(currentTask,{command:true}),{source:'research',query:'三角洲行动 渡鸦活动',commandRead:true,fresh:true})
  assert.equal(searchIntent(currentTask),null,'普通聊天保持显式检索策略')
  for(const task of ['点评三国中的潘凤','今天你喜欢我吗','假设游戏出了新活动，写一段台词','只根据我提供的内容评价这次活动','不要联网，锐评这次活动'])assert.equal(searchIntent(task,{command:true}),null,task)
  assert.equal(searchIntent(currentTask,{command:true,enabled:false}),null)
  assert.equal(searchIntent('分析这次游戏更新',{command:true}).source,'research')
  let calls=0,time=0
  const lookup=createChatSearch({now:()=>time,researchVideos:async(query,_cfg,options)=>{calls++;assert.equal(query,'杀阶戴冠战 作业');assert.equal(options.commandRead,false);await new Promise(r=>setImmediate(r));return {ok:true,complete:true,source:'bili',results:[row]}}})
  const [a,b]=await Promise.all([lookup(intent,{}),lookup(intent,{})])
  assert.equal(calls,1);assert.deepEqual(a,b)
  assert.equal((await lookup(intent,{})).cached,true)
  time=600001;await lookup(intent,{});assert.equal(calls,2)
  const rss='<rss><channel><item><title><![CDATA[杭州天气]]></title><link>https://example.test/weather?a=1&amp;b=2</link><description>杭州今天晴，&lt;b&gt;仅测试&lt;/b&gt;</description></item><item><title>坏链接</title><link>javascript:alert(1)</link></item></channel></rss>'
  assert.equal(parseSearchRSS(rss).length,1)
  assert.equal(parseSearchRSS(rss)[0].url,'https://example.test/weather?a=1&b=2')
  assert.throws(()=>parseSearchRSS('<html>challenge</html>'))
  assert.equal(relevantResults([{title:'杀的字典释义',description:'汉字'}],intent.query).length,0)
  let requests=0,searchURL=''
  const web=createChatSearch({readPage:async url=>({ok:false,url,reason:'fixture未读取正文'}),request:async url=>{requests++;searchURL=url;return new Response(rss)}})
  assert.equal((await web(searchIntent('网页查询杭州天气'),{})).results.length,1)
  assert.match(searchURL,/bing\.com\/search/)
  assert.equal((await web(searchIntent('网页查询上海天气'),{})).ok,false)
  assert.equal(requests,1,'网页查询间隔不因关键词不同而绕过')
  const blocked=createChatSearch({researchVideos:async()=>{throw Object.assign(Error('B站全局冷却中'),{biliPolicy:true})}})
  assert.match((await blocked(intent,{})).reason,/冷却/)
  const result={ok:true,source:'bili',results:[{title:row.title,url:'https://www.bilibili.com/video/'+row.bvid,description:row.desc}]}
  assert.match(groundedSearchReply(result,'我不能实时联网搜索。','Master'),/杀阶戴冠战攻略/)
  assert.ok(searchFallback(result,'Master').replace(/\s/g,'').length>=200)
  assert.ok(searchFallback({ok:false,results:[],reason:'冷却中'},'Master').replace(/\s/g,'').length>=200)
  const prompts=[],sent=[],queries=[]
  const cfg={llm:{provider:'fixture',apiKey:'fixture'},qq:{groupIds:['123456']},chat:{splitReplies:false,admins:['111111'],replyEveryMessage:true,outputRateOnly:true,contextMessages:0,shield:{maxOutputTokens:20000}}}
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,replySleep:async()=>{},logger:{},lookup:async i=>{queries.push(i);return result},llmChat:async(_cfg,p)=>{prompts.push(p);return {content:'Master，我不能实时查询B站。'}},say:async(_cfg,id,msg)=>sent.push({channel:'group',msg}),sayPrivate:async(_cfg,id,msg)=>sent.push({channel:'private',msg})})
  for (const type of ['group','private']) {
    await bot.handleEvent({post_type:'message',message_type:type,group_id:'123456',user_id:'111111',message_id:type,message:[{type:'text',data:{text:'我以令咒命之：查询b站杀阶戴冠战的作业'}}]})
  }
  assert.equal(queries.length,2);assert.ok(queries.every(q=>q.query==='杀阶戴冠战 作业'))
  assert.equal(prompts.length,4,'短答每条只补试一次')
  assert.ok(prompts.every(p=>p.user.includes(row.bvid)&&p.user.includes(row.title)))
  assert.match(prompts[1].system,/上一版只有\d+字/)
  for(const channel of ['group','private']){const text=sent.filter(s=>s.channel===channel).flatMap(s=>s.msg).filter(s=>s.type==='text').map(s=>s.data.text).join('');assert.match(text,/杀阶戴冠战攻略/);assert.doesNotMatch(text,/https?:/);assert.ok(text.replace(/\s/g,'').length>=200);assert.doesNotMatch(text,/未能生成满足200字/)}
  assert.equal(bot.status().diagnostics.recent.at(-1).search.count,1)
  assert.equal(JSON.stringify(bot.status().diagnostics).includes('杀阶戴冠战'),false,'诊断不额外记录查询正文')
  bot.stop()
  const autoQueries=[],autoPrompts=[],autoSent=[]
  const autoResult={ok:true,source:'web',results:[{title:'三角洲行动渡鸦活动资料（测试）',url:'https://fixture.test/raven',description:'离线测试资料，不能作为真实活动规则。'}],pages:[]}
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,replySleep:async()=>{},logger:{},lookup:async i=>{autoQueries.push(i);return autoResult},llmChat:async(_cfg,p)=>{autoPrompts.push(p);return {content:'根据本次取得的资料作评价。'.repeat(24)+' https://fixture.test/raven'}},say:async(_cfg,id,msg)=>autoSent.push({channel:'group',msg}),sayPrivate:async(_cfg,id,msg)=>autoSent.push({channel:'private',msg})})
  for(const type of ['group','private']) await bot.handleEvent({post_type:'message',message_type:type,group_id:'123456',user_id:'111111',message_id:'auto-'+type,message:[{type:'text',data:{text:'我以令咒命之：'+currentTask}}]})
  assert.equal(autoQueries.length,2)
  assert.ok(autoQueries.every(i=>i.query==='三角洲行动 渡鸦活动'&&i.source==='research'&&i.commandRead===true))
  assert.ok(autoPrompts.every(p=>p.user.includes('联网回答引导')&&p.user.includes('旧闻不能冒充最新消息')))
  assert.equal(new Set(autoSent.map(s=>s.channel)).size,2)
  assert.equal(bot.status().search.automaticCommands,true)
  let repairUser='';let round=0
  await generateDirectReply(async(_m,p)=>{if(round++)repairUser=p.user;return {content:'短答。'}},cfg.llm,{system:'至少200字',user:'问题与已有资料',minReplyChars:200,strictMinReply:true})
  assert.match(repairUser,/上一版正文：短答/)
  console.log('联网检索通过：令咒群聊/私聊真实查询注入、短答修订、来源兜底200字、URL与相关性过滤、RSS解析、同词缓存/并发合并、15秒网页限频、B站冷却说明、无虚构链接、诊断不存查询正文。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
