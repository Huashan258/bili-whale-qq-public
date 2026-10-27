import fs from 'node:fs'
import path from 'node:path'
import {spawn} from 'node:child_process'
import {DATA,ROOT} from './config.mjs'
import {reserveLocalVoiceSlot} from './gpt-sovits.mjs'
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
export function createNativeVoiceUi({dataDir=DATA,launch=spawn,request=fetch}={}){
  const receipt=path.join(dataDir,'voice-native-ui.json'),port=9874,url=`http://127.0.0.1:${port}`
  async function status(){let saved={};try{saved=JSON.parse(fs.readFileSync(receipt,'utf8'))}catch{};let online=false,occupied=false;try{const r=await request(url+'/config',{signal:AbortSignal.timeout(1200)});occupied=true;const c=await r.json();online=r.ok&&String(c.title??'').includes('GPT-SoVITS')}catch{};return {url,port,online,occupied,state:online?'ready':saved.pid&&alive(saved.pid)?'starting':'stopped',pid:saved.pid??null}}
  return {status,async start(cfg){
    const release=await reserveLocalVoiceSlot(path.join(dataDir,'voice-native-ui-start.lock'),AbortSignal.timeout(5000))
    try{const current=await status();if(current.online||current.state==='starting')return current;if(current.occupied)throw Error('9874已由其他应用占用')
      const root=path.resolve(cfg.chat?.voice?.localInstallDir||''),python=path.join(root,'runtime','python.exe');if(!cfg.chat?.voice?.localInstallDir||![python,path.join(root,'webui.py')].every(fs.existsSync))throw Error('先配置完整的GPT-SoVITS安装目录')
      fs.mkdirSync(dataDir,{recursive:true})
      const out=fs.openSync(path.join(dataDir,'voice-native-ui.out.log'),'a'),err=fs.openSync(path.join(dataDir,'voice-native-ui.err.log'),'a')
      try{const child=launch(python,['-I',path.join(ROOT,'scripts','native-voice-webui.py'),'--root',root,'--port',String(port)],{cwd:root,windowsHide:true,detached:true,stdio:['ignore',out,err],env:{...process.env,PATH:path.join(root,'runtime')+path.delimiter+process.env.PATH,PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1',GRADIO_ANALYTICS_ENABLED:'False',is_share:'False'}});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)});child.unref();fs.writeFileSync(receipt,JSON.stringify({pid:child.pid,root,url,startedAt:new Date().toISOString()}));return {...current,state:'starting',pid:child.pid}}finally{fs.closeSync(out);fs.closeSync(err)}
    }finally{release()}
  }}
}
