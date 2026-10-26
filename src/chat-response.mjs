import {stripBookReferences,humanizeBookReply} from './book-display.mjs'
import { parseJSON } from './llm.mjs'
import { styleIssue, STYLE_REPAIR, removeColonFrames } from './natural-style.mjs'
import { prepareDeepReply } from './deep-reply.mjs'
import { withoutSourceURLs } from './reply-links.mjs'

// 必回模式只需要正文；兼容旧JSON，但绝不把损坏的结构、why或思考内容发到QQ。
export function decodeChatReply(content) {
  if(typeof content!=='string')return {reply:'',reason:'empty'}
  let text=content.replace(/^\uFEFF/,'').trim()
  text=text.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi,'').trim()
  if(!text||/^<think\b/i.test(text))return {reply:'',reason:'empty'}
  text=text.replace(/^```(?:json|text)?\s*\n?([\s\S]*?)\n?```$/i,'$1').trim()
  if(/^\s*<(?:!doctype|html|head|body)\b/i.test(text))return {reply:'',reason:'html'}
  const structured=/^[{[]/.test(text)
  const parsed=structured?parseJSON(text):null
  if(parsed&&typeof parsed==='object')return {reply:typeof parsed.reply==='string'?parsed.reply.trim():'',reason:'legacy-json'}
  if(structured) {
    // 截断发生在why字段时，已完整闭合的reply字符串仍可用；不补造半句话。
    const match=text.match(/"reply"\s*:\s*("(?:\\[\s\S]|[^"\\])*")(?=\s*[,}]|\s*$)/)
    if(match)try{return {reply:JSON.parse(match[1]).trim(),reason:'recovered-json'}}catch{}
    return {reply:'',reason:'malformed-json'}
  }
  if(text.startsWith('"'))try{const value=JSON.parse(text);if(typeof value==='string')return {reply:value.trim(),reason:'quoted-text'}}catch{}
  return {reply:text,reason:'text'}
}

/** 仅空/损坏内容补一次生成；两次共用同一截止时间，首次usage也记账。 */
export function replyIssue(reply,{minReplyChars=0,maxReplyChars=0,entityEvidenceAvailable=false}={}) {
  const text=String(reply??'').trim()
  if(!text)return 'empty'
  if(entityEvidenceAvailable&&text.length<150&&/(?:没查到叫|这名字.{0,8}没查到|不知道.{0,12}是谁|不确定.{0,12}(?:哪本书|哪部作品)|(?:本仙|我)(?:不认识|没听说过))/.test(text))return 'entity-denied'
  if(text.length>140) {
    if(/(.)\1{11,}/u.test(text)||/(.{6,24})\1{2,}/u.test(text))return 'repetition'
    if(text.split(/[，。！？；：、,.!?;:\n~～…]/u).some(part=>part.length>110))return 'broken-sentences'
  }
  const size=text.replace(/\s/g,'').length
  return size<minReplyChars?'too-short':maxReplyChars&&size>maxReplyChars?'too-long':null
}

export async function generateDirectReply(call,model,options,{onResult=()=>{},now=Date.now}={}) {
  options=await prepareDeepReply(model,options)
  const timeoutMs=Math.min(180,Math.max(10,Number(model.requestTimeoutSec)||60))*1000
  const deadline=now()+timeoutMs
  const signal=options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)
  const usage={prompt:0,completion:0,reasoning:0,total:0}
  let last=null,decoded={reply:'',reason:'empty'},bestLength=null,styleFallback=null
  const deviation=reply=>Math.max(0,(options.minReplyChars||0)-reply.length,options.maxReplyChars?reply.length-options.maxReplyChars:0)
  const keepReply=entry=>{const clean=humanizeBookReply(removeColonFrames(entry.reply,options),options.styleTask??options.user);return replyIssue(clean,options)?entry.reply:clean}
  for(let attempt=0;attempt<2;attempt++) {
    signal.throwIfAborted()
    const remaining=deadline-now()
    if(remaining<1000)break
    try {
      last=await call({...model,requestTimeoutSec:Math.ceil(remaining/1000),...(attempt?{maxRetries:0}:{})},{...options,json:false,signal,
        ...(attempt?{temperature:Math.min(Number(options.temperature)||.6,.6),user:options.user+'\n\n【回复修订要求】上一版正文：'+String(decoded.reply??'').slice(0,4000)+'\n请在不丢失问题与检索来源的前提下修订，直接给出完整正文。',system:options.system+(decoded.reason.startsWith('style-')?STYLE_REPAIR:'')+(decoded.reason==='style-library-jargon'?'\n不要谈索引、入库或编号。说眼下没找到合适的书中内容即可，不据此断言书不存在。':'')+'\n请重新组织完整通顺的回复，切实回答本次问题并满足指定字数。不要无意义串词或重复，不要JSON、解释或思考过程。'+(options.minReplyChars&&decoded.reason==='too-short'?`上一版只有${String(decoded.reply??'').replace(/\s/g,'').length}字，未满足长度要求。请依据用户问题及已有资料重写为至少${options.minReplyChars}字的完整答复${options.maxReplyChars?`，不超过${options.maxReplyChars}字`:'，建议比最低要求多写40~80字'}。不能编造事实凑字。`:'' )}:{}),
      })
    }catch(e){
      if(!last)throw e
      onResult({attempts:attempt+1,contentChars:0,format:'retry-failed',finish:null})
      // 第一次已消耗的token不能因为第二次失败而丢失。
      const retained=styleFallback||(!options.strictMinReply?bestLength:null)
      return {...last,content:retained?JSON.stringify({speak:true,reply:keepReply(retained),why:'正文回复'}):'',usage,replyFormat:'retry-failed'}
    }
    for(const key of Object.keys(usage))usage[key]+=Number(last.usage?.[key])||0
    decoded=decodeChatReply(last.content)
    if(options.hideSourceURLs)decoded.reply=withoutSourceURLs(decoded.reply)
    decoded.reply=stripBookReferences(decoded.reply)
    const issue=decoded.reply?(replyIssue(decoded.reply,options)||styleIssue(decoded.reply,options)):null
    if(issue==='too-short'||issue==='too-long') {if(!bestLength||deviation(decoded.reply)<deviation(bestLength.reply))bestLength={...decoded};decoded.reason=issue}
    else if(issue?.startsWith('style-')) {styleFallback??={...decoded};decoded.reason=issue}
    else if(issue)decoded={reply:'',reason:issue}
    onResult({attempts:attempt+1,contentChars:typeof last.content==='string'?last.content.length:0,format:decoded.reason,finish:last.finish??null})
    if(decoded.reply&&!issue)break
  }
  if(styleFallback&&(!decoded.reply||replyIssue(decoded.reply,options)))decoded=styleFallback
  else if(bestLength&&(!decoded.reply||['too-short','too-long'].includes(decoded.reason)&&deviation(bestLength.reply)<deviation(decoded.reply)))decoded=bestLength
  if(options.strictMinReply && replyIssue(decoded.reply,options))decoded={reply:'',reason:'length-rejected'}
  return {...last,content:decoded.reply?JSON.stringify({speak:true,reply:keepReply(decoded),why:'正文回复'}):'',usage,replyFormat:decoded.reason}
}
// Recovery accounts for both generations and never exposes structured metadata as a reply.
// Length deviations and obvious repetition share the same single recovery attempt as empty output.

// QQ command and explicit video integration, 2026-10-21.

// Explicit QQ search supplies verified source summaries before reply generation.
