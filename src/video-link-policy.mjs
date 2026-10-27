export function explicitAtSelf(message,selfId){
 const uid=String(selfId??'');if(!/^\d+$/.test(uid))return false
 if(Array.isArray(message))return message.some(s=>s?.type==='at'&&String(s.data?.qq)===uid)
 return [...String(message??'').matchAll(/\[CQ:at,([^\]]+)\]/g)].some(m=>m[1].split(',').some(p=>p==='qq='+uid))
}
function videoURL(text){try{const u=new URL(text),h=u.hostname.toLowerCase(),p=u.pathname;return h==='b23.tv'||(h==='bilibili.com'||h.endsWith('.bilibili.com'))&&(/^\/(?:video\/|bangumi\/play)/i.test(p)||/BV[A-Za-z0-9]{10}/.test(p)||u.searchParams.has('bvid'))||h==='youtu.be'||(h==='youtube.com'||h.endsWith('.youtube.com'))&&/^\/(?:watch|shorts|live)(?:\/|$)/i.test(p)}catch{return false}}
export const UNAT_VIDEO_GUIDE='\n【本条视频读取条件】本条群消息没有明确@本仙，所带视频链接或BV号未读取。只按实际提供的文字接话，不概述、点评或假称看过该视频，不自行打开该链接；也不把此规则说成没有联网能力。'
/** Do not let the general page-reader fallback reopen a video link refused by QQ's @ rule. */
export function withoutVideoLinks(input){
 let blocked=false
 const text=String(input??'').split(/(https?:\/\/[^\s<>"'，。；）】]+)/gi).map((part,i)=>{
  if(i%2){if(videoURL(part)){blocked=true;return ''}return part}
  return part.replace(/\bBV[A-Za-z0-9]{10}\b/g,()=>{blocked=true;return ''})
 }).join('').replace(/\s+/g,' ').trim()
 return {text,blocked}
}
