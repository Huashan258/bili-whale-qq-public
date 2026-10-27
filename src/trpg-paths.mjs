import path from 'node:path'
import fs from 'node:fs'
import {DATA,ROOT} from './config.mjs'
const sibling=path.resolve(ROOT,'..','airunning')
export const AIRUNNING_ROOT=fs.existsSync(path.join(sibling,'dice-plugin','index.mjs'))?sibling:path.join(ROOT,'integrations','airunning')
// Tests with an isolated host DATA must never touch the user's real TRPG files.
export const TRPG_ROOT=path.resolve(DATA)===path.join(ROOT,'.data')?AIRUNNING_ROOT:path.join(DATA,'airunning')
export const TRPG_DATA=path.join(TRPG_ROOT,'.data')
export const DICE_FILE=path.join(TRPG_DATA,'trpg-dice.json')
export const SCRIPT_FILE=path.join(TRPG_DATA,'trpg-scripts.json')
export const NPC_MEMORY_ROOT=path.join(TRPG_ROOT,'npc-memory')
