import {localVoiceOnline,startLocalVoice} from './local-voice-host.mjs'
import {trainingPaused} from './voice-studio-config.mjs'

// Runs when DSH starts, without waiting for the first speech request.
export function createLocalVoiceWatchdog({config,check=localVoiceOnline,ensure=startLocalVoice,logger=()=>{},intervalMs=30000,retryMs=60000,now=Date.now,isTraining=trainingPaused}={}){
  let stopped=false,timer,pending,nextRetry=0
  let state={phase:'idle',lastReadyAt:null,nextRetryAt:null}
  const tick=()=>{
    if(stopped)return Promise.resolve({...state})
    if(pending)return pending
    pending=(async()=>{
      const cfg=config(),v=cfg.chat?.voice??{}
      if(isTraining()){state={...state,phase:'training-paused',nextRetryAt:null};return state}
      if(v.provider!=='gpt-sovits'||v.localAutoStart!==true){state={...state,phase:'disabled',nextRetryAt:null};return state}
      try{
        if(await check(cfg)){
          if(stopped)return state
          if(state.phase!=='ready')logger('本地语音：GPT-SoVITS API已就绪')
          nextRetry=0;state={phase:'ready',lastReadyAt:new Date(now()).toISOString(),nextRetryAt:null};return state
        }
        if(stopped)return state
        if(now()<nextRetry){state={...state,phase:'loading'};return state}
        nextRetry=now()+retryMs
        state={...state,phase:'starting',nextRetryAt:new Date(nextRetry).toISOString()}
        const result=await ensure(cfg)
        if(stopped)return state
        state={...state,phase:result.state==='online'?'ready':'loading'}
        logger(result.state==='online'?'本地语音：复用已有API':'本地语音：已自动启动API，正在加载银狼模型')
      }catch{if(!stopped){nextRetry=now()+retryMs;state={...state,phase:'unavailable',nextRetryAt:new Date(nextRetry).toISOString()};logger('本地语音：启动或检测失败，稍后重试；请检查本地API日志')}}
      return state
    })().finally(()=>{pending=null})
    return pending
  }
  return {
    start(){if(stopped)return;if(!timer){timer=setInterval(()=>{tick().catch(()=>{})},intervalMs);timer.unref?.()}return tick()},
    checkNow:tick,status:()=>({...state}),stop(){stopped=true;if(timer)clearInterval(timer);timer=null},
  }
}
