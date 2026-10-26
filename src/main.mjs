#!/usr/bin/env node
import { biliPolicy } from './bili-policy.mjs'
/**
 * bili-whale-qq —— B站看视频 → AI 写评论 → QQ群分享
 *
 * 用法：
 *   node src/main.mjs pick --up 123456 --limit 8            自动挑一条没发过的（定时任务用）
 *   node src/main.mjs collect BV1xx411c7mD            只采素材，打印给你看
 *   node src/main.mjs compose BV1xx411c7mD --whale    采 + 让模型写（不发送）
 *   node src/main.mjs send BV1xx411c7mD --file .data/draft-BV1xx411c7mD.json --group 123456 --go
 *                                                     发一份外部写好的草稿（WorkBuddy 定时任务用）
 *   node src/main.mjs run BV1xx411c7mD --group 123456 走完整流程，默认只预演
 *   node src/main.mjs run BV1xx411c7mD --group 123456 --go        真的发到群
 *   node src/main.mjs comment BV1xx411c7mD --text "..." --go      真的发B站评论（高危，需二次确认）
 *   node src/main.mjs quota                                      今天 B 站还剩多少条（含插件预留）
 *   node src/main.mjs patrol [--go] [--max N]                     手动跑一次评论区巡检（默认只预演）
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, loadState, saveState, DATA, log, masterOf } from './config.mjs'
import { collect, toPromptText, upLatest, videoInfo } from './collect.mjs'
import { chat, parseJSON, hasLLM } from './llm.mjs'
import { sendGroup, buildShareMessage, ping } from './qq.mjs'
import { SYSTEM, MASTER_SYSTEM } from './prompt.mjs'
import { addComment } from './bili-comment.mjs'
import { check } from './guard.mjs'
import { runPatrol } from './bili-patrol.mjs'
import { quotaView } from './quota.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]
const flag = (n) => argv.includes(`--${n}`)
const opt = (n, d = '') => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const positional = argv.slice(1).filter((a, i) => !a.startsWith('--') && !(i > 0 && argv.slice(1)[i - 1]?.startsWith('--')))
// BV 号大小写敏感，绝对不能 toUpperCase
const bvid = positional[0] ?? ''

function needBvid() {
  if (!bvid.startsWith('BV')) {
    console.error('用法：node src/main.mjs <collect|compose|run|comment> BV1xxxxxxxxx [--group 群号] [--go]')
    process.exit(1)
  }
}

async function doCollect(cfg) {
  needBvid()
  log(`采集 ${bvid} …`)
  const m = await collect(bvid, cfg, { whale: flag('whale') })
  const text = toPromptText(m, cfg.llm)
  return { m, text }
}

async function doCompose(cfg) {
  const { m, text } = await doCollect(cfg)
  log(`字幕 ${m.subtitle?.lines?.length ?? 0} 行｜弹幕 ${m.danmaku.total} 条｜热评 ${m.comments.length} 条｜素材 ${text.length} 字`)

  if (!hasLLM(cfg.llm)) {
    const out = path.join(DATA, `material-${bvid}.md`)
    fs.mkdirSync(DATA, { recursive: true })
    fs.writeFileSync(out, text)
    log(`\n未配置模型（provider=${cfg.llm.provider}）。素材已写到：${out}`)
    log('把这份文件交给 WorkBuddy，让它按 SYSTEM 里的要求写评论和群分享即可。')
    return { m, text, result: null }
  }

  const master = masterOf(cfg, m.video?.ownerMid)
  const system = master ? MASTER_SYSTEM.replace('{{master}}', master.name || m.video.owner || '主人') : SYSTEM
  if (master) log(`这条是主人「${master.name || m.video.owner}」的片子，说话放开一点`)
  const { content, usage } = await chat(cfg.llm, { system, user: text, json: true,replyConfig:cfg,replyTask:m.video?.title,replyMaterial:text })
  const result = parseJSON(content)
  if (!result) throw new Error(`模型没吐合法 JSON：${content.slice(0, 300)}`)
  if (usage) log(`token：prompt ${usage.prompt_tokens} / completion ${usage.completion_tokens}`)
  return { m, text, result }
}

/**
 * 发送动作只此一份：预演、真发、记账都在这里，各命令共用，
 * 免得 CLI 和定时任务那边各写一套、额度算两次或者漏算。
 */
