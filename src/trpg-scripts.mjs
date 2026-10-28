import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {DATA,ROOT} from './config.mjs'
import {recordNpcGroup} from './dice-plugin.mjs'
import {AIRUNNING_ROOT,TRPG_ROOT,DICE_FILE,SCRIPT_FILE} from './trpg-paths.mjs'
export const SCRIPT_ROOT=TRPG_ROOT
const pendingTurns=new Map()
const plain=message=>typeof message==='string'?message:Array.isArray(message)?message.filter(s=>s?.type==='text').map(s=>s.data?.text??'').join(''):''
export function registerScriptTurns(group,message,turns){if(!group||!Array.isArray(turns)||!turns.length)return;for(const [key,v] of pendingTurns)if(v.until<Date.now())pendingTurns.delete(key);pendingTurns.set(String(group)+'\0'+plain(message),{turns,until:Date.now()+120000});if(pendingTurns.size>500)pendingTurns.delete(pendingTurns.keys().next().value)}
let engine
export function scripts(){return engine??=import(pathToFileURL(path.join(AIRUNNING_ROOT,'dice-plugin','scripts.mjs')).href+'?version=12').then(m=>m.createScripts({root:SCRIPT_ROOT,file:SCRIPT_FILE,diceFile:DICE_FILE})).catch(e=>{engine=null;throw e})}
async function recordBoth(entry){const results=await Promise.allSettled([(await scripts()).record(entry),recordNpcGroup(entry)]);const failed=results.find(r=>r.status==='rejected');if(failed)throw failed.reason;return results.map(r=>r.value)}
export async function recordScriptEvent(ev,{self=false}={}){if(ev.message_type!=='group')return;self||=ev.post_type==='message_sent';const message=ev.message??ev.raw_message,pending=self?pendingTurns.get(String(ev.group_id)+'\0'+plain(message)):null;return recordBoth({group:ev.group_id,uid:self?'':ev.user_id??ev.sender?.user_id??'',name:self?'青娥鱼':ev.sender?.card||ev.sender?.nickname||'',message,id:ev.message_id,...(self?{direction:'out',turns:pending?.until>Date.now()?pending.turns:undefined}:{})})}
export async function recordScriptSend(action,params,result,scriptText,scriptTurns){if(!params.group_id||!['send_group_msg','send_group_ai_record','send_msg'].includes(action))return;return recordBoth({group:params.group_id,name:'青娥鱼',direction:'out',turns:scriptTurns,id:result?.data?.message_id,message:params.message,text:scriptText!==undefined?'[语音] '+scriptText:action==='send_group_ai_record'?'[语音] '+params.text:undefined})}
