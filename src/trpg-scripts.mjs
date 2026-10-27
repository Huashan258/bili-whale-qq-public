import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {DATA,ROOT} from './config.mjs'
import {recordNpcGroup} from './dice-plugin.mjs'
import {AIRUNNING_ROOT,TRPG_ROOT,DICE_FILE,SCRIPT_FILE} from './trpg-paths.mjs'
export const SCRIPT_ROOT=TRPG_ROOT
let engine
export function scripts(){return engine??=import(pathToFileURL(path.join(AIRUNNING_ROOT,'dice-plugin','scripts.mjs')).href+'?version=11').then(m=>m.createScripts({root:SCRIPT_ROOT,file:SCRIPT_FILE,diceFile:DICE_FILE})).catch(e=>{engine=null;throw e})}
async function recordBoth(entry){const results=await Promise.allSettled([(await scripts()).record(entry),recordNpcGroup(entry)]);const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;return results.map(r=>r.value)}
export async function recordScriptEvent(ev){if(ev.message_type!=='group')return;return recordBoth({group:ev.group_id,uid:ev.user_id??ev.sender?.user_id??'',name:ev.sender?.card||ev.sender?.nickname||'',message:ev.message??ev.raw_message,id:ev.message_id})}
export async function recordScriptSend(action,params,result,scriptText){if(!params.group_id||!['send_group_msg','send_group_ai_record','send_msg'].includes(action))return;return recordBoth({group:params.group_id,name:'青娥鱼',direction:'out',id:result?.data?.message_id,message:params.message,text:scriptText!==undefined?'[语音] '+scriptText:action==='send_group_ai_record'?'[语音] '+params.text:undefined})}
