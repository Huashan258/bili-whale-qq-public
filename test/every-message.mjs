import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-every-message-'))
process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs')
const cfg={qq:{groupIds:['123456','654321']},llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'青娥鱼',admins:['887000001'],replyEveryMessage:true,outputRateOnly:true,speakChance:1,quote:true,shield:{enabled:false}}}
const event=(text,id,group='123456',uid='887000001')=>({post_type:'message',message_type:'group',group_id:group,user_id:uid,message_id:id,sender:{nickname:'测试主人'},message:[{type:'text',data:{text}}]})
try {
  let active=0,maxActive=0,calls=0
  const sent=[],prompts=[]
  const bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:dir,logger:{},llmChat:async(_cfg,prompt)=>{
    active++;maxActive=Math.max(maxActive,active);prompts.push(prompt)
    await new Promise(r=>setImmediate(r));active--
    calls++
    const target=prompt.styleTask
    if(target==='啊啊啊')throw Error('fixture model unavailable')
    return {content:target==='喵'?'':target==='喵呜'?'喵呜～听见啦':JSON.stringify({speak:false,reply:'收到咕咕啦'})}
  },say:async(_cfg,gid,message,context)=>sent.push({gid,message,context}),sayPrivate:async(_cfg,uid,message)=>sent.push({uid,message})})
  bot.selfId('999999')
  const texts=['咕咕嘎嘎','喵','喵呜','啊啊啊']
  const results=await Promise.all(texts.map((text,i)=>bot.handleEvent(event(text,i+1))))
  assert.equal(results.filter(r=>r?.spoke).length,4)
  assert.equal(sent.length,4,'四条短消息各回复一次，不能只补一条')
  assert.deepEqual(sent.map(s=>s.message[0].data.id),['1','2','3','4'])
  assert.equal(maxActive,1,'同一会话模型调用必须串行')
  for(let i=0;i<4;i++) {
    const promptsForTarget=prompts.filter(p=>p.styleTask===texts[i])
    assert.ok(promptsForTarget.length>=1&&promptsForTarget.length<=2)
    for(const p of promptsForTarget){
      assert.match(p.system,/每一条新消息都必须/)
      assert.doesNotMatch(p.system,/拿不准就别说|只是在刷表情.*不说|只输出 JSON/)
      assert.equal(p.json,false,'必回模式不再强制JSON')
      assert.match(p.user,/必须回应当前目标消息/);assert.equal(p.replyActor.uid,'887000001');assert.equal(p.styleTask,texts[i])
    }
    assert.equal(sent[i].context.replyToUserId,'887000001','管理员豁免保留真实来源')
  }
  assert.equal(bot.status().queuedMessages,0)
  assert.equal(bot.status().catchUp.enabled,false,'必回模式不再用会覆盖消息的补话槽')
  assert.equal((await bot.handleEvent(event('喵',2))).why,'重复投递')
  assert.equal(await bot.handleEvent(event('机器人自己',5,'123456','999999')),null)
  const prior=sent.length
  await Promise.all([bot.handleEvent(event('无ID一',undefined)),bot.handleEvent(event('无ID二',undefined))])
  assert.equal(sent.length,prior+2,'缺少message_id也不能只处理第一条')
  await Promise.all([bot.handleEvent(event('A群',77)),bot.handleEvent(event('B群',77,'654321'))])
  assert.equal(sent.length,prior+4,'不同会话的相同ID不能误去重')
  await bot.handleEvent({...event('',100),message:[{type:'face',data:{id:1}}]})
  assert.equal(sent.length,prior+5,'纯QQ表情也应回')
  bot.stop()
  const beforeStop=sent.length
  await bot.handleEvent(event('停机后',101))
  assert.equal(sent.length,beforeStop)
  console.log('逐条必回通过：真实示例四连发/不@短句、兼容JSON/正文直出/空内容单次补试/失败回执、顺序与引用ID、无合并覆盖、管理员来源、去重/无ID/跨群ID、表情、停止不发送。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