async function deliver(cfg, { bvid, title, share, cover, groupId, go }) {
  const msg = buildShareMessage({ bvid, title, text: share, cover, atAll: cfg.qq?.atAll ?? false })

  if (!go) {
    log('\n【预演】实际会发到群 ' + groupId + '：\n')
    log(`  ${share}\n  《${title}》\n  https://www.bilibili.com/video/${bvid}`)
    log('\n确认没问题就加 --go 真发。')
    return false
  }

  await biliPolicy.claim('share',bvid)
  const shape = await sendGroup(cfg, groupId, msg)
  log(`\n已发送到群 ${groupId}（${shape === 'text' ? '纯文本 + 链接' : shape + ' 卡片'}）`)

  const state = loadState()
  state.sharedToday = (state.sharedToday ?? 0) + 1
  state.seen[bvid] = new Date().toISOString()
  saveState(state)
  log(`今日已用额度：${state.sharedToday}/${cfg.guard?.maxSharePerDay ?? 3}`)
  return true
}

/** 自动挑一条没发过的：定时任务的第一步。 */
async function doPick(cfg) {
  const mid = opt('up')
  const limit = Number(opt('limit', '8')) || 8

  const state = loadState()
  const cd = cfg.guard?.sameVideoCooldownDays ?? 7
  const max = cfg.guard?.maxSharePerDay ?? 3
  const isFresh = (bvid) => {
    const seen = state.seen?.[bvid]
    return !seen || (Date.now() - new Date(seen).getTime()) / 86_400_000 >= cd
  }

  // 两条来源：UP 主最新投稿（要 cookie）／固定观察名单（config.bili.watchList，不需要 cookie）
  let candidates = []
  let source = ''
  let fallbackNote = ''

  if (mid) {
    try {
      candidates = await upLatest(mid, cfg, Math.max(limit, 8))
      source = `UP ${mid}`
    } catch (e) {
      const watch = cfg.raw?.bili?.watchList ?? []
      if (!watch.length) throw e
      fallbackNote = `（UP 投稿取不到：${e.message}　改用 watchList）`
      source = 'watchList'
      candidates = watch.map((b) => ({ bvid: b, title: '', created: 0, play: 0 }))
    }
  } else {
    const watch = cfg.raw?.bili?.watchList ?? []
    if (!watch.length) {
      throw new Error('缺 --up <UP主 mid>，config.bili.watchList 也是空的。两者至少给一个。')
    }
    source = 'watchList'
    candidates = watch.map((b) => ({ bvid: b, title: '', created: 0, play: 0 }))
  }

  const fresh = candidates.filter((v) => isFresh(v.bvid))

  if (flag('json')) {
    console.log(JSON.stringify({
      source,
      note: fallbackNote || undefined,
      quota: { used: state.sharedToday ?? 0, max },
      picked: fresh[0] ?? null,
      candidates: fresh,
    }, null, 2))
    return
  }

  log(`来源 ${source}：共 ${candidates.length} 条，可用 ${fresh.length} 条（冷却 ${cd} 天）${fallbackNote}`)
  if ((state.sharedToday ?? 0) >= max) log(`⚠ 今日额度已用完（${state.sharedToday}/${max}），发了也会被闸门拦`)
  for (const v of fresh.slice(0, limit)) {
    const day = v.created ? new Date(v.created * 1000).toISOString().slice(0, 10) : '—'
    log(`  ${v.bvid}  ${day}  ${v.play ? v.play + '播放  ' : ''}${v.title}`)
  }
  if (!fresh.length) log('\n没有新片。等 UP 更新，或把 guard.sameVideoCooldownDays 调小。')
}

