// 所有写入都指向系统临时目录；不连接模型、QQ 或 B站。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSettingsStore, validatePatch } from '../src/settings.mjs'
import { UI_FIELDS } from '../dsh-plugin/lib/uicfg.mjs'
import { fields, overlayMap } from '../public/settings-schema.js'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(),'whale-settings-'))
try {
  const configFile=path.join(tmp,'config.json'), overlayFile=path.join(tmp,'whale-ui.json')
  fs.writeFileSync(configFile,JSON.stringify({ llm:{apiKey:'secret-fixture',provider:'deepseek'}, chat:{persona:'原人设',shield:{dailyTokens:999}}, scroll:{tags:['旧题材']},_说明:'保留未知说明' }))
  fs.writeFileSync(overlayFile,JSON.stringify({temperature:1.7,scrollTags:'覆盖题材',dry:false}))
  const store=createSettingsStore({configFile,overlayFile,backupDir:path.join(tmp,'backups')})
  let snap=store.snapshot()
  assert.equal(JSON.stringify(snap).includes('secret-fixture'),false)
  assert.equal(snap.secrets['llm.apiKey'],true)
  assert.equal(snap.values['chat.temperature'],1.7)
  assert.deepEqual(snap.values['scroll.tags'],['覆盖题材'])
  const before=snap.revision
  const result=store.save({revision:before,patch:{'chat.temperature':0.9,'chat.shield.longFormMaxOutputTokens':3200,'chat.contextMessages':0,'chat.historyRestore':0,'scroll.tags':['新题材'],'qq.groupIds':['123456'],'llm.apiKey':'','chat.taboo':'','share.replyPatrolMinutes':5,'runtime.dry':true}})
  const raw=JSON.parse(fs.readFileSync(configFile)), overlay=JSON.parse(fs.readFileSync(overlayFile))
  assert.equal(raw.llm.apiKey,'secret-fixture')
  assert.equal(raw.chat.shield.longFormMaxOutputTokens,3200)
  assert.equal(raw.chat.shield.dailyTokens,999)
  assert.deepEqual(raw.chat.groups,['123456'])
  assert.equal(overlay.temperature,0.9)
  assert.equal(overlay.longFormMaxOutputTokens,3200)
  assert.equal(overlay.scrollTags,'新题材')
  assert.equal(overlay.dry,true)
  assert.equal(overlay.replyPatrolMinutes,5)
  assert.equal(raw._说明,'保留未知说明')
  assert.equal(result.values['chat.contextMessages'],0)
  assert.throws(()=>store.save({revision:before,patch:{'chat.nick':'冲突'}}),/其他页面/)
  for (const patch of [{'chat.shield.dailyTokens':-1},{'chat.contextMessages':1.5},{'runtime.dry':'false'},{'share.replyPatrolMinutes':0.1},{'chat.quietHours':[25,8]},{'qq.wsUrl':'http://localhost'},{'__proto__.polluted':true},{'bili.masters':[ {mid:'1234',name:'a'}, {mid:'1234'} ]}]) assert.throws(()=>validatePatch(patch))
  assert.deepEqual(validatePatch({'chat.quietHours':[],'scroll.tags':[],'share.replyPatrolMinutes':0}),{'chat.quietHours':[],'scroll.tags':[],'share.replyPatrolMinutes':0})
  assert.deepEqual(validatePatch({'chat.longFormTemperature':.6}),{'chat.longFormTemperature':.6},'长文温度必须允许小数')
  const unchanged=fs.readFileSync(configFile,'utf8')
  assert.throws(()=>store.save({revision:store.snapshot().revision,patch:{'chat.nick':'不会部分保存','chat.temperature':9}}))
  assert.equal(fs.readFileSync(configFile,'utf8'),unchanged)
  for(let i=0;i<12;i++) store.save({revision:store.snapshot().revision,patch:{'chat.nick':`test${i}`}})
  assert.ok(fs.readdirSync(path.join(tmp,'backups')).length<=10)
  for(const key of Object.values(overlayMap)) assert.ok(UI_FIELDS.includes(key),`DSH 白名单缺少 ${key}`)
  assert.equal(new Set(fields.map(f=>f.path)).size,fields.length)
  console.log(`设置验证通过：${fields.length} 个字段；凭据不回传、嵌套合并、零值、DSH 同步、冲突保护、拒绝非法输入、备份保留。`)
} finally {
  fs.rmSync(tmp,{recursive:true,force:true})
}
