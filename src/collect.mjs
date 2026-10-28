/**
 * 采集层：把一条视频变成"可读的文字素材"。
 *
 * 温和模式只读视频元信息/简介与官方字幕，按全局队列串行请求。
 * 不拉全量弹幕或热评，不启动额外外部采集器。仅开启标签评论时，额外读取一次视频标签。
 *
 * 两个最容易踩的坑，这里都处理了：
 *  1) 字幕接口必须带登录 cookie + WBI 签名，否则 subtitle_url 缺 auth_key，CDN 403
 *  2) 无官方字幕时仅根据标题和简介判断，不追加抽帧/硬字幕请求。
 */
import { biliFetch, biliPolicy } from './bili-policy.mjs'
import crypto from 'node:crypto'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const MIXIN_TAB = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]

let wbiCache = { day: '', mixin: '' }
const today = () => new Date().toISOString().slice(0, 10)

async function getJSON(url, cookie, referer = 'https://www.bilibili.com/', opts = {}) {
  const r = await biliFetch(url, {
    headers: {
      'user-agent': UA,
      referer,
      ...(cookie ? { cookie } : {}),
    },
    isActive: opts.isActive,
    commandRead: opts.commandRead===true,
    signal: AbortSignal.timeout(20_000),
  })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return null }
}

export async function wbiMixin(cfg, opts = {}) {
  if (wbiCache.day === today() && wbiCache.mixin) return wbiCache.mixin
  const nav = await getJSON('https://api.bilibili.com/x/web-interface/nav', cfg.cookieHeader, undefined, opts)
  const img = nav?.data?.wbi_img
  if (!img) return ''
  const keyOf = (u) => u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('.'))
  const raw = keyOf(img.img_url ?? '') + keyOf(img.sub_url ?? '')
  const mixin = MIXIN_TAB.map((i) => raw[i]).join('').slice(0, 32)
  wbiCache = { day: today(), mixin }
  return mixin
}

export function sign(params, mixin) {
  const wts = Math.round(Date.now() / 1000)
  const all = { ...params, wts }
  const q = Object.keys(all).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex')
  return `${q}&w_rid=${w_rid}`
}

const viewCache = new Map()
async function fetchView(bvid, cfg, opts = {}) {
  const cached = viewCache.get(bvid)
  if (cached && cached.until > Date.now()) return cached.value
  const j = await getJSON(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, cfg.cookieHeader, undefined, opts)
  if (j?.code !== 0) throw new Error(`取视频信息失败：${j?.message ?? '未知'}（BV 号对吗？）`)
  const d = j.data
  const value = {
    bvid,
    aid: d.aid,
    cid: d.pages?.[0]?.cid,
    title: d.title,
    desc: d.desc ?? '',
    owner: d.owner?.name ?? '',
    ownerMid: String(d.owner?.mid ?? ''),
    tname: d.tname ?? '',
    duration: d.duration ?? 0,
    pubdate: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : '',
    stat: { view: d.stat?.view, like: d.stat?.like, danmaku: d.stat?.danmaku, reply: d.stat?.reply },
    pic: d.pic,
    pages: d.pages?.length ?? 1,
  }
  viewCache.set(bvid,{value,until:Date.now()+30*60000})
  return value
}

async function fetchSubtitle(video, cfg, opts = {}) {
  if (!video.cid) return { lines: [], note: '没有 cid' }
  const mixin = await wbiMixin(cfg, opts)
  if (!mixin) return { lines: [], note: '拿不到 WBI 密钥' }
  const q = sign({ bvid: video.bvid, cid: video.cid }, mixin)
  const j = await getJSON(`https://api.bilibili.com/x/player/wbi/v2?${q}`, cfg.cookieHeader, undefined, opts)
  const subs = j?.data?.subtitle?.subtitles ?? []
  if (!subs.length) return { lines: [], note: '无官方字幕轨（可能需要 --substrip 读硬字幕）' }

  const pick = subs.find((s) => s.lan === 'ai-zh') ?? subs.find((s) => s.lan === 'zh-CN') ?? subs[0]
  const url = String(pick.subtitle_url).startsWith('http') ? pick.subtitle_url : 'https:' + pick.subtitle_url
  const body = (await getJSON(url, undefined, undefined, opts))?.body ?? []
  return { lines: body.map((l) => l.content).filter(Boolean), lan: pick.lan, note: '' }
}

