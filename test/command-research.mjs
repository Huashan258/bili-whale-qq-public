import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'command-research-'));process.env.BILI_WHALE_DATA=dir
const {createCommandResearch,wikiTargets,parseEngineHTML,parseYouTubeSearch}=await import('../src/command-research.mjs')
const {createChatSearch,searchIntent,searchPrompt,groundedSearchReply,parseSearchRSS,relevantResults}=await import('../src/chat-search.mjs')
const {withoutSourceURLs,hideReplyURLs}=await import('../src/reply-links.mjs')
const now=Date.parse('2026-10-25T08:00:00Z'),calls=[],bili=[]
const responseBody='这是FGO冠位戴冠战Assassin的测试公开资料，需要按国服日服和活动时间分别核对。'.repeat(10)
const readPage=async(url,o)=>{
 calls.push({kind:'read',url,refresh:o.refresh})
 const u=new URL(url)
 if(u.pathname==='/api.php')return {ok:true,body:JSON.stringify({query:{search:[1,2,3].map(i=>({title:'冠位戴冠战 Assassin 2026资料'+i,snippet:'FGO最新冠位戴冠战Assassin资料',timestamp:'2026-10-24T00:00:00Z'}))}})}
 return {ok:true,url,finalURL:url,title:'FGO冠位戴冠战Assassin资料',body:responseBody,readAt:now,links:[]}
}
const request=async url=>{
 calls.push({kind:'engine',url})
 const u=new URL(url),q=u.searchParams.get('q')||'',youtube=q.includes('site:youtube.com')
 if(u.hostname==='www.youtube.com')return new Response('var ytInitialData = '+JSON.stringify({contents:[{videoRenderer:{videoId:'fixture1234',title:{runs:[{text:'FGO冠位戴冠战Assassin 2026资料'}]},publishedTimeText:{simpleText:'2天前'}}}]})+';')
 const target=youtube?'https://www.youtube.com/watch?v=fixture123':'https://guide.test/'+(q.includes('最新')?'recent':'general')+'/'+u.hostname
 const title='FGO冠位戴冠战Assassin 2026资料'
 if(u.hostname.includes('bing'))return new Response(`<rss><channel><item><title>${title}</title><link>${target}</link><description>FGO冠位戴冠战Assassin</description></item></channel></rss>`)
 if(u.hostname.includes('duckduckgo'))return new Response(`<a class="result__a" href="${target}">${title}</a>FGO冠位戴冠战Assassin`)
 return new Response(`<a href="${target}">${title}</a>FGO冠位戴冠战Assassin`)
}
const videos=Array.from({length:5},(_,i)=>({bvid:'BV'+String(i).padStart(10,'0'),title:'FGO冠位戴冠战Assassin资料',url:'https://www.bilibili.com/video/BV'+String(i).padStart(10,'0'),description:'测试资料',date:'2026-10-24',hasSubtitle:true,body:'取得的测试字幕'}))
try{
 assert.equal(wikiTargets('FGO杀阶戴冠战')[0].id,'fgo')
 assert.equal(wikiTargets('明日方舟感谢庆典')[0].id,'prts')
 assert.equal(wikiTargets('星穹铁道混沌回忆')[0].id,'sr')
 assert.equal(wikiTargets('原神深境螺旋')[0].id,'ys')
 assert.equal(wikiTargets('杭州天气').length,0)
 const research=createCommandResearch({request,readPage,researchVideos:async(q,_c,o)=>{bili.push(q);assert.equal(o.commandRead,true);assert.equal(o.preferRecent,true);return {ok:true,complete:true,videosRead:5,results:videos,videos}},parseRSS:parseSearchRSS,relevant:relevantResults,now:()=>now})
 const intent=searchIntent('查询FGO最新杀阶戴冠战的作业',{command:true})
 assert.equal(intent.source,'research');assert.equal(intent.fresh,true)
 const r=await research(intent,{})
 assert.equal(r.source,'research');assert.equal(r.selectedTier,'cross-check')
 assert.equal(bili.length,1,'Wiki有正文也继续查询B站')
 const engineCalls=calls.filter(c=>c.kind==='engine')
 assert.equal(engineCalls.length,10,'两层已有资料，仍查三引擎和YouTube公开搜索')
 assert.ok(engineCalls.some(c=>new URL(c.url).hostname.includes('duckduckgo')))
 assert.ok(engineCalls.some(c=>new URL(c.url).hostname.includes('brave')))
 assert.ok(engineCalls.some(c=>(new URL(c.url).searchParams.get('q')||'').includes('site:youtube.com')))
 assert.ok(calls.filter(c=>c.kind==='read').every(c=>c.refresh===true))
 assert.ok(r.trace.some(t=>t.site==='Mooncell'));assert.ok(r.trace.some(t=>t.stage==='youtube'))
 const prompt=searchPrompt(r)
 assert.match(prompt,/最后编辑时间不等于活动日期/);assert.match(prompt,/不贴网址/);assert.match(prompt,/未读取视频画面或字幕/)
 assert.match(prompt,/fgo\.wiki/,'证据链接保留内部')
 assert.doesNotMatch(groundedSearchReply(r,'资料交叉核对后回答 https://fgo.wiki/w/资料 [参考](https://guide.test/source)','Master'),/https?:|fgo\.wiki/)
 const evidence=fs.readdirSync(path.join(dir,'search-evidence'))
 const saved=JSON.parse(fs.readFileSync(path.join(dir,'search-evidence',evidence[0]),'utf8'))
 assert.equal(saved.query,undefined);assert.ok(saved.results.some(s=>s.url))
 assert.equal(withoutSourceURLs('正文 [来源](https://example.org/a)\n来源：https://example.org/a\n fgo.wiki/w/首页'),'正文 来源')
 assert.match(withoutSourceURLs('示例 `https://api.test/v1`'),/https:\/\/api.test/,'代码内容不因隐藏来源而损坏')
 assert.equal(JSON.parse(hideReplyURLs('{"reply":"答复 https://source.test/path","comment":"见www.fgo.wiki"}')).reply,'答复')
 let cachedCalls=0,time=now
 const lookup=createChatSearch({now:()=>time,commandResearch:async()=>{cachedCalls++;return r}})
 await lookup(intent,{});time+=119000;await lookup(intent,{});assert.equal(cachedCalls,1)
 time+=2000;await lookup(intent,{});assert.equal(cachedCalls,2,'近期令咒缓存两分钟，不沿用十分钟旧结果')
 const ctrl=new AbortController();ctrl.abort(Error('停止'))
 await assert.rejects(()=>research(intent,{}, {signal:ctrl.signal}),/停止/)
 assert.equal(parseEngineHTML('<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fsource.test%2Fa">有效测试标题</a>','duckduckgo')[0].url,'https://source.test/a')
 assert.equal(parseYouTubeSearch('var ytInitialData = {"contents":[{"videoRenderer":{"videoId":"fixture1234","title":{"simpleText":"测试视频"}}}]};')[0].title,'测试视频')
 console.log('令咒多源检索通过：三Wiki路由/最新年份与正文/找到仍交叉查B站及三引擎YouTube/五视频保留/读取范围与编辑时间区分/近期两分钟缓存/后台来源留存不记查询/答案隐藏网址/停止。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
