/**
 * 输出层：通过 OneBot v11 让 SnowLuma 发到 QQ 群。
 *
 * SnowLuma 的 OneBot HTTP 服务默认在 3000（WebUI 是 5099，WS 是 3001）。
 * 分享卡片在新版 QQ 上会被服务端替换成「发送者版本过低」，所以默认只发文本 + 链接。
 * 想试卡片：share → json 两级，配 config.qq.sendCard = true。
 */

import { qqOutputLimit } from './qq-output-limit.mjs'

async function call(cfg, action, params, {replyToUserId='',signal,beforeDispatch}={}) {
  const admins=new Set((cfg.chat?.admins??[]).map(String))
  const adminReply=action==='send_private_msg'?admins.has(String(params.user_id)):admins.has(String(replyToUserId))
  if (!adminReply && (['send_group_msg','send_private_msg','send_msg','send_group_ai_record'].includes(action))) await qqOutputLimit.reserve()
  signal?.throwIfAborted()
  await beforeDispatch?.()
  const url = cfg.qq.onebotHttp.replace(/\/+$/, '') + '/'
  const headers = { 'content-type': 'application/json' }
  if (cfg.qq.accessToken) headers.authorization = `Bearer ${cfg.qq.accessToken}`

  const r = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ action, params, echo: `${action}-${Date.now()}` }),
    signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
  })
  const t = await r.text()
  let j
  try { j = JSON.parse(t) } catch { throw new Error(`OneBot 返回非 JSON：${t.slice(0, 200)}`) }
  if (j.status === 'failed' || (j.retcode && j.retcode !== 0)) {
    throw Object.assign(new Error(`OneBot ${action} 失败：retcode=${j.retcode} ${j.wording ?? j.message ?? ''}`),{onebotRejected:true})
  }
  return j
}

export async function getImage(cfg,file,options={}) {
  return (await call(cfg,'get_image',{file},options)).data
}

/** QQ合成请求本身会发布到群；只调用一次带回执的发送动作，绝不再转发音频。 */
export async function sendAIVoice(cfg,groupId,character,text,options={}) {
  const result=await call(cfg,'send_group_ai_record',{group_id:Number(groupId),character,text,chat_type:1},options)
  // 返回失败或缺回执时也可能已经发出；调用方不能因此重发/补文字。
  if(result.data?.message_id===undefined || result.data?.message_id===null)throw Error('语音发送未返回消息回执')
  return result.data
}
export async function sendAudioRecord(cfg,groupId,bytes,options={}) {
  const result=await call(cfg,'send_group_msg',{group_id:Number(groupId),message:[{type:'record',data:{file:`base64://${bytes.toString('base64')}`}}]},options)
  if(result.data?.message_id===undefined||result.data?.message_id===null)throw Error('语音投递回执未确认，不自动重发')
  return result.data
}

function shareSeg({ url, title, content, image }) {
  return { type: 'share', data: { url, title, content, ...(image ? { image } : {}) } }
}

function jsonCardSeg({ url, title, content, image }) {
  const card = {
    app: 'com.tencent.structmsg',
    view: 'news',
    meta: {
      news: {
        title,
        desc: content,
        jumpUrl: url,
        preview: image ?? '',
        tag: 'B站',
      },
    },
  }
  return { type: 'json', data: { data: JSON.stringify(card) } }
}

/**
 * 发一条消息到群。返回真正生效的形态。
 *
 * 2026-10 实测：新版 QQNT（9.9.x）会把机器人构造的 structmsg 分享卡片直接替换成
 * “发送者版本过低，无法展示内容”。API 返回 retcode 0，但群里只剩一行占位文字，
 * 比纯链接更难用。所以默认不发卡片，只发「一句话 + 链接」。
 * 想再试卡片：config.qq.sendCard = true。
 */
export async function sendGroup(cfg, groupId, message, context={}) {
  const segs = Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message) } }]
  const card = segs.find((s) => s.__card)?.__card

  if (card && cfg.qq?.sendCard === true) {
    const tries = [
      ['share', [shareSeg(card)]],
      ['json', [jsonCardSeg(card)]],
    ]
    for (const [name, msg] of tries) {
      try {
        await call(cfg, 'send_group_msg', { group_id: Number(groupId), message: msg },context)
        return name
      } catch(e) { if(e.qqRateLimited||!e.onebotRejected)throw e /* 只在明确拒绝时降级；超时不能确定是否已经发送 */ }
    }
  }

  const hasText = segs.some((s) => s.type === 'text' && String(s.data?.text ?? '').trim())
  const plain = segs.map((s) => (s.__card
    ? {
        type: 'text',
        // 前面已经有话说时，卡片只补一个链接，别把标题再重复一遍
        data: { text: hasText ? s.__card.url : `《${s.__card.title}》\n${s.__card.url}` },
      }
    : s))
  await call(cfg, 'send_group_msg', { group_id: Number(groupId), message: plain },context)
  return 'text'
}

