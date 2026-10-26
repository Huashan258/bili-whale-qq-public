#!/usr/bin/env node
/**
 * 不开网页也能把 key 写进本机 config.json。
 *
 *   node src/setkey.mjs sk-xxxxxxxx
 *   npm run setkey -- sk-xxxxxxxx
 *
 * 写完立即生效（agent 会热加载），下次启动也直接沿用。
 */
import { CONFIG_FILE, readRawConfig, writeRawConfig, buildConfig } from './config.mjs'

const key = String(process.argv[2] ?? '').trim().replace(/^['"]|['"]$/g, '')

if (!key) {
  console.log('用法：node src/setkey.mjs sk-xxxxxxxx')
  console.log('   或：npm run setkey -- sk-xxxxxxxx')
  process.exit(1)
}
if (!key.startsWith('sk-')) {
  console.log(`⚠ 这个值不像 key（应以 sk- 开头）：${key.slice(0, 6)}…  还是写进去了，自己确认一下。`)
}

const raw = readRawConfig()
raw.llm = raw.llm ?? {}
raw.llm.apiKey = key
if (!raw.llm.provider || raw.llm.provider === 'none') raw.llm.provider = 'deepseek'
if (!raw.llm.model) raw.llm.model = 'deepseek-chat'
if (!raw.llm.baseUrl) raw.llm.baseUrl = 'https://api.deepseek.com'

writeRawConfig(raw)

const c = buildConfig(readRawConfig())
const mask = c.llm.apiKey.length <= 8 ? '••••' : `${c.llm.apiKey.slice(0, 3)}…${c.llm.apiKey.slice(-4)}`

console.log('已写入本机配置：')
console.log(`  文件      ${CONFIG_FILE}`)
console.log(`  key       ${mask}（${c.llm.apiKey.length} 位）`)
console.log(`  模型      ${c.llm.provider} / ${c.llm.model}`)
console.log('')
console.log('正在运行的 agent 会在 2 秒内自动加载，不用重启。')
