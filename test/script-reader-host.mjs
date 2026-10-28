import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'script-reader-host-'));process.env.BILI_WHALE_DATA=dir
const {createChat}=await import('../src/chat.mjs'),{scripts}=await import('../src/trpg-scripts.mjs'),{sendGroup}=await import('../src/qq.mjs'),{scriptLibrary,readScript,downloadScript}=await import('../src/script-reader.mjs')
const previousFetch=globalThis.fetch;let bot,calls=0
try{
 const cfg={qq:{groupIds:['123'],onebotHttp:'http://fixture.invalid'},chat:{admins:['456'],speakChance:0,shield:{enabled:false},outputRateOnly:true},llm:{provider:'fixture',apiKey:'fixture'}}
 const engine=await scripts();await engine.control('123','on','结构化剧本')
 bot=createChat(cfg,{stateFile:null,logFile:null,privateDir:path.join(dir,'private'),logger:{},llmChat:async()=>{throw Error('不应调用模型')}});bot.selfId('999')
 const text='青娥模拟：【科比 传球\n佐巴杨 接球】',turns=[{npc:'科比',reply:'传球给佐巴杨'},{npc:'佐巴杨',reply:'接住科比的传球'}]
 globalThis.fetch=async(_url,request)=>{calls++;const body=JSON.parse(request.body);assert.equal(body.params.scriptTurns,undefined,'内部角色元数据不发给OneBot');await bot.handleEvent({post_type:'message_sent',message_type:'group',group_id:123,user_id:999,message_id:500,message:body.params.message});return new Response(JSON.stringify({status:'ok',data:{message_id:500}}))}
 await sendGroup(cfg,123,[{type:'text',data:{text}}],{replyToUserId:'456',scriptTurns:turns});assert.equal(calls,1)
 const list=await scriptLibrary(cfg),id=list.sessions[0].id,result=await readScript(cfg,{group:'123',id});assert.equal(result.rawRows,1,'HTTP回执前的自身回声不重复记录');assert.equal(result.total,2);assert.deepEqual(result.entries.map(e=>e.speaker),['npc:科比','npc:佐巴杨']);assert.equal(result.entries[0].inferred,undefined,'保留明确角色元数据')
 const filtered=await readScript(cfg,{group:'123',id,hidden:['npc:科比']});assert.equal(filtered.entries.length,1);assert.equal(filtered.entries[0].name,'佐巴杨');assert.match(filtered.entries[0].text,/科比/,'正文提及被隐藏角色时仍保留当前说话者')
 assert.match(fs.readFileSync((await downloadScript(cfg,{group:'123',id})).file,'utf8'),/科比/);await assert.rejects(readScript(cfg,{group:'124',id}),/白名单/)
 console.log('剧本阅读宿主通过：QQ发送前角色归属缓存、回执前自身回声去重、多NPC拆分/独立筛选、原文下载、群隔离。未连接真实QQ或修改真实剧本。')
}finally{bot?.stop();globalThis.fetch=previousFetch;fs.rmSync(dir,{recursive:true,force:true})}
