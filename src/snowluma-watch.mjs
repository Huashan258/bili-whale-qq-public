// 只恢复 QQ 桥接服务；不发消息，也不停止其他模块共享的 SnowLuma。
export function createSnowLumaWatchdog({check,ensure,logger=()=>{},intervalMs=15000,retryMs=60000,now=Date.now} = {}) {
  let timer=null,pending=null,stopped=false,misses=0,nextRetry=0
  let state={phase:'checking',lastReadyAt:null,lastError:'',nextRetryAt:null}
  const log=message=>{try{logger(message)}catch{}}
  function tick() {
    if(stopped)return Promise.resolve(state)
    if(pending)return pending
    pending=(async()=>{
      try {
        if(await check()) {
          if(stopped)return state
          if(state.phase!=='ready')log('QQ 通道：SnowLuma / OneBot HTTP / WebSocket 已就绪')
          misses=0;state={phase:'ready',lastReadyAt:new Date(now()).toISOString(),lastError:'',nextRetryAt:null}
          return state
        }
        if(stopped)return state
        misses++
        const wasReady=Boolean(state.lastReadyAt)
        state={...state,phase:'disconnected'}
        // 启动时立即自举；运行中的单次短暂断线等下一跳确认，避免无谓重启。
        if((wasReady && misses<2) || now()<nextRetry)return state
        nextRetry=now()+retryMs
        state={...state,phase:'starting',nextRetryAt:new Date(nextRetry).toISOString()}
        log('QQ 通道：检测到 SnowLuma 或 OneBot 不可用，正在自动恢复')
        const result=await ensure()
        if(stopped)return state
        if(result.ok && await check()) {
          misses=0;state={phase:'ready',lastReadyAt:new Date(now()).toISOString(),lastError:'',nextRetryAt:null}
          log(`QQ 通道：SnowLuma 已自动恢复（${result.reason || 'ready'}）`)
        } else {
          state={...state,phase:'unavailable',lastError:result.reason || 'OneBot HTTP / WebSocket 尚未就绪'}
          log(`QQ 通道：${state.lastError}；稍后自动重试`)
        }
      } catch(e) {
        if(!stopped){nextRetry=now()+retryMs;state={...state,phase:'unavailable',lastError:e.message,nextRetryAt:new Date(nextRetry).toISOString()};log(`QQ 通道恢复失败：${e.message}；稍后自动重试`)}
      }
      return state
    })().finally(()=>{pending=null})
    return pending
  }
  return {
    start(){if(stopped)return;if(!timer){timer=setInterval(()=>{tick().catch(()=>{})},intervalMs);timer.unref?.()}return tick()},
    checkNow:tick,
    status:()=>({...state}),
    stop(){stopped=true;if(timer)clearInterval(timer);timer=null},
  }
}
