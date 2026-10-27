(()=>{
  const button=document.querySelector('#mood-refresh'),status=document.querySelector('#mood-status')
  if(!button)return
  const labels={joy:'轻快',calm:'平静',concern:'挂心',sadness:'低落',pride:'得意',irritation:'不快',warmth:'亲切'}
  button.onclick=async()=>{button.disabled=true;try{const r=await fetch('/api/mood'),s=await r.json();if(!r.ok)throw Error('情绪状态暂不可用');const top=Object.entries(s.latest?.dims??{}).sort((a,b)=>b[1]-a[1]).filter(([,v])=>v>=5).slice(0,2).map(([k])=>labels[k]).join('、');status.textContent=!s.enabled?'情绪续接已关闭。':!s.latest?'还没有足够的相处记录。':`最近一轮${top||'平静'}，正在随时间回稳。已接受 ${s.applied??0} 次判断，低可信度 ${s.uncertain??0} 次；这只是内部表达状态，不是对聊天对象的诊断。`}catch(e){status.textContent=e.message}finally{button.disabled=false}}
})()
