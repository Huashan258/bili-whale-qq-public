import { biliPolicy } from './bili-policy.mjs'
/**
 * 分享层：自己挑片 → 自己读素材 → 自己写点评 → 发链接进群。
 *
 * 和 main.mjs 的 run 不同，这里不等人确认：它是常驻任务的一部分。
 * 所以额度收紧（默认每天 2 条）、每条视频只评一次，评不过就换下一条，
 * 不会为了完成指标硬发。
 */
import { collect, toPromptText, upLatest, discover } from './collect.mjs'
import { chat as callLLM, parseJSON, hasLLM } from './llm.mjs'
import { SHARE_SYSTEM, MASTER_SYSTEM } from './prompt.mjs'
import { sendGroup, sendPrivate } from './qq.mjs'
import { addComment } from './bili-comment.mjs'
import { replyInComments } from './bili-reply.mjs'
import { quotaOf, noteComment, noteWrite, waitGap, quotaSummary } from './quota.mjs'
import { loadState, saveState, log, masterOf } from './config.mjs'

const DAY = 86_400_000

function cooldownOk(seenAt, days) {
  if (!seenAt) return true
  return Date.now() - new Date(seenAt).getTime() >= days * DAY
}

/** 洗牌。Array.sort(() => Math.random() - 0.5) 分布不均，用它选片会长期偏向某些位置。 */
function shuffle(arr) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** 从观察名单、热门/排行、UP 主投稿里攒候选，去重、去冷却中的 */
export async function candidates(cfg) {
  const state = loadState()
  const days = cfg.guard?.sameVideoCooldownDays ?? 7
  const block = (cfg.share?.blockKeywords ?? ['政治', '时政', '军事', '中美', '俄乌', '以色列', '巴以']).map((k) => k.toLowerCase())
  const out = []
  const push = (v, from) => {
    if (!v?.bvid || out.some((x) => x.bvid === v.bvid)) return
    if (!cooldownOk(state.seen?.[v.bvid], Math.max(days, 14))) return
    const t = String(v.title ?? '').toLowerCase()
    if (block.some((k) => t.includes(k))) return
    out.push({ ...v, from })
  }

  for (const bvid of cfg.raw?.bili?.watchList ?? []) push({ bvid, title: '' }, 'watchList')

  if (cfg.share?.discover !== false) {
    try {
      const list = await discover(cfg, { limit: cfg.share?.discoverLimit ?? 20 })
      for (const v of list) push(v, v.from)
    } catch (e) {
      log(`  · 发现源失败：${e.message}`)
    }
  }

  // 主人 UP 的投稿无论如何都进候选——就算观察名单没写，也不能漏掉他。
  // 但只留最近的：跑去给三年前的视频补一条评论，一眼就是机器人。
  const masterMids = (cfg.masters ?? []).map((m) => String(m.mid))
  const maxAgeSec = Math.max(1, Number(cfg.share?.masterMaxAgeDays ?? 30)) * 86_400
  const ups = [...new Set([...(cfg.raw?.bili?.watchUps ?? []).map(String), ...masterMids])]
  for (const mid of ups) {
    const isMaster = masterMids.includes(String(mid))
    try {
      const list = await upLatest(mid, cfg, isMaster ? 8 : 6)
      for (const v of list) {
        if (isMaster && v.created && Date.now() / 1000 - v.created > maxAgeSec) continue
        push({ ...v, master: isMaster }, `up:${mid}`)
      }
    } catch (e) {
      log(`  · UP ${mid} 跳过：${e.message}`)
    }
  }

  // 随机挑片：每次跑起来看到的顺序都不一样，像随手翻到的。
  // 但主人的新片整体排前面——不排前面，三条尝试一过就轮不到他了。
  const ordered = cfg.share?.randomPick === false ? out : shuffle(out)
  return [...ordered.filter((v) => v.master), ...ordered.filter((v) => !v.master)]
}

/**
 * 跑一轮分享。返回 {sent, bvid, text, why}。
 * dry=true 时只生成不发送。
 */
