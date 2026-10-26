const $=selector=>document.querySelector(selector)
const root=$('#view-overview')
let snapshot=null,receivedAt=0,loading=false,saving=false,generation=0
const navigate=view=>document.dispatchEvent(new CustomEvent('navigate:view',{detail:{view}}))
document.querySelectorAll('[data-go]').forEach(button=>button.addEventListener('click',()=>navigate(button.dataset.go)))
function theme(value) {
  document.documentElement.dataset.theme=value
  $('#theme-toggle').setAttribute('aria-label',value==='dark'?'切换浅色主题':'切换深色主题')
  try {localStorage.setItem('whale-theme',value)}catch{}
}
try {theme(localStorage.getItem('whale-theme')||'light')}catch{theme('light')}
$('#theme-toggle').onclick=()=>theme(document.documentElement.dataset.theme==='dark'?'light':'dark')
const set=(id,text)=>{$('#'+id).textContent=text}
function currentTime(){return snapshot?snapshot.now+Date.now()-receivedAt:Date.now()}
function remaining(until) {
  const seconds=Math.ceil((Number(until)-currentTime())/1000)
  if(seconds<=0)return '可以继续'
  if(seconds<60)return `${seconds} 秒后可继续`
  return `${Math.floor(seconds/60)} 分 ${String(seconds%60).padStart(2,'0')} 秒后可继续`
}
function countdowns() {
  if(!snapshot)return
  const c=snapshot.cooldown
  set('watch-next',c.globalUntil>currentTime()?'全局冷却中':remaining(c.nextWatchAt))
  set('share-next',c.globalUntil>currentTime()?'全局冷却中':remaining(c.nextShareAt))
  const until=Math.max(c.globalUntil,c.commentUntil)
  $('#overview-cooldown').hidden=until<=currentTime()
  set('overview-cooldown',`${c.globalUntil>currentTime()?'B站访问已暂停':'评论巡检冷却中'} · ${remaining(until)}。到期后会自动重新检查。`)
}
function render(data) {
  snapshot=data;receivedAt=Date.now()
  const r=data.runtime,a=data.automation
  set('overview-runtime',r.running?(r.source==='dsh'?'跟随 DSH':'独立运行'):'等待启动')
  set('overview-source',r.running?`进程 ${r.pid??'—'} · ${r.dry?'预演模式':'正常运行'}`:'打开 DSH 后自动接续')
  set('overview-qq',r.qqConnected===true?'已连接':r.qqConnected===false?'恢复连接中':r.running?'等待连接状态':'尚未运行')
  set('overview-qq-detail',r.qqConnected===true?'SnowLuma 通道已就绪':'在群聊页查看连接详情')
  $('#overview-runtime').dataset.tone=r.running?'good':'muted'
  $('#overview-qq').dataset.tone=r.qqConnected===true?'good':'muted'
  set('overview-watches',data.usage.videos);set('overview-shares',data.usage.shares)
  $('#watch-progress').value=data.usage.videos;$('#share-progress').value=data.usage.shares
  set('overview-tracked',data.usage.trackedVideos);set('overview-replied',data.usage.repliedFloors);set('overview-requests',data.usage.requests)
  set('overview-mode',r.dry?'预演中':'持久化限额')
  set('overview-delivery',a.hourlyReactionEnabled?`小时比较：已读 ${a.hourlyScroll?.read??0}/10 · 读满后分享 1 个视频${a.biliPrivatePushEnabled?' · 同步B站私信':''} · 选词 ${(a.reactionKeywords??[]).join(' / ')}${a.hourlyScroll?.winner?' · 本轮已选 '+a.hourlyScroll.winner:''}`:`${a.deliveryMode==='comment'?'评论区 @':'QQ 私聊'}${a.syncGroups?' · 同步群聊':''} · 每小时最多 1 个`)
  const toggle=$('#overview-scroll-toggle');toggle.disabled=saving;toggle.textContent=a.scrollEnabled?'暂停刷站':'开启刷站';toggle.classList.toggle('is-enabled',a.scrollEnabled);toggle.setAttribute('aria-pressed',String(a.scrollEnabled))
  set('overview-patrol',a.patrolEnabled?`每 ${a.patrolMinutes} 分钟分批巡检 · 每条只读一页`:'巡检已关闭 · 可在设置中恢复')
  const issues=$('#overview-issues');issues.replaceChildren()
  const list=data.issues.length?data.issues:[{title:'一切都安排好了',detail:'温和限额始终生效，按当前设置继续工作。',tone:'good',view:'settings'}]
  for(const issue of list){const button=document.createElement('button');button.className='issue-row';button.dataset.tone=issue.tone;const title=document.createElement('strong'),description=document.createElement('span');title.textContent=issue.title;description.textContent=issue.detail;button.append(title,description);button.onclick=()=>navigate(issue.view);issues.append(button)}
  const activity=$('#overview-activity');activity.replaceChildren()
  for(const line of data.activity.length?data.activity:['还没有新的动态，启动后会在这里留下记录。']){const li=document.createElement('li');const match=line.match(/^(\S+)\s+(.*)$/);if(match&&!Number.isNaN(Date.parse(match[1]))){const time=document.createElement('time');time.dateTime=match[1];time.textContent=new Date(match[1]).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});const text=document.createElement('span');text.textContent=match[2];li.append(time,text)}else li.textContent=line;activity.append(li)}
  set('overview-updated',`更新于 ${new Date(data.now).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}`)
  // 顶栏同步真实运行状态，不主动请求 B站或反复探测 QQ。
  if(r.qqConnected!==null){set('qq-state',r.qqConnected?'QQ 已连接':'QQ 恢复中');$('#qq-dot').className='dot '+(r.qqConnected?'on':'off')}
  countdowns()
}
async function refresh() {
  if(loading||root.hidden||document.hidden)return
  const readGeneration=generation
  loading=true;$('#overview-refresh').disabled=true
  try {const r=await fetch('/api/overview',{cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'读取失败');if(readGeneration!==generation)return;render(data);$('#overview-error').hidden=true}
  catch(e){set('overview-error',`暂时无法更新：${e.message}。${snapshot?'正在保留上次读取的状态。':'请确认本地 WebUI 服务已启动。'}`);$('#overview-error').hidden=false}
  finally{loading=false;$('#overview-refresh').disabled=false}
}
$('#overview-refresh').onclick=refresh
$('#overview-scroll-toggle').onclick=async()=>{
  if(!snapshot||saving)return
  saving=true;$('#overview-scroll-toggle').disabled=true
  try {const r=await fetch('/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({revision:snapshot.revision,patch:{'scroll.enabled':!snapshot.automation.scrollEnabled}})});const d=await r.json();if(!r.ok)throw Error(d.error||'保存失败');generation++;render({...snapshot,now:currentTime(),revision:d.revision,automation:{...snapshot.automation,scrollEnabled:Boolean(d.values['scroll.enabled'])}});await refresh()}
  catch(e){set('overview-error',e.message);$('#overview-error').hidden=false}
  finally{saving=false;$('#overview-scroll-toggle').disabled=false}
}
document.addEventListener('view:changed',()=>{if(!root.hidden)refresh()})
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()})
setInterval(()=>{if(!root.hidden)countdowns()},1000)
setInterval(refresh,15000)
refresh()
