import { isClosedComment, isBiliRisk } from './bili-policy.mjs'
// 评论接口可能返回 HTML 风控页，不能直接 response.json()。
export function isCommentRisk(error) {
  if (error?.commentClosed || /12002.*(?:关闭|closed|disabled)/i.test(String(error?.message ?? error ?? ''))) return false
  return Boolean(error?.commentRisk) || /-412|-352|12002|12015|HTTP (?:403|412|429)|非 JSON|Unexpected token.*</i.test(String(error?.message ?? error ?? ''))
}

export async function commentJSON(response) {
  const raw = await response.text()
  let data
  try { data = JSON.parse(raw) } catch { /* 下方统一给出 HTTP 状态 */ }
  if (isClosedComment(data)) throw Object.assign(new Error('评论区已关闭（code=12002），跳过该视频'),{commentClosed:true})
  const risk = [403, 412, 429].includes(response.status) || !data || isBiliRisk(data)
  if (!response.ok || !data || risk) {
    const error = new Error(`B站评论接口 HTTP ${response.status}${data ? `，code=${data.code} ${String(data.message ?? '').slice(0, 120)}` : '，返回非 JSON 页面（可能是风控或网关拦截）'}${risk ? '；已停止本轮巡检并冷却' : ''}`)
    error.commentRisk = risk
    const retry = response.headers.get('retry-after')
    error.retryAfterMs = retry ? Math.max(0, /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) || 0 : 0
    throw error
  }
  return data
}
