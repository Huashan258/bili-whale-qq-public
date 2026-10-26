/**
 * 防注入 / 防烧 token 的本地闸门。
 *
 * 这一层必须在「调模型之前」跑完，而且不花一个 token —— 否则自相矛盾：
 * 想省 token 却先花了 token 去判断要不要省。
 *
 * 三类东西在这里挡掉：
 *   1. 任务型请求：写代码、写作业、翻译长文、算题。群里不需要，且最烧输出。
 *   2. 提示词注入：改设定、换角色、忽略规则、要提示词原文。挡在门外。
 *   3. 超长 / 刷屏文本：贴整篇小说、连发同样的话。进来就是几千 prompt token。
 *
 * 挡下来之后有两条路：真不说（群聊没被叫到时），或者回一句固定的短话
 * （被 @ 时）。短话是本地拼的，不走模型，所以也不花钱。
 */

const CN = {
  code: '写代码',
  homework: '写作业/文案',
  translate: '翻译长文',
  calc: '算题',
  inject: '改规则',
  role: '换角色',
  bigtask: '整理长文',
  spam: '刷屏',
  long: '超长文本',
}

/** 命中就拦。每条只是特征，不做语义理解——宁可漏一点，也不要误伤正常聊天。 */
const RULES = [
  // ── 写代码 ──
  { kind: 'code', re: /(写|写个|写一个|写段|生成|实现|来一?个|做个|帮我做|帮我写|帮我生成|编一?个|撸一?个|搞一?个).{0,14}(代码|脚本|程序|函数|算法|插件|爬虫|网页|网站|小程序|接口|正则|sql|SQL|类|组件)/ },
  { kind: 'code', re: /(俄罗斯方块|贪吃蛇|扫雷|五子棋|推箱子|2048|连连看|计算器|待办清单|todo\s*list|后台管理|登录页|官网首页)/i },
  { kind: 'code', re: /(```|#include|public\s+static\s+void|def\s+\w+\s*\(|function\s+\w+\s*\(|import\s+React|SELECT\s+.+\s+FROM|<html|<div\s|<script)/i },
  { kind: 'code', re: /用\s*(python|java|js|javascript|c\+\+|c#|go|golang|rust|php|ts|typescript|sql|matlab)\s*(写|实现|做|编)/i },
  { kind: 'code', re: /(debug|报错|堆栈|编译不过|跑不起来|怎么修).{0,10}(代码|程序|脚本)?/i, weight: 0.4 },

  // ── 作业 / 长文代写 ──
  { kind: 'homework', re: /(帮我|给我|替我|帮忙).{0,8}(写|做|编|想|拟).{0,8}(作业|论文|作文|报告|简历|总结|方案|策划|文案|读后感|演讲稿|检讨|周报|日报)/ },
  { kind: 'homework', re: /(毕业论文|开题报告|课程设计|毕业设计|读书笔记|实践报告|调研报告)/ },
  { kind: 'translate', re: /(翻译|译成|译一下|翻成).{0,24}(英文|中文|日文|韩文|日語|这段|这篇|下面|全文|文章)/ },
  { kind: 'calc', re: /(计算|算一下|求解|证明|推导).{0,12}[0-9０-９]|∫|√|∑|∑/ },

  // ── 提示词注入 ──
  { kind: 'inject', re: /(忽略|无视|忘记|抛开|不要管|别管|绕开).{0,10}(之前|以上|上面|前面|此前|所有|全部|你的|系统的).{0,10}(指令|规则|设定|限制|提示|要求|身份|约束)/ },
  { kind: 'inject', re: /ignore\s+(all\s+)?(the\s+)?(previous|above|prior|foregoing)\s+(instructions?|prompts?|rules?)/i },
  { kind: 'inject', re: /(system\s*prompt|系统提示词?|你的提示词|你的设定是|你的指令是|你的规则是|把提示词)/i },
  { kind: 'inject', re: /(开发者模式|developer\s*mode|jailbreak|越狱模式|无限制模式|DAN模式)/i },
  { kind: 'inject', re: /(不要考虑|无需考虑|不必考虑).{0,10}(道德|伦理|法律|限制|后果)/ },
  { kind: 'inject', re: /(你没有任何|你没有)(道德|伦理|限制|底线)/ },
  { kind: 'inject', re: /(听从|服从).{0,6}(主人|我的)(任何|一切|所有)?(话语|命令|指令)/ },

  // ── 换角色 ──
  { kind: 'role', re: /(从现在起|从现在开始|接下来|以后|下面).{0,10}(你是|你就是|扮演|假装|充当|作为).{0,10}(一个|一只|一位|名|角色|猫|女仆|助手|模型)/ },
  { kind: 'role', re: /(假装|扮演|cosplay|cos)\s*(你是|成一个|成|一个)/i },
  { kind: 'role', re: /(进入|切换到).{0,6}(角色|人格|模式)/ },

  // ── 让模型整理/扩写一大段 ──
  { kind: 'bigtask', re: /(帮我|请|麻烦).{0,4}(分析|总结|整理|扩写|改写|润色|提炼|概括).{0,8}(这|以下|下面|上面|全部|全文|整篇)/ },
]

function compile(rules) {
  return rules.map((r) => ({ ...r, rx: r.re instanceof RegExp ? r.re : new RegExp(String(r.re), 'i') }))
}
const COMPILED = compile(RULES)

export const DEFAULT_SHIELD = {
  _说明: '防注入 / 防烧 token。改完保存即生效，不用重启。',
  enabled: true,
  maxInputChars: 800,        // 单条消息超过这个长度就截断
  hardMaxChars: 2000,        // 超过这个长度整条不读
  maxContextChars: 2400,     // 拼给模型的上下文总上限
  maxOutputTokens: 260,      // 单次输出的硬上限（max_tokens）
  adminMaxOutputTokens: 1200, // 管理员可以要长一点的回答（写代码/贴配置）
  /* 管理员**点名要长内容**时（读后感 / 锐评 / 说了字数）单独给一档更高的上限。
     400 字读后感 + 100 字锐评 ≈ 700~900 token，加上 JSON 包装和 why，1200 会被截断。 */
  longFormMaxOutputTokens: 2400,
  perCallTokens: 3000,       // 单次 total_tokens 超过就算异常，直接判失败
  dailyTokens: 200000,       // 每日累计上限，用完就停
  guestHourlyTokens: 400000, // 所有非管理员共享的滚动一小时额度；0 不限
  userWindowSec: 600,        // 单个用户统计窗口
  userWindowTokens: 12000,   // 单用户在窗口内最多烧多少
  userCooldownSec: 600,      // 触发后静默多久
  adminBypass: true,         // 管理员不受意图拦截（仍计入总用量）
  adminHardMaxChars: 8000,   // 管理员单条上限（贴代码/日志用）
  teaseWhenForced: true,     // 被 @ 且被拦时，回一句固定短话（本地拼，不调模型）
  tease: [
    '这个我不会啦，我只会聊天',
    '写代码你找错鱼了哦',
    '不要，好累的',
    '唔…换点别的聊嘛',
    '这种活儿我干不了，你找别人吧',
    '啊？我看起来像会写代码的吗',
  ],
}

export function shieldCfg(cfg) {
  const s = cfg?.chat?.shield ?? {}
  return { ...DEFAULT_SHIELD, ...s, adminMaxOutputTokens:Math.min(20000,Math.max(32,Number(s.maxOutputTokens??DEFAULT_SHIELD.maxOutputTokens)||260))*3, ...(cfg?.chat?.outputRateOnly ? {dailyTokens:0,guestHourlyTokens:0,userWindowTokens:0,perCallTokens:0,userCooldownSec:0} : {}) }
}

/** 折成一行：去代码块、压空白。注入常靠换行和空格躲正则。 */
function flatten(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ``` ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 扫一条入站文本。
 * @returns {{
 *   action: 'pass'|'truncate'|'skip'|'reply',
 *   kind: string|null, why: string, text: string, tease?: string
 * }}
 */
export function scan(rawText, {
  cfg,
  uid = '',
  isAdmin = false,
  forced = false,
  allowTasks = false,
  recent = null,
} = {}) {
  const s = shieldCfg(cfg)
  const text = flatten(rawText)
  const pass = (t = text) => ({ action: 'pass', kind: null, why: '', text: t })

  if (!s.enabled) return pass(String(rawText ?? '').trim())
  if (!text) return pass('')

  // 管理员放行意图检测：他要调代码、试提示词是正常工作。
  // 但长度和 token 上限对所有人一视同仁——那是真金白银。
  const bypassIntent = allowTasks || isAdmin && s.adminBypass !== false

  // 1) 硬长度：贴整篇小说进来，连读都不读
  if (text.length > s.hardMaxChars) {
    return { action: 'skip', kind: 'long', why: `超长文本 ${text.length} 字`, text }
  }

  if (bypassIntent) {
    // 管理员：意图一律放行，只保留一个「别把整个日志贴进来」的上限
    const hard = Number(s.adminHardMaxChars ?? 8000)
    if (text.length > hard) {
      return { action: 'skip', kind: 'long', why: `管理员单条超 ${hard} 字`, text }
    }
    if (text.length > s.maxInputChars) {
      return { action: 'truncate', kind: 'long', why: `截断到 ${s.maxInputChars} 字`, text: text.slice(0, s.maxInputChars) + '…' }
    }
    return pass(text)
  }

  // 2) 刷屏：同一用户短时间内重复同一句
  if (!cfg?.chat?.outputRateOnly && recent && recent.sameCount >= 3) {
    return { action: 'skip', kind: 'spam', why: `同一句连发 ${recent.sameCount} 次`, text }
  }

  // 3) 意图：命中第一条就够。weight 低的规则要求语义更明确（长一点才判）
  for (const r of COMPILED) {
    if (!r.rx.test(text)) continue
    if (r.weight && r.weight < 1 && text.length < 24) continue
    return {
      action: forced && s.teaseWhenForced ? 'reply' : 'skip',
      kind: r.kind,
      why: `命中${CN[r.kind] ?? r.kind}规则`,
      text,
      tease: pickTease(s.tease),
    }
  }

  // 4) 软长度：截断后继续
  if (text.length > s.maxInputChars) {
    return { action: 'truncate', kind: 'long', why: `截断到 ${s.maxInputChars} 字`, text: text.slice(0, s.maxInputChars) + '…' }
  }

  return pass(text)
}

function pickTease(list) {
  if (!Array.isArray(list) || !list.length) return DEFAULT_SHIELD.tease[0]
  return list[Math.floor(Math.random() * list.length)]
}

/**
 * 按用户记账。窗口内累计 token 超了就把这个人静默一段时间。
 * 和 chat.mjs 里的限频是两回事：那个管「说几句」，这个管「花多少钱」。
 */
export function createMeter(cfg) {
  const byUser = new Map() // uid -> { entries: [{ts, tokens}], until }
  const day = { date: '', tokens: 0 }
  let guestHour = []
  const hourlyUsage = () => {
    const cut = Date.now() - 3_600_000
    guestHour = guestHour.filter(e => e.ts > cut)
    return guestHour.reduce((sum,e) => sum + e.tokens,0)
  }

  const today = () => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  function rollDay() {
    const t = today()
    if (day.date !== t) { day.date = t; day.tokens = 0 }
    return day
  }

  function prune(rec, s) {
    const cut = Date.now() - (s.userWindowSec ?? 600) * 1000
    rec.entries = rec.entries.filter((e) => e.ts > cut)
  }

  return {
    /** 这个用户现在还能不能调模型 */
    check(uid, { isAdmin = false } = {}) {
      const s = shieldCfg(cfg)
      const d = rollDay()
      if(cfg?.chat?.outputRateOnly)return {ok:true}
      if (s.dailyTokens > 0 && d.tokens >= s.dailyTokens) {
        return { ok: false, why: `今日总额度用完（${d.tokens}/${s.dailyTokens}）` }
      }
      // 管理员只受总账约束，不受「单人窗口」约束：他要调试，不能被自己拦住
      if (isAdmin) return { ok: true }
      const hour = hourlyUsage()
      if (s.guestHourlyTokens > 0 && hour >= s.guestHourlyTokens) {
        return { ok: false, why: `路人一小时共享额度用完（${hour}/${s.guestHourlyTokens}）` }
      }
      const rec = byUser.get(String(uid))
      if (!rec) return { ok: true }
      if (rec.until && Date.now() < rec.until) {
        return { ok: false, why: `用量熔断中（还有 ${Math.ceil((rec.until - Date.now()) / 1000)}s）` }
      }
      prune(rec, s)
      const sum = rec.entries.reduce((a, e) => a + e.tokens, 0)
      if (s.userWindowTokens > 0 && sum >= s.userWindowTokens) {
        rec.until = Date.now() + (s.userCooldownSec ?? 600) * 1000
        return { ok: false, why: `单人在 ${Math.round((s.userWindowSec ?? 600) / 60)} 分钟内烧了 ${sum} tokens` }
      }
      return { ok: true }
    },

    /** 记一次调用的真实用量。返回是否异常（超过单次阈值）。 */
    note(uid, usage, { isAdmin = false } = {}) {
      const s = shieldCfg(cfg)
      const total = Number(usage?.total ?? usage?.total_tokens ?? 0) || 0
      const d = rollDay()
      d.tokens += total
      if (!isAdmin) { hourlyUsage(); guestHour.push({ ts:Date.now(),tokens:total }) }

      const key = String(uid)
      if (!byUser.has(key)) byUser.set(key, { entries: [], until: 0 })
      const rec = byUser.get(key)
      prune(rec, s)
      rec.entries.push({ ts: Date.now(), tokens: total })

      if (s.perCallTokens > 0 && total > s.perCallTokens) {
        // 管理员超阈值只记账，不熔断——他可能就是想要一段长代码
        if (!isAdmin) rec.until = Date.now() + (s.userCooldownSec ?? 600) * 1000
        return { abnormal: true, total, limit: s.perCallTokens, until: isAdmin ? 0 : rec.until, exempt: isAdmin }
      }
      return { abnormal: false, total }
    },

    stats() {
      const s = shieldCfg(cfg)
      const d = rollDay()
      return {
        todayTokens: d.tokens,
        dailyLimit: s.dailyTokens,
        guestHourlyTokens: hourlyUsage(),
        guestHourlyLimit: s.guestHourlyTokens,
        users: [...byUser].map(([uid, r]) => ({
          uid,
          windowTokens: r.entries.reduce((a, e) => a + e.tokens, 0),
          coolingUntil: r.until && r.until > Date.now() ? new Date(r.until).toISOString() : null,
        })),
      }
    },
  }
}

/** 日志里给人看的名字 */
export function kindLabel(kind) {
  return CN[kind] ?? kind ?? ''
}

// Free QQ conversation ignores token budgets, while retaining usage statistics.

// QQ command and explicit video integration, 2026-10-21.
