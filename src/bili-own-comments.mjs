import { quotaOf,noteComment,noteWrite,waitGap } from './quota.mjs'

// 只用于已核验UP=登录账号的投稿，不把用户根评论伪装成机器人的评论。
export async function runOwnVideoReplies(cfg,state,video,{dry=false,listComments,listReplies,compose,send,save,logger=()=>{},isActive=()=>true}={}) {
  const self=String(cfg.raw?.bili?.dedeUserId??'')
  if(!self||String(video.ownerMid)!==self)throw Error('自己的投稿身份未核验')
  const masters=new Set((cfg.masters??[]).map(m=>String(m.mid)))
  const since=Date.now()/1000-Math.max(1,Number(cfg.share?.replyPatrolWithinDays)||7)*86400
  const roots=await listComments(cfg,{bvid:video.bvid,aid:video.aid,pages:1,ps:20})
  const eligible=f=>String(f.mid)!==self&&String(f.text??'').trim()&&Number(f.ctime)>=since&&!state.replied?.[String(f.rpid)]
  const pending=roots.filter(eligible).sort((a,b)=>Number(masters.has(String(b.mid)))-Number(masters.has(String(a.mid)))||Number(b.ctime)-Number(a.ctime))
  state.ownCommentThreads??={}
  const threads=state.ownCommentThreads[video.bvid]??={}
  let target=pending[0],root=target,floors=[]
  if(!target) {
    const keys=Object.keys(threads)
    if(!keys.length)return {sent:0,why:`${video.bvid} 读到${roots.length}条一级评论，无新的待回复留言`}
    state.ownCommentCursor??={}
    const cursor=Number(state.ownCommentCursor[video.bvid]??0)%keys.length
    const rootMap=new Map(roots.map(r=>[String(r.rpid),r]))
    // 一级评论已经带回复总数。优先读取新增回复的楼，不能盲目轮换让新留言等半小时。
    // 每轮仍只读取一栋楼，不增加B站请求量。
    const changed=keys.map(key=>({key,increase:Number(rootMap.get(key)?.count??0)-Number(threads[key].checkedReplyCount??0)}))
      .filter(x=>x.increase>0).sort((a,b)=>b.increase-a.increase)
    const key=changed[0]?.key??keys[cursor]
    root=rootMap.get(key)??threads[key]
    if(!dry){state.ownCommentCursor[video.bvid]=(keys.indexOf(key)+1)%keys.length;save(state)}
    floors=await listReplies(cfg,{bvid:video.bvid,aid:video.aid,root:root.rpid,pages:1,ps:20})
    // 读取成功即可记录检查数量，不能等到发出了回复才记录，否则会一直读同一栋空楼。
    if(!dry){threads[key]={...threads[key],checkedReplyCount:Number(root.count??threads[key].checkedReplyCount??0),checkedAt:Date.now()};save(state)}
    target=floors.filter(eligible).sort((a,b)=>Number(masters.has(String(b.mid)))-Number(masters.has(String(a.mid)))||Number(a.ctime)-Number(b.ctime))[0]
  }
  if(!target)return {sent:0,why:`${video.bvid} 未发现新的待回复楼层`}
  const q=quotaOf(cfg,state,self,'reply',{master:masters.has(String(target.mid))})
  if(!q.ok)return {sent:0,why:q.why}
  const relevant=floors.filter(f=>Number(f.ctime)<=Number(target.ctime)).slice(-12)
  const line=f=>`${String(f.mid)===self?'我':masters.has(String(f.mid))?'【主人】'+(f.uname||f.mid):f.uname||f.mid}：${String(f.text).slice(0,300)}`
  const dialogue={text:`视频：《${video.title||video.bvid}》\n这是我自己投稿下的留言。\n${[root,...relevant].map(line).join('\n')}`}
  const text=await compose(cfg,{dialogue,target,master:(cfg.masters??[]).find(m=>String(m.mid)===String(target.mid)),ownVideo:true,isActive})
  if(!text)return {sent:0,why:'自己的投稿评论未生成可用回复'}
  if(dry)return {sent:0,planned:[`${video.bvid} 准备回复rpid=${target.rpid}`],why:'预演：自己的投稿一级评论/楼中楼可回复'}
  if(!isActive())return {sent:0,why:'运行已停止'}
  await waitGap(cfg,state)
  if(!isActive())return {sent:0,why:'运行已停止'}
  const result=await send(cfg,{bvid:video.bvid,aid:video.aid,text,root:String(root.rpid),parent:String(target.rpid),isActive})
  state.replied??={}
  state.replied[String(target.rpid)]={at:new Date().toISOString(),rpid:result.rpid,bvid:video.bvid,root:String(root.rpid),mid:String(target.mid),patrol:true,ownVideo:true}
  threads[String(root.rpid)]={...threads[String(root.rpid)],rpid:String(root.rpid),mid:String(root.mid),uname:root.uname??'',text:String(root.text),ctime:root.ctime}
  noteComment(cfg,state,self,'reply');noteWrite(state);save(state)
  logger(`  自己的投稿接话 ${video.bvid} parent=${target.rpid} rpid=${result.rpid}`)
  return {sent:1,why:'已回复自己投稿下的留言'}
}
// Bilibili conversation integration: shared gentle policy and persistent reply tracking.
