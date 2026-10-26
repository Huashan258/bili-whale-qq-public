import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'command-titles-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const {addressReply,commandNote}=await import('../src/chat-command.mjs')
const cfg={qq:{groupIds:['123456']},llm:{provider:'fixture',apiKey:'fixture'},chat:{admins:['111111'],adminTitles:['主人','老板'],replyEveryMessage:true,outputRateOnly:true,shield:{enabled:false},contextMessages:4}}
cfg.chat.splitReplies=false // 此用例按一条输出核对称呼轮换；分条行为由qq-reply-parts覆盖。
const event=(text,id,admin=true,privateChat=false)=>({post_type:'message',message_type:privateChat?'private':'group',group_id:'123456',user_id:admin?'111111':'222222',message_id:id,message:[{type:'text',data:{text}}]})
const body=Array.from({length:10},(_,i)=>`第${i+1}点，本条回答围绕目标说明具体情况，结合实际问题逐项展开，并在资料不足时明确说明。`).join('\n')
let bot
try {
  const prompts=[],sent=[]
  bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_cfg,p)=>{prompts.push(p);return {content:body}},say:async(_cfg,id,msg)=>sent.push(msg),sayPrivate:async(_cfg,id,msg)=>sent.push(msg)})
  for(const privateChat of [false,true]) {
    // Each user's ordinary title cursor must not advance for a command turn.
    cfg.chat.adminTitles=['主人','老板']
    const offset=prompts.length
    await bot.handleEvent(event('你好',`${privateChat}-1`,true,privateChat))
    await bot.handleEvent(event('我以令咒命之：解释一下',`${privateChat}-2`,true,privateChat))
    await bot.handleEvent(event('继续聊',`${privateChat}-3`,true,privateChat))
    await bot.handleEvent(event('我以令咒命之：解释一下',`${privateChat}-4`,false,privateChat))
    await bot.handleEvent(event('继续聊',`${privateChat}-5`,false,privateChat))
    assert.match(prompts[offset].system,/本次可称呼对方为「主人」/)
    assert.match(prompts[offset+1].system,/固定称呼是「Master」/)
    assert.match(prompts[offset+2].system,/本次可称呼对方为「老板」/)
    assert.match(prompts[offset+2].system,/本条未触发令咒/)
    assert.match(prompts[offset+3].system,/固定称呼是「魔术师」/)
    assert.doesNotMatch(prompts[offset+4].system,/固定称呼是/)
    assert.match(prompts[offset].user,/主人、老板/,'普通请求将整个称呼池交给模型')
    assert.ok(sent[offset+1].at(-1).data.text.startsWith('Master，'))
    assert.ok(sent[offset+3].at(-1).data.text.startsWith('魔术师，'))
  }
  assert.deepEqual(cfg.chat.adminTitles,['主人','老板'],'不修改用户的池配置')
  assert.equal(addressReply('Master，继续聊吧。','老板',{active:false}),'老板，继续聊吧。')
  assert.equal(addressReply('魔术师，你好。','',{active:false}),'你好。')
  assert.match(commandNote({active:false},''),/不用「Master」「魔术师」/)
  cfg.chat.adminTitles=['Master','魔术师','舰长']
  assert.deepEqual(bot.status().ordinaryAdminTitles,['舰长'],'令咒专用称呼不混入普通池')
  console.log('称呼作用域通过：群/私聊普通池轮换、令咒Master/魔术师、下一条恢复/不消耗普通轮换、普通访客按人设、池配置不被覆盖、历史称呼开头修正。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