export async function collect(bvid, cfg, opts = {}) {
  if (opts.isActive && !opts.isActive()) throw Error('视频采集已停止')
  await biliPolicy.claim('watch', bvid, {commandRead:opts.commandRead===true})
  const video = await fetchView(bvid, cfg, opts)
  // 温和模式读取简介与官方字幕；仅标签评论开关开启时补读一次标签。
  const subtitle = await fetchSubtitle(video, cfg, opts)
  let tags=[],tagNote=''
  if(opts.readTags===true){try{const j=await getJSON(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`,cfg.cookieHeader,`https://www.bilibili.com/video/${bvid}/`,opts);if(j?.code!==0||!Array.isArray(j.data))throw Error('未取得视频标签');tags=j.data.map(t=>String(t.tag_name??'').trim()).filter(Boolean)}catch(e){if(e.biliPolicy||e.commentRisk)throw e;tagNote='标签读取未完成，不据标题猜测标签'}}
  const danmaku = [], comments = [], whale = null

  // 弹幕按内容聚合：重复出现的才是"热区"，比原序更有信息量
  const freq = new Map()
  for (const d of danmaku) freq.set(d, (freq.get(d) ?? 0) + 1)
  const hotDanmaku = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({ text: t, n }))

  return {
    video,
    tags,
    tagNote,
    subtitle,
    danmaku: { total: danmaku.length, hot: hotDanmaku.slice(0, 60), sample: danmaku.slice(0, 200) },
    comments,
    whale,
    collectedAt: new Date().toISOString(),
  }
}

const clip = (s, n) => (s.length <= n ? s : s.slice(0, Math.floor(n * 0.75)) + '\n……（中间省略）……\n' + s.slice(-Math.floor(n * 0.25)))

/** 压成喂给模型的纯文本。token 大头在字幕，所以这里做头尾截断而不是硬切。 */
export function toPromptText(m, llm = {}) {
  const v = m.video
  const L = []
  L.push(`标题：${v.title}`)
  L.push(`UP：${v.owner}｜分区：${v.tname}｜时长：${v.duration}s｜发布：${v.pubdate}`)
  L.push(`数据：播放 ${v.stat.view ?? '?'}｜点赞 ${v.stat.like ?? '?'}｜弹幕 ${v.stat.danmaku ?? '?'}｜评论 ${v.stat.reply ?? '?'}`)
  if (m.tags?.length) L.push(`标签：${m.tags.join(' / ')}`)
  if (v.desc) L.push(`简介：\n${clip(v.desc, 900)}`)

  if (m.subtitle?.lines?.length) {
    L.push(`\n【官方字幕 · ${m.subtitle.lines.length} 行】\n${clip(m.subtitle.lines.join(' '), llm.maxCharsSubtitle ?? 6000)}`)
  } else {
    L.push(`\n【无官方字幕】${m.subtitle?.note ?? ''}`)
  }

  if (m.danmaku?.total) {
    const hot = m.danmaku.hot.slice(0, 40).map((d) => d.text).join(' / ')
    L.push(`\n【弹幕 ${m.danmaku.total} 条 · 高频片段】\n${clip(hot, llm.maxCharsDanmaku ?? 1200)}`)
  }

  if (m.comments?.length) {
    L.push(`\n【热评】`)
    for (const c of m.comments.slice(0, llm.maxComments ?? 15)) {
      L.push(`· ${c.user}（${c.like}赞）：${clip(c.text, 160)}`)
    }
  }

  if (m.whale) L.push(`\n【whale 深读（含抽帧/字幕带）】\n${clip(m.whale, 5000)}`)
  return L.join('\n')
}

/** 只要视频元信息，不拉弹幕字幕。发送时用来取标题，比 collect 便宜得多。 */
export function videoInfo(bvid, cfg, opts = {}) {
  return fetchView(bvid, cfg, opts)
}

/**
 * 某个 UP 主的最新投稿，给定时任务自动选片用。
 * mid 是空间地址 https://space.bilibili.com/<mid> 里那串数字。
 */
export async function upLatest(mid, cfg, ps = 8) {
  const mixin = await wbiMixin(cfg, opts)
  if (!mixin) throw new Error('拿不到 WBI 密钥（B 站 nav 接口异常），稍后重试')
  const q = sign({ mid: String(mid), ps: String(ps), pn: '1', order: 'pubdate', platform: 'web', web_location: '1550101' }, mixin)
  const spaceUrl = `https://space.bilibili.com/${mid}/video`
  const api = `https://api.bilibili.com/x/space/wbi/arc/search?${q}`
  const j = await getJSON(api, cfg.cookieHeader, spaceUrl)
  if (!j) {
    throw new Error('空间投稿接口没返回 JSON（多半是 412 风控）。先填 bili.sessdata / bili_jct / buvid3，再试。')
  }
  if (j.code !== 0) {
    const hint = j.code === -352 ? '（-352 风控：需要登录 cookie，且频率别太高）' : ''
    throw new Error(`取 UP 主投稿失败：code=${j.code} ${j.message ?? '未知'}${hint}`)
  }
  const list = j.data?.list?.vlist ?? []
  return list.map((v) => ({
    bvid: v.bvid,
    aid: v.aid,
    title: v.title,
    created: v.created,
    play: v.play,
    length: v.length,
    duration: durToSec(v.length),
    author: v.author ?? '',
    mid: String(v.mid ?? mid),
    desc: v.description ?? '',
  }))
}

/**
 * 自己找片：热门 + 排行榜，都不需要登录 cookie。
 * 这一步只拿标题/数据，真正判断值不值得发要等 collect() 拿到素材之后。
 */
export async function discover(cfg, { limit = 20, maxAgeDays = 10 } = {}) {
  const urls = [
    `https://api.bilibili.com/x/web-interface/popular?ps=${limit}&pn=1`,
    'https://api.bilibili.com/x/web-interface/ranking?rid=0&day=3',
  ]
  const out = []
  const seen = new Set()
  const cutoff = Date.now() / 1000 - maxAgeDays * 86_400

  for (const u of urls.slice(0, 1)) {
    const j = await getJSON(u, cfg.cookieHeader)
    if (j?.code !== 0) continue
    for (const v of j.data?.list ?? []) {
      if (!v?.bvid || seen.has(v.bvid)) continue
      if (v.pubdate && v.pubdate < cutoff) continue
      seen.add(v.bvid)
      out.push({
        bvid: v.bvid,
        title: v.title ?? '',
        owner: v.owner?.name ?? '',
        play: v.stat?.view ?? 0,
        pubdate: v.pubdate ?? 0,
        tname: v.tname ?? '',
        from: u.includes('popular') ? '热门' : '排行榜',
      })
    }
  }
  return out
}

/** 去掉 B 站搜索结果里的高亮标签（标题会带 `<em class="keyword">…</em>`） */
function stripHtml(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .trim()
}

/** "12:34" / "1:02:03" → 秒。搜索结果里 duration 是这种字符串（不是数字）。 */
function durToSec(s) {
  const parts = String(s ?? '').split(':').map((n) => Number(n) || 0)
  if (!parts.length) return 0
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 关键词搜索 —— `dsh-bili-scroll` 那个 `bili_search` 在 whale 里的等价物。
 *
 * 实测（2026-10-20，未登录）：
 *  · **不需要登录**，但**必须带 buvid3** —— 不带的话 B 站直接回一段 HTML 风控页
 *    （不是 JSON，`getJSON` 会解出 null），看上去就像"接口挂了"一样。
 *    仅使用配置里的实际 cookie；缺少登录/设备凭据时不伪造，不短间隔重试。
 *  · 请求统一走温和队列；遇 412 立即全局冷却，不短间隔重试。
 *
 * @returns {Promise<Array<{bvid,aid,title,author,mid,play,danmaku,pubdate,duration,desc,from}>>}
 */
export async function search(cfg, { keyword, page = 1, order = '', limit = 20, isActive, commandRead=false } = {}) {
  const kw = String(keyword ?? '').trim()
  if (!kw) throw new Error('关键词是空的')

  const cookie = cfg.cookieHeader || ''

  // ⚠️ order 留空 = 让 B 站用默认的**综合排序**。实测传 'pubdate'（按发布时间）
  //    搜出来的多半是刚发布的无关视频（搜「街霸6」出来 Apex 切片），挑片质量明显变差。
  const q = new URLSearchParams({ search_type: 'video', keyword: kw, page: String(page) })
  if (order) q.set('order', order)
  const url = `https://api.bilibili.com/x/web-interface/search/type?${q}`
  const ref = 'https://search.bilibili.com/'

  const j = await getJSON(url, cookie, ref, {isActive,commandRead})
  if (!j) throw new Error(`搜索「${kw}」没返回 JSON（多半是 412 风控），稍后再试`)
  if (j.code !== 0) throw new Error(`搜索「${kw}」失败：code=${j.code} ${j.message ?? '未知'}`)

  return (j.data?.result ?? []).slice(0, limit).map((v) => ({
    bvid: v.bvid,
    aid: v.aid,
    title: stripHtml(v.title),
    author: v.author ?? '',
    mid: String(v.mid ?? ''),
    play: Number(v.play) || 0,
    danmaku: Number(v.video_review) || 0,
    pubdate: Number(v.pubdate) || 0,
    duration: durToSec(v.duration),
    desc: stripHtml(v.description),
    from: `搜索：${kw}`,
  }))
}
// Bilibili conversation integration: shared gentle policy and persistent reply tracking.

// QQ command and explicit video integration, 2026-10-21.

// Explicit QQ search supplies verified source summaries before reply generation.
