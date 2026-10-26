(() => {
  const button=document.querySelector('#voice-preview-button'),status=document.querySelector('#voice-preview-status'),audio=document.querySelector('#voice-preview-audio')
  if(!button)return
  button.onclick=async()=>{
    if(button.disabled)return
    button.disabled=true;status.textContent='正在云端合成试听…'
    try{
      const r=await fetch('/api/voice/preview',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:document.querySelector('#voice-preview-text').value})})
      const data=await r.json();if(!r.ok)throw Error(data.error||'试听生成失败')
      audio.src=data.url;audio.hidden=false;audio.load();status.textContent=`试听已生成，计费字符 ${data.characters}；点击播放，不会发送QQ群。`
    }catch(e){status.textContent=e.message}finally{button.disabled=false}
  }
})()
