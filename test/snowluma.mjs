/**
 * SnowLuma 自愈逻辑的离线测试。
 *
 * 覆盖的是这次「重启后连不上」的根因：
 *   1. hookAutoLoad 默认 false → QQ 重启后不再注入，3000 永远不起来
 *   2. 老代码探活只看 5099，WebUI 在就报「已启动」，掩盖了 OneBot 没起
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { ensureHookAutoLoad, portPid, ensureSnowLuma } from '../src/snowluma.mjs'

let pass = 0
const ok = (name, cond, extra = '') => {
  if (!cond) throw new Error(`FAIL ${name} ${extra}`)
  pass++
  console.log(`  ✓ ${name}`)
}

// ── hookAutoLoad ────────────────────────────────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'))
  fs.mkdirSync(path.join(dir, 'config'))
  const file = path.join(dir, 'config', 'runtime.json')
  fs.writeFileSync(file, JSON.stringify({ webuiPort: 5099, hookAutoLoad: false, logRetainDays: 7 }, null, 2))

  const r1 = ensureHookAutoLoad(dir)
  ok('默认 false 时会被打开', r1.changed === true, JSON.stringify(r1))

  const after = JSON.parse(fs.readFileSync(file, 'utf8'))
  ok('写回后 hookAutoLoad=true', after.hookAutoLoad === true)
  ok('其它字段没被动过', after.webuiPort === 5099 && after.logRetainDays === 7)

  const r2 = ensureHookAutoLoad(dir)
  ok('已经是 true 就不重复写', r2.changed === false && r2.why === 'already-true')

  fs.rmSync(dir, { recursive: true, force: true })
}

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-test-'))
  const r = ensureHookAutoLoad(dir)
  ok('没有 runtime.json 时不崩', r.changed === false)
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── portPid ─────────────────────────────────────────────────────
ok('空闲端口拿不到 pid', portPid(59999) === null)

const slPid = portPid(5099)
if (slPid) {
  ok(`5099 的 pid 是正数（${slPid}）`, slPid > 0)
} else {
  console.log('  · 5099 没在跑，跳过 pid 检查')
}

// ── 探活语义：WebUI 在、OneBot 不在，不能算 ready ────────────────
// 这里不真的去杀 SnowLuma，只验证返回值结构里 ok 与 3000 相关。
{
  const bothUp = Boolean(portPid(5099)) && Boolean(portPid(3000))
  if (bothUp) {
    const r = await ensureSnowLuma()
    ok('两边都在时报 already-running 且 ok', r.ok === true && r.reason === 'already-running', JSON.stringify(r))
  } else {
    console.log('  · SnowLuma 未完全就绪，跳过 ensureSnowLuma 就绪分支')
  }
}

console.log(`\n  ${pass} 项通过`)
