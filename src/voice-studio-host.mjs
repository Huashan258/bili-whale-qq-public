import fs from 'node:fs'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {DATA} from './config.mjs'
import {localVoiceEndpoint,reserveLocalVoiceSlot} from './gpt-sovits.mjs'
import {startLocalVoice,localVoiceOnline} from './local-voice-host.mjs'
import {trainingPaused,setTrainingMode} from './voice-studio-config.mjs'
const exec=promisify(execFile)
async function pythonProcesses(){if(process.platform!=='win32')return [];const r=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$p=Get-CimInstance Win32_Process -Filter \"Name='python.exe'\";ConvertTo-Json -Compress -InputObject @($p | Select-Object ProcessId,ExecutablePath,CommandLine)"],{windowsHide:true,maxBuffer:1024*1024});return JSON.parse(r.stdout||'[]')}
const norm=s=>String(s??'').replaceAll('\\','/').toLowerCase()
export function createVoiceStudioHost({dataDir=DATA,inspect=pythonProcesses,kill=pid=>process.kill(pid),request=fetch,online=localVoiceOnline,start=startLocalVoice}={}){
 const rootOf=cfg=>path.resolve(cfg.chat?.voice?.localInstallDir||'.')
 function models(cfg){const root=rootOf(cfg),gpt=[],sovits=[];for(const dir of fs.readdirSync(root,{withFileTypes:true})){if(!dir.isDirectory()||!/^(?:GPT|SoVITS)_weights(?:_v[\w]+)?$/.test(dir.name))continue;for(const name of fs.readdirSync(path.join(root,dir.name))){const file=path.join(root,dir.name,name);if(fs.statSync(file).isFile()&&/\.(?:ckpt|pth)$/.test(name))(name.endsWith('.ckpt')?gpt:sovits).push({name:dir.name+'/'+name,path:file})}}return {gpt,sovits}}
 function active(cfg){try{return JSON.parse(fs.readFileSync(path.join(dataDir,'voice-active-model.json'),'utf8'))}catch{};const root=rootOf(cfg),source=fs.readFileSync(path.join(root,'GPT_SoVITS','configs','tts_infer.yaml'),'utf8'),custom=source.split(/(?=^\S)/m).find(s=>s.startsWith('custom:'))||'';const field=k=>{const value=custom.match(new RegExp('^  '+k+':\\s*(.+)$','m'))?.[1];if(!value)return '';let name=value;try{name=JSON.parse(value)}catch{}return path.resolve(root,name)};return {gpt:field('t2s_weights_path'),sovits:field('vits_weights_path')}}
 async function workers(cfg){const root=norm(rootOf(cfg));return (await inspect()).filter(p=>norm(p.CommandLine).includes(root)&&/(?:s[12]_train|inference_webui|[123]-get-(?:text|hubert|semantic|sv)|asr|denoise|uvr5|slice_audio)/i.test(p.CommandLine)).map(p=>({pid:p.ProcessId,kind:/inference_webui/i.test(p.CommandLine)?'原版推理':'训练或数据处理'}))}
 async function pause(cfg){const release=await reserveLocalVoiceSlot(path.join(dataDir,'gpt-sovits-inference.lock'),AbortSignal.timeout(15000));try{let saved={};try{saved=JSON.parse(fs.readFileSync(path.join(dataDir,'gpt-sovits-api.json'),'utf8'))}catch{};const processes=await inspect(),p=processes.find(p=>p.ProcessId===saved.pid),root=rootOf(cfg);const managed=p&&norm(saved.dir)===norm(root)&&norm(p.ExecutablePath)===norm(path.join(root,'runtime','python.exe'))&&norm(p.CommandLine).includes(norm(path.join(root,'api_v2.py')));if(p&&!managed||await online(cfg)&&!managed)throw Error('API进程身份无法核验，请先手动关闭后再进入训练模式')
  setTrainingMode(true,dataDir);try{if(p)await kill(saved.pid)}catch(e){setTrainingMode(false,dataDir);throw Error('未能停止受管API，未进入训练模式')};return {trainingMode:true,stoppedApi:Boolean(p)}
 }finally{release()}}
 async function resume(cfg){const busy=await workers(cfg);if(busy.length)throw Error('请先在原版面板停止训练、数据处理或原版推理，再恢复机器人API');if(trainingPaused(dataDir)&&await online(cfg))await pause(cfg);setTrainingMode(false,dataDir);return {trainingMode:false,...await start(cfg,{dataDir})}}
 async function apply(cfg,{gpt,sovits}){
  const available=models(cfg);if(!available.gpt.some(m=>m.path===gpt)||!available.sovits.some(m=>m.path===sovits))throw Error('请选择扫描列表中的GPT和SoVITS权重');if(trainingPaused(dataDir))throw Error('先结束训练并恢复对话模式，再应用权重')
  const release=await reserveLocalVoiceSlot(path.join(dataDir,'gpt-sovits-inference.lock'),AbortSignal.timeout(180000)),previous=active(cfg),base=localVoiceEndpoint(cfg.chat?.voice?.localApiUrl)
  const load=async(kind,file)=>{const r=await request(base+'/set_'+kind+'_weights?weights_path='+encodeURIComponent(file),{signal:AbortSignal.timeout(120000),redirect:'error'});if(!r.ok)throw Error('加载'+kind+'权重失败')}
  let touched=false,targets=[]
  try{
   if(trainingPaused(dataDir))throw Error('先结束训练并恢复对话模式，再应用权重')
   const source=fs.readFileSync(path.join(rootOf(cfg),'GPT_SoVITS','configs','tts_infer.yaml'),'utf8'),parts=source.split(/(?=^\S)/m),index=parts.findIndex(s=>s.startsWith('custom:'))
   if(index<0||!/^  t2s_weights_path:/m.test(parts[index])||!/^  vits_weights_path:/m.test(parts[index]))throw Error('启动配置缺少custom权重字段')
   parts[index]=parts[index].replace(/^  t2s_weights_path:.*$/m,'  t2s_weights_path: '+JSON.stringify(gpt)).replace(/^  vits_weights_path:.*$/m,'  vits_weights_path: '+JSON.stringify(sovits))
   const value={gpt,sovits,at:Date.now()};fs.mkdirSync(dataDir,{recursive:true})
   targets=[['gpt-sovits-studio.yaml',parts.join('')],['voice-active-model.json',JSON.stringify(value)]].map(([name,text])=>{const file=path.join(dataDir,name);return {file,text,old:fs.existsSync(file)?fs.readFileSync(file):null}})
   touched=true;await load('gpt',gpt);await load('sovits',sovits)
   for(const t of targets){fs.writeFileSync(t.file+'.tmp',t.text);fs.renameSync(t.file+'.tmp',t.file)}
   return value
  }catch(e){
   for(const t of targets)try{if(t.old===null){if(fs.existsSync(t.file))fs.unlinkSync(t.file)}else fs.writeFileSync(t.file,t.old);if(fs.existsSync(t.file+'.tmp'))fs.unlinkSync(t.file+'.tmp')}catch{}
   if(touched)try{await load('gpt',previous.gpt);await load('sovits',previous.sovits)}catch{setTrainingMode(true,dataDir);throw Error('切换失败且旧权重未能恢复，已暂停自动推理；请停止受管API后重新恢复')}
   throw Error(touched?'切换或保存失败，已恢复之前的权重':e.message)
  }finally{release()}
 }

 return {models,active,workers,pause,resume,apply,trainingMode:()=>trainingPaused(dataDir)}
}
