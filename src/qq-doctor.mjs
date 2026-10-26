#!/usr/bin/env node
/**
 * QQ 链路自检：一条命令告诉你坏在哪一层。
 *
 *   node src/qq-doctor.mjs
 *
 * 依次检查：SnowLuma 进程 → WebUI → OneBot HTTP → 登录态 → 群列表
 * 任何一步失败都直接说下一步该做什么，不需要翻日志。
 */
import { buildConfig, readRawConfig } from './config.mjs'
import { ping } from './qq.mjs'

const c = buildConfig(readRawConfig())
const base = c.qq.onebotHttp.replace(/\/+$/, '')

const ok = (s) => console.log(`  ✓ ${s}`)
const bad = (s) => { console.log(`  ✗ ${s}`); process.exitCode = 1 }

async function head(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(1500) })
    return r.status
  } catch { return 0 }
}

console.log('\nQQ 链路自检\n')

// 1. WebUI（能开不代表注入成功，但关着就一定不行）
const webui = await head('http://127.0.0.1:5099/api/status')
webui ? ok(`SnowLuma WebUI 在跑（5099，HTTP ${webui}）`)
      : bad('SnowLuma 没启动。cd snowluma && ./node.exe index.mjs')

// 2. OneBot HTTP
const onebot = await head(base)
onebot ? ok(`OneBot HTTP 可达（${base}）`)
       : bad(`OneBot HTTP 连不上（${base}）。检查 WebUI 里 httpServer 是否启用、端口是否一致`)

if (onebot) {
  // 3. 登录态
  try {
    const me = await ping(c)
    ok(`已登录：${me.nickname}（${me.user_id}）`)
    console.log(`    accessToken 有效，可以发消息`)

    // 4. 群列表
    const r = await fetch(base + '/', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(c.qq.accessToken ? { authorization: `Bearer ${c.qq.accessToken}` } : {}),
      },
      body: JSON.stringify({ action: 'get_group_list', params: {} }),
      signal: AbortSignal.timeout(8000),
    })
    const j = await r.json()
    const groups = j.data ?? []
    if (!groups.length) bad('群列表为空。这个号还没加群，或者被风控限制了')
    else {
      const configured = new Set((c.qq.groupIds ?? []).map(String))
      ok(`群列表 ${groups.length} 个，配置里 ${configured.size} 个`)
      for (const g of groups) {
        const mark = configured.has(String(g.group_id)) ? '→' : ' '
        console.log(`    ${mark} ${g.group_id}  ${g.group_name}（${g.member_count} 人）`)
      }
      const missing = [...configured].filter((id) => !groups.some((g) => String(g.group_id) === id))
      if (missing.length) console.log(`    ⚠ 配置里有、但账号不在的群：${missing.join(', ')}`)
    }
  } catch (e) {
    bad(e.message)
  }
}

console.log()
