/**
 * 「设置页」这一页的配置存取（供 client.js ↔ index.js 用）
 * ============================================================================
 * ⭐ 为什么要另存一份，而不是直接写 DSH 的 volatile 设置：
 *
 *   cordis 的 volatile 字段**写不回去**（2026-10-20 实测：设置页改了，插件读到的还是旧值；
 *   而且 `settings.update()` 在只有 volatile 字段时容易抛）。bili-scroll 那边的老办法是
 *   「靠家目录 config.json 兜底读配置」—— 同一个思路，这里叫 **UI 覆盖层**：
 *
 *     cordis 配置（patch.yml / 默认值）  ←  启动时读一次
 *              ↓ 叠加
 *     .data/whale-ui.json（设置页写的） ←  优先级更高，改完 30 秒内生效（或事件立刻）
 *
 *   ⇒ 设置页改的值**保证生效**，同时不影响 cordis 那边的初始装载。
 *
 * ⭐ 一律「留空 = 不动」：string 空串 / number 负数都是哨兵，叠加时会被跳过，
 *    这样设置页没填的字段不会把 config.json 里手写的长文本（比如 persona）冲掉。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 设置页允许改的字段（白名单 —— 前端传别的键一律丢掉） */
export const UI_FIELDS = [
  'enabled', 'dry', 'replyPatrolMinutes', 'qqEnabled', 'diceEnabled', 'webUi', 'webUiPort',
  /* 刷B站（从 dsh-bili-scroll 移植过来的那一轮） */
  'scrollEnabled', 'scrollMinutes', 'scrollKeywords', 'scrollPerDay', 'scrollMention',
  'scrollPreferences', 'scrollTags', 'scrollMaxVideos',
  'nick', 'persona', 'taboo', 'aliases', 'groups', 'admins', 'quietHours',
  'speakChance', 'minGapSec', 'maxPerHour',
  /* 模型与记忆：温度和「记几条」必须能自己调 —— 闲聊要活泼、长文要稳，一个值兼顾不了 */
  'temperature', 'longFormTemperature', 'longFormMaxOutputTokens',
  'contextMessages', 'historyRestore',
]

/** 哨兵：这些值表示「设置页没填，沿用原来的」 */
const isSkip = (k, v) => {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return !v.trim()
  if (typeof v === 'number') return !Number.isFinite(v) || v < 0
  return false
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, n))
}

/**
 * 钳制 + 过滤。
 * WebUI 已改为独立 Node 子进程，可以通过覆盖层安全控制自启动与端口。
 */
export function clampUiPatch(raw) {
  const out = {}
  const src = raw && typeof raw === 'object' ? raw : {}
  for (const k of UI_FIELDS) {
    if (!(k in src)) continue
    const v = src[k]
    if (isSkip(k, v)) { out[k] = typeof v === 'number' ? -1 : ''; continue }
    switch (k) {
      case 'enabled':
      case 'dry':
      case 'qqEnabled':
      case 'diceEnabled':
      case 'scrollEnabled':
      case 'webUi':
        out[k] = Boolean(v); break
      case 'webUiPort':
        out[k] = Math.round(clampNum(v, 1, 65535, 7788)); break
      /* 用户要求五分钟巡检，0 仍表示关闭；其他非零值至少五分钟。 */
      case 'replyPatrolMinutes':
        out[k] = Number(v) === 0 ? 0 : clampNum(v, 5, 1440, 5); break
      case 'scrollMinutes':
        out[k] = Math.round(clampNum(v, 6, 1440, 6)); break
      // 上限放宽到 50：跟「每天最多看 50 个视频」对齐（原来卡在 20，@ 上限调不高）
      case 'scrollPerDay':
        out[k] = Math.round(clampNum(v, -1, 50, -1)); break
      case 'scrollMaxVideos':
        out[k] = Math.round(clampNum(v, -1, 1, -1)); break
      case 'speakChance':
        out[k] = clampNum(v, 0, 1, 1); break
      /* 温度：0.1~2。给 0 会变成复读机，所以下限不是 0 */
      case 'temperature':
        out[k] = clampNum(v, 0.1, 2, 1.2); break
      case 'longFormTemperature':
        out[k] = clampNum(v, 0.1, 2, 0.9); break
      /* 长文上限：400+100 字大概 700~900 token，留足 JSON 包装的余量 */
      case 'longFormMaxOutputTokens':
        out[k] = Math.round(clampNum(v, 200, 8000, 2400)); break
      /* 记几条：0/1 = 只带当前这句（等于不记忆）；上限 50 已远超缓冲的 30 条 */
      case 'contextMessages':
        out[k] = Math.round(clampNum(v, 0, 50, 14)); break
      case 'historyRestore':
        out[k] = Math.round(clampNum(v, 0, 50, 14)); break
      case 'minGapSec':
        out[k] = Math.round(clampNum(v, 0, 3600, 0)); break
      case 'maxPerHour':
        out[k] = Math.round(clampNum(v, 0, 1440, 0)); break
      default:
        /* 文本类：硬性截个长度，免得粘贴一大坨把文件撑爆 */
        out[k] = String(v).slice(0, k === 'persona' || k === 'taboo' ? 8000 : 2000)
    }
  }
  return out
}

/** 读覆盖层。**只在字段"真的填了"时才覆盖**（哨兵值跳过） */
export function readUiCfg(file) {
  let raw = {}
  try {
    if (!existsSync(file)) return {}
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch { return {} }
  if (!raw || typeof raw !== 'object') return {}
  const out = {}
  for (const k of UI_FIELDS) {
    if (!(k in raw)) continue
    const v = raw[k]
    if (isSkip(k, v)) continue
    if (typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') out[k] = v
  }
  return out
}

/** 写覆盖层（先合并再落盘，避免把没传的字段清掉）。返回合并后的全量 */
export function writeUiCfg(file, patch) {
  const cur = readUiCfgRaw(file)
  const next = { ...cur, ...clampUiPatch(patch) }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2), 'utf8')
  } catch { /* 写不进去就算了，设置页会看到没生效 */ }
  return next
}

/** 原样读（含哨兵值）—— 给前端回显用，让界面知道"这一项是空的" */
export function readUiCfgRaw(file) {
  try {
    if (!existsSync(file)) return {}
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch { return {} }
}

/** 默认文件位置：跟状态目录放一起 */
export function uiFileOf(projectRoot) {
  return join(projectRoot, '.data', 'whale-ui.json')
}
