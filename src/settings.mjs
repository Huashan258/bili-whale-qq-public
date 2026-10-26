import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fields, overlayMap } from '../public/settings-schema.js'
import { readUiCfg } from '../dsh-plugin/lib/uicfg.mjs'

const get = (obj, key) => key.split('.').reduce((v, k) => v?.[k], obj)
const set = (obj, key, value) => {
  const parts = key.split('.')
  let cur = obj
  for (const k of parts.slice(0, -1)) cur = cur[k] ??= {}
  cur[parts.at(-1)] = value
}
const validPaths = new Map(fields.map(f => [f.path, f]))
export function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置补丁必须是对象')
  const out = {}
  for (const [key, v] of Object.entries(patch)) {
    const f = validPaths.get(key)
    if (!f) throw new Error(`未知设置：${key}`)
    const fail = () => { throw new Error(`${f.label}：格式或范围不正确`) }
    if(key==='chat.voice.instruction'&&(typeof v!=='string'||[...v].reduce((n,c)=>n+(/\p{Script=Han}/u.test(c)?2:1),0)>100))fail()
    if (f.type === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < f.min || v > f.max) fail()
      if (!/temperature|speakChance|Minutes|\.chance$/i.test(key) && !Number.isInteger(v)) fail()
      if (key === 'share.replyPatrolMinutes' && v > 0 && v < 5) fail()
    } else if (f.type === 'boolean') {
      if (typeof v !== 'boolean') fail()
    } else if (f.type === 'hours') {
      if (!Array.isArray(v) || ![0,2].includes(v.length) || v.some(x => !Number.isInteger(x) || x < 0 || x > 23)) fail()
    } else if (f.type === 'list') {
      if (!Array.isArray(v) || v.length > 500 || v.some(x => typeof x !== 'string' || x.length > 2000)) fail()
      if(key==='scroll.reactionKeywords'&&(v.length>30||v.some(x=>!x.trim()||x.length>32)))fail()
    } else if (f.type === 'masters') {
      if (!Array.isArray(v) || v.length > 100) fail()
      const seen = new Set()
      for (const m of v) {
        if (!m || typeof m !== 'object' || !/^\d{4,}$/.test(String(m.mid ?? '')) || seen.has(String(m.mid))) fail()
        if (Object.keys(m).some(k => !['mid','name','autoComment','replyComments'].includes(k))) fail()
        if (m.name !== undefined && (typeof m.name !== 'string' || m.name.length > 100)) fail()
        for (const k of ['autoComment','replyComments']) if (m[k] !== undefined && typeof m[k] !== 'boolean') fail()
        seen.add(String(m.mid))
      }
    } else {
      if (typeof v !== 'string' || v.length > (f.type === 'long' ? 8000 : 2000)) fail()
      if (f.type === 'secret' && !v.trim()) continue
    }
    if (f.type === 'select' && !f.options.some(option=>option.value === v)) fail()
    if(key==='chat.voice.localApiUrl'){
      try{const u=new URL(v);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['','/'].includes(u.pathname))fail()}catch{fail()}
    }
    if (key === 'llm.provider' && !['deepseek','openai','workbuddy','none'].includes(v)) fail()
    if (['llm.baseUrl','qq.onebotHttp','qq.wsUrl'].includes(key)) {
      try { const u = new URL(v); if (!(key.endsWith('wsUrl') ? ['ws:','wss:'] : ['http:','https:']).includes(u.protocol)) fail() } catch { fail() }
    }
    out[key] = v
  }
  return out
}

export function createSettingsStore({ configFile, overlayFile, backupDir }) {
  const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '{}'
  const revision = () => createHash('sha256').update(read(configFile)).update('\0').update(read(overlayFile)).digest('hex')
  function snapshot(dsh = null) {
    const raw = JSON.parse(read(configFile))
    const overlay = readUiCfg(overlayFile)
    const values = {}, secrets = {}
    for (const f of fields) {
      let v = get(raw, f.path) ?? f.value
      const remote = dsh?.config?.[overlayMap[f.path]]
      const ov = remote !== undefined && remote !== '' && !(typeof remote === 'number' && remote < 0) ? remote : overlay[overlayMap[f.path]]
      if (ov !== undefined) {
        v = ['list','hours'].includes(f.type) ? String(ov).split(/[,，\s]+/).filter(Boolean) : ov
        if (f.type === 'hours') v = v.map(Number)
      }
      if (f.type === 'secret') { secrets[f.path] = Boolean(get(raw, f.path)); continue }
      values[f.path] = v
    }
    values['chat.shield.adminMaxOutputTokens'] = values['chat.shield.maxOutputTokens'] * 3
    let runtime = null
    try { runtime = JSON.parse(read(path.join(path.dirname(overlayFile), 'dsh-plugin.json'))) } catch { /* 尚未启动 */ }
    for (const [key,hbKey] of [['enabled','enabled'],['dry','dry'],['qqEnabled','qq']]) {
      if (overlay[key] === undefined && typeof runtime?.[hbKey] === 'boolean') values[`runtime.${key}`] = runtime[hbKey]
    }
    return { values, secrets, revision: revision(), configFile, runtime, source:dsh ? {kind:'dsh',pid:dsh.pid,url:dsh.base} : {kind:'local'} }
  }
  function save({ patch, revision: expected } = {}) {
    if (!expected || expected !== revision()) throw new Error('配置已被其他页面或进程修改，请重新读取后再保存。你的编辑仍保留在页面中。')
    const changes = validatePatch(patch)
    const raw = JSON.parse(read(configFile)), overlay = JSON.parse(read(overlayFile))
    for (const [key,v] of Object.entries(changes)) {
      if (!key.startsWith('runtime.')) set(raw,key,v)
      if (overlayMap[key]) overlay[overlayMap[key]] = Array.isArray(v) ? v.join(',') : v
    }
    raw.chat ??= {}; raw.chat.shield ??= {}
    raw.chat.shield.adminMaxOutputTokens = Math.min(20000,Math.max(32,Number(raw.chat.shield.maxOutputTokens??260)||260))*3
    if (changes['qq.groupIds']) raw.chat = { ...raw.chat, groups: [...changes['qq.groupIds']] }
    if (!Object.keys(changes).length) return { ok:true, changed:0, ...snapshot() }
    // 先完整校验，再备份和替换；回写失败时恢复另一份，避免静默只存一半。
    const oldConfig = read(configFile), oldOverlay = read(overlayFile)
    fs.mkdirSync(backupDir,{recursive:true})
    fs.writeFileSync(path.join(backupDir,`${Date.now()}.json`), JSON.stringify({ config: JSON.parse(oldConfig), overlay: JSON.parse(oldOverlay) },null,2))
    function atomic(file, contents) {
      fs.mkdirSync(path.dirname(file),{recursive:true})
      const tmp = `${file}.${process.pid}.tmp`
      try { fs.writeFileSync(tmp,contents,'utf8'); fs.renameSync(tmp,file) }
      finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
    }
    try {
      atomic(overlayFile,JSON.stringify(overlay,null,2))
      atomic(configFile,JSON.stringify(raw,null,2))
    } catch (e) {
      atomic(overlayFile,oldOverlay); atomic(configFile,oldConfig)
      throw e
    }
    for (const name of fs.readdirSync(backupDir).filter(n => /^\d+\.json$/.test(n)).sort().reverse().slice(10)) fs.unlinkSync(path.join(backupDir,name))
    return { ok:true, changed:Object.keys(changes).length, ...snapshot() }
  }
  return { snapshot, save }
}
