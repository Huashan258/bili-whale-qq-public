import fs from 'node:fs'
import path from 'node:path'
import {DATA} from './config.mjs'
// Source priority is wiki -> Bilibili -> web/video index; all families are cross-checked.
export const PRIORITY_WIKIS=Object.freeze([
 {id:'fgo',name:'Mooncell',origin:'https://fgo.wiki',api:'/api.php',prefix:'/w/',match:/fgo|fate|mooncell|从者|宝具|戴冠|冠位|杀阶|圣晶石/i},
 {id:'prts',name:'PRTS',origin:'https://prts.wiki',api:'/api.php',prefix:'/w/',match:/prts|明日方舟|干员|合成玉|危机合约|集成战略|剿灭作战/i},
 {id:'sr',name:'星穹铁道BWIKI',origin:'https://wiki.biligame.com',api:'/sr/api.php',prefix:'/sr/',match:/星穹铁道|星铁|崩铁|遗器|忘却之庭|虚构叙事|末日幻影|异相仲裁/i},
 {id:'ys',name:'原神BWIKI',origin:'https://wiki.biligame.com',api:'/ys/api.php',prefix:'/ys/',match:/原神|genshin|提瓦特|圣遗物|深境螺旋|幻想真境剧诗|幽境危战|若娜瓦|ronova|死之执政/i},
])
const clean=s=>String(s??'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim()
const link=s=>{try{const u=new URL(s);return /^https?:$/.test(u.protocol)&&!u.username&&!u.password?u.href:''}catch{return ''}}
export function wikiTargets(query){return PRIORITY_WIKIS.filter(w=>w.match.test(query))}
export function parseEngineHTML(html,engine) {
 const rows=[]
 const pattern=engine==='duckduckgo'?/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi:/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
 for(const m of html.matchAll(pattern)) {
  let url=m[1].replace(/&amp;/g,'&')
  try{const u=new URL(url,'https://duckduckgo.com');url=u.searchParams.get('uddg')||u.href}catch{continue}
  url=link(url);const title=clean(m[2]);if(!url||title.length<4)continue
  if(/(?:duckduckgo|search\.brave|bing)\.com/.test(new URL(url).hostname))continue
  const after=m.index+m[0].length
  rows.push({title,url,description:clean(html.slice(after,after+500)).slice(0,300),engine})
  if(rows.length>=12)break
 }
 return rows
}
export function parseYouTubeSearch(html) {
 const match=html.match(/(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]*?\});/)
 if(!match)return []
 let data;try{data=JSON.parse(match[1])}catch{return []}
 const out=[],seen=new Set(),plain=x=>x?.simpleText||(x?.runs??[]).map(r=>r.text||'').join('')
 function visit(value){
  if(!value||typeof value!=='object'||out.length>=10)return
  const v=value.videoRenderer
  if(v&&/^[\w-]{11}$/.test(v.videoId)&&!seen.has(v.videoId)){seen.add(v.videoId);out.push({title:plain(v.title),url:'https://www.youtube.com/watch?v='+v.videoId,description:(v.detailedMetadataSnippets??[]).map(s=>plain(s.snippetText)).join(' ').slice(0,400),dateLabel:plain(v.publishedTimeText),platform:'youtube',engine:'youtube-public'})}
  for(const next of Object.values(value))if(Array.isArray(next))for(const item of next)visit(item);else if(next&&typeof next==='object')visit(next)
 }
 visit(data);return out
}
export function createCommandResearch({request=fetch,readPage,researchVideos,parseRSS,relevant,now=Date.now}={}) {
 return async function research(intent,cfg,{isActive=()=>true,signal,onProgress=()=>{}}={}) {
  if(intent.entityLookup)intent={...intent,query:intent.query.replace(/^[\s！!？?。，,:：]+|[\s！!？?。，,:：]+$/g,'')}
  const started=now(),fresh=intent.fresh!==false,localDate=new Date(now()+8*3600000).toISOString(),year=Number(localDate.slice(0,4)),trace=[],pages=[],results=[],seen=new Set()
  const active=()=>isActive()&&!signal?.aborted&&cfg.chat?.search?.enabled!==false
  const check=()=>{signal?.throwIfAborted();if(!active())throw Error('检索已停止')}
  const add=row=>{if(row?.url&&!seen.has(row.url)){seen.add(row.url);results.push(row)}}
  const report=(stage,extra={})=>onProgress({...extra,source:'research',stage,count:results.length})
  const old=row=>fresh&&!/\b20\d{2}\b/.test(intent.query)&&[...String(row.title??'').matchAll(/\b(20\d{2})\b/g)].some(m=>Number(m[1])<year)
  const read=async(row,tier)=>{
   check();if(pages.some(p=>p.url===row.url))return
   try {
    const p=await readPage(row.url,{signal,refresh:fresh})
    const published=Date.parse(p.publishedAt||row.date)
    row.publishedAt=p.publishedAt;row.modifiedAt=p.modifiedAt
    pages.push({...p,tier,revisedAt:row.revisedAt??'',stale:old(row)||fresh&&Number.isFinite(published)&&now()-published>180*86400000,platform:/youtube\.com|youtu\.be/.test(row.url)?'youtube':'web'})
   }catch{check();pages.push({ok:false,url:row.url,tier,reason:'本次未取得公开正文'})}
  }
  const enough=()=>pages.filter(p=>p.ok&&!p.stale&&p.body?.length>=250).length>=2
  const finish=(selectedTier,bili)=>{
   const value={ok:results.length>0,source:'research',query:intent.query,entityLookup:Boolean(intent.entityLookup),fresh,selectedTier,results:[...results].sort((a,b)=>Number(pages.some(p=>p.ok&&p.url===b.url))-Number(pages.some(p=>p.ok&&p.url===a.url))).slice(0,12),pages:pages.slice(0,10),trace,bili,readAt:now(),searchedAt:started,reason:results.length?'':'各层检索未取得足够相关的公开资料'}
   try {
    const dir=path.join(DATA,'search-evidence');fs.mkdirSync(dir,{recursive:true})
    const name=Date.now()+'-'+Math.random().toString(16).slice(2,8)+'.json'
    fs.writeFileSync(path.join(dir,name),JSON.stringify({readAt:value.readAt,fresh,trace,results:value.results.map(({title,url,date,dateLabel,publishedAt,modifiedAt,revisedAt,wiki,engine,platform})=>({title,url,date,dateLabel,publishedAt,modifiedAt,revisedAt,wiki,engine,platform})),pages:value.pages.map(({ok,url,finalURL,publishedAt,modifiedAt,revisedAt,readAt,platform,tier,reason})=>({ok,url,finalURL,publishedAt,modifiedAt,revisedAt,readAt,platform,tier,reason}))},null,2))
    for(const file of fs.readdirSync(dir).filter(f=>/^\d+-[a-f\d]+\.json$/.test(f)).sort().reverse().slice(30))fs.unlinkSync(path.join(dir,file))
   }catch{/* Public-source bookkeeping never prevents a reply; no user query/UID is written. */}
   return value
  }
  report('wiki')
  const priorities=cfg.chat?.search?.priorityWikis??['fgo.wiki','prts.wiki','wiki.biligame.com/sr','wiki.biligame.com/ys']
  const matched=wikiTargets(intent.query),targets=matched.length?matched:intent.entityLookup?PRIORITY_WIKIS:[]
  const selectedWikis=targets.filter(w=>priorities.includes(w.origin.replace('https://','')+(w.id==='sr'?'/sr':w.id==='ys'?'/ys':''))).sort((a,b)=>priorities.findIndex(s=>s===a.origin.replace('https://','')+(a.id==='sr'?'/sr':a.id==='ys'?'/ys':''))-priorities.findIndex(s=>s===b.origin.replace('https://','')+(b.id==='sr'?'/sr':b.id==='ys'?'/ys':'')))
  for(const wiki of selectedWikis) {
   check();let count=0
   const core=intent.query.replace(/fgo|fate(?:\/grand order)?|mooncell|prts|明日方舟|崩坏[:：]?星穹铁道|星穹铁道|星铁|崩铁|原神|genshin/gi,' ').replace(/最新|这次|此次|本次|今年|现在|查询|攻略|作业|锐评|点评|介绍|活动|怎么|如何|配队|打法|一下/g,' ').replace(/杀阶戴冠战/g,'冠位戴冠战 Assassin').replace(/^[\s]*(?:里|中)(?:面)?(?:的)?\s*/,'').replace(/\s+/g,' ').trim()||intent.query
   const topic=wiki.id==='fgo'&&/戴冠|冠位/.test(core)?'冠位戴冠战'+(/杀阶|Assassin/i.test(intent.query)?' Assassin':''):wiki.id==='prts'?core.match(/感谢庆典|周年庆典|危机合约|集成战略|剿灭作战/)?.[0]:wiki.id==='sr'?core.match(/混沌回忆|忘却之庭|虚构叙事|末日幻影|异相仲裁|货币战争/)?.[0]:null
   const queries=[...new Set([fresh&&!/20\d{2}/.test(core)?core+' '+year:core,topic&&fresh?topic+' '+year:topic,topic||core])].filter(Boolean)
   try {
    for(const q of queries) {
     const url=wiki.origin+wiki.api+'?'+new URLSearchParams({action:'query',list:'search',srsearch:q,srlimit:'8',srprop:'snippet|timestamp',format:'json',formatversion:'2'})
     const api=await readPage(url,{signal,refresh:fresh});check()
     if(!api.ok)continue
     let data;try{data=JSON.parse(api.body)}catch{continue}
     const rows=(data.query?.search??[]).map(r=>({title:r.title,url:wiki.origin+wiki.prefix+encodeURIComponent(r.title),description:clean(r.snippet),revisedAt:r.timestamp||'',date:r.timestamp||'',wiki:wiki.id}))
     const related=relevant(rows,topic||core,8).filter(r=>!old(r)&&(!intent.entityLookup||(r.title+' '+r.description).toLowerCase().includes(core.toLowerCase()))).sort((a,b)=>Number(b.title===core)-Number(a.title===core)||(fresh?(Date.parse(b.revisedAt)||0)-(Date.parse(a.revisedAt)||0):0))
     for(const row of related.slice(0,3)) {add(row);await read(row,'wiki');count++}
     if(enough())break
    }
   }catch{check()}
   trace.push({stage:'wiki',site:wiki.name,results:count,read:pages.filter(p=>p.tier==='wiki'&&p.ok).length})
   if(cfg.chat?.search?.crossCheck===false&&enough())return finish('wiki')
  }
  report('bili')
  let bili
  if(!intent.entityLookup||intent.commandRead)try{bili=await researchVideos(intent.query,cfg,{isActive:active,signal,commandRead:intent.commandRead!==false,preferRecent:fresh,onProgress:p=>report('bili',p)})}catch{check()}
  for(const r of bili?.results??[])add({...r,platform:'bili'})
  trace.push({stage:'bili',read:bili?.videosRead??0,complete:Boolean(bili?.complete),reason:bili?.reason||''})
  const recentVideo=(bili?.videos??[]).some(v=>{const t=Date.parse(v.date);return Number.isFinite(t)&&now()-t>=0&&now()-t<120*86400000})
  if(cfg.chat?.search?.crossCheck===false&&bili?.complete&&(!fresh||recentVideo))return finish('bili',bili)
  // Finding enough at one layer never prevents cross-checking other source families.
  report('web')
  const broad=intent.query.replace(/最新|这次|本次|查询|怎么|如何|一下|攻略|作业/g,' ').replace(/杀阶戴冠战/g,'冠位戴冠战 Assassin').replace(/\s+/g,' ').trim()||intent.query
  const queries=intent.entityLookup&&!intent.commandRead?[broad]:[broad,fresh&&!/20\d{2}/.test(broad)?broad+' '+localDate.slice(0,7)+' 最新':broad+' 攻略',...(cfg.chat?.search?.youtube===false?[]:[broad+' site:youtube.com/watch'+(fresh?' '+year:'')])]
  // Search engine pages are discovery only. Actual source pages use the safe reader.
  for(const [index,q] of queries.entries()) {
   check()
   if(index===2){
    let rows=[],reason=''
    try{const r=await request('https://www.youtube.com/results?search_query='+encodeURIComponent(broad+(fresh?' '+year:'')),{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});if(!r.ok)throw Error('不可用');const raw=await r.text();if(raw.length<=2500000)rows=relevant(parseYouTubeSearch(raw),broad,6);else reason='公开搜索页过大，未解析'}catch{check();reason='公开搜索页暂不可达或未取得结果'}
    trace.push({stage:'youtube',engine:'youtube-public',results:rows.length,reason})
    for(const row of rows.slice(0,3)){add(row);if(pages.length<10)await read(row,'youtube')}
   }
   for(const engine of [...new Set(cfg.chat?.search?.engines??['bing','duckduckgo','brave'])].filter(e=>['bing','duckduckgo','brave'].includes(e))) {
    check();let rows=[],reason=''
    try {
     const url=engine==='bing'?'https://www.bing.com/search?format=rss&mkt=zh-CN&q='+encodeURIComponent(q):engine==='duckduckgo'?'https://html.duckduckgo.com/html/?q='+encodeURIComponent(q):'https://search.brave.com/search?q='+encodeURIComponent(q)+'&source=web'
     const response=await request(url,{signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000),headers:{accept:engine==='bing'?'application/rss+xml':'text/html'}})
     if(!response.ok)throw Error('搜索服务拒绝')
     const raw=await response.text();if(raw.length>1500000)throw Error('搜索页面过大')
     rows=engine==='bing'?parseRSS(raw).map(r=>({...r,engine})):parseEngineHTML(raw,engine)
    }catch{check();reason='请求或解析未成功，不当作已取得资料'}
    const related=relevant(rows,broad,6).filter(r=>!old(r)).filter(r=>index!==2||/(?:youtube\.com|youtu\.be)/.test(new URL(r.url).hostname))
    trace.push({stage:index===2?'youtube':'web',engine,results:related.length,reason})
    for(const row of related.slice(0,3)) {
     add(row)
     const host=new URL(row.url).hostname
     if(host==='b23.tv'||host==='bilibili.com'||host.endsWith('.bilibili.com'))continue
     if(pages.length<(index===2?10:8))await read(row,index===2?'youtube':'web')
    }
    if(cfg.chat?.search?.crossCheck===false&&enough())return finish(index===2?'youtube':'web',bili)
   }
  }
  return finish(enough()||bili?.complete&&(!fresh||recentVideo)?'cross-check':'partial',bili)
 }
}
