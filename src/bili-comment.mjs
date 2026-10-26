/**
 * B 站发评论。单独拎出来，是因为这件事「看起来简单、实际到处都是坑」：
 *
 *  1) oid 要的是 aid（数字），不是 BV 号。历史记录里没有 aid 时必须现查一次。
 *  2) csrf 要和 cookie 里的 bili_jct 完全一致，body 里放一份、query 里再放一份最稳。
 *  3) 少了 DedeUserID / origin，风控会认不出这是登录态，直接 -412。
 *  4) B 站对「同一账号短时间发多条」很敏感，所以这里只做单次尝试，不重试、不并发。
 *
 * 出错时把 code 翻成人话，省得每次都要去查 -412 是什么意思。
 */
import { biliFetch } from './bili-policy.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { DATA, ensureData } from './config.mjs'
import { videoInfo } from './collect.mjs'
import { commentJSON, isCommentRisk } from './comment-response.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const API = 'https://api.bilibili.com/x/v2/reply/add'

const HINTS = {
  '-101': 'SESSDATA 失效了，重新扫码登录一次',
  '-111': 'csrf 校验失败（bili_jct 和 SESSDATA 不是同一次登录的），重登一次',
  '-352': '风控校验失败，停一会儿再试，别连着发',
  '-412': '被风控拦了，停手，过几小时再说',
  '-400': '参数不对（多半是 oid 传成了 BV 号）',
  '12002': '评论太频繁，等几分钟',
  '12015': '这个号还不能评论（需要绑定手机号/等级不够）',
  '12051': '评论被折叠了，换个说法',
  '12061': '内容不合法或为空',
}

function explain(code, message) {
  const h = HINTS[String(code)]
  return `code=${code} ${message ?? ''}${h ? `｜${h}` : ''}`
}

function logLine(obj) {
  try {
    ensureData()
    fs.appendFileSync(path.join(DATA, 'comment.log'), JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n')
  } catch { /* 日志失败不影响主流程 */ }
}

/**
 * 发一条评论。
 * @returns {Promise<{ok: true, rpid: string, aid: string}>}
 */
export async function addComment(cfg, { bvid, aid, text, root = 0, parent = 0,isActive=()=>true }) {
  const msg = String(text ?? '').trim()
  if (!msg) throw new Error('评论是空的')
  if (msg.length > 1000) throw new Error(`评论 ${msg.length} 字，超过 B 站 1000 字上限`)

  const jct = cfg.cookie?.bili_jct
  if (!jct) throw new Error('缺 bili_jct，没法发评论（去设置里重新扫码登录）')
  if (!cfg.cookie?.sessdata) throw new Error('缺 SESSDATA，没登录')

  let oid = String(aid ?? '').trim()
  let title = ''
  if (!oid || !/^\d+$/.test(oid)) {
    if (!bvid) throw new Error('既没有 aid 也没有 bvid，不知道发到哪条视频')
    const info = await videoInfo(bvid, cfg)
    oid = String(info.aid ?? '')
    title = info.title ?? ''
    if (!oid) throw new Error(`查不到 ${bvid} 的 aid`)
  }

  const body = new URLSearchParams({ type: '1', oid, message: msg, csrf: jct })
  if (root) body.set('root', String(root))
  if (parent) body.set('parent', String(parent))

  let res
  try {
    res = await biliFetch(`${API}?csrf=${encodeURIComponent(jct)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cfg.cookieHeader,
        origin: 'https://www.bilibili.com',
        referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : `https://www.bilibili.com/video/av${oid}/`,
        'user-agent': UA,
      },
      body,
      signal: AbortSignal.timeout(20_000),
      isActive,
    })
  } catch (e) {
    logLine({ ok: false, oid, bvid, why: `网络错误 ${e.message}` })
    throw new Error(`连不上 B 站：${e.message}`)
  }

  let j
  try {j=await commentJSON(res)} catch(e) {
    logLine({ok:false,oid,bvid,http:res.status,why:e.message})
    throw e
  }
  if (j.code !== 0) {
    logLine({ ok: false, oid, bvid, code: j.code, message: j.message })
    throw new Error(`发评论失败：${explain(j.code, j.message)}`)
  }

  const rpid = String(j.data?.rpid ?? j.data?.rpid_str ?? '')
  logLine({ ok: true, oid, bvid, rpid, title })
  return { ok: true, rpid, aid: oid, title, toast: j.data?.success_toast ?? '' }
}

/**
 * 读视频的评论区（一级评论，按时间倒序）。
 * 返回的 root/parent 原样保留：回一级评论时 root=parent=rpid，回到楼中楼时 root 取根。
 */
