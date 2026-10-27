/**
 * 人设页新增字段的可用性检查（无头 Edge + CDP）。
 * 只验三件事：字段渲染出来了、值填对了、改完保存能落到服务端。
 *
 *   node test/ui-shield-test.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7795'
const CDP = 'http://127.0.0.1:9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const errors = []
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
})
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Page.enable'); await send('Runtime.enable')
await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` })
await sleep(2500)

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return r?.result?.value ?? r?.exceptionDetails?.text ?? null
}

// 切到人设页
await ev(`document.querySelector('button[data-view="persona"]').click()`)
await sleep(600)

const filled = await ev(`(() => ({
  titles: document.querySelector('#p-admin-titles').value,
  on: document.querySelector('#p-shield-on').checked,
  maxinput: document.querySelector('#p-shield-maxinput').value,
  maxtokens: document.querySelector('#p-shield-maxtokens').value,
  percall: document.querySelector('#p-shield-percall').value,
  windowmin: document.querySelector('#p-shield-window').value,
  cooldownmin: document.querySelector('#p-shield-cooldown').value,
  tease: document.querySelector('#p-shield-tease').value.split('\\n').filter(Boolean).length,
}))()`)
console.log('字段回填:', JSON.stringify(filled))

// 改一个值，保存，再读回来
const OLD = filled.maxtokens
await ev(`document.querySelector('#p-shield-maxtokens').value = '210'`)
await ev(`document.querySelector('#btn-persona-save').click()`)
await sleep(1800)

const after = await (await fetch(`${BASE}/api/persona`)).json()
console.log('保存后 maxOutputTokens =', after.shield?.maxOutputTokens, after.shield?.maxOutputTokens === 210 ? '✓' : '✗')
console.log('管理员称呼 =', JSON.stringify(after.adminTitles))

// 还原
await ev(`document.querySelector('#p-shield-maxtokens').value = '${OLD}'`)
await ev(`document.querySelector('#btn-persona-save').click()`)
await sleep(1200)
const back = await (await fetch(`${BASE}/api/persona`)).json()
console.log('已还原 =', back.shield?.maxOutputTokens)

console.log('JS 异常:', errors.length ? errors : '无')
ws.close()
