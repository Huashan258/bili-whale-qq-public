import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {ROOT} from './config.mjs'
import {AIRUNNING_ROOT,TRPG_DATA,DICE_FILE,SCRIPT_FILE,NPC_MEMORY_ROOT} from './trpg-paths.mjs'
export {NPC_MEMORY_ROOT} from './trpg-paths.mjs'
export const DICE_ROOT=path.join(AIRUNNING_ROOT,'dice-plugin')
let loaded
export function loadDiceModule(){return loaded??=import(pathToFileURL(path.join(DICE_ROOT,'index.mjs')).href+'?version=10').catch(e=>{loaded=null;throw e})}
let catalogueReady;const theatreModule=async()=>{const m=await import(pathToFileURL(path.join(DICE_ROOT,'theatre.mjs')).href+'?version=10');await (catalogueReady??=m.createTheatre({file:DICE_FILE,memoryRoot:NPC_MEMORY_ROOT,memoryAllowed:g=>m.scriptMemoryAllowed(SCRIPT_FILE,g)}).migrateCatalog().catch(e=>{catalogueReady=null;throw e}));return m}
let memoryRecorder
export async function recordNpcGroup(entry){const mod=await theatreModule();memoryRecorder??=mod.createTheatre({file:DICE_FILE,memoryRoot:NPC_MEMORY_ROOT,memoryAllowed:g=>mod.scriptMemoryAllowed(SCRIPT_FILE,g)});return memoryRecorder.recordGroup(entry)}
export async function npcMemory(cfg,group,name){if(!diceGroups(cfg).includes(String(group)))throw Error('请选择白名单中的群');const mod=await theatreModule();return mod.createTheatre({file:DICE_FILE,memoryRoot:NPC_MEMORY_ROOT,memoryAllowed:g=>mod.scriptMemoryAllowed(SCRIPT_FILE,g)}).memoryStatus(group,name)}
export function createDiceAdapter({dataDir=TRPG_DATA}={}){
 let instance,theatre
 return async(ev,context)=>{const mod=await loadDiceModule(),tm=await theatreModule();const tc=tm.theatreCommand(ev.message);if(tc){const ats=Array.isArray(ev.message)?ev.message.filter(s=>s.type==='at').map(s=>String(s.data?.qq)): [...String(ev.message).matchAll(/\[CQ:at,qq=([^,\]]+)/g)].map(m=>m[1]);if(ats.some(id=>id!==String(context.selfId)))return {handled:true,spoke:false,why:'指向其他用户'};theatre??=tm.createTheatre({file:path.join(dataDir,'trpg-dice.json'),memoryRoot:path.resolve(dataDir)===path.resolve(TRPG_DATA)?NPC_MEMORY_ROOT:path.join(dataDir,'npc-memory'),memoryAllowed:g=>tm.scriptMemoryAllowed(path.resolve(dataDir)===path.resolve(TRPG_DATA)?SCRIPT_FILE:path.join(dataDir,'trpg-scripts.json'),g)});return theatre.handle(ev,context)}if(!mod.diceCommand(ev.message))return {handled:false};instance??=mod.createDicePlugin({file:path.join(dataDir,'trpg-dice.json')});return instance.handleEvent(ev,context)}
}
export async function diceStatus(groups=[]){await theatreModule();const mod=await loadDiceModule();return {...mod.createDicePlugin({file:DICE_FILE}).status(groups),help:mod.HELP,installed:fs.existsSync(path.join(DICE_ROOT,'index.mjs'))}}
export function diceGroups(cfg){return [...new Set([...(cfg.qq?.groupIds??[]),...(cfg.chat?.groups??[])].map(String))]}
export async function setDiceKeeper(cfg,body){const group=String(body.group??'');if(!diceGroups(cfg).includes(group))throw Error('请选择当前白名单中的群');const mod=await loadDiceModule();return mod.createDicePlugin({file:DICE_FILE}).setKeeper(group,body.clear===true?null:body.uid,{name:body.name,operator:'webui'})}
export async function clearDicePlayers(confirm){if(confirm!=='CLEAR_DICE_PLAYERS')throw Error('清理全部玩家记录需要明确确认');const mod=await loadDiceModule();return mod.createDicePlugin({file:DICE_FILE}).clearPlayers()}
export async function diceTheatre(cfg,body){const group=String(body.group??'');if(!diceGroups(cfg).includes(group))throw Error('请选择当前白名单中的群');const mod=await theatreModule();return mod.createTheatre({file:DICE_FILE,memoryRoot:NPC_MEMORY_ROOT,memoryAllowed:g=>mod.scriptMemoryAllowed(SCRIPT_FILE,g)}).change(group,body)}
export async function diceTheatreDefaults(){return (await theatreModule()).THEATRE_DEFAULTS}

export async function editNpcMemory(cfg,body){const group=String(body.group??'');if(!diceGroups(cfg).includes(group))throw Error('请选择白名单中的群');const m=await theatreModule();return m.createTheatre({file:DICE_FILE,memoryRoot:NPC_MEMORY_ROOT,memoryAllowed:g=>m.scriptMemoryAllowed(SCRIPT_FILE,g)}).replaceMemory(group,String(body.name??''),body.text)}
