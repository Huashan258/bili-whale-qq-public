import { BILI_LIMITS } from './bili-policy.mjs'

// 只汇总本机状态；不访问 B站，不回传配置凭据或人设正文。
export function buildOverview({cfg,state={},policy={},dsh=null,agent={},heartbeat=null,activity=[],now=Date.now(),hourlyScroll=null}={}) {
  const recent=key=>(policy[key]??[]).filter(item=>Number(item.at)>now-3600000)
  const watching=recent('watch'), sharing=recent('share'), requests=recent('requests')
  const running=Boolean(dsh?.status?.running || agent.running)
  const chat=dsh?.status?.chat ?? agent.chat ?? null
  const globalUntil=Number(policy.cooldownUntil)||0
  const commentUntil=Number(state.commentPatrolCooldown?.until)||0
  const issues=[]
  if(!running)issues.push({tone:'warn',title:'机器人尚未运行',detail:'启动 DSH 后会自动跟随；也可以在群聊页查看独立运行状态。',view:'chat'})
  if(running && chat?.connected===false)issues.push({tone:'warn',title:'QQ 通道正在恢复',detail:'检查 SnowLuma 的登录状态，连接恢复后继续处理消息。',view:'chat'})
  if(!cfg.cookie?.sessdata || !cfg.cookie?.bili_jct)issues.push({tone:'warn',title:'B站凭据未配置完整',detail:'前往设置扫码登录，凭据只保存在本机。',view:'settings'})
  if(!cfg.llm?.apiKey)issues.push({tone:'warn',title:'写作模型尚未配置',detail:'在完整设置中填写模型与凭据。',view:'settings'})
  if(globalUntil>now)issues.unshift({tone:'warn',title:'B站正在冷却',detail:'所有 B站访问已暂停，到期后才会重新尝试；QQ 聊天不受影响。',view:'settings'})
  return {
    now, runtime:{running,source:dsh?'dsh':agent.running?'agent':'offline',pid:dsh?.pid??(agent.running?agent.pid:null),qqConnected:typeof chat?.connected==='boolean'?chat.connected:null,heartbeat:heartbeat?.heartbeat??null,dry:dsh?.status?.dry??false},
    automation:{scrollEnabled:Boolean(cfg.scroll?.enabled),patrolMinutes:Math.max(5,Number(cfg.share?.replyPatrolMinutes)||5),patrolEnabled:Number(cfg.share?.replyPatrolMinutes)>0,deliveryMode:cfg.scroll?.deliveryMode??'private',syncGroups:cfg.scroll?.syncGroups!==false,hourlyReactionEnabled:cfg.scroll?.hourlyReactionEnabled===true,reactionKeywords:cfg.scroll?.reactionKeywords??['?','？','妈妈'],hourlyScroll,biliPrivatePushEnabled:cfg.scroll?.biliPrivateEnabled===true},
    limits:BILI_LIMITS,
    usage:{videos:watching.length,shares:sharing.length,requests:requests.length,trackedVideos:Object.keys(state.commented??{}).length,repliedFloors:Object.keys(state.replied??{}).length},
    cooldown:{globalUntil:globalUntil>now?globalUntil:0,commentUntil:commentUntil>now?commentUntil:0,nextWatchAt:Number.isFinite(policy.nextWatchAt)?Math.max(now,policy.nextWatchAt):now,nextShareAt:Number.isFinite(policy.nextShareAt)?Math.max(now,policy.nextShareAt):now},
    patrol:dsh?.status?.patrol??null,
    issues,activity:activity.slice(-8).reverse(),
  }
}