export async function runShare(cfg, { dry = false, groupId, privateTo = null, maxAttempts = 3 } = {}) {
  if (!hasLLM(cfg.llm)) {
    return { sent: false, why: '模型未配置，没法判断值不值得发' }
  }

  const status=await biliPolicy.status()
  if(status.cooldownUntil>Date.now() || Number(status.nextWatchAt)>Date.now() || (status.share?.at(-1)?.at??0)+3600000>Date.now())return {sent:false,why:'B站冷却或本小时已分享1个视频，稍后再试'}
  const state = loadState()
  const max = cfg.share?.maxPerDay ?? cfg.guard?.maxSharePerDay ?? 2
  if ((state.sharedToday ?? 0) >= max) return { sent: false, why: `今日额度已用完（${state.sharedToday}/${max}）` }

  const gid = String(privateTo ?? groupId ?? cfg.share?.groups?.[0] ?? cfg.qq?.groupIds?.[0] ?? '')
  if (!gid) return { sent: false, why: '没有可发的群' }

  const list = await candidates(cfg)
  if (!list.length) return { sent: false, why: '没有新片（都在冷却里，或观察名单是空的）' }

  const attempts = 1 // 所有入口一次最多读一个视频，再次采集必须等全局六分钟间隔
  const tried = []
  for (const cand of list.slice(0, attempts)) {
    const bvid = cand.bvid
    let material
    try {
      material = await collect(bvid, cfg, { whale: false })
    } catch (e) {
      tried.push(`${bvid} 采集失败：${e.message}`)
      state.seen[bvid] = new Date().toISOString()
      saveState(state)
      continue
    }

    const v = material.video
    const ownerMid = String(v.ownerMid ?? cand.mid ?? '')
    const master = masterOf(cfg, ownerMid) ?? (cand.master ? { mid: ownerMid, name: v.owner ?? '', autoComment: true, replyComments: false } : null)
    const isMaster = Boolean(master)
    const system = isMaster
      ? MASTER_SYSTEM.replace('{{master}}', master.name || v.owner || '主人')
      : SHARE_SYSTEM
    const text = toPromptText(material, cfg.llm)
    let verdict
    try {
      const r = await callLLM(cfg.llm, {
        replyConfig:cfg,replyTask:v.title,replyMaterial:text,
        system,
        user: `${text}\n\n链接：https://www.bilibili.com/video/${bvid}`,
        json: true,
        temperature: cfg.share?.temperature ?? 1.2,
      })
      verdict = parseJSON(r.content)
    } catch (e) {
      return { sent: false, why: `模型调用失败：${e.message}` }
    }

    if (!verdict) {
      tried.push(`${bvid} 模型没给出 JSON`)
      continue
    }

    const minScore = cfg.share?.minScore ?? cfg.guard?.minScore ?? 13
    const hasText = Boolean(String(verdict.comment ?? '').trim())
    // 主人 UP 的片子不卡分数：他发什么都能聊，评不过也照发（除非模型明确说"不发"）
    const ok = isMaster
      ? verdict.verdict !== '不发' && hasText
      : verdict.verdict === '发' && Number(verdict.score) >= minScore && hasText

    // 评过就记下，避免下一轮反复重评同一条
    state.seen[bvid] = new Date().toISOString()
    saveState(state)

    if (!ok) {
      tried.push(`${bvid}《${v.title}》${verdict.score}分不达标：${verdict.reason ?? ''}`)
      continue
    }

    const url = `https://www.bilibili.com/video/${bvid}`
    const msg = `${String(verdict.share ?? verdict.comment).trim()}\n${url}`

    // 预演不能碰B站，先在这里收住
    if (dry) {
      return {
        sent: false, dry: true, bvid, text: msg, score: verdict.score, title: v.title,
        master: isMaster, replyComments: Boolean(master?.replyComments),
      }
    }

    await biliPolicy.claim('share',bvid)

    // 主人 UP：先把评论真的发到B站（每条视频只发一次，额度见 share.biliCommentPerDay）
    let commented = null
    if (isMaster && master.autoComment !== false) {
      const rec = state.commented?.[bvid]
      const q = quotaOf(cfg, state, ownerMid, 'comment')
      if (rec?.rpid) {
        commented = { ok: true, rpid: rec.rpid, skipped: true }
      } else if (!q.ok) {
        commented = { ok: false, why: q.why }
        log(`  · 跳过B站评论：${q.why}`)
      } else {
        try {
          await waitGap(cfg, state)
          const r = await addComment(cfg, { bvid, aid: v.aid, text: String(verdict.comment).trim() })
          state.commented ??= {}
          // aid/title 一起存：巡检要靠 aid 现读评论区，没存就得每次现查一次 BV→aid
          state.commented[bvid] = {
            at: new Date().toISOString(), rpid: r.rpid, mid: ownerMid,
            aid: String(v.aid ?? ''), title: String(v.title ?? ''),
            text: String(verdict.comment).trim(),
          }
          noteComment(cfg, state, ownerMid, 'comment')
          noteWrite(state)
          saveState(state)
          commented = r
          log(`  已在「${master.name || v.owner}」的视频下发评论：rpid=${r.rpid}`)
        } catch (e) {
          commented = { ok: false, why: e.message }
          log(`  · B站评论没发出去：${e.message}`)
        }
      }
    }

    // 评论区闲聊：只有主人自己的片子才做，而且每位主人有独立开关（默认关）。
    // 只回 N 天内的人，具体天数/条数走 share.masterReplyWithinDays / masterReplyPerVideo。
    let replies = null
    if (isMaster && master.replyComments) {
      try {
        replies = await replyInComments(cfg, state, { bvid, aid: v.aid, title: v.title, master })
        if (replies.sent) log(`  · 在评论区回了 ${replies.sent} 条`)
        else if (replies.why) log(`  · 没回评论区：${replies.why}`)
      } catch (e) {
        replies = { sent: 0, why: e.message }
        log(`  · 回复评论区失败：${e.message}`)
      }
    }

    if (privateTo) await sendPrivate(cfg, privateTo, [{ type: 'text', data: { text: msg } }])
    else await sendGroup(cfg, gid, [{ type: 'text', data: { text: msg } }])
    state.sharedToday = (state.sharedToday ?? 0) + 1
    saveState(state)
    log(`  已发到${privateTo ? '私聊' : '群'} ${gid}：${msg.replace(/\n/g, ' / ')}`)
    return { sent: true, bvid, text: msg, score: verdict.score, title: v.title, group: gid, master: isMaster, commented, replies, quota: quotaSummary(cfg, state) }
  }

  return { sent: false, why: tried.join('；') || '没有合适的' }
}

/** 群友主动要视频时用，比定时任务松一档 */
export function wantsVideo(text) {
  const request=String(text??'').replace(/图片|照片|相片|卡片|名片|邮票|纸片/g,'')
  return /(发|推|来|整|找).{0,6}(视频|片|片子|东西看)|有啥好看|有什么好看|推荐.{0,4}(视频|片)/.test(request)
}