export async function listRecentComments(cfg, { bvid, aid, ps = 20, pages = 1, request = biliFetch }) {
  const oid = String(aid ?? '').trim()
  if (!oid) throw new Error('没有 aid，读不了评论区')
  const out = []
  for (let pn = 1; pn <= Math.max(1, pages); pn++) {
    const url = `https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(oid)}&sort=0&ps=${Math.min(20, ps)}&pn=${pn}`
    let j = null
    try {
      const r = await request(url, {
        headers: {
          cookie: cfg.cookieHeader,
          referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
          'user-agent': UA,
        },
        signal: AbortSignal.timeout(15_000),
      })
      j = await commentJSON(r)
    } catch (e) {
      if (e.commentClosed || isCommentRisk(e)) throw e
      if (out.length) break
      throw new Error(`读评论区失败：${e.message}`)
    }
    if (!j || j.code !== 0) {
      if (out.length) break
      if (j?.code === -404) throw new Error('评论区不存在或已关闭')
      if (j?.code === 12002) throw new Error('code=12002 评论区读取太频繁')
      throw new Error(`读评论区失败：${explain(j?.code, j?.message)}`)
    }
    const arr = j?.data?.replies ?? []
    if (!arr.length) break
    out.push(...arr.map((r) => ({
      rpid: String(r.rpid ?? ''),
      root: String(r.root || r.rpid || '0'),
      parent: String(r.rpid ?? '0'),
      mid: String(r.mid ?? r.member?.mid ?? ''),
      uname: r.member?.uname ?? '',
      text: r.content?.message ?? '',
      ctime: Number(r.ctime ?? 0),
      like: Number(r.like ?? 0),
      count: Number(r.rcount ?? 0),
    })).filter((x) => x.rpid))
    if (arr.length < Math.min(20, ps)) break
  }
  return out
}

/**
 * 读某条根评论下面的楼中楼（二级回复）。
 *
 * 和 listRecentComments 的区别：这个是 /x/v2/reply/reply，必须带 root；
 * 返回的是这一栋楼里所有楼层（含自己说过的话），按时间正序。
 * 巡检要靠它把整条对话读全——重启后上下文全靠这一口。
 */
export async function listReplyReplies(cfg, { bvid, aid, root, ps = 20, pages = 1, request = biliFetch }) {
  const oid = String(aid ?? '').trim()
  const rootId = String(root ?? '').trim()
  if (!oid) throw new Error('没有 aid，读不了楼中楼')
  if (!rootId || rootId === '0') throw new Error('没有 root，读不了楼中楼')
  const out = []
  const size = Math.min(20, Math.max(1, ps))
  for (let pn = 1; pn <= Math.max(1, pages); pn++) {
    const url = `https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${encodeURIComponent(oid)}&root=${encodeURIComponent(rootId)}&ps=${size}&pn=${pn}`
    let j = null
    try {
      const r = await request(url, {
        headers: {
          cookie: cfg.cookieHeader,
          referer: bvid ? `https://www.bilibili.com/video/${bvid}/` : 'https://www.bilibili.com/',
          'user-agent': UA,
        },
        signal: AbortSignal.timeout(15_000),
      })
      j = await commentJSON(r)
    } catch (e) {
      // 已经读到一些就够用了，别因为后面几页失败把整栋楼丢掉
      if (e.commentClosed || isCommentRisk(e)) throw e
      if (out.length) break
      throw new Error(`读楼中楼失败：${e.message}`)
    }
    if (!j || j.code !== 0) {
      if (out.length) break
      if (j?.code === -404) throw new Error('这栋楼不存在或已被删除')
      if (j?.code === 12002) throw new Error('code=12002 评论区读取太频繁')
      throw new Error(`读楼中楼失败：${explain(j?.code, j?.message)}`)
    }
    const arr = j?.data?.replies ?? []
    if (!arr.length) break
    out.push(...arr.map((r) => ({
      rpid: String(r.rpid ?? ''),
      root: String(r.root || rootId),
      parent: String(r.parent || rootId),
      mid: String(r.mid ?? r.member?.mid ?? ''),
      uname: r.member?.uname ?? '',
      text: r.content?.message ?? '',
      ctime: Number(r.ctime ?? 0),
      like: Number(r.like ?? 0),
    })).filter((x) => x.rpid))
    if (arr.length < size) break
  }
  // 楼中楼有时间倒着给的、也有正着给的，统一按时间升序，拼对话链时才不会前言不搭后语
  out.sort((a, b) => (a.ctime || 0) - (b.ctime || 0))
  return out
}

/**
 * 发完再查一眼，确认真的挂在视频下面了。
 * 查不到不代表失败（评论区有缓存/审核），所以只作为参考值返回。
 */
export async function verifyComment(cfg, { bvid, aid, rpid }) {
  const oid = String(aid)
  const hit = (list) => (list ?? []).some((x) => String(x.rpid) === String(rpid))
  for (const sort of [2]) {
    try {
      const url = `https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&sort=${sort}&ps=30&pn=1`
      const r = await biliFetch(url, {
        headers: { cookie: cfg.cookieHeader, referer: `https://www.bilibili.com/video/${bvid}/`, 'user-agent': UA },
        signal: AbortSignal.timeout(15_000),
      })
      const j = await commentJSON(r)
      if (j?.code === 0 && hit(j?.data?.replies)) return true
    } catch { /* 换下一个排序再试 */ }
  }
  // 查不到不代表没发出去（审核/缓存），返回 null 让上层只做提示
  return null
}

// Comment readers preserve HTTP blocks instead of parsing HTML as JSON.
// Bilibili conversation integration: shared gentle policy and persistent reply tracking.