export function buildShareMessage({ bvid, title, text, cover, atAll }) {
  const url = `https://www.bilibili.com/video/${bvid}`
  const segs = []
  if (atAll) segs.push({ type: 'at', data: { qq: 'all' } })
  segs.push({ type: 'text', data: { text: text.trim() + '\n' } })
  segs.push({ __card: { url, title, content: text.trim().slice(0, 60), image: cover } })
  return segs
}

export async function ping(cfg) {
  const base = cfg.qq.onebotHttp.replace(/\/+$/, '')
  try {
    const info = await call(cfg, 'get_login_info', {})
    const d = info.data ?? {}
    if (!d.user_id) throw new Error('连上了，但 OneBot 说没登录账号。先在 SnowLuma WebUI 里扫码登录。')
    return { base, ...d }
  } catch (e) {
    // fetch 的报错只有一句 "fetch failed"，真正的原因在 cause 里，得挖出来才看得懂
    const code = e.cause?.code ?? ''
    if (code === 'ECONNREFUSED' || /fetch failed/i.test(e.message)) {
      throw new Error(
        `连不上 ${base}。三种可能：\n` +
        `· SnowLuma 没启动（launcher.bat 双击了吗）\n` +
        `· 端口不是 3000（SnowLuma 的 OneBot HTTP 默认 3000，WebUI 里能改）\n` +
        `· 只开了 WebSocket 没开 HTTP 服务端`
      )
    }
    throw e
  }
}

/**
 * 拉群历史消息（OneBot 扩展 action `get_group_msg_history`）。
 *
 * 这是**扩展**接口，不是 v11 标准，各端的参数名不一样，所以调用方必须自己吞掉失败——
 * 拉不到就当没这回事，走本地日志即可，绝不能因为接口不存在就报错。
 *
 * 2026-10-19 实测确认（读 SnowLuma 自己的 index.mjs + 它的运行日志）：
 *   **SnowLuma 是支持的**，而且比想象中强——它走 `SsoGetGroupMsg` 向服务器拉，
 *   能返回**它自己活着的时候没见过**的消息（正好是「停机期间错过的话」）。
 *   但它的锚点参数叫 `message_id`，**不认 `message_seq`**（那是 go-cqhttp / NapCat 的叫法），
 *   所以两个名字都发，谁认识谁用；不传锚点时它默认从最新一条往前翻。
 *
 * @returns {Promise<Array>} 消息事件数组（顺序不定，调用方自己按 time 排）；拿不到就返回空数组
 */
export async function getGroupMsgHistory(cfg, groupId, { count = 20, messageSeq = 0, messageId = 0 } = {}) {
  const gid = Number(groupId)
  if (!Number.isFinite(gid)) return []
  const anchor = Number(messageId || messageSeq || 0)

  /**
   * 发一次。锚点有**两种叫法**，而且互相不认：
   *   - SnowLuma  → message_id   （它的 params 里压根没声明 message_seq）
   *   - go-cqhttp / Lagrange / NapCat → message_seq
   *
   * ⚠ 所以**分档重试，绝不一次全发**：万一哪天哪个端改成 strict 校验（拒绝未声明的键），
   *   多带一个键会把整次调用干掉、静默变 [] —— 那就成了"为了兼容反而把能用的搞坏"。
   *   （已核：SnowLuma 现在的 parse 是只按声明键读 raw、多余键不看，所以当前多发也安全；
   *    但这是实现细节，不能当契约依赖。保守做法就是分开两次发。）
   */
  const attempt = async (useSeq) => {
    const params = { group_id: gid, count: Math.max(1, Math.min(100, count)) }
    if (anchor) params[useSeq ? 'message_seq' : 'message_id'] = anchor
    const j = await call(cfg, 'get_group_msg_history', params)
    const list = j?.data?.messages
    return Array.isArray(list) ? list : []
  }

  // ① 先试 SnowLuma 那套叫法
  try {
    const list = await attempt(false)
    // 没锚点时两次请求完全一样，没必要再打一次
    if (!list.length && anchor) return await attempt(true).catch(() => [])
    return list
  } catch {
    // ② 第一次就失败（端不支持 / strict 拒绝了 / 没权限）→ 换个叫法再试一次
    if (!anchor) return []
    return await attempt(true).catch(() => [])
  }
}

/** 私聊发一条。管理员对话走这条，不经过群。 */
export async function sendPrivate(cfg, userId, message,context={}) {
  const segs = Array.isArray(message) ? message : [{ type: 'text', data: { text: String(message) } }]
  await call(cfg, 'send_private_msg', { user_id: Number(userId), message: segs },context)
  return 'private'
}
// An uncertain transport result must not trigger a second format send.
