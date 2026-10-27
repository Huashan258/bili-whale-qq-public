import fs from 'node:fs'
import path from 'node:path'
import {DATA} from './config.mjs'
export const STUDIO_PARAMETERS={top_k:15,top_p:1,temperature:1,text_split_method:'cut5',seed:-1,batch_size:1,parallel_infer:false,repetition_penalty:1.35,split_bucket:true,fragment_interval:.3,sample_steps:32,speed_factor:1}
const ranges={top_k:[1,100,true],top_p:[.01,1],temperature:[.1,2],seed:[-1,2147483647,true],batch_size:[1,8,true],repetition_penalty:[1,2],fragment_interval:[.1,1],sample_steps:[4,128,true],speed_factor:[.5,2]}
function atomic(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(value,null,2));fs.renameSync(tmp,file)}
export function validateStudioParameters(input={}){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('推理参数格式不正确')
 const out={};for(const [k,v]of Object.entries(input)){
  if(k==='text_split_method'){if(!['cut0','cut1','cut2','cut3','cut4','cut5'].includes(v))throw Error('切句方式不支持')}
  else if(['parallel_infer','split_bucket'].includes(k)){if(typeof v!=='boolean')throw Error(k+'须为开关值')}
  else{const r=ranges[k];if(!r||typeof v!=='number'||!Number.isFinite(v)||v<r[0]||v>r[1]||r[2]&&!Number.isInteger(v))throw Error('推理参数超出范围：'+k)}
  out[k]=v
 }return out
}
export function readStudioParameters(dataDir=DATA){try{return {...STUDIO_PARAMETERS,...validateStudioParameters(JSON.parse(fs.readFileSync(path.join(dataDir,'voice-studio-parameters.json'),'utf8')))}}catch(e){if(e.code==='ENOENT')return {...STUDIO_PARAMETERS};throw e}}
export function saveStudioParameters(input,dataDir=DATA){const parameters={...STUDIO_PARAMETERS,...validateStudioParameters(input)};atomic(path.join(dataDir,'voice-studio-parameters.json'),parameters);return parameters}
export function trainingPaused(dataDir=DATA){try{return JSON.parse(fs.readFileSync(path.join(dataDir,'voice-training-mode.json'),'utf8')).enabled===true}catch{return false}}
export function setTrainingMode(enabled,dataDir=DATA){atomic(path.join(dataDir,'voice-training-mode.json'),{enabled,at:Date.now()})}
