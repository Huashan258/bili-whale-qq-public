import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
const hash=s=>createHash('sha256').update(s).digest('hex')
const decode=s=>String(s).replace(/&#44;/g,',').replace(/&#91;/g,'[').replace(/&#93;/g,']').replace(/&amp;/g,'&')
function segmentsOf(message){
  if(Array.isArray(message))return message
  const input=String(message??''),out=[];let end=0
  for(const m of input.matchAll(/\[CQ:([a-z_]+)(?:,([^\]]*))?\]/g)){if(m.index>end)out.push({type:'text',data:{text:decode(input.slice(end,m.index))}});out.push({type:m[1],data:Object.fromEntries(String(m[2]??'').split(',').filter(Boolean).map(s=>{const i=s.indexOf('=');return [s.slice(0,i),decode(s.slice(i+1))]}))});end=m.index+m[0].length}
  if(end<input.length)out.push({type:'text',data:{text:decode(input.slice(end))}})
  return out
}
function imageFile(data){
  for(const value of [data.file,data.url]){
    const input=String(value??'')
    if(/^[a-f\d-]{16,100}(?:\.(?:jpg|jpeg|png|gif|webp|image))?$/i.test(input))return input
    try{const u=new URL(input);if(['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&(!u.port||['80','443'].includes(u.port))&&['qpic.cn','qq.com','qq.com.cn','gtimg.cn','qlogo.cn'].some(d=>u.hostname===d||u.hostname.endsWith('.'+d)))return u.href}catch{}
  }
  return ''
}
export function repeatCandidate(message,{text=true,stickers=true,maxChars=200}={}){
  const segments=[],media=[],imageMD5=[];let content=''
  for(const s of segmentsOf(message)){
    if(!s||!['text','image','face','mface'].includes(s.type))return null
    const d=s.data??{}
    if(s.type==='text'){const value=String(d.text??'');if(!text&&value.trim())return null;content+=value;segments.push({type:'text',data:{text:value}});continue}
    if(!stickers)return null
    if(s.type==='face'){const id=String(d.id??'');if(!/^\d{1,5}$/.test(id))return null;segments.push({type:'face',data:{id}});media.push('face:'+id);continue}
    const emoji=String(d.emoji_id??''),pack=String(d.emoji_package_id??''),key=String(d.key??'')
    if(emoji&&/^[\w-]{1,128}$/.test(emoji)&&/^[\w-]{0,128}$/.test(pack)&&/^[\w-]{0,256}$/.test(key)){
      const data={emoji_id:emoji,emoji_package_id:pack,key,summary:String(d.summary??d.text??'').slice(0,100)}
      segments.push({type:s.type,data});media.push('emoji:'+pack+':'+emoji);continue
    }
    if(s.type!=='image')return null
    const file=imageFile(d);if(!file)return null
    const md5=file.match(/^([a-f\d]{32})(?:\.|$)/i)?.[1];if(md5)imageMD5.push(md5.toLowerCase())
    segments.push({type:'image',data:{file}});let identity=file;try{const u=new URL(file),id=u.searchParams.get('fileid')||u.searchParams.get('file_id')||u.searchParams.get('id');identity=id?u.origin+u.pathname+'?id='+id:u.origin+u.pathname+u.search}catch{identity=file.toLowerCase()}media.push('image:'+identity)
  }
  if(!segments.length||(!content.trim()&&!media.length)||[...content].length>Math.max(1,Number(maxChars)||200))return null
  return {segments,content,imageMD5,kind:media.length?(content.trim()?'mixed':'sticker'):'text',signature:hash(JSON.stringify({content,media})),media:media.map(hash)}
}
export function createQqRepeater({file=null,random=Math.random,now=Date.now}={}){
  let used={};try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))used=parsed}catch{}
  const stats={sent:0,failed:0}
  const recent=(key,ms)=>Number.isFinite(used[key])&&now()-used[key]<ms
  const limited=()=>Object.assign(Error('复读仍在冷却或同内容间隔内'),{repeatLimited:true})
  function save(){for(const key of Object.keys(used))if(!Number.isFinite(used[key])||now()-used[key]>8*86400000)delete used[key];const keys=Object.keys(used);for(const key of keys.slice(0,Math.max(0,keys.length-2048)))delete used[key];if(file){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(used));fs.renameSync(tmp,file)}}
  return {
    select(message,{groupId,settings={},excluded=false,bot=false,mediaRepeatMinutes=5}={}){
      if(settings.enabled!==true||excluded||bot)return null
      const candidate=repeatCandidate(message,settings);if(!candidate)return null
      const chance=Math.max(0,Math.min(1,Number(settings.chance??.1)));if(!chance||chance<1&&random()>=chance)return null
      const group=hash(String(groupId)),key=group+':'+candidate.signature,cooldown=Math.max(0,Number(settings.cooldownSec??30))*1000,mediaMs=Math.max(0,Number(mediaRepeatMinutes??5))*60000
      const check=()=>{if(recent('g:'+group,cooldown)||recent('c:'+key,120000)||candidate.media.some(k=>recent('m:'+k,mediaMs)))throw limited()}
      try{check()}catch{return null}
      return {...candidate,claim(){check();used['g:'+group]=now();used['c:'+key]=now();for(const k of candidate.media)used['m:'+k]=now();save()}}
    },
    sent(){stats.sent++},failed(){stats.failed++},status:()=>({...stats,version:1,probabilityWithinReplies:true,duplicatesSuppressed:true}),
  }
}
