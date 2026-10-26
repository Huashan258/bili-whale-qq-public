(() => {
  const button=document.querySelector('#voice-preview-button'),status=document.querySelector('#voice-preview-status'),audio=document.querySelector('#voice-preview-audio')
  if(!button)return
  button.onclick=async()=>{
    if(button.disabled)return
    button.disabled=true;status.textContent='正在合成试听，本地模型可能需要等待加载或排队…'
    try{
      const r=await fetch('/api/voice/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.querySelector('#voice-preview-text').value})})
      const data=await r.json();if(!r.ok)throw Error(data.error||'试听生成失败')
      audio.src=data.url;audio.hidden=false;audio.load()
      const gain=data.loudness?.rmsBefore>0?`，实测增益 ${(20*Math.log10(data.loudness.rmsAfter/data.loudness.rmsBefore)).toFixed(1)}dB`:''
      status.textContent=data.provider==='gpt-sovits'?`本地试听已生成${data.source==='dsh'?'（使用DSH实际发送链）':''}${gain}，不调用百炼、不发送QQ群。`:`试听已生成，计费字符 ${data.characters}；点击播放，不会发送QQ群。`
    }catch(e){status.textContent=e.message}finally{button.disabled=false}
  }
  const check=document.querySelector('#voice-status-button')
  const start=document.querySelector('#voice-local-start-button')
  if(start)start.onclick=async()=>{start.disabled=true;try{const r=await fetch('/api/voice/local/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});const s=await r.json();if(!r.ok)throw Error(s.error||'启动本地API失败');status.textContent=s.state==='online'?'本地语音API已在线。':'本地语音API正在加载模型，稍后点击检查语音服务。'}catch(e){status.textContent=e.message}finally{start.disabled=false}}
  if(check)check.onclick=async()=>{
    check.disabled=true
    try{const r=await fetch('/api/voice/status');const s=await r.json();if(!r.ok)throw Error('读取语音状态失败');status.textContent=s.provider==='gpt-sovits'?`本地GPT-SoVITS：${s.online?'API在线':'API未就绪或离线'}；${s.configured?'参考配置已填写':'请填写参考音频和文字'}。`:`当前提供方：${s.provider}，${s.configured?'云端配置已填写':'请检查配置或使用QQ原生语音'}。`}catch(e){status.textContent=e.message}finally{check.disabled=false}
  }
})()