/** 发一份外部写好的草稿：定时任务里由 WorkBuddy 产出 JSON，这里只负责闸门 + 发送。 */
async function doSend(cfg) {
  needBvid()
  const file = opt('file', path.join(DATA, `draft-${bvid}.json`))
  if (!fs.existsSync(file)) {
    throw new Error(`找不到草稿：${file}\n应先生成 {"score":16,"verdict":"发","risk":"无","comment":"...","share":"...","reason":"..."}`)
  }

  let draft
  try {
    draft = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`${file} 不是合法 JSON`)
  }
  const result = draft.result ?? draft

  if (typeof result.share !== 'string' || !result.share.trim()) throw new Error('草稿缺 share（群分享文案）')
  if (typeof result.score !== 'number') throw new Error('草稿缺 score（0-20 的数字）')

  const v = await videoInfo(bvid, cfg)
  log(`草稿对应：${v.title}（${v.owner}）`)
  log(`评分 ${result.score}/20｜判定 ${result.verdict ?? '—'}｜风险 ${result.risk ?? '—'}`)
  if (result.comment) log(`B站评论（不会自动发，仅存档）：${result.comment}`)

  const state = loadState()
  const problems = check(cfg, state, result, bvid)
  if (problems.length) {
    log(`\n闸门拦下：${problems.join('；')} → 不发送`)
    return
  }

  const groupId = opt('group', cfg.qq?.groupIds?.[0] ? String(cfg.qq.groupIds[0]) : '')
  if (!groupId) {
    log('\n没指定群号（--group），到此为止。')
    return
  }

  await deliver(cfg, { bvid, title: v.title, share: result.share, cover: v.pic, groupId, go: flag('go') })
}

async function doRun(cfg) {
  const { m, result } = await doCompose(cfg)
  if (!result) return
  const state = loadState()
  const problems = check(cfg, state, result, bvid)

  log('\n──────── 生成结果 ────────')
  log(`评分：${result.score}/20　判定：${result.verdict}　风险：${result.risk}`)
  log(`理由：${result.reason}`)
  log(`评论：${result.comment}`)
  log(`群分享：${result.share}`)

  if (problems.length) {
    log(`\n闸门拦下：${problems.join('；')} → 不发送`)
    return
  }

  const groupId = opt('group', cfg.qq?.groupIds?.[0] ? String(cfg.qq.groupIds[0]) : '')
  if (!groupId) {
    log('\n没指定群号（--group），到此为止。')
    return
  }

  await deliver(cfg, { bvid, title: m.video.title, share: result.share, cover: m.video.pic, groupId, go: flag('go') })
}

/** B站发评论。默认不发，必须 --go 且 --confirm-risk 才真发。 */
async function doComment(cfg) {
  needBvid()
  const text = opt('text')
  if (!text) throw new Error('缺 --text "评论内容"')
  if (!cfg.cookie.bili_jct) throw new Error('缺 bili_jct，无法发评论')

  const info = await videoInfo(bvid, cfg)
  log(`目标视频：${info.title}（aid=${info.aid}）`)
  log(`评论内容：${text}`)

  if (!flag('go') || !flag('confirm-risk')) {
    log('\n【未发送】自动化评论违反 B 站社区规则，封号风险落在你自己的账号上。')
    log('确认要发就同时加 --go --confirm-risk，并用小号。')
    return
  }

  const r = await addComment(cfg, { bvid, aid: info.aid, text })
  log(`已发送，rpid=${r.rpid}`)
}

/**
 * B 站额度体检：把「60 条/天是谁在用」打印清楚。
 * 60 是**账号**级风控线，dsh-bili-scroll 和本仓库同一个账号，所以先扣 pluginReservePerDay。
 */
