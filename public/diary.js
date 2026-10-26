(() => {
  const $=s=>document.querySelector(s),button=$('#diary-generate'),message=$('#diary-status'),download=$('#diary-download'),progress=$('#diary-progress')
  let busy=false,polling=false,creating=false,epoch=0,notice=''
  async function request(method='GET') {
    const response=await fetch('/api/diary',{method})
    const result=await response.json()
    if(!response.ok)throw Error(result.error||'读取日记任务失败')
    const publishing=document.querySelector('#diary-publish-status'),list=document.querySelector('#diary-publish-list')
    const collectionLink=document.querySelector('#diary-collection-link'),collection=result.publishing?.collection
    if(collectionLink){collectionLink.hidden=!/^\d+$/.test(collection?.id||'');if(!collectionLink.hidden){collectionLink.href='https://www.bilibili.com/read/readlist/rl'+collection.id;collectionLink.textContent='日记文集：'+collection.name}}
    if(publishing&&result.publishing){const p=result.publishing;publishing.textContent=p.enabled?`B站专栏自动投稿已开启${p.active?'':'（等待正式后台运行）'} · 每天发布完整日记，历史日记每隔${p.gapMinutes}分钟补发${p.error?' · '+p.error:''}`:'B站专栏自动投稿已关闭，可在「完整设置 → 记忆与长文」开启。';if(list){list.replaceChildren();for(const item of p.items||[]){const li=document.createElement('li');li.textContent=`${item.day} · ${item.title} · ${{submitted:'已提交，审核结果以B站为准',pending:'投稿回执待核对，不自动重发',unknown:'投稿结果不明，请在创作中心核对',retry:'等待重试',preparing:'准备投稿'}[item.state]||'排队中'}`+(item.error?' · '+item.error:'');if(item.url&&/^https:\/\/www\.bilibili\.com\/opus\/\d+$/.test(item.url)){const a=document.createElement('a');a.href=item.url;a.textContent=' 查看文章';a.target='_blank';a.rel='noopener noreferrer';li.append(a)}list.append(li)}}}
    const auto=document.querySelector('#diary-auto-status')
    if(auto&&result.automation){const a=result.automation;auto.textContent=a.enabled?`自动日记已开启${a.active?'':'（等待正式后台运行）'} · 启动补写 / 北京时间跨日归档${a.pending?.length?' · 待补写 '+a.pending.join('、'):''}${a.nextRetryAt?' · 下次重试 '+new Date(a.nextRetryAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):''}${a.error?' · '+a.error:''}`:'自动日记已关闭；仍可手动生成。可在「记忆与长文」更改。'}
    return result.job
  }
  function render(job) {
    busy=job.status==='running'
    button.disabled=busy;button.textContent=busy?'正在写日记…':'✎ 生成今日日记'
    progress.hidden=!busy
    download.hidden=job.status!=='done'
    if(busy)message.textContent=`${job.day} · ${job.automatic?'自动补写 · ':''}${job.phase}${job.chars?` · 正文已有 ${job.chars} 汉字`:''}。可继续使用其它页面。`
    else if(job.status==='done') {
      message.textContent=`已保存：${job.path} · 正文 ${job.chars} 汉字 · 群消息 ${job.counts?.qqIn??0} 条、回复 ${job.counts?.qqOut??0} 条、B站记录 ${job.counts?.bili??0} 条 · 模型累计用量 ${job.tokens??0} token。`
      download.href='/api/diary/download?file='+encodeURIComponent(job.filename);download.download=job.filename
    }else if(job.status==='failed')message.textContent=`生成未完成：${job.error||'任务中断，请重试'}`
    else message.textContent=notice||'准备好了。点击后在后台整理当天记录并写作，以文言文抒怀，可引古籍句段，省略事件与视频链接，每篇标题与正文合计不超过3000字（含标点），不设最低字数。'
  }
  async function refresh() {
    if(polling||creating)return
    const version=epoch
    polling=true
    try{const job=await request();if(version===epoch)render(job)}catch{if(version===epoch)message.textContent='暂时无法读取日记任务，恢复连接后会继续显示进度。'}finally{polling=false}
  }
  button.onclick=async()=>{
    if(busy||creating)return
    creating=true;epoch++
    notice='';busy=true;button.disabled=true;download.hidden=true;message.textContent='正在创建今日日记任务…'
    try{render(await request('POST'))}catch(e){busy=false;button.disabled=false;notice=e.message;message.textContent=e.message}finally{creating=false}
  }
  setInterval(()=>{if(busy||!document.hidden&&!$('#view-overview').hidden)refresh()},3000)
  refresh()
})()
