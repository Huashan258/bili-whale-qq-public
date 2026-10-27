/**
 * 检查「检查登录」按钮与设置抽屉的可用性（无头 Edge + CDP）。
 *   node test/ui-bili-test.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7793'
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

console.log('打开抽屉:', await ev(`(() => { document.querySelector('#btn-settings').click(); return document.querySelector('#settings').hidden ? '失败' : '成功' })()`))
console.log('抽屉里的按钮:', await ev(`(() => ({
  save: !!document.querySelector('#btn-save'),
  saveVisible: (() => { const r = document.querySelector('#btn-save').getBoundingClientRect(); return r.top > 0 && r.bottom <= innerHeight })(),
  biliLogin: !!document.querySelector('#btn-bili-login'),
  biliCheck: !!document.querySelector('#btn-bili-check'),
}))()`))

await ev(`document.querySelector('#btn-bili-check').click()`)
await sleep(3500)
console.log('检查结果:', await ev(`document.querySelector('#bili-login-note').textContent`))
console.log('JS 异常:', errors.length ? errors : '无')
ws.close()
