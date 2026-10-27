/**
 * 用真实鼠标事件（CDP Input.dispatchMouseEvent）点击「保存」，
 * 检查是不是被遮罩层挡住、点击根本没落在按钮上。
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7793'
const NEWKEY = process.argv[3] ?? 'fixture-ui-key-not-a-real-secret'
const CDP = 'http://127.0.0.1:9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
const ws = new WebSocket(target.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const sent = []
const exceptions = []

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id); return }
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/config')) {
    sent.push(m.params.request.postData ?? '')
  }
  if (m.method === 'Runtime.exceptionThrown') {
    exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)
  }
})
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id
  pending.set(mid, res)
  ws.send(JSON.stringify({ id: mid, method, params }))
})
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')

await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` })
await sleep(2500)

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  return r?.result?.value ?? r?.exceptionDetails?.text ?? null
}

await ev(`document.querySelector('#btn-settings').click()`)
await sleep(300)
await ev(`(() => { const i = document.querySelector('#s-apikey'); i.focus(); i.value = ${JSON.stringify(NEWKEY)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1 })()`)
await sleep(200)

// 保存按钮的位置 + 那个点上最顶层的元素是谁
const info = await ev(`(() => {
  const b = document.querySelector('#btn-save')
  const r = b.getBoundingClientRect()
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  const hit = document.elementFromPoint(x, y)
  const mask = document.querySelector('#mask')
  const drawer = document.querySelector('#settings')
  return {
    x, y,
    hit: hit ? (hit.id || hit.className || hit.tagName) : 'null',
    maskZ: getComputedStyle(mask).zIndex,
    drawerZ: getComputedStyle(drawer).zIndex,
    maskHidden: mask.hidden,
    drawerHidden: drawer.hidden,
  }
})()`)
console.log('按钮命中情况:', JSON.stringify(info))

await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: info.x, y: info.y })
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 })
await sleep(2500)

const after = await ev(`(() => ({
  toast: document.querySelector('#toast')?.textContent ?? '',
  drawerHidden: document.querySelector('#settings').hidden,
  state: document.querySelector('#s-apikey-state')?.textContent ?? '',
}))()`)
console.log('真实点击之后:', JSON.stringify(after))
console.log('发出的 body:', sent.length ? sent[sent.length - 1].slice(0, 120) + '…' : '(没发)')
console.log('JS 异常:', exceptions.length ? exceptions : '无')
ws.close()
