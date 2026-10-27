import {createRequire} from 'node:module'
import path from 'node:path'
import {AIRUNNING_ROOT} from './trpg-paths.mjs'
const require=createRequire(import.meta.url)
let detect
try{({isOutOfCharacter:detect}=require(path.join(AIRUNNING_ROOT,'dice-plugin','ooc.cjs')))}catch{detect=()=>false}
export const isNpcAside=message=>detect(message)
