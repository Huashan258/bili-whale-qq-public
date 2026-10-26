import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)

export function parseListeningPorts(text, pid) {
  const ports = new Set()
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols[0] !== 'TCP' || cols.at(-1) !== String(pid) || !/LISTEN/i.test(cols[3] ?? '')) continue
    const m = cols[1]?.match(/^(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]|\[::1\]):(\d+)$/)
    if (m) ports.add(Number(m[1]))
  }
  return [...ports]
}
export function createDshLink({ dataDir, listPorts = async pid => {
  if (process.platform !== 'win32') return []
  const { stdout } = await exec('netstat',['-ano','-p','tcp'],{ windowsHide:true,timeout:5000,maxBuffer:4*1024*1024 })
  return parseListeningPorts(stdout,pid)
}, fetcher = fetch } = {}) {
  let cached = null, checked = 0, pending = null
  function heartbeat() {
    try {
      const hb = JSON.parse(fs.readFileSync(path.join(dataDir,'dsh-plugin.json'),'utf8'))
      const age = Date.now() - Number(hb.heartbeat)
      return hb.running && hb.host === 'dsh-plugin' && age >= 0 && age < 90000 && Number.isInteger(hb.pid) && hb.pid > 0 ? hb : null
    } catch { return null }
  }
  async function getJSON(url) {
    const r = await fetcher(url,{signal:AbortSignal.timeout(1500)})
    if (!r.ok) throw new Error(`DSH HTTP ${r.status}`)
    return r.json()
  }
  async function read() {
    const hb = heartbeat()
    if (!hb) { cached=null; return null }
    if (cached?.pid === hb.pid && Date.now()-checked < 5000) return cached
    if (pending) return pending
    pending=(async()=>{
      try {
        const ports = cached?.pid === hb.pid ? [cached.port] : await listPorts(hb.pid)
        for (const port of ports) {
          try {
            const base=`http://127.0.0.1:${port}`
            const status=await getJSON(`${base}/api/whale/status`)
            if (!status.ok || status.pid !== hb.pid || !status.running) continue
            const cfg=await getJSON(`${base}/api/whale/config`)
            if (!cfg.ok || !cfg.config) continue
            cached={pid:hb.pid,port,base,config:cfg.config,status,heartbeat:hb}
            checked=Date.now(); return cached
          } catch { /* 同进程可能有其他端口，逐一验证插件身份 */ }
        }
      } catch { /* netstat 权限不足时退回本地共享文件 */ }
      cached=null; checked=Date.now(); return null
    })()
    try { return await pending } finally { pending=null }
  }
  return { read, heartbeat }
}
