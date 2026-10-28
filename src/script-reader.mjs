import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {AIRUNNING_ROOT,TRPG_ROOT,SCRIPT_FILE,DICE_FILE} from './trpg-paths.mjs'
import {diceGroups} from './dice-plugin.mjs'
let loaded
const library=()=>loaded??=import(pathToFileURL(path.join(AIRUNNING_ROOT,'dice-plugin','script-reader.mjs')).href+'?version=1').then(m=>m.createScriptReader({root:TRPG_ROOT,file:SCRIPT_FILE,diceFile:DICE_FILE})).catch(e=>{loaded=null;throw e})
export async function scriptLibrary(cfg){const groups=diceGroups(cfg);return {groups,...(await library()).list(groups)}}
export async function readScript(cfg,params){return (await library()).read({...params,allowedGroups:diceGroups(cfg)})}
export async function downloadScript(cfg,params){return (await library()).download({...params,allowedGroups:diceGroups(cfg)})}
