// Keep internal evidence URLs. Hide prose source links in user-visible answers.
export function withoutSourceURLs(value) {
 return String(value??'').split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part,i)=>i%2?part:part
  .replace(/!?\[([^\]]*)\]\(https?:\/\/[^\s)]+\)/gi,'$1')
  .replace(/https?:\/\/[^\s<>"'，。！？；）】)]+/gi,'')
  .replace(/\b(?:[a-z\d-]+\.)+(?:com|cn|org|net|wiki|tv|io|xyz)(?:\/[^\s<>"'，。！？；）】)]*)?/gi,'')
  .replace(/^[ \t]*(?:来源|链接|来源网址|原文链接|网址|URL)[：:][ \t]*$/gmi,'')
  .replace(/[ \t]+\n/g,'\n').replace(/\n{3,}/g,'\n\n')).join('').trim()
}
export function hideReplyURLs(content) {
 try {
  const data=JSON.parse(content)
  if(data&&typeof data==='object'&&!Array.isArray(data)){
   for(const key of ['reply','comment'])if(typeof data[key]==='string')data[key]=withoutSourceURLs(data[key])
   return JSON.stringify(data)
  }
 }catch{}
 return withoutSourceURLs(content)
}