async function doQuota(cfg) {
  const v = quotaView(cfg, loadState())
  log('')
  log('  ── B 站发言额度 ──────────────────────────')
  log(`  日期          ${v.day}`)
  log(`  账号上限      ${v.accountCap} 条/天（同一个 UID：本仓库 + dsh-bili-scroll 插件）`)
  log(`  插件预留      ${v.pluginReserve} 条（share.pluginReservePerDay）`)
  log(`  本仓库可用    ${v.whaleCap} 条`)
  log(`  今天已发      ${v.used} 条`)
  log(`  今天还剩      ${v.whaleLeft} 条`)
  const mids = Object.entries(v.byMid ?? {})
  if (mids.length) {
    log('  分主人：')
    for (const [mid, x] of mids) log(`    ${mid}　评论 ${x?.comment ?? 0}　回复 ${x?.reply ?? 0}`)
  }
  log('')
  log('  ⚠ 插件那边今天发了多少它不告诉我们，所以预留是**硬扣**的：')
  log('    不管插件跑没跑，这 ' + v.pluginReserve + ' 条都不动，宁可浪费也别超账号风控线。')
  log('')
}

/**
 * 手动跑一次评论区巡检。默认**只预演**，真发要显式 --go。
 * 常驻进程里是 agent.mjs 每 share.replyPatrolMinutes 分钟自动跑一次（--dry 时也是预演）。
 */
async function doPatrol(cfg) {
  const go = flag('go')
  const state = loadState()
  const maxVideos = opt('max') ? Number(opt('max')) : undefined
  const r = await runPatrol(cfg, state, { dry: !go, maxVideos })
  log('')
  log(`  ── 评论区巡检（${go ? '实发' : '预演'}）──────────────────` )
  log(`  看了 ${r.videos} 条视频`)
  if (r.planned?.length) {
    for (const p of r.planned) log(`  · ${p}`)
  }
  if (go) log(`  实发 ${r.sent} 条`)
  if (r.why) log(`  说明：${r.why}`)
  if (!go) log('\n  这是预演，一条都没发出去。确认要真发：node src/main.mjs patrol --go')
  log('')
}

async function main() {
  const cfg = loadConfig()
  switch (cmd) {
    case 'quota': await doQuota(cfg); break
    case 'patrol': await doPatrol(cfg); break
    case 'collect': {
      const { m, text } = await doCollect(cfg)
      log(`\n${text.slice(0, 1500)}${text.length > 1500 ? '\n……' : ''}`)
      log(`\n（素材共 ${text.length} 字）`)
      if (flag('out')) {
        fs.mkdirSync(DATA, { recursive: true })
        const f = path.join(DATA, `material-${bvid}.md`)
        fs.writeFileSync(f, text)
        log(`已写入 ${f}`)
      }
      break
    }
    case 'compose': {
      const { result } = await doCompose(cfg)
      if (result) {
        log('\n──────── 生成结果 ────────')
        log(`评分：${result.score}/20　判定：${result.verdict}　风险：${result.risk}`)
        log(`理由：${result.reason}`)
        log(`评论：${result.comment}`)
        log(`群分享：${result.share}`)
      }
      break
    }
    case 'pick': await doPick(cfg); break
    case 'send': await doSend(cfg); break
    case 'run': await doRun(cfg); break
    case 'comment': await doComment(cfg); break
    case 'ping': {
      const info = await ping(cfg)
      log('SnowLuma 在线：', JSON.stringify(info.data ?? info))
      break
    }
    default:
      log('用法：node src/main.mjs <pick|collect|compose|send|run|comment|ping|quota|patrol> [BV...] [--up mid] [--file 草稿.json] [--group 群号] [--go] [--whale]')
      log('  quota                          打印今天 B 站还剩多少条（含插件预留）')
      log('  patrol [--go] [--max N]        手动跑一次评论区巡检（默认只预演，--go 才真发）')
  }
}

main().catch((e) => {
  console.error('\n出错了：', e.message)
  process.exit(1)
})
