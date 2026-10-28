import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {fields,sections,allowsDecimal} from '../public/settings-schema.js'
import {parseGroupChances,formatGroupChances} from '../public/group-probabilities.js'
const source=fs.readFileSync(new URL('../public/workspace.js',import.meta.url),'utf8').replace(/^import .*\r?\n/gm,'').replace('export const workspaces','const workspaces').replace('await reload()','reload()')
class Element{
 constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attrs={};this.value='';this.hidden=false;this.classList={toggle:()=>{}};this.events={}}
 append(...e){this.children.push(...e)}setAttribute(k,v){this.attrs[k]=v}addEventListener(k,fn){this.events[k]=fn}checkValidity(){return this.value!==''&&Number(this.value)>=Number(this.min)&&Number(this.value)<=Number(this.max)&&(this.step==='any'||Number.isInteger(Number(this.value)))}
}
for(const page of ['bili','chat','memory','diary','system','computer']){
 const ids=['lab-title','lab-description','lab-tabs','lab-shortcuts','lab-save','lab-status','lab-fields','lab-search','lab-reload','lab-categories','lab-diary'],els=new Map(ids.map(id=>['#'+id,new Element()])),posts=[]
 let data={revision:'fixture',values:Object.fromEntries(fields.map(f=>[f.path,structuredClone(f.value)])),secrets:{}},fail=false
 const document={title:'',body:new Element(),createElement:t=>new Element(t),querySelector:s=>els.get(s),querySelectorAll:s=>s==='.lab-section-heading'?els.get('#lab-fields').children.filter(e=>e.tagName==='H2'):s==='#lab-categories button'?els.get('#lab-categories').children:[]}
 const context=vm.createContext({document,location:{pathname:`/${page}-lab.html`},window:{addEventListener:()=>{}},setInterval:()=>{},fields,sections,allowsDecimal,parseGroupChances,formatGroupChances,confirm:()=>true,fetch:async(url,opts)=>{if(url==='/diary-panel.html')return {ok:true,text:async()=>'<section>diary</section>'};if(opts?.body){const body=JSON.parse(opts.body);posts.push(body);if(fail)return {ok:false,json:async()=>({error:'配置冲突'})};Object.assign(data.values,body.patch)}return {ok:true,json:async()=>structuredClone(data)}}})
 await vm.runInContext('(async()=>{'+source+'})()',context);await new Promise(r=>setImmediate(r));assert.match(els.get('#lab-status').textContent,/已读取/);assert.ok(els.get('#lab-fields').children.length>0)
 const cards=els.get('#lab-fields').children.filter(e=>e.dataset.setting),initial=cards.filter(e=>!e.hidden);assert.ok(initial.length);assert.equal(new Set(initial.map(e=>e.dataset.section)).size,1,'初次只显示一组设置')
 if(page==='bili'){
  const input=cards.find(e=>e.dataset.setting==='scroll.tagCommentEnabled').children[1];input.checked=true;input.events.input();assert.equal(els.get('#lab-save').disabled,false);await els.get('#lab-save').onclick();assert.deepEqual(posts[0],{revision:'fixture',patch:{'scroll.tagCommentEnabled':true}});assert.equal(els.get('#lab-save').disabled,true)
  const field=cards.find(e=>e.dataset.setting==='scroll.tagCommentMaxPerHour').children[1];field.value='11';field.events.input();await els.get('#lab-save').onclick();assert.equal(posts.length,1,'非法数值不提交');field.value='2';field.events.input();fail=true;await els.get('#lab-save').onclick();assert.match(els.get('#lab-status').textContent,/配置冲突/);assert.equal(els.get('#lab-save').disabled,false,'冲突保留编辑')
  els.get('#lab-search').value='自动评论的视频标签';els.get('#lab-search').oninput();assert.equal(cards.filter(e=>!e.hidden).length,1)
 }
 if(page==='system'){const secret=cards.find(e=>e.dataset.setting==='llm.apiKey').children[1];secret.value='';secret.events.input();assert.equal(els.get('#lab-save').disabled,true,'空凭据不覆盖')}
}
console.log('六个工作台验证通过：实际脚本加载、分类显示、搜索、精确补丁保存、非法数字拒绝、冲突保留、空凭据保护；未写真实配置。')
