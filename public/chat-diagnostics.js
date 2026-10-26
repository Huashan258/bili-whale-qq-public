(() => {
  const $=s=>document.querySelector(s)
  const labels={queued:'排队中',processing:'处理中',voice:'合成语音中',search:'联网检索中',model:'等待模型',sending:'发送中','rate-wait':'等待分钟额度',replied:'已回复',skipped:'已跳过',failed:'失败'}
  const failures={empty:'空输出','empty-reply':'空回复','legacy-json':'JSON回复为空','malformed-json':'结构损坏',html:'返回网页','retry-failed':'补试失败',timeout:'模型超时','model-error':'模型调用失败',repetition:'异常重复','broken-sentences':'长串无断句','length-rejected':'补试后仍未满足字数','search-source-fallback':'已交付真实检索来源'}
  let snapshot=null
  const seconds=ms=>Number.isFinite(ms)?(ms/1000).toFixed(1)+'s':'—'
  function render(data) {
    snapshot=data
    const d=data.diagnostics,c=d?.counts
    $('#chat-diagnostics-summary').textContent=c?`收 ${c.received} · 回 ${c.replied} · 待处理 ${d.pending} · 本地回执 ${c.fallback} · 失败 ${c.failed} · P95 ${seconds(d.p95Ms)}`:'等待新版运行状态，以下为本机历史记录'
    const connection=data.connection
    $('#chat-connection-detail').textContent=connection?.nextReconnectAt?`QQ 重连尝试 ${connection.reconnectAttempts} 次，下次 ${new Date(connection.nextReconnectAt).toLocaleTimeString('zh-CN')}`:data.connected?'QQ 已连接':''
    const records=new Map((data.traces??[]).map(r=>[r.traceId,r]))
    for(const r of d?.recent??[])records.set(r.traceId,r)
    const mode=$('#chat-trace-filter').value
    const rows=[...records.values()].sort((a,b)=>b.receivedAt-a.receivedAt).filter(r=>mode==='all'||mode==='pending'&&!['replied','skipped','failed'].includes(r.stage)||mode==='failed'&&['failed','skipped'].includes(r.stage)||mode==='fallback'&&r.fallback).slice(0,60)
    const body=$('#chat-traces');body.replaceChildren()
    for(const r of rows) {
      const tr=document.createElement('tr');tr.dataset.stage=r.stage
      const voiceLabel=r.voice?.format==='voice'?'语音 · ':r.voice?'语音回退文字 · ':''
      const searchLabel=r.search?.requiredVideos?`B站资料已读 ${r.search.videosRead??0}/${r.search.requiredVideos} · ${r.search.waiting?'等待下一读取时段':r.search.complete?'读取完成':'读取中或未完成'} · `:r.search?`${r.search.source==='bili'?'B站检索':r.search.source==='page'?'网页读取':r.search.source==='research'?'多源交叉检索':'网页检索'}${r.search.ok?'成功':'失败'} · ${r.search.count??0}条${r.search.cached?'（缓存）':''} · 正文已读${r.search.pagesRead??0}页/失败${r.search.pagesFailed??0}页 · `:''
      const partsLabel=r.replyParts?`文字 ${r.replyParts.sent}/${r.replyParts.planned}条 · `:''
      const stickerLabels={'repeat-cooldown':'同图重复间隔未到','chance-missed':'未抽中','cooldown':'冷却中','disabled':'已关闭','empty-library':'无启用图片','no-match':'未选到合适图片','invalid-selection':'选图返回无效编号','selection-error':'选图失败或超时','selected':'已选好','sent':'已发出','send-unconfirmed':'发送未确认','cancelled':'已取消','disabled-during-selection':'选图期间停用'}
      const stickerLabel=r.sticker?`表情：${stickerLabels[r.sticker.reason]||r.sticker.reason}${r.sticker.explicit?'（点图）':''} · `:''
      const result=voiceLabel+partsLabel+stickerLabel+searchLabel+(r.reason??'等待完成')+(r.fallbackReason?` · ${failures[r.fallbackReason]??'无可用正文'}`:r.modelResult?.attempts>1?' · 补试恢复':'')
      const fields=[`${new Date(r.receivedAt).toLocaleTimeString('zh-CN')} / ${r.channel==='group'?'群':'私聊'} ${r.target}`,r.messageId??'无ID',labels[r.stage]??r.stage,`${seconds(r.waitMs)} / ${seconds(r.modelMs)} / ${seconds(r.totalMs??Date.now()-r.receivedAt)}`,result]
      for(const value of fields){const td=document.createElement('td');td.textContent=value;tr.append(td)}
      body.append(tr)
    }
    if(!rows.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=5;td.textContent='暂无符合条件的消息处理记录';tr.append(td);body.append(tr)}
  }
  $('#chat-trace-filter').onchange=()=>{if(snapshot)render(snapshot)}
  window.renderChatDiagnostics=render
})()
