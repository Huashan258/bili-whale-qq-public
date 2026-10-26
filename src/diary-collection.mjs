import {biliFetch} from './bili-policy.mjs'
const API='https://api.bilibili.com/x/article/creative/list'
const id=v=>/^[1-9]\d*$/.test(String(v??''))?String(v):''
export function createDiaryCollection({request=biliFetch}={}) {
  async function call(route,cfg,{body,isActive=()=>true}={}) {
    if(!cfg.cookie?.sessdata||!cfg.cookie?.bili_jct)throw Error('请先登录B站再创建日记文集')
    const response=await request(API+route,{method:body?'POST':'GET',headers:{cookie:cfg.cookieHeader,'user-agent':'Mozilla/5.0',referer:'https://member.bilibili.com/platform/text-read-list',origin:'https://member.bilibili.com',...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},...(body?{body:new URLSearchParams({...body,csrf:cfg.cookie.bili_jct})}:{}),isActive,signal:AbortSignal.timeout(20000)})
    let j;try{j=await response.json()}catch{throw Error('文集操作回执不明，将先核对远端状态')}
    if(!response.ok||j.code!==0)throw Object.assign(Error(`B站文集操作失败：${String(j.message||'未知错误').slice(0,150)}（${j.code??response.status}）`),{collectionRejected:true})
    return j.data
  }
  return {
    async ensure(cfg,{name,known,save,isActive}) {
      if(known?.name===name&&id(known.id))return known
      const all=await call('/all',cfg,{isActive}),matches=(all?.lists||[]).filter(l=>l.name===name)
      if(matches.length>1)throw Error('有多个同名日记文集，请在B站保留一个后再重试')
      if(matches.length===1){const value={id:id(matches[0].id),name,state:'ready'};if(!value.id)throw Error('文集ID无效');await save(value);return value}
      if(known?.name===name&&known.state==='creating')throw Error('上次建文集的结果不明，远端暂未查到；停止重复创建，请检查创作中心')
      await save({name,state:'creating'})
      let data
      try{data=await call('/add',cfg,{body:{name},isActive})}catch(e){if(e.collectionRejected||e.biliNotSent||e.biliPolicy&&!e.commentRisk)await save({name,state:'retry',error:e.message});throw e}
      const value={name,id:id(data?.id??data?.list_id),state:'ready'}
      if(!value.id)throw Error('文集创建缺少ID，先核对远端再继续')
      await save(value);return value
    },
    async sync(cfg,{collection,entries,isActive}) {
      const pending=entries.filter(e=>e.state==='submitted'&&String(e.collectionId||'')!==collection.id)
      if(!pending.length)return []
      const current=await call('/articles/all?id='+collection.id,cfg,{isActive})
      if(id(current?.list?.id)!==collection.id)throw Error('B站返回的文集ID不符，未修改文章列表')
      const available=await call('/articles/can_add',cfg,{isActive}),existing=current.articles||[],candidates=[...existing,...(available?.articles||[])],resolved=[]
      for(const entry of pending){
        const matches=candidates.filter(a=>String(a.dyn_id_str||'')===entry.id||a.title===entry.title)
        const ids=[...new Set(matches.map(a=>id(a.id)).filter(Boolean))]
        if(ids.length===1)resolved.push({entry,articleId:ids[0]})
      }
      if(!resolved.length)return [] // 未审核通过的文章可能暂时不能加入；下一轮再核对。
      const ids=[...new Set([...existing.map(a=>id(a.id)).filter(Boolean),...resolved.map(r=>r.articleId)])]
      if(ids.length>(current.limit||500))throw Error('日记文集已达到B站容量，未移除任何旧文章')
      if(ids.length!==existing.length)await call('/update',cfg,{body:{list_id:collection.id,ids:ids.join(','),name:current.list.name,image_url:current.list.image_url||'',summary:current.list.summary||'',only_list:'false'},isActive})
      // 写操作结果未知时不认成功；下轮先重读成员，再决定是否需要写。
      return resolved.map(r=>r.entry.day)
    },
  }
}
