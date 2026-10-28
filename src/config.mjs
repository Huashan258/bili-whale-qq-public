import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// import.meta.dirname 要 Node >= 20.11；老版本上是 undefined，
// 会让 ROOT 变成 "E:\.."，然后整个进程秒退且看不出原因。这里兜一层。
const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))

export const ROOT = path.resolve(HERE, '..')

/**
 * 数据目录。默认 <项目>/.data。
 *
 * 设 BILI_WHALE_DATA 可以指到别处——**测试必须指走**。
 * 2026-10-19 真踩过：test/bili-patrol.mjs 跑完把假 state（aid=170001、rpid=R1）写进了真实
 * .data/state.json，巡检拿着这个假 aid 去翻别人的视频，主人在我们评论底下回的「oi」两小时没回。
 * 现在测试统一把 BILI_WHALE_DATA 指到临时目录，真实 state 不再被测试碰。
 */
export const DATA = process.env.BILI_WHALE_DATA
  ? path.resolve(process.env.BILI_WHALE_DATA)
  : path.join(ROOT, '.data')
export const CONFIG_FILE = path.join(ROOT, 'config.json')
export const EXAMPLE_FILE = path.join(ROOT, 'config.example.json')

export function expandHome(p) {
  if (!p) return p
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p
}

/** "env:FOO" → process.env.FOO；其余原样返回 */
export function deref(v) {
  if (typeof v !== 'string') return v
  if (v.startsWith('env:')) return process.env[v.slice(4)] ?? ''
  return expandHome(v)
}

/** config.json 不存在时回落 example，这样 WebUI 可以先把界面拉起来再让用户填 */
export function readRawConfig() {
  const f = fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : EXAMPLE_FILE
  return JSON.parse(fs.readFileSync(f, 'utf8'))
}

export function writeRawConfig(obj) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2), 'utf8')
}

/**
 * 「主人」UP 名单。支持三种写法：
 *   "887000007"、{ mid: "887000007", name: "示例管理员" }、以及直接粘空间链接（自动抠 mid）。
 * autoComment=false 只影响「自动去B站发评论」，不影响称呼和放宽挑选。
 */
export function normalizeMasters(v) {
  if (!v) return []
  const arr = Array.isArray(v) ? v : String(v).split(/[,，\s]+/)
  return arr.map((x) => {
    if (x && typeof x === 'object') {
      return {
        mid: String(x.mid ?? x.uid ?? '').trim(),
        name: String(x.name ?? '').trim(),
        autoComment: x.autoComment !== false,
        // 只回复主人视频评论区里的人。默认关——这是最容易被当成机器人的一件事。
        replyComments: x.replyComments === true,
      }
    }
    const s = String(x).trim()
    const m = s.match(/(\d{4,})/)
    return { mid: m ? m[1] : '', name: '', autoComment: true, replyComments: false }
  }).filter((x) => x.mid)
}

export function masterOf(cfg, mid) {
  const k = String(mid ?? '')
  return (cfg?.masters ?? []).find((m) => m.mid === k) ?? null
}

/** 把原始 JSON 解析成运行时配置（解引用 env:、拼 cookie 串） */
export function buildConfig(raw) {
  const cookie = {
    sessdata: deref(raw.bili?.sessdata),
    bili_jct: deref(raw.bili?.bili_jct),
    buvid3: deref(raw.bili?.buvid3),
  }

  // 三件套不在 env 里时，退回去读 dsh-bili-whale 的凭据文件
  if (!cookie.sessdata && raw.bili?.cookie_file) {
    const cf = expandHome(raw.bili.cookie_file)
    if (fs.existsSync(cf)) {
      try {
        const c = JSON.parse(fs.readFileSync(cf, 'utf8'))
        cookie.sessdata ||= c.sessdata ?? c.SESSDATA ?? ''
        cookie.bili_jct ||= c.bili_jct ?? c.biliJct ?? ''
        cookie.buvid3 ||= c.buvid3 ?? c.BUVID3 ?? ''
      } catch { /* 凭据损坏就当没有 */ }
    }
  }

  return {
    raw,
    cookie,
    cookieHeader: [
      cookie.sessdata && `SESSDATA=${cookie.sessdata}`,
      cookie.bili_jct && `bili_jct=${cookie.bili_jct}`,
      cookie.buvid3 && `buvid3=${cookie.buvid3}`,
      raw.bili?.dedeUserId && `DedeUserID=${raw.bili.dedeUserId}`,
    ].filter(Boolean).join('; '),
    masters: normalizeMasters(raw.bili?.masters),
    llm: {
      ...raw.llm,
      apiKey: deref(raw.llm?.apiKey),
      baseUrl: (raw.llm?.baseUrl ?? '').replace(/\/+$/, ''),
    },
    qq: { ...raw.qq, accessToken: deref(raw.qq?.accessToken) },
    chat: { ...(raw.chat ?? {}) },
    vision: { enabled:true, maxImages:3, detail:'auto', ...(raw.vision ?? {}) },
    diary: { ...(raw.diary ?? {}) },
    computer: { ...(raw.computer ?? {}) },
    biliInbox: { ...(raw.biliInbox ?? {}) },
    share: { ...(raw.share ?? {}) },
    /** 刷B站（从 dsh-bili-scroll 移植过来的那一轮）。默认值在 scroll-duty.mjs 的 DEFAULTS 里兜底。 */
    scroll: { ...(raw.scroll ?? {}) },
    guard: raw.guard ?? {},
    whale: { dir: deref(raw.whale?.dir), ffmpeg: deref(raw.whale?.ffmpeg) },
  }
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    throw new Error(`缺少配置文件：${CONFIG_FILE}\n先执行：cp config.example.json config.json`)
  }
  return buildConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
}

export function ensureData() {
  fs.mkdirSync(DATA, { recursive: true })
  return DATA
}

/** 简单的按天计数 + 视频去重，落在 .data/state.json */
export function loadState() {
  ensureData()
  const f = path.join(DATA, 'state.json')
  const today = new Date().toISOString().slice(0, 10)
  let s = { day: today, sharedToday: 0, seen: {} }
  if (fs.existsSync(f)) {
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { /* 重建 */ }
  }
  if (s.day !== today) Object.assign(s, { day: today, sharedToday: 0 })
  s.seen ??= {}
  s.commented ??= {}
  s.commentDaily ??= { day: today, byMid: {} }
  return s
}

export function saveState(s) {
  ensureData()
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify(s, null, 2))
}

export function log(...a) {
  console.log(...a)
}
// Bilibili conversation integration: shared gentle policy and persistent reply tracking.
