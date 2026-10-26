import {biliFetch} from './bili-policy.mjs'
import {wbiMixin,sign} from './collect.mjs'

// 2026-10-23 对照B站自有 read-editor 前端；scene=12是专栏，不是普通短动态。
export const ARTICLE_EDITOR='eva3-4.0.0'
const API='https://api.bilibili.com'
const headers=cfg=>({cookie:cfg.cookieHeader,'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',origin:'https://member.bilibili.com',referer:'https://member.bilibili.com/york/read-editor'})
async function result(response) {
  let j
  try{j=await response.json()}catch{throw Error('专栏接口返回非JSON，未确认投稿结果')}
  if(!response.ok||j.code!==0)throw Object.assign(Error(`专栏接口拒绝：${String(j.message||'请求失败').slice(0,160)}（${j.code??response.status}）`),{articleRejected:true,articleCode:j.code})
  return j.data
}
export function articlePayload({title,body,collectionId=0}) {
  const paragraphs=('本文由 AI 根据本地保存的互动记录整理生成。\n\n'+body).split(/\n\s*\n/).filter(p=>p.trim()).map(p=>({para_type:1,format:{align:0},text:{nodes:[{node_type:1,word:{words:p.trim(),font_size:17,font_level:'regular',color:'',dark_color:'',style:{}}}]}}))
  return {raw_content:'',opus_req:{opus:{opus_source:2,title,content:{paragraphs},article:{category_id:15,list_id:Number(collectionId),originality:0,reproduced:0},pub_info:{editor_version:ARTICLE_EDITOR}},scene:12,meta:{app_meta:{from:'create.creative.h5',mobi_app:'web'}},option:{aigc:1,close_comment:0,up_choose_comment:0,private_pub:2}}}
}
export async function submitDiaryArticle(item,cfg,{request=biliFetch,mixin=wbiMixin,isActive=()=>true,onDispatch=()=>{}}={}) {
  let body,query
  try {
    if(!cfg.cookie?.sessdata||!cfg.cookie?.bili_jct)throw Error('B站未登录，请重新扫码登录')
    const check=await result(await request(`${API}/x/dynamic/feed/create/opus_init_check?editor_version=${ARTICLE_EDITOR}`,{headers:headers(cfg),isActive,signal:AbortSignal.timeout(20000)}))
    const reasons={banned:'账号封禁',level_unsufficient:'账号需转正答题',unreal_name:'账号需实名认证',unbind_phone:'账号需绑定手机',editor_version_unqualified:'投稿接口版本需更新',post_count_exceeded:'今日投稿数量达到平台上限'}
    for(const [key,label] of Object.entries(reasons))if(check?.verify?.[key]?.result===1)throw Error(label)
    body=articlePayload(item)
    const length=body.opus_req.opus.content.paragraphs.reduce((n,p)=>n+p.text.nodes[0].word.words.length,0)
    if(item.title.length>(check?.config?.max_title_len||40)||item.title.length<(check?.config?.min_title_len||2)||length>(check?.config?.max_article_len||40000))throw Error('日记标题或全文超过专栏容量，保留原文待处理，不截断发布')
    const key=await mixin(cfg,{isActive})
    if(!key)throw Error('无法取得B站投稿签名')
    query=sign({csrf:cfg.cookie.bili_jct,gaia_source:'main_web'},key)
    if(!isActive())throw Error('专栏发布任务已停止')
    await onDispatch()
  }catch(e){e.biliNotSent=true;throw e}
  const data=await result(await request(`${API}/x/dynamic/feed/create/opus?${query}`,{method:'POST',headers:{...headers(cfg),'content-type':'application/json'},body:JSON.stringify(body),isActive,signal:AbortSignal.timeout(20000)}))
  const id=String(data?.dyn_id_str??'')
  if(!/^[1-9]\d*$/.test(id))throw Error('专栏投稿缺少文章回执，停止自动重发，请在创作中心核对')
  return {id,url:`https://www.bilibili.com/opus/${id}`,collectionId:item.collectionId||undefined,state:'submitted',platformStatus:'已提交，公开可见性以B站审核结果为准'}
}
