const $=s=>document.querySelector(s)
const states={synthesizing:'合成中',sending:'待发送确认',ready:'试听就绪',sent:'已确认发送','synthesis-failed':'合成失败','send-unconfirmed':'发送未确认'}
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e}
async function api(url,body){const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw Error(data.error||'请求失败');return data}
async function paths(){try{const p=await api('/api/voice/lab/path');$('#reference-text').textContent=p.referenceText||'未填写参考转写；应与上方音频逐字对应。';$('#path').textContent=`服务 ${p.online?'在线':'未就绪'} · ${p.source}\n提供方 ${p.provider} · 增益 +${p.gainDb}dB\n接口 ${p.endpoint}\n目录 ${p.installation}\nPython ${p.python}\n入口 ${p.entry}\n推理配置 ${p.inferenceConfig}\n启动配置（API内手动切换后须另核对）\n${p.weights.join('\n')}\n参考 ${p.referenceAudio||'未填写'}（${p.referenceExists?'存在':'缺失'}）\n检测记录 ${p.auditDir}\n${p.output}`;$('#api-docs').href=new URL('/docs',p.endpoint).href;$('#api-docs').hidden=false}catch(e){$('#path').textContent=e.message}}
async function records(){try{const {records}=await api('/api/voice/lab');$('#records').replaceChildren();$('#list-status').textContent=records.length?`共 ${records.length} 条，最新在前。`:'还没有新记录。新合成、实际发送或本页试听后再刷新。'
 for(const r of records){const card=node('article',undefined,'record'),same=records.some(x=>x.id!==r.id&&x.audioSHA256&&x.audioSHA256===r.audioSHA256&&x.text!==r.text);card.append(node('div',`${new Date(r.at).toLocaleString('zh-CN')} · ${states[r.state]||r.state} · ${r.mode==='send'?r.target:'只试听'} · 第${(r.partIndex??0)+1}/${r.partCount??1}段`,'meta'),node('p',r.text,'utterance'),node('div',`记录 ${r.id} · 轮次 ${r.turnId||'独立试听'} · 耗时 ${((r.synthesisMs??0)/1000).toFixed(1)}s · 音长 ${r.wave?.durationSec??'?'}s · ${r.wave?.sampleRate??'?'}Hz · SHA256 ${r.audioSHA256||'待生成'}`,'meta'))
 if(same)card.append(node('p','不同文本出现了相同的音频哈希，请人工听检是否复用了声音。','warning'))
 for(const warning of r.warnings??[])card.append(node('p',warning,'warning'))
 if(r.audioSHA256){const players=node('div',undefined,'players');for(const [label,raw]of [[r.rawCaptured?'模型原始返回':'提供方未另存原始版（同发送版）',true],['发送用版本（含现有增益）',false]]){const box=node('div'),a=node('audio');a.controls=true;a.preload='none';a.src=`/api/voice/lab/audio?id=${encodeURIComponent(r.id)}${raw?'&raw=1':''}`;box.append(node('label',label),a);players.append(box)}card.append(players)}
 $('#records').append(card)}
 }catch(e){$('#list-status').textContent=e.message}}
$('#check').onclick=paths;$('#refresh').onclick=records
$('#clear').onclick=async()=>{try{await api('/api/voice/lab/clear',{});await records()}catch(e){$('#list-status').textContent=e.message}}
$('#generate').onclick=async()=>{const b=$('#generate');b.disabled=true;$('#result').textContent='正在排队合成，不会发送 QQ…';try{const text=$('#sample').value.trim();if(!text)throw Error('先输入试听文本');await api('/api/voice/preview',{text});$('#result').textContent='试听已生成。下方可对照原始版与发送版播放。';await records()}catch(e){$('#result').textContent=e.message;await records()}finally{b.disabled=false}}
paths();records()
