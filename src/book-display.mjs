export const BOOK_DISPLAY_GUIDE = '日常谈论学过的文献，用记得、读过、翻到、眼下还没找到合适内容等自然说法，不向聊天对象报告索引、标签命中、片段编号、入库流程或检索维度，不展示内部书库/文章ID。引用用《书名》和篇章名称。一次没找到只能说这次没查到，不能断言书不存在或完整书库没有；不知道哪些书可用就不要臆造书目清单。用户明确询问知识库技术或整理工作时可以正常解释技术。'

export function stripBookReferences(text) {
  // IDs carry no human-facing meaning. Retain ordinary titles, chapter names and code.
  return String(text??'').split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part,i)=>{
    if(i%2)return part
    const clean=part.replace(/[\[【](?:书库|文章|片段)[：:]\s*[^\]】\r\n]+[\]】]/g,'').replace(/\b[a-f0-9]{16}:(?:article:)?\d{6}\b/gi,'')
    return clean===part?part:clean.replace(/[ \t]+(?=[，。！？；])/g,'').replace(/ {2,}/g,' ')
  }).join('')
}

export function libraryJargon(reply,task='') {
  if (/知识库|索引|标签|入库|向量|数据库|片段(?:id|编号)|检索|整理书|录入/i.test(String(task))) return false
  const text=String(reply).replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」/g,'')
  return /检索维度|片段编号|文章编号|索引(?:值|编号)|命中.{0,4}标签|标签.{0,4}命中|(?:书|医书|典籍|文献|书库|本仙|我).{0,24}(?:没(?:有)?索引|索引到|已索引|未索引|检索片段|入库)|(?:索引|入库).{0,8}(?:到|完成|没有)/.test(text)
}

export function humanizeBookReply(reply,task='') {
  if (/知识库|索引|标签|入库|向量|数据库|检索|整理书|录入/i.test(String(task))) return reply
  return String(reply).split(/(```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」)/g).map((part,i)=>i%2?part:part
    .replace(/没(?:有)?索引到就是没有/g,'这次还没查到合适内容')
    .replace(/还没(?:有)?索引到|没(?:有)?索引到/g,'暂时还没查到合适内容')
    .replace(/已索引的(?:书籍|书|文献)/g,'眼下能查阅的文献')
    .replace(/未索引的(?:书籍|书|文献)/g,'暂时还不能查阅的文献')).join('')
}
// Keep operational retrieval metadata out of ordinary character dialogue.
