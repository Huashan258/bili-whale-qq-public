/**
 * 用无头 Edge + CDP 跑一遍「设置里填 key → 点保存」，验证前端真的把值发出去了。
 * 只用于本地排查，不参与正常运行。
 *
 *   node test/ui-save-test.mjs [baseUrl] [newKey]
 */
const BASE = process.argv[2] ?? 'http://127.0.0.1:7793'
const NEWKEY = process.argv[3] ?? 'fixture-ui-key-not-a-real-secret'
const CDP = 'http://127.0.0.1:9333'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let target
  for (let i = 0; i < 30; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
      if (target?.webSocketDebuggerUrl) break
    } catch { /* 等 Edge 起来 */ }
    await sleep(500)
  }
  if (!target) throw new Error('连不上 Edge 的调试端口 9333')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const sent = []
  const errors = []

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg.result ?? msg.error)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Network.requestWillBeSent' && msg.params.request.url.includes('/api/config')) {
      sent.push(msg.params.request.postData ?? '(无 body)')
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '))
    }
  })

  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id
    pending.set(mid, res)
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

  await new Promise((r) => ws.addEventListener('open', r, { once: true }))
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Network.enable')

  await send('Page.navigate', { url: `${BASE}/?t=${Date.now()}` })
  await sleep(2500)

  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    return r?.result?.value ?? r?.exceptionDetails?.text ?? null
  }

  // 打开设置、填 key、点保存
  const opened = await evalJS(`(() => {
    const b = document.querySelector('#btn-settings')
    if (!b) return 'no #btn-settings'
    b.click()
    const d = document.querySelector('#settings')
    return d && !d.hidden ? 'opened' : 'drawer hidden'
  })()`)

  await sleep(300)
  const typed = await evalJS(`(() => {
    const i = document.querySelector('#s-apikey')
    if (!i) return 'no input'
    i.focus()
    i.value = ${JSON.stringify(NEWKEY)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
    return i.value.slice(-4)
  })()`)

  await sleep(200)
  const clicked = await evalJS(`(() => {
    const b = document.querySelector('#btn-save')
    if (!b) return 'no #btn-save'
    b.click()
    return 'clicked'
  })()`)

  await sleep(2500)

  const after = await evalJS(`(() => ({
    toast: document.querySelector('#toast')?.textContent ?? '',
    state: document.querySelector('#s-apikey-state')?.textContent ?? '',
    input: document.querySelector('#s-apikey')?.value ?? '',
  }))()`)

  console.log('打开设置:', opened)
  console.log('输入尾号:', typed)
  console.log('点保存:', clicked)
  console.log('发出的 /api/config body:', sent.length ? sent[sent.length - 1] : '(一个都没发出)')
  console.log('保存后界面:', JSON.stringify(after))
  console.log('页面 JS 报错:', errors.length ? errors : '无')

  ws.close()
}

main().catch((e) => { console.error(e); process.exit(1) })
