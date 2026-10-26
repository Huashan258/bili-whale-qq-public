/**
 * 在主人视频的评论区里跟人搭话。
 *
 * 只做三件事：读评论区 → 挑「三天内、不是自己人、说得出内容」的留言 → 让模型接一句再发出去。
 * 边界卡得很死：
 *   - 只在主人自己的视频里跑（调用方保证），别人的视频一条都不发；
 *   - 只回 N 天内的（默认 3 天），老评论突然被翻出来回复，一眼机器人；
 *   - 每条留言只回一次（state.replied 记账），重跑不会重复；
 *   - 受「账号每天总条数」「每个主人每天回复数」双重限制。
 */
import { chat, parseJSON, hasLLM } from './llm.mjs'
import { REPLY_SYSTEM } from './prompt.mjs'
import { listRecentComments, addComment } from './bili-comment.mjs'
import { quotaOf, noteComment, noteWrite, waitGap } from './quota.mjs'
import { saveState, log } from './config.mjs'
import { biliIdentityPrompt, biliPersona } from './bili-identity.mjs'
import { composeBiliCommand, biliCommandMode } from './bili-command.mjs'

const JUNK = /^(顶|沙发|前排|打卡|路过|签到|来了|哈哈+|嘿嘿+|233+|6+|[\s?？!！。.…~～]+)$/

function plain(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 哪些留言值得回。纯函数，方便离线测试。 */
export function pickTargets(cfg, state, comments, { master, withinDays = 3 } = {}) {
  const self = String(cfg.raw?.bili?.dedeUserId ?? '')
  const masterMid = String(master?.mid ?? '')
  const since = Date.now() / 1000 - Math.max(1, withinDays) * 86400
  const block = (cfg.share?.blockKeywords ?? []).map((k) => String(k).toLowerCase())
  return (comments ?? []).filter((c) => {
    if (!c?.rpid) return false
    if (state.replied?.[c.rpid]) return false
    if (self && String(c.mid) === self) return false       // 自己发的
    if (masterMid && String(c.mid) === masterMid) return false // 主人自己发的
    if (Number(c.ctime) < since) return false
    const t = plain(c.text)
    if (t.length < 4 || t.length > 120) return false
    if (JUNK.test(t)) return false
    if (/(https?:\/\/|www\.|加群|私信|代刷|广告)/i.test(t)) return false
    if (block.some((k) => t.toLowerCase().includes(k))) return false
    return true
  })
}

async function composeReply(cfg, { title, uname, text, master, mid }) {
  const command=await composeBiliCommand(cfg,{mid,text,context:`视频：《${plain(title)}》`,channel:'comment'})
  if(command!==null)return command
  const r = await chat(cfg.llm, {
    replyConfig:cfg,replyTask:text,
    system: REPLY_SYSTEM.replace('这条视频的 UP 主是你主人（{{master}}），所以你在这儿说话比较随意。','你已经在这条视频下参与聊天，视频作者与留言者分别判断身份。') + biliPersona(cfg) + biliIdentityPrompt(cfg,mid),
    user: `视频：《${plain(title).slice(0, 60)}》\n评论区里 ${plain(uname) || '有人'} 说：${plain(text)}\n\n回他一句。`,
    json: true,
    temperature: 1.05,
    maxTokens: 160,
  })
  const v = parseJSON(r.content)
  return plain(v?.reply ?? v?.comment ?? '')
}

/**
 * 在一条主人视频下回几条评论。
 * @returns {Promise<{sent:number, why:string, picked:string[]}>}
 */
export async function replyInComments(cfg, state, { bvid, aid, title, master }) {
  if (!hasLLM(cfg.llm)) return { sent: 0, why: '模型未配置' }
  const perVideo = Math.max(0, Number(cfg.share?.masterReplyPerVideo ?? 2))
  if (!perVideo) return { sent: 0, why: '单条视频回复数设成 0 了' }

  const withinDays = Math.max(1, Number(cfg.share?.masterReplyWithinDays ?? 3))
  let comments
  try {
    comments = await listRecentComments(cfg, { bvid, aid, ps: 30 })
  } catch (e) {
    return { sent: 0, why: e.message }
  }

  const pool = pickTargets(cfg, state, comments, { master, withinDays })
  if (!pool.length) {
    return { sent: 0, why: `${comments.length} 条评论里没有 ${withinDays} 天内可回的` }
  }

  let sent = 0
  const notes = []
  for (const c of shuffle(pool).slice(0, perVideo * 3)) {
    if (sent >= perVideo) break

    const q = quotaOf(cfg, state, master?.mid ?? '', 'reply')
    if (!q.ok) { notes.push(q.why); break }

    let text = ''
    try {
      text = await composeReply(cfg, { title, uname: c.uname, text: c.text, master, mid:c.mid })
    } catch (e) {
      notes.push(`写回复失败：${e.message}`)
      continue
    }
    if (!text) { notes.push('模型没写出回复'); continue }
    // 普通回复80字；令咒保留200字以上，仍不超过B站单条容量。
    const cap=biliCommandMode(c.text,cfg,{comment:true}).active?900:80
    if (text.length > cap) text = text.slice(0, cap)

    try {
      await waitGap(cfg, state)
      const r = await addComment(cfg, { bvid, aid, text, root: c.root, parent: c.parent })
      state.replied ??= {}
      state.replied[c.rpid] = {
        at: new Date().toISOString(),
        rpid: r.rpid,
        bvid,
        mid: String(master?.mid ?? ''),
        to: c.uname,
        quote: plain(c.text).slice(0, 80),
        text,
      }
      noteComment(cfg, state, master?.mid ?? '', 'reply')
      noteWrite(state)
      saveState(state)
      sent++
      log(`  回了 ${c.uname || '某位观众'}：「${plain(c.text).slice(0, 24)}」→「${text}」`)
    } catch (e) {
      notes.push(`发回复失败：${e.message}`)
      // 被风控/太频繁就收手，别接着打接口
      if (/-412|-352|12002|12015/.test(e.message)) break
    }
  }

  return { sent, why: notes.join('；'), picked: pool.map((x) => x.rpid) }
}
