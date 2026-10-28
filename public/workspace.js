import {fields,sections,allowsDecimal} from './settings-schema.js'
import {parseGroupChances,formatGroupChances} from './group-probabilities.js'
export const workspaces={
 'computer-lab':{title:'电脑工作台',description:'通过QQ管理员指令查看本机资源、文件与程序；读取Maa状态，按明确请求操作按钮。程序结果可直接回群，文件仍私聊。',pick:f=>f.section==='computer',links:[['指令说明','/computer-help.html'],['查看聊天记录','/#chat']]},
 'bili-lab':{title:'B站工作台',description:'发现、观看、评论与分享。在这里安排青娥鱼探索 B站的节奏。',pick:f=>['scroll','share','bili','guard'].includes(f.section),links:[['视频与草稿','/#review'],['登录与巡检诊断','/#settings']]},
 'chat-lab':{title:'群聊工作台',description:'管理群聊连接、回复概率、用量与表情。每个群，都可以有自己的节奏。',pick:f=>['qq','shield'].includes(f.section)||(f.section==='chat'&&!/persona|voice|book|diary|style/i.test(f.path)),links:[['查看聊天记录','/#chat'],['表情包管理','/#persona'],['语音工作台','/voice-lab.html']]},
 'memory-lab':{title:'人设与知识',description:'人设决定她是谁，书籍与记忆丰富她说的话。',pick:f=>(f.section==='memory'&&!/diary/i.test(f.path))||(/persona|book|style/i.test(f.path)&&! /diary|voice/i.test(f.path)),links:[['人设正文、书籍与表情管理','/#persona']]},
 'diary-lab':{title:'日记工作台',description:'把留存的相遇写成日记，管理自动补写与专栏发布。',pick:f=>/diary/i.test(f.path),links:[['人设与知识','/memory-lab.html']]},
 'system-lab':{title:'连接与模型',description:'管理运行方式、模型、图像识别和深读工具。',pick:f=>['runtime','llm','whale'].includes(f.section)&&! /diary|book|persona|style/i.test(f.path),links:[['完整设置与诊断','/#settings'],['阿里云百炼','https://bailian.console.aliyun.com/']]},
}
const $=s=>document.querySelector(s),key=location.pathname.split('/').pop().replace('.html',''),page=workspaces[key]??workspaces['bili-lab'],chosen=fields.filter(page.pick),inputs=new Map(),dirty=new Map();let loaded,busy=false,category=chosen[0]?.section
$('#lab-title').textContent=page.title;document.title=`${page.title} · 鲸屿`;$('#lab-description').textContent=page.description
for(const [id,p] of Object.entries(workspaces)){const a=document.createElement('a');a.href=`/${id}.html`;a.textContent=p.title;if(id===key)a.setAttribute('aria-current','page');$('#lab-tabs').append(a)}
for(const [title,url] of page.links){const a=document.createElement('a');a.href=url;a.textContent=title+' ↗';$('#lab-shortcuts').append(a)}
function status(t,error=false){$('#lab-status').textContent=t;$('#lab-status').classList.toggle('error',error)}
function update(){ $('#lab-save').disabled=busy||!loaded||!dirty.size;$('#lab-save').textContent=dirty.size?`保存 ${dirty.size} 项修改`:'保存修改';for(const [p,{card}] of inputs)card.classList.toggle('is-dirty',dirty.has(p)) }
function parse(f,input){if(f.type==='boolean')return input.checked;if(f.type==='number'){if(!input.value.trim()||!input.checkValidity())throw Error(`${f.label}：请填写 ${f.min}–${f.max} 之间的数值`);return Number(input.value)}if(f.type==='group-probabilities')return parseGroupChances(input.value);if(f.type==='masters')return JSON.parse(input.value||'[]');if(['list','hours'].includes(f.type)){const a=input.value.split(/[\n,，]+/).map(s=>s.trim()).filter(Boolean);return f.type==='hours'?a.map(Number):a}return input.value}
for(const section of Object.keys(sections)){
 const group=chosen.filter(f=>f.section===section);if(!group.length)continue
 const h=document.createElement('h2');h.className='lab-section-heading';h.textContent=sections[section];h.dataset.section=section;$('#lab-fields').append(h)
 for(const f of group){const card=document.createElement('div');card.className='lab-field'+(f.type==='masters'||/persona/.test(f.path)?' is-wide':'');card.dataset.section=section;card.dataset.setting=f.path;const label=document.createElement('label'),input=document.createElement(f.type==='select'?'select':['long','list','hours','masters','group-probabilities'].includes(f.type)?'textarea':'input');input.id='field-'+f.path.replaceAll('.','-');label.htmlFor=input.id;label.textContent=f.label
 if(f.type==='select')for(const o of f.options){const option=document.createElement('option');option.value=o.value;option.textContent=o.label;input.append(option)}
 if(input.tagName==='INPUT')input.type=f.type==='boolean'?'checkbox':f.type==='secret'?'password':f.type==='number'?'number':'text'
 if(f.type==='number'){input.min=f.min;input.max=f.max;input.step=allowsDecimal(f.path)?'any':'1'}input.readOnly=!!f.readOnly;input.autocomplete='off';input.spellcheck=false;if(input.tagName==='TEXTAREA')input.rows=f.type==='long'?5:3
 const hint=document.createElement('small');hint.textContent=f.hint||(f.type==='number'?`允许范围 ${f.min}–${f.max}`:f.type==='list'?'每行一项；清空可移除全部。':'');card.append(label,input,hint);$('#lab-fields').append(card);inputs.set(f.path,{input,card})
 input.addEventListener('input',()=>{if(!loaded)return;try{const value=parse(f,input);if(f.type==='secret'&&!value.trim()||JSON.stringify(value)===JSON.stringify(loaded.values[f.path]))dirty.delete(f.path);else dirty.set(f.path,value);status(dirty.size?`${dirty.size} 项修改待保存`:'与已读取配置一致')}catch(e){dirty.set(f.path,undefined);status(e.message,true)}update()})
 }
}
async function request(body){const r=await fetch('/api/settings',body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),d=await r.json();if(!r.ok)throw Error(d.error||'读取失败');return d}
function fill(d){loaded=d;dirty.clear();for(const f of chosen){const {input}=inputs.get(f.path),v=d.values[f.path];if(f.type==='boolean')input.checked=!!v;else input.value=f.type==='secret'?'':f.type==='group-probabilities'?formatGroupChances(v):f.type==='masters'?JSON.stringify(v,null,2):Array.isArray(v)?v.join('\n'):v??'';if(f.type==='secret')input.placeholder=d.secrets[f.path]?'已配置 · 留空保留':'未配置'}update()}
async function reload(){if(busy)return;if(dirty.size&&!confirm('重新读取会放弃未保存的修改，继续吗？'))return;try{fill(await request());status('已读取当前配置。保存后参数会随现有热更新机制生效。')}catch(e){status(e.message,true)}}
$('#lab-reload').onclick=reload
$('#lab-save').onclick=async()=>{if(busy||!loaded||!dirty.size)return;try{for(const [p] of dirty){const f=chosen.find(f=>f.path===p);dirty.set(p,parse(f,inputs.get(p).input))}busy=true;$('#lab-reload').disabled=true;for(const {input} of inputs.values())input.disabled=true;update();fill(await request({revision:loaded.revision,patch:Object.fromEntries(dirty)}));status('已保存并备份。连接与启动类设置可能需要重启相应通道。')}catch(e){status(e.message,true)}finally{busy=false;$('#lab-reload').disabled=false;for(const {input} of inputs.values())input.disabled=false;update()}}
function filter(){const q=$('#lab-search').value.trim().toLowerCase();for(const f of chosen)inputs.get(f.path).card.hidden=q?!`${f.label} ${f.hint} ${f.path}`.toLowerCase().includes(q):f.section!==category;for(const h of document.querySelectorAll('.lab-section-heading'))h.hidden=!chosen.some(f=>f.section===h.dataset.section&&!inputs.get(f.path).card.hidden);for(const b of document.querySelectorAll('#lab-categories button'))b.setAttribute('aria-pressed',String(!q&&b.dataset.category===category))}
for(const section of [...new Set(chosen.map(f=>f.section))]){const b=document.createElement('button');b.type='button';b.dataset.category=section;b.textContent=sections[section];b.onclick=()=>{category=section;$('#lab-search').value='';filter()};$('#lab-categories').append(b)}
$('#lab-search').oninput=filter;filter()
window.addEventListener('beforeunload',e=>{if(dirty.size){e.preventDefault();e.returnValue=''}})
if(key==='diary-lab'){try{const r=await fetch('/diary-panel.html');if(!r.ok)throw Error('日记面板加载失败');$('#lab-diary').innerHTML=await r.text();$('#lab-diary').hidden=false;const script=document.createElement('script');script.src='/diary.js?v=2';document.body.append(script)}catch(e){status(e.message,true)}}
await reload()
let polling=false
setInterval(async()=>{if(polling||busy||dirty.size||document.hidden)return;polling=true;try{const d=await request();if(!busy&&!dirty.size&&d.revision!==loaded?.revision){fill(d);status('已同步最新配置。')}}catch{}finally{polling=false}},5000)
