import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {readChatHistory} from '../src/chat-history.mjs'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-history-')),file=path.join(dir,'chat.log')
try{
 const original=Array.from({length:70},(_,i)=>({type:i%2?'out':'in',id:i,text:'中文🌊'.repeat(480)+(i===11?'红夹子':''),group:'123'}))
 fs.writeFileSync(file,original.map(JSON.stringify).join('\n')+'\n'+Array.from({length:500},()=>JSON.stringify({type:'usage',tokens:1})).join('\n')+'\n')
 const first=readChatHistory(file,{limit:12});assert.deepEqual(first.rows.map(r=>r.id),original.slice(-12).map(r=>r.id),'先过滤技术日志再取聊天条数')
 fs.appendFileSync(file,JSON.stringify({type:'in',id:70,text:'新追加'})+'\n')
 let cursor=first.nextBefore,all=[...first.rows]
 while(cursor>0){const page=readChatHistory(file,{before:cursor,limit:12});assert.ok(page.nextBefore<cursor);all=[...page.rows,...all];cursor=page.nextBefore}
 assert.deepEqual(all,original,'UTF8跨块分页无丢失重复，追加不影响旧游标')
 const found=readChatHistory(file,{query:'红夹子'});assert.equal(found.rows.length,1);assert.equal(found.rows[0].id,11)
 assert.equal(readChatHistory(file).rows.at(-1).id,70)
 fs.appendFileSync(file,'{unfinished');assert.equal(readChatHistory(file).rows.at(-1).id,70)
 assert.equal(readChatHistory(file,{before:'invalid'}).rows.length,0)
 assert.equal(readChatHistory(path.join(dir,'missing')).rows.length,0)
 console.log('聊天历史通过：技术行不挤掉聊天/中文跨块分页/追加期间游标稳定无重复丢失/关键词搜索/半条日志与文件缺失。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
