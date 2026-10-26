import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const root=path.resolve(import.meta.dirname,'..')
const read=f=>fs.readFileSync(path.join(root,f),'utf8')
const cfg=JSON.parse(read('config.example.json')),pkg=JSON.parse(read('package.json'))
assert.equal(pkg.license,'MIT');assert.equal(JSON.parse(read('dsh-plugin/package.json')).license,'MIT')
assert.match(read('LICENSE'),/MIT License/)
for(const a of [cfg.bili.masters,cfg.qq.groupIds,cfg.chat.admins,cfg.chat.groups,cfg.scroll.privateUsers,cfg.scroll.groupIds,cfg.scroll.biliPrivateUsers])assert.deepEqual(a,[])
for(const flag of [cfg.share.enabled,cfg.scroll.enabled,cfg.diary.autoEnabled,cfg.diary.publishEnabled,cfg.biliInbox.enabled,cfg.biliInbox.mentionsEnabled,cfg.vision.enabled,cfg.chat.enabled])assert.equal(flag,false)
assert.equal(cfg.share.replyPatrolMinutes,0);assert.equal(cfg.chat.voice.instruction,'');assert.equal(cfg.chat.voice.boostDb,0)
assert.equal(cfg.qq.wsToken,'');assert.equal(cfg.bili.cookie_file,'')
for(const k of ['localInstallDir','localReferenceAudio','localPromptText'])assert.equal(cfg.chat.voice[k],'')
assert.equal(cfg.chat.voice.localAutoStart,false);assert.equal(cfg.chat.voice.localGainDb,0)
function credentials(o){for(const [k,v]of Object.entries(o??{})){if(/api.?key|token|password|sessdata|bili_jct|buvid/i.test(k)&&typeof v==='string')assert.ok(!v||v.startsWith('env:'),'Credential literal in config');if(v&&typeof v==='object')credentials(v)}}credentials(cfg)
for(const f of ['config.json','.env','HANDOVER.md','项目总览与维护指南.md','public/assets/whale/portrait.png'])assert.equal(fs.existsSync(path.join(root,f)),false,'Private file included: '+f)
const excluded=new Set(['.git','.data','node_modules','book','words','biaoqingbao','.idea','tmp'])
let checked=0
function scan(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(excluded.has(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())scan(p);else{const b=fs.readFileSync(p);if(b.includes(0))continue;checked++;const s=b.toString('utf8');assert.ok(!/\b(?:sk-(?:ws-)?[A-Za-z0-9_.-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{35,})\b/.test(s),'Credential pattern: '+path.relative(root,p));assert.ok(!/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/.test(s),'Private key: '+p)}}}scan(root)
for(const file of ['README.md','THIRD_PARTY_NOTICES.md'])for(const [,link]of read(file).matchAll(/\]\(([^)]+)\)/g)){if(!/^https?:/.test(link))assert.ok(fs.existsSync(path.join(root,link)),link)}
assert.match(read('public/index.html'),/\/assets\/whale\/portrait\.svg/)
assert.doesNotMatch(read('src/snowluma.mjs'),/export const SL_DIR = .*['"][A-Z]:/)
console.log(`公开版检查通过：${checked}个文本文件，MIT与上游许可入口、空账号/令牌、默认关闭发布、链接及通用路径。`)
