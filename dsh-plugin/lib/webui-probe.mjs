/**
 * WebUI 端口探测 —— `import('src/server.mjs')` **之前**先问一句：
 *   「`127.0.0.1:<port>` 上是不是已经有一个 bili-whale-qq 控制台在跑？」
 *
 * 为什么这十行是保命的（2026-10-20 QA 实测，`qa-webui.mjs`）：
 *   `src/server.mjs` 是 **import 即 listen**，端口被占时它在 `server.on('error')` 里
 *   自己判占用者；一旦判成「自己人」（`/api/status` 返回 `{"app":"bili-whale-qq"}`），
 *   它走的是 **`process.exit(0)`**（`src/server.mjs:764`）。
 *
 *   ⚠️ `process.exit()` 是**进程退出**，不是异常 —— 插件里
 *      `try { await import(...) } catch {}` **拦不住**（try/catch 只接 throw）。
 *      ⇒ 用户在设置页勾上「WebUI」，下次重启 DSH 时宿主**静默消失**，
 *        日志里还留着上一行「WebUI 已挂在 http://…」，完全查不出原因。
 *        用户的现场就是：7788 被 pid 8228 的 `src/server.mjs` 占着。
 *
 *   ⇒ 所以先探测，认成「自己人」就**根本不 import**，只在日志里说清楚。
 *
 * 另外这个模块**不 import 任何 src/**：它得能在探测本身出错时也不连累宿主（R1）。
 */
import { get } from 'node:http'

/** 控制台在 `/api/status` 里报的名字；`src/server.mjs` 的 `probe()` 也按这个字符串判「自己人」 */
export const APP_TAG = 'bili-whale-qq'

/** /api/status 的响应体上限：正常就几十字节，超过这个数只能是别人家的服务 */
const MAX_BODY = 64 * 1024

/**
 * 探一下端口上有没有人、是谁。
 *
 * 判定语义**刻意照抄** `src/server.mjs` 的 `probe()`（连不上 ⇒ free / 超时 ⇒ other /
 * JSON 里 `app` 对上 ⇒ ours / 其余 ⇒ other），免得两边对同一个端口得出不同结论。
 *
 * **永不 reject**：探测失败一律当成“没人占”（= 照旧 import，保持原来行为）。
 *
 * @param {number} port 目标端口
 * @param {{timeoutMs?: number, host?: string}} [opts]
 *   ⚠️ `timeoutMs` 必须 **≥ `src/server.mjs:730` 那个 probe 的 1200ms**，否则会留一条缝：
 *   控制台「活着但慢」时我们先超时判 `other` ⇒ 照旧 import ⇒ server.mjs 用 1200ms 再探到 `ours`
 *   ⇒ **照样 `process.exit(0)`**。插件里传的是 1500。默认值 800 只适合"快速判个大概"的场景。
 * @returns {Promise<'ours'|'other'|'free'>}
 */
export function probeConsole(port, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? 800)
  const host = String(opts.host ?? '127.0.0.1')
  return new Promise((settle) => {
    let done = false
    /** 只认第一次结论；后面 socket 关掉时的 error/close 一律忽略 */
    const finish = (verdict) => {
      if (done) return
      done = true
      settle(verdict)
    }
    try {
      const req = get({ host, port, path: '/api/status', timeout: timeoutMs }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          body += chunk
          if (body.length > MAX_BODY) {          // 别人家的服务可能一直吐，别把内存吃满
            body = ''
            try { req.destroy() } catch { /* 已经断了 */ }
            finish('other')
          }
        })
        res.on('end', () => {
          try {
            finish(JSON.parse(body).app === APP_TAG ? 'ours' : 'other')
          } catch {
            finish('other')                      // 不是 JSON ⇒ 不是控制台
          }
        })
        res.on('error', () => finish('other'))
      })
      req.on('timeout', () => { finish('other'); try { req.destroy() } catch { /* 已经断了 */ } })
      req.on('error', () => finish('free'))      // ECONNREFUSED / ENOTFOUND ⇒ 空端口
    } catch {
      finish('free')                             // 参数畸形之类，当他没人占
    }
  })
}

/**
 * 拿到探测结论之后：**该不该 import `src/server.mjs`**。
 *
 * 抽成纯函数是为了 selfcheck 能正反两面都验（`ours` ⇒ 不 import；`other`/`free` ⇒ 照旧 import），
 * 而不用在测试里真的把控制台启起来（那会顺带 `ensureSnowLuma()` + `agentHost.start()`）。
 *
 * @param {'ours'|'other'|'free'} verdict
 * @returns {{use: boolean, why: string}}
 */
export function decideWebUi(verdict) {
  if (verdict === 'ours') return { use: false, why: 'port-has-console' }
  return { use: true, why: verdict === 'other' ? 'port-has-other-app' : 'port-free' }
}
