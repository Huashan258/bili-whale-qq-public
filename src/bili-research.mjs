import { collect, search, toPromptText } from './collect.mjs'
import { biliPolicy } from './bili-policy.mjs'
import { setTimeout as delay } from 'node:timers/promises'

export const BILI_RESEARCH_MIN = 5
// 资料读取复用30分钟；只缓存成功取得的素材，不把搜索摘要计作已读。
export function createBiliResearch({searchVideos=search,collectVideo=collect,policy=biliPolicy,now=Date.now,sleep=(ms,signal)=>delay(ms,undefined,{signal}),relevant=rows=>rows,budgetMs=90*60000}={}) {
  const cache=new Map()
  return async function research(query,cfg,{isActive=()=>true,signal,onProgress=()=>{},commandRead=false,preferRecent=false}={}) {
    const started=now(),materials=[],candidates=new Map()
    const active=()=>isActive()&&!signal?.aborted&&cfg.chat?.search?.enabled!==false
    const check=()=>{if(!active())throw Error('资料读取已停止');if(now()-started>=budgetMs)throw Error('读取五个视频的等待时间已达90分钟')}
    const progress=extra=>onProgress({source:'bili',requiredVideos:BILI_RESEARCH_MIN,videosRead:materials.length,...extra})
    const wait=async ms=>{
      const until=now()+ms
      while(now()<until){check();progress({waiting:true,nextAt:until});await sleep(Math.min(30000,until-now(),Math.max(1,budgetMs-(now()-started))),signal)}
      check()
    }
    let reason=''
    try {
      // 最多三页60条候选，相关结果足够即停，不轮询轰炸搜索接口。
      for(let page=1;page<=3;page++) {
        check()
        const rows=await searchVideos(cfg,{keyword:query,page,limit:20,isActive:active,commandRead,...(preferRecent?{order:'pubdate'}:{})})
        for(const row of relevant(rows,query))if(/^BV[A-Za-z0-9]{10}$/.test(row.bvid)&&!candidates.has(row.bvid))candidates.set(row.bvid,row)
        progress({candidates:candidates.size,waiting:false})
        if(candidates.size>=8||!rows.length)break
      }
      if(candidates.size<5)reason=`最多三页搜索仅取得${candidates.size}个不同的相关视频，未达到五个，未生成完整评价`
      else for(const row of [...candidates.values()].slice(0,10)) {
        check()
        let material=cache.get(row.bvid)
        if(!(material?.until>now())) {
          // 共用持久账本；普通读取排队，令咒仅豁免本地只读额度。
          for(;;) {
            check()
            const state=await policy.status()
            if(state.cooldownUntil>now())throw Object.assign(Error('B站全局风控冷却中，本次停止读取'),{biliPolicy:true})
            if(!commandRead&&state.nextWatchAt>now())await wait(state.nextWatchAt-now())
            try {
              const value=await collectVideo(row.bvid,cfg,{isActive:active,commandRead})
              if(value?.video?.bvid!==row.bvid||!value.video.title)throw Error('视频素材无效')
              material={value,until:now()+30*60000}
              if(cache.size>=80)cache.delete(cache.keys().next().value)
              cache.set(row.bvid,material)
              break
            }catch(e){
              if(e.biliWatchLimited&&!commandRead){await wait(e.retryAfterMs);continue}
              if(e.biliPolicy||!active())throw e
              reason='部分视频未取得有效素材，已尝试其它相关候选'
              break
            }
          }
        }
        if(!material||!(material.until>now()))continue
        materials.push({bvid:row.bvid,title:material.value.video.title,url:`https://www.bilibili.com/video/${row.bvid}`,description:material.value.video.desc||'',date:material.value.video.pubdate||'',body:toPromptText(material.value,{...cfg.llm,maxCharsSubtitle:4500}),hasSubtitle:Boolean(material.value.subtitle?.lines?.length),readAt:material.value.collectedAt,cached:material.until-30*60000<started})
        progress({waiting:false,candidates:candidates.size})
        if(materials.length>=5)break
      }
    }catch(e){reason=!active()?'资料读取已停止':e.biliPolicy?e.message:'视频素材采集失败或等待到期，未达到五个；未生成完整评价'}
    const complete=materials.length>=5
    return {ok:complete,source:'bili',query,requiredVideos:5,complete,videosRead:materials.length,videos:materials,results:materials.map(({title,url,description,date})=>({title,url,description,date})),reason:complete?'':reason||'未读满五个相关视频，未生成完整评价'}
  }
}
