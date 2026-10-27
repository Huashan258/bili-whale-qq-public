/**
 * B 站发言额度。评论和回复共用一个「账号每天总条数」，因为风控是按账号算的，
 * 不是按视频、也不是按 UP 算。另外每个主人还有自己的上限，免得一天全砸给同一个人。
 *
 * ⚠ 60 条/天是**账号级**上限：dsh-bili-scroll（DSH 插件）和本仓库用的是同一个 B 站账号，
 *   两边加起来不能超。所以这里先把插件的份额扣出来（share.pluginReservePerDay），
 *   剩下的才是本仓库真正能用的——见 whaleCap() / quotaView()。
 *
 * state.commentDaily 的结构（旧版是 byMid[mid] = 数字，读的时候顺手迁移）：
 *   { day: '2026-10-19', total: 4, byMid: { '887000007': { comment: 1, reply: 3 } } }
 */

const DAY_MS = 86_400_000
export const DAY = DAY_MS

export function today() {
  return new Date().toISOString().slice(0, 10)
}

/** 取当天的计数桶，跨天自动归零，顺手把旧结构升级 */
export function dayBucket(state) {
  const d = today()
  if (!state.commentDaily || state.commentDaily.day !== d) {
    state.commentDaily = { day: d, total: 0, byMid: {} }
  }
  const b = state.commentDaily
  b.byMid ??= {}
  for (const k of Object.keys(b.byMid)) {
    const v = b.byMid[k]
    if (typeof v === 'number') b.byMid[k] = { comment: v, reply: 0 }
  }
  b.total ??= Object.values(b.byMid).reduce((n, x) => n + (x.comment ?? 0) + (x.reply ?? 0), 0)
  return b
}

/** 账号每天总共能发几条（评论 + 回复，风控按账号算） */
export function accountCap(cfg) {
  return Math.max(0, Number(cfg?.share?.biliCommentPerDay ?? 6))
}

/**
 * 给 dsh-bili-scroll 预留的份额。
 * 默认 0（= 不预留，行为和加这个字段之前完全一样），要留给插件就在 config.json 里配。
 */
export function pluginReserve(cfg) {
  return Math.min(Math.max(0, Number(cfg?.share?.pluginReservePerDay ?? 0)), accountCap(cfg))
}

/** 扣掉插件预留之后，本仓库今天真正能用的条数 */
export function whaleCap(cfg) {
  return Math.max(0, accountCap(cfg) - pluginReserve(cfg))
}

/**
 * kind: 'comment'（视频下说一句）| 'reply'（回别人评论）
 *
 * opts.master —— 对面是主人/管理员（UP 主本人）时传 true。
 *   ⭐ 2026-10-20 用户要求「与管理员的对话容量无限」：跟主人的对话**不占**每天那条总量线，
 *     也不占「每个主人每天几条」的细分线 —— 他什么时候来都接。
 *   注意：**照样计数**（noteComment 照调），只是不卡闸，所以日报/quota 里看得到真实用量。
 *   别担心会失控：`perVideo`（单条视频单轮最多回几条）在调用侧照旧生效，
 *   那条是防刷屏的，跟"每天总量"是两回事。
 */
export function quotaOf(cfg, state, mid, kind, opts = {}) {
  const b = dayBucket(state)
  const m = b.byMid[String(mid)] ?? { comment: 0, reply: 0 }
  const totalCap = whaleCap(cfg)
  const cap = kind === 'reply'
    ? Math.max(0, Number(cfg.share?.masterReplyPerDay ?? 3))
    : Math.max(0, Number(cfg.share?.masterCommentPerDay ?? 1))
  const used = m[kind] ?? 0
  if (opts.master) {
    return {
      ok: true,
      used,
      cap: Infinity,
      total: b.total,
      totalCap,
      infinite: true,
      why: '',
    }
  }
  return {
    ok: b.total < totalCap && used < cap,
    used,
    cap,
    total: b.total,
    totalCap,
    why: b.total >= totalCap
      ? `今天 B 站总共发了 ${b.total} 条，到上限 ${totalCap} 了`
      : `今天给这个主人发了 ${used} 条${kind === 'reply' ? '回复' : '评论'}，到上限 ${cap} 了`,
  }
}

export function noteComment(cfg, state, mid, kind) {
  const b = dayBucket(state)
  const m = b.byMid[String(mid)] ?? { comment: 0, reply: 0 }
  m[kind] = (m[kind] ?? 0) + 1
  b.byMid[String(mid)] = m
  b.total = (b.total ?? 0) + 1
  return b
}

/** 上一次真正写 B 站的时间，用来控制间隔，别连着打接口 */
export function gapLeftMs(cfg, state) {
  const gap = Math.max(0, Number(cfg.share?.biliGapSec ?? 25)) * 1000
  const last = state.lastBiliWrite ? new Date(state.lastBiliWrite).getTime() : 0
  if (!last) return 0
  return Math.max(0, last + gap - Date.now())
}

export async function waitGap(cfg, state) {
  const ms = gapLeftMs(cfg, state)
  if (ms > 0) await new Promise((r) => setTimeout(r, Math.min(ms, 120_000)))
}

export function noteWrite(state) {
  state.lastBiliWrite = new Date().toISOString()
}

/** 给前端/日志看的一句话 */
export function quotaSummary(cfg, state) {
  const b = dayBucket(state)
  return {
    day: b.day,
    total: b.total,
    // cap 保持「本仓库能用多少」的口径（= 账号上限 - 插件预留），前端显示的就是真正能发的数
    cap: whaleCap(cfg),
    accountCap: accountCap(cfg),
    pluginReserve: pluginReserve(cfg),
    left: Math.max(0, whaleCap(cfg) - (b.total ?? 0)),
    byMid: b.byMid,
  }
}

/**
 * 额度体检（CLI / 日志用）：把「60 条谁在用」讲清楚。
 *
 * 注意：used 只统计**本仓库自己发的**（记在 state.commentDaily）。
 * 插件那边今天发了多少它没告诉我们，所以 pluginReserve 是**硬预留**——
 * 不管插件今天跑没跑，这 20 条都不动，宁可浪费也别超账号的风控线。
 */
export function quotaView(cfg, state) {
  const b = dayBucket(state)
  const used = b.total ?? 0
  const total = accountCap(cfg)
  const reserve = pluginReserve(cfg)
  const mine = whaleCap(cfg)
  return {
    day: b.day,
    used,
    accountCap: total,
    pluginReserve: reserve,
    whaleCap: mine,
    whaleLeft: Math.max(0, mine - used),
    accountLeft: Math.max(0, total - used),
    byMid: b.byMid,
    text: `${b.day}｜账号上限 ${total} 条/天（bili-whale-qq + dsh-bili-scroll 同一个账号）`
      + `｜插件预留 ${reserve}｜本仓库可用 ${mine}｜今天已发 ${used}｜还剩 ${Math.max(0, mine - used)} 条`,
  }
}
