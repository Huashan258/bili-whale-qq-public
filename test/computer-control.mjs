import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'computer-control-'));process.env.BILI_WHALE_DATA=dir
const {computerIntent,createComputerControl,readComputerFile,formatComputerResult}=await import('../src/computer-control.mjs')
const {createChat}=await import('../src/chat.mjs')
const {validatePatch}=await import('../src/settings.mjs')
const cfg={computer:{enabled:true,allowActions:true,fileRoots:[dir],screenshotProcesses:['MAA'],maaDir:'E:\\fixture'},qq:{groupIds:['123']},chat:{admins:['111'],speakChance:0,replyEveryMessage:false,outputRateOnly:true,shield:{enabled:false}},llm:{provider:'fixture',apiKey:'fixture'}}
let calls=0,models=0,bot
const data={ok:true,running:true,taskState:'stopped',roguelike:'Off',processes:[{pid:1,memory:1024,responding:true}],modals:[]}
try{
 assert.equal(computerIntent('程序查询：Maa运行状态').kind,'maa');assert.equal(computerIntent('[CQ:at,qq=999] 程序截图：maa').screenshot,true);assert.equal(computerIntent('程序查询：CPU与内存网络流量').kind,'resources')
 assert.equal(computerIntent('有人说程序操作：Maa开始'),null);assert.equal(computerIntent('程序操作：Maa 开始 && calc').kind,'invalid');assert.equal(computerIntent('程序查询：MAA;shutdown').kind,'invalid')
 const fake=async(action,opts)=>{calls++;if(opts.outputFile)fs.writeFileSync(opts.outputFile,Buffer.from('fixture-image'));return {...data,screenshot:opts.outputFile,action}}
 const handler=createComputerControl({run:fake,dataDir:dir})
 assert.equal((await handler('程序截图：Maa',cfg,{admin:false})).denied,true);assert.equal(calls,0)
 const image=await handler('程序截图：Maa',cfg,{admin:true});assert.equal(image.image.toString(),'fixture-image');assert.equal(fs.readdirSync(path.join(dir,'computer-captures')).length,0,'发送后无需留存截图');assert.match(image.text,/未勾选/);assert.match(image.text,/任务已停止/)
 const before=calls;await handler('程序截图：QQ',cfg,{admin:true});assert.equal(calls,before)
 await handler('程序操作：Maa 开始',cfg,{admin:true,requestId:'one'});assert.equal(calls,before+1)
 const restarted=createComputerControl({run:fake,dataDir:dir});assert.match((await restarted('程序操作：Maa 开始',cfg,{admin:true,requestId:'one'})).text,/不重复/);assert.equal(calls,before+1)
 await handler('程序操作：Maa 开始',cfg,{admin:true,requestId:'old',messageTime:1});assert.equal(calls,before+1)
 await handler('程序操作：Maa 开始',{...cfg,computer:{...cfg.computer,allowActions:false}},{admin:true,requestId:'off'});assert.equal(calls,before+1)
 const file=path.join(dir,'readme.txt');fs.writeFileSync(file,'hello\napiKey=fixture-short-value');assert.match(readComputerFile({kind:'file',path:file},cfg),/凭据已隐藏/)
 assert.throws(()=>readComputerFile({kind:'file',path:path.join(dir,'config.json')},cfg),/凭据/)
 assert.throws(()=>readComputerFile({kind:'file',path:file},{computer:{fileRoots:[]}}),/允许读取/)
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'computer-outside-'));try{fs.writeFileSync(path.join(outside,'x.txt'),'outside');fs.symlinkSync(outside,path.join(dir,'outside'),'junction');assert.throws(()=>readComputerFile({kind:'file',path:path.join(dir,'outside','x.txt')},cfg),/允许读取/)}finally{fs.unlinkSync(path.join(dir,'outside'));fs.rmSync(outside,{recursive:true,force:true})}
 assert.match(formatComputerResult({kind:'resources'},{cpu:12,memoryTotal:100,memoryAvailable:40,sampleSeconds:1,network:[]}),/并非今日/)
 const groups=[],privateSends=[]
 bot=createChat(cfg,{computerHandler:handler,llmChat:async()=>{models++;throw Error('不应调用模型')},say:async(_c,g,m)=>groups.push(m),sayPrivate:async(_c,uid,m)=>privateSends.push({uid,m}),stateFile:null,logFile:path.join(dir,'chat.log'),privateDir:path.join(dir,'private'),logger:{}});bot.selfId('999')
 const ev=(id,uid=111,type='group',text='程序查询：Maa运行状态')=>({post_type:'message',message_type:type,group_id:123,user_id:uid,message_id:id,sender:{nickname:'fixture'},message:[{type:'text',data:{text}}]})
 assert.equal((await bot.handleEvent(ev(1))).spoke,true);assert.equal(privateSends[0].uid,'111');assert.equal(groups.length,1);assert.match(groups[0][0].data.text,/私聊/);assert.equal(models,0)
 const count=calls;await bot.handleEvent(ev(2,222));assert.equal(calls,count);assert.equal(privateSends.length,1)
 await bot.handleEvent(ev(3,111,'private','程序截图：Maa'));assert.equal(privateSends.length,2);assert.equal(privateSends[1].m[1].type,'image');assert.match(privateSends[1].m[1].data.file,/^base64:\/\//);await bot.handleEvent(ev(3,111,'private','程序截图：Maa'));assert.equal(privateSends.length,2,'QQ重复投递不重发')
 cfg.computer.groupResults=true
 await bot.handleEvent(ev(4));assert.equal(privateSends.length,2,'直接回群不再同时私聊');assert.match(groups.at(-1)[0].data.text,/任务已停止/)
 await bot.handleEvent(ev(5,111,'group','程序截图：Maa'));assert.equal(groups.at(-1)[1].type,'image');const groupCount=groups.length;await bot.handleEvent(ev(5,111,'group','程序截图：Maa'));assert.equal(groups.length,groupCount,'重复投递不重复发群截图')
 await bot.handleEvent(ev(6,222));assert.equal(groups.length,groupCount,'访客不能触发群查询')
 await bot.handleEvent(ev(7,111,'group','文件读取：'+file));assert.equal(privateSends.length,3);assert.match(privateSends.at(-1).m[0].data.text,/hello/);assert.match(groups.at(-1)[0].data.text,/私聊/);assert.ok(!groups.some(m=>m.some(s=>s.data?.text?.includes('hello'))),'文件正文不发群')
 assert.equal(fs.existsSync(path.join(dir,'private','111.json')),false,'本机结果不进入模型对话记忆')
 assert.deepEqual(validatePatch({'computer.enabled':true,'computer.fileRoots':[dir]}),{'computer.enabled':true,'computer.fileRoots':[dir]})
 console.log('本机助手通过：管理员验证、确定指令、零模型/概率独立、截图私聊/清理、Maa状态、按钮白名单、跨重启去重、过期拒绝、目录越界/链接越界/凭据保护、QQ真实入口与重复投递。无真实QQ发送或Maa操作。')
}finally{bot?.stop();fs.rmSync(dir,{recursive:true,force:true})}
