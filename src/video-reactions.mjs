import {biliFetch} from './bili-policy.mjs'
import {listRecentComments} from './bili-comment.mjs'

const decode=s=>String(s).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#(\d+);/g,(_,n)=>Number(n)<=0x10ffff?String.fromCodePoint(Number(n)):'')
export function reactionCounts(texts,keywords=['?','？','妈妈']) {
 const counts={asciiQuestion:0,fullwidthQuestion:0,mama:0,byKeyword:Object.create(null),total:0}
 const terms=[...new Set(keywords.map(String).map(t=>t.trim()).filter(Boolean))].slice(0,30)
 for(const term of terms)counts.byKeyword[term]=0
 for(const text of texts){counts.asciiQuestion+=(String(text).match(/\?/g)||[]).length;counts.fullwidthQuestion+=(String(text).match(/？/g)||[]).length;counts.mama+=(String(text).match(/妈妈/g)||[]).length;for(const term of terms)counts.byKeyword[term]+=String(text).split(term).length-1}
 counts.total=Object.values(counts.byKeyword).reduce((n,c)=>n+c,0)
 return counts
}
export function reactionScore(counts) {return counts.total??((counts.asciiQuestion||0)+(counts.fullwidthQuestion||0)+(counts.mama||0))}
export async function readVideoReactions(material,cfg,{request=biliFetch,listComments=listRecentComments,isActive=()=>true}={}) {
 const sc=cfg.scroll??{},video=material.video,keywords=sc.reactionKeywords??['?','？','妈妈'],samples=[],coverage={danmaku:0,comments:0,danmakuAvailable:false,commentsAvailable:false},errors=[]
 const add=texts=>samples.push(...texts.map(t=>String(t).slice(0,300)))
 if(!isActive())throw Error('已停止')
 try{
  if(!video.cid)throw Error('无cid')
  const r=await request('https://api.bilibili.com/x/v1/dm/list.so?oid='+encodeURIComponent(video.cid),{headers:{'user-agent':'Mozilla/5.0',referer:`https://www.bilibili.com/video/${video.bvid}/`},isActive,signal:AbortSignal.timeout(20000)})
  if(!r.ok)throw Error('弹幕请求失败')
  const text=await r.text();if(!/<i[\s>]/.test(text))throw Error('未取得弹幕XML')
  const lines=[]
  for(const m of text.matchAll(/<d\b[^>]*>([\s\S]*?)<\/d>/g)){lines.push(decode(m[1]));if(lines.length>=Math.min(5000,Math.max(100,Number(sc.danmakuSample??1000))))break}
  coverage.danmaku=lines.length;coverage.danmakuAvailable=true;add(lines)
 }catch(e){if(e.biliPolicy||e.commentRisk)throw e;errors.push('弹幕未取得，不当作零条')}
 if(!isActive())throw Error('已停止')
 try{
  const rows=await listComments(cfg,{bvid:video.bvid,aid:video.aid,ps:Math.min(20,Math.max(5,Number(sc.commentSample??20))),pages:1,request:(url,o)=>request(url,{...o,isActive})})
  const seen=new Set(),self=String(cfg.raw?.bili?.dedeUserId??'')
  const texts=rows.filter(r=>r.mid!==self&&!seen.has(r.rpid)&&(seen.add(r.rpid)||true)).map(r=>r.text)
  coverage.comments=texts.length;coverage.commentsAvailable=true;add(texts)
 }catch(e){if(e.biliPolicy||e.commentRisk)throw e;errors.push('评论未取得，不当作零条')}
 const counts=reactionCounts(samples,keywords)
 return {counts,score:reactionScore(counts),keywords,samples,coverage,complete:coverage.danmakuAvailable&&coverage.commentsAvailable,scope:'采样：最多指定条数弹幕及一页最新评论，每条最多300字符，非全量互动总数',errors}
}
