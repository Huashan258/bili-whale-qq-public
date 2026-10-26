import { fields, sections } from './settings-schema.js'
const $ = s => document.querySelector(s)
const root = $('#view-settings')
let loaded, dirty = new Map(), category = 'chat', query = '', busy = false, dirtyOnly = false
const inputs = new Map()
const json = v => JSON.stringify(v)
async function request(body) {
  const r = await fetch('/api/settings', body ? { method:'POST',headers:{'content-type':'application/json'},body:json(body) } : {})
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || '请求失败')
  return data
}
function status(text, error = false) {
  $('#settings-message').textContent = text
  $('#settings-message').classList.toggle('error', error)
}
function updateDirty() {
  $('#settings-count').textContent = dirty.size ? `${dirty.size} 项未保存` : '与已读取配置一致'
  $('#settings-save').disabled = !loaded || !dirty.size || busy
  for(const card of root.querySelectorAll('[data-setting]'))card.classList.toggle('is-dirty',dirty.has(card.dataset.setting))
  if(dirtyOnly)filter()
}
function parse(f, input) {
  if (f.type === 'boolean') return input.checked
  if (f.type === 'number') {
    if (input.value.trim() === '' || !input.checkValidity()) throw new Error(`${f.label}：请填写 ${f.min}–${f.max} 之间的数值`)
    return Number(input.value)
  }
  if (f.type === 'masters') return JSON.parse(input.value || '[]')
  if (['list','hours'].includes(f.type)) {
    const arr = input.value.split(/[\n,，]+/).map(x=>x.trim()).filter(Boolean)
    return f.type === 'hours' ? arr.map(Number) : arr
  }
  return input.value
}
function fill(data) {
  loaded = data; dirty.clear()
  for (const f of fields) {
    const input = inputs.get(f.path), v = data.values[f.path]
    input.setCustomValidity('')
    if (f.type === 'boolean') input.checked = Boolean(v)
    else input.value = f.type === 'secret' ? '' : f.type === 'masters' ? JSON.stringify(v,null,2) : Array.isArray(v) ? v.join(f.type === 'hours' ? ', ' : '\n') : v ?? ''
    if (f.type === 'secret') input.placeholder = data.secrets[f.path] ? '已配置 · 留空保留' : '未配置'
  }
  const rt = data.runtime
  const age = rt ? Date.now() - Number(rt.heartbeat) : Infinity
  $('#settings-runtime').textContent = data.source?.kind === 'dsh' ? `正在跟随 DSH · PID ${data.source.pid} · ${data.source.url} · 每 5 秒读取生效设置` : rt?.running && age >= 0 && age < 90000 ? `DSH 运行中 · PID ${rt.pid ?? '未知'} · ${rt.dry ? '预演' : '实发'} · 心跳 ${Math.round(age/1000)} 秒前（当前读取共享配置文件）` : 'DSH 未运行或心跳已过期；独立 Agent 状态可在「群聊」查看。'
  $('#settings-file').textContent = data.configFile
  $('#settings-preview').hidden = true
  updateDirty()
}
async function reload() {
  if (dirty.size && !window.confirm('重新读取将放弃当前未保存的修改，继续吗？')) return
  try { status('正在读取…'); fill(await request()); status('已读取。内容参数约 2 秒热更新；DSH 调度参数约 30 秒，连接与启动记忆参数需重启。') }
  catch(e) { status(e.message,true) }
}
function filter() {
  for (const card of root.querySelectorAll('[data-setting]')) {
    const f = fields.find(f=>f.path === card.dataset.setting)
    card.hidden = (dirtyOnly && !dirty.has(f.path)) || (query ? !`${f.label} ${f.path} ${f.hint}`.toLowerCase().includes(query) : !dirtyOnly && f.section !== category)
  }
  root.querySelectorAll('[data-category]').forEach(btn => btn.classList.toggle('active', !query && btn.dataset.category === category))
  const shown = [...root.querySelectorAll('[data-setting]')].filter(el=>!el.hidden).length
  $('#settings-empty').hidden = shown > 0
  $('#settings-section-title').textContent = dirtyOnly ? `未保存修改 · ${shown} 项` : query ? `搜索结果 · ${shown} 项` : `${sections[category]} · ${shown} 项`
}
for (const [key,label] of Object.entries(sections)) {
  const btn = document.createElement('button'); btn.type='button'; btn.textContent=label; btn.dataset.category=key
  btn.onclick=()=>{ category=key; query=''; $('#settings-search').value=''; filter() }
  $('#settings-categories').append(btn)
}
for (const f of fields) {
  const card = document.createElement('div'); card.className='setting-card'; card.dataset.setting=f.path
  const label = document.createElement('label'), id = `setting-${f.path.replaceAll('.','-')}`
  label.htmlFor=id; label.textContent=f.label
  const code = document.createElement('code'); code.textContent=f.path
  const input = document.createElement(f.type === 'select' ? 'select' : ['long','list','masters','hours'].includes(f.type) ? 'textarea' : 'input')
  if (f.type === 'select') for (const option of f.options) {
    const el=document.createElement('option'); el.value=option.value; el.textContent=option.label; input.append(el)
  }
  input.readOnly=Boolean(f.readOnly)
  input.id=id; input.autocomplete='off'; input.spellcheck=false
  if (input.tagName==='INPUT') input.type = f.type === 'boolean' ? 'checkbox' : f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'
  if (f.type === 'number') { input.min=f.min; input.max=f.max; input.step=/temperature|speakChance|Minutes/i.test(f.path)?'any':'1' }
  if (input.tagName==='TEXTAREA') input.rows = f.type === 'long' || f.type === 'masters' ? 8 : 3
  const hint = document.createElement('small'); hint.textContent=f.hint || (f.type === 'number' ? `允许范围 ${f.min}–${f.max}` : f.type === 'list' ? '每行一项或逗号分隔；清空可移除全部。' : '')
  input.addEventListener('input',()=>{
    if (!loaded) return
    input.setCustomValidity('')
    try {
      const v=parse(f,input)
      if(f.path==='chat.shield.maxOutputTokens')inputs.get('chat.shield.adminMaxOutputTokens').value=v*3
      if ((f.type==='secret'&&!v.trim()) || json(v)===json(loaded.values[f.path])) dirty.delete(f.path)
      else dirty.set(f.path,v)
    } catch(e) { dirty.set(f.path,undefined); status(`${f.label}：${e.message}`,true) }
    $('#settings-preview').hidden=true; updateDirty()
  })
  card.append(label,code,input,hint); $('#settings-fields').append(card); inputs.set(f.path,input)
}
$('#settings-dirty-only').onclick=()=>{dirtyOnly=!dirtyOnly;$('#settings-dirty-only').setAttribute('aria-pressed',String(dirtyOnly));filter()}
$('#settings-search').oninput=e=>{ query=e.target.value.toLowerCase().trim(); filter() }
$('#settings-reload').onclick=reload
$('#settings-bili-check').onclick=async()=>{
  const panel=$('#settings-bili-diagnostics'); panel.hidden=false; panel.textContent='正在读取本机记录…'
  try {
    const r=await fetch('/api/bili/diagnostics'), d=await r.json()
    if(!r.ok) throw new Error(d.error || '读取失败')
    const hourly=d.hourlyReactionEnabled?`小时选词比较：${d.hourlyScroll?.read??0}/10 · 状态 ${d.hourlyScroll?.status??'等待开始'}\n当前选词：${(d.reactionKeywords??[]).join(' / ')}\n${(d.hourlyScroll?.items??[]).map(v=>`${v.title} · ${v.score}次 · ${JSON.stringify(v.counts?.byKeyword??{})}${v.complete?'':'（统计不完整）'}`).join('\n')}\n已选：${d.hourlyScroll?.winner??'尚未选定'}\n投递状态：${(d.hourlyScroll?.deliveries??[]).map(t=>`${t.kind==='bili-private'?'B站私信':'QQ群'} ${t.id} ${t.status}`).join(' / ')||'尚未进入投递'}\n\n`:''
    const research=`检索优先站：${(d.research?.priorityWikis??[]).join(' / ')}\n交叉查证：${d.research?.crossCheck?'开':'关'} · 引擎 ${(d.research?.engines??[]).join(' / ')} · YouTube ${d.research?.youtube?'开':'关'} · 回答不贴网址\n\n`
    panel.textContent=hourly+research+`DSH：${d.dshRunning?'运行中':'未运行'} · B站凭据：${d.hasCookie?'已配置':'缺失'}\n分享方式：${d.deliveryMode==='comment'?'评论区 @':'QQ 私聊'} · 同步群聊：${d.syncGroups?'开启':'关闭'}\n私聊接收 QQ：${(d.privateUsers ?? []).join(' / ')}\n同步群号：${(d.syncGroupIds ?? []).join(' / ')}\n题材：${d.topics.join(' / ') || '未设置'}\nB站视频私信推送：${d.biliPrivatePushEnabled?'开启':'关闭'} · 接收UID ${(d.biliPrivatePushUsers??[]).join(' / ')}\nB站私信收件回复：${d.conversations?.privateEnabled?'开启':'关闭'} · 联系UID：${(d.conversations?.privateUsers??[]).join(' / ')} · 已回复 ${d.conversations?.privateSent??0} 条 · 待核对 ${d.conversations?.privateUncertain??0} 条\n自己的投稿接话：${d.conversations?.ownVideoReplies?'开启':'关闭'} · 优先视频：${(d.conversations?.focusVideos??[]).join(' / ')}\n已纳入巡检：${d.trackedVideos} 条视频 · 已回复：${d.repliedFloors} 个楼层\n最近一轮：${JSON.stringify(d.lastRun)}\n\n${d.report}\n\n最近任务日志：\n${d.log || '暂无任务日志'}`
  } catch(e) {panel.textContent=e.message}
}
$('#settings-review').onclick=()=>{
  const preview=$('#settings-preview'); preview.replaceChildren(); preview.hidden=false
  for (const [key,v] of dirty) {
    const f=fields.find(f=>f.path===key), row=document.createElement('p')
    row.textContent=f.type==='secret' ? `${f.label}：替换凭据（不显示内容）` : `${f.label}：${json(loaded.values[key])} → ${v===undefined?'格式错误':json(v)}`
    preview.append(row)
  }
  if (!dirty.size) preview.textContent='暂无修改'
}
$('#settings-save').onclick=async()=>{
  if (!dirty.size || busy) return
  const patch={}
  try { for (const key of dirty.keys()) patch[key]=parse(fields.find(f=>f.path===key),inputs.get(key)) }
  catch(e) { status(e.message,true); return }
  busy=true; updateDirty(); status('正在保存…')
  $('#settings-reload').disabled=true
  // 请求期间锁住输入，避免回执覆盖用户在途编辑。
  for (const input of inputs.values()) input.disabled=true
  try { const data=await request({patch,revision:loaded.revision}); fill(data); status(`已保存 ${data.changed} 项，已备份原配置并同步 DSH 覆盖层。内容参数约 2 秒生效；调度约 30 秒；连接与启动记忆参数需重启。`) }
  catch(e) { status(e.message,true) }
  finally { busy=false; $('#settings-reload').disabled=false; for(const input of inputs.values()) input.disabled=false; updateDirty() }
}
$('#settings-export').onclick=()=>{
  if (!loaded) return
  const blob=new Blob([JSON.stringify({ values:loaded.values },null,2)],{type:'application/json'})
  const url=URL.createObjectURL(blob), link=document.createElement('a'); link.href=url; link.download='whale-settings-no-secrets.json'; link.click(); URL.revokeObjectURL(url)
  status('已导出读取时的非凭据配置；未保存修改不包含在内。')
}
window.addEventListener('beforeunload',e=>{ if(dirty.size){ e.preventDefault(); e.returnValue='' } })
document.addEventListener('settings:open',()=>{ if(!loaded) reload() })
filter(); updateDirty()
if (!root.hidden) reload()
let polling=false
setInterval(async()=>{
  if (root.hidden || document.hidden || busy || polling || !loaded || document.activeElement?.closest('#settings-fields')) return
  polling=true
  try {
    const data=await request()
    if (dirty.size) {
      if (data.revision!==loaded.revision) status('DSH 或其他进程更新了配置；当前编辑已保留，请先核对再重新读取。',true)
    } else fill(data)
  } catch { /* 暂时断线不清除当前表单 */ }
  finally { polling=false }
},5000)
