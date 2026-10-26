(() => {
  const $=s=>document.querySelector(s),root=$('.sticker-library'),status=$('#stickers-status'),list=$('#stickers-list')
  let state=null,busy=false
  const element=(tag,text)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node}
  async function request(body) {
    const response=await fetch('/api/stickers',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,revision:state.revision})}:{})
    const result=await response.json()
    if(!response.ok)throw Error(result.error||'表情包操作失败')
    return result
  }
  function render() {
    $('#stickers-enabled').checked=state.enabled
    $('#stickers-chance').value=Math.round(state.chance*100)
    $('#stickers-cooldown').value=state.cooldownSec
    $('#stickers-repeat').value=state.repeatMinutes??5
    list.replaceChildren()
    for(const item of state.items) {
      const form=element('form');form.className='sticker-item'
      const image=element('img');image.src='/api/stickers/image?id='+encodeURIComponent(item.id);image.alt=item.name;image.loading='lazy'
      const name=element('input');name.value=item.name;name.maxLength=40;name.required=true;name.setAttribute('aria-label','表情包名称')
      const description=element('textarea');description.value=item.description;description.maxLength=300;description.rows=3;description.required=true;description.setAttribute('aria-label','画面和用途')
      const label=element('label'),enabled=element('input');enabled.type='checkbox';enabled.checked=item.enabled!==false;label.append(enabled,document.createTextNode(' 允许 AI 使用'))
      const actions=element('div');actions.className='sticker-actions'
      const save=element('button','保存说明');save.type='submit';save.className='btn ghost sm'
      const remove=element('button','移出表情库');remove.type='button';remove.className='btn ghost sm'
      form.onsubmit=event=>{event.preventDefault();mutate({action:'update',id:item.id,name:name.value,description:description.value,enabled:enabled.checked})}
      remove.onclick=()=>mutate({action:'remove',id:item.id})
      actions.append(save,remove);form.append(image,name,description,label,actions);list.append(form)
    }
    status.textContent=state.items.length?`已保存 ${state.items.length} 张，启用 ${state.items.filter(i=>i.enabled!==false).length} 张。来自 biaoqingbao 与已有表情库，保存后立即生效，无单图大小或数量上限。`:'表情库还是空的，可放入项目 biaoqingbao 文件夹，或在此上传。'
  }
  async function run(work) {
    if(busy)return
    busy=true;root.querySelectorAll('button').forEach(b=>b.disabled=true)
    try{await work()}catch(e){status.textContent=e.message}finally{busy=false;root.querySelectorAll('button').forEach(b=>b.disabled=false)}
  }
  const mutate=body=>run(async()=>{if(!state)throw Error('请先重新读取表情库');state=await request(body);render()})
  $('#stickers-reload').onclick=()=>run(async()=>{state=await request();render()})
  $('#stickers-settings').onsubmit=event=>{event.preventDefault();mutate({action:'settings',enabled:$('#stickers-enabled').checked,chance:Number($('#stickers-chance').value)/100,cooldownSec:Number($('#stickers-cooldown').value),repeatMinutes:Number($('#stickers-repeat').value)})}
  $('#stickers-upload').onsubmit=event=>{
    event.preventDefault()
    run(async()=>{
      if(!state)throw Error('请先重新读取表情库')
      const file=$('#stickers-file').files[0]
      if(!file)throw Error('请选择 PNG、JPEG、GIF 或 WebP 图片')
      const base64=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('读取图片失败'));reader.readAsDataURL(file)})
      state=await request({action:'upload',base64,name:$('#stickers-name').value,description:$('#stickers-description').value});$('#stickers-upload').reset();render()
    })
  }
  $('#stickers-reload').click()
})()
