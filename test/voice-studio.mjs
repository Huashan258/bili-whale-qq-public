import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {EventEmitter} from 'node:events'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'voice-studio-'));process.env.BILI_WHALE_DATA=dir
const {validateStudioParameters,readStudioParameters,saveStudioParameters,setTrainingMode,trainingPaused}=await import('../src/voice-studio-config.mjs')
const {createVoiceStudioHost}=await import('../src/voice-studio-host.mjs')
const {createNativeVoiceUi}=await import('../src/voice-native-ui.mjs')
const {createGptSovits}=await import('../src/gpt-sovits.mjs')
const {createLocalVoiceWatchdog}=await import('../src/local-voice-watch.mjs')
try{
 assert.equal(validateStudioParameters({top_p:.65}).top_p,.65)
 for(const p of [{seed:1.5},{speed_factor:8},{streaming_mode:true},{ref_audio_path:'private'},{top_k:0}])assert.throws(()=>validateStudioParameters(p))
 saveStudioParameters({speed_factor:1.1,seed:42},dir);assert.equal(readStudioParameters(dir).seed,42)
 setTrainingMode(true,dir);let requests=0
 await assert.rejects(createGptSovits({dataDir:dir,request:async()=>{requests++}})('测试',{}),e=>e.voiceReason==='training-paused');assert.equal(requests,0)
 const watch=createLocalVoiceWatchdog({config:()=>({chat:{voice:{provider:'gpt-sovits',localAutoStart:true}}}),isTraining:()=>trainingPaused(dir),ensure:async()=>{throw Error('训练模式不启动API')}});await watch.start();assert.equal(watch.status().phase,'training-paused');watch.stop();setTrainingMode(false,dir)
 const root=path.join(dir,'install'),g=path.join(root,'GPT_weights_v2Pro'),s=path.join(root,'SoVITS_weights_v2Pro');for(const p of [g,s,path.join(root,'runtime'),path.join(root,'GPT_SoVITS','configs')])fs.mkdirSync(p,{recursive:true})
 for(const f of [path.join(g,'old.ckpt'),path.join(g,'new.ckpt'),path.join(s,'old.pth'),path.join(s,'new.pth'),path.join(root,'runtime','python.exe'),path.join(root,'webui.py')])fs.writeFileSync(f,'fixture')
 const yaml='custom:\n  device: cuda\n  t2s_weights_path: GPT_weights_v2Pro/old.ckpt\n  vits_weights_path: SoVITS_weights_v2Pro/old.pth\nv1:\n  device: cpu\n';fs.writeFileSync(path.join(root,'GPT_SoVITS','configs','tts_infer.yaml'),yaml)
 const cfg={chat:{voice:{localInstallDir:root,localApiUrl:'http://127.0.0.1:9880'}}},old={gpt:path.join(g,'old.ckpt'),sovits:path.join(s,'old.pth')},next={gpt:path.join(g,'new.ckpt'),sovits:path.join(s,'new.pth')}
 let fail=false,loads=[],processes=[],kills=[],starts=0
 const host=createVoiceStudioHost({dataDir:dir,inspect:async()=>processes,kill:async pid=>kills.push(pid),online:async()=>false,start:async()=>{starts++;return {state:'starting'}},request:async u=>{loads.push(u);if(fail&&u.includes('set_sovits')&&decodeURIComponent(u).includes('old.pth'))return new Response('',{status:400});return new Response('{}')}})
 await host.apply(cfg,next);assert.deepEqual({gpt:host.active(cfg).gpt,sovits:host.active(cfg).sovits},next);assert.equal(fs.readFileSync(path.join(root,'GPT_SoVITS','configs','tts_infer.yaml'),'utf8'),yaml,'原配置不覆盖')
 assert.match(fs.readFileSync(path.join(dir,'gpt-sovits-studio.yaml'),'utf8'),/new\.ckpt/)
 fail=true;await assert.rejects(host.apply(cfg,old),/已恢复/);assert.equal(host.active(cfg).gpt,next.gpt);assert.ok(decodeURIComponent(loads.at(-1)).includes('new.pth'));assert.equal(trainingPaused(dir),false)
 await assert.rejects(host.apply(cfg,{gpt:'outside',sovits:next.sovits}),/扫描列表/)
 fs.writeFileSync(path.join(dir,'gpt-sovits-api.json'),JSON.stringify({pid:43210,dir:root}));processes=[{ProcessId:43210,ExecutablePath:'C:/unrelated/python.exe',CommandLine:'other.py'}]
 await assert.rejects(host.pause(cfg),/身份/);assert.deepEqual(kills,[],'PID复用不得误杀')
 processes=[{ProcessId:43210,ExecutablePath:path.join(root,'runtime','python.exe'),CommandLine:path.join(root,'api_v2.py')}];await host.pause(cfg);assert.deepEqual(kills,[43210]);assert.equal(trainingPaused(dir),true)
 processes=[{ProcessId:55,CommandLine:path.join(root,'GPT_SoVITS','s2_train.py')}];await assert.rejects(host.resume(cfg),/先在原版/);assert.equal(trainingPaused(dir),true)
 processes=[];await host.resume(cfg);assert.equal(starts,1);assert.equal(trainingPaused(dir),false)
 let args,opts
 const native=createNativeVoiceUi({dataDir:path.join(dir,'native'),request:async()=>{throw Error('offline')},launch:(bin,a,o)=>{args=a;opts=o;const e=new EventEmitter();e.pid=12345;e.unref=()=>{};setTimeout(()=>e.emit('spawn'),1);return e}})
 await native.start(cfg);assert.ok(args.includes('--root'));assert.equal(opts.windowsHide,true);assert.equal(opts.env.is_share,'False');assert.ok(args.some(a=>a.endsWith('native-voice-webui.py')))
 console.log('语音工作台通过：高级参数与小数/未知字段拒绝、训练暂停合成和看门狗、模型列表/原配置保留/专用启动配置、失败回滚、PID复用保护、训练任务未停禁止恢复、原版UI隐藏启动/禁公网分享。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
