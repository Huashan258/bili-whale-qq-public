import { normalizePersonaOutput } from './persona.mjs'
import { prepareDeepReply } from './deep-reply.mjs'
import { hideReplyURLs } from './reply-links.mjs'
/**
 * 模型层：只有"写作"和"判断"两件事，纯文本即可。
 *
 * provider 支持：
 *   deepseek  —— 官方 /chat/completions，OpenAI 兼容，最省钱
 *   openai    —— 任何 OpenAI 兼容网关（qwen / glm / moonshot / 硅基流动 / 自建 vLLM）
 *   none      —— 不调模型，只吐素材。交给 WorkBuddy 的智能体自己写
 *
 * 注意：WorkBuddy 云服务的免密钥模型（/.cloud/llm/chat/completions）是给
 * "部署在 WorkBuddy 上的应用/小程序"用的，需要在宿主里拿会话凭证，
 * 不能当成一个公开 baseUrl 挂到 VPS 上。所以最顺的 WorkBuddy 用法是
 * provider=none + WorkBuddy 定时任务唤醒（见 README 的 A 方案）。
 */

function endpoint(llm) {
  if (llm.provider === 'workbuddy') return `${llm.baseUrl}/.cloud/llm/chat/completions`
  return `${llm.baseUrl}/chat/completions`
}

export function hasLLM(llm) {
  return llm.provider !== 'none' && Boolean(llm.apiKey)
}

/**
 * 把各家 usage 归一成 { prompt, completion, reasoning, total }。
 * reasoner 类模型会把思考过程单独计费，不取出来的话「一句烧了三千」永远查不到源头。
 */
function normUsage(u) {
  if (!u) return { prompt: 0, completion: 0, reasoning: 0, total: 0 }
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0
  const completion = u.completion_tokens ?? u.output_tokens ?? 0
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0
  const total = u.total_tokens ?? prompt + completion
  return { prompt, completion, reasoning, total }
}

export async function chat(llm, options, runtime={}) {
  if (!hasLLM(llm)) {
    throw new Error(`模型未配置：provider=${llm.provider}，apiKey 为空`)
  }
  const { system, user, json = false, temperature, maxTokens, signal, outputTokenCeiling = 20000, thinking, reasoningEffort, hideSourceURLs }=await prepareDeepReply(llm,options)

  const body = {
    model: llm.model,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    temperature: temperature ?? llm.temperature ?? 1.3,
    stream: false,
  }
  // 普通路人调用20K，管理员可显式申请60K、令咒最高200K；实际能力仍取决于所用模型。
  const cap = Number(maxTokens ?? llm.maxTokens ?? 0)
  if (cap > 0) body.max_tokens = Math.min(Math.floor(cap), Math.min(200000, Math.max(1, Number(outputTokenCeiling) || 20000)))

  // DeepSeek 的 json mode 偶尔会把 JSON 包在 markdown 里，解析侧有兜底，这里能加就加
  if (json) body.response_format = { type: 'json_object' }
  if (llm.provider === 'deepseek' && ['enabled','disabled'].includes(thinking)) body.thinking = {type:thinking}
  if(llm.provider==='deepseek'&&thinking==='enabled'&&['low','high','max'].includes(reasoningEffort))body.reasoning_effort=reasoningEffort

  const now=runtime.now??Date.now,random=runtime.random??Math.random,request=runtime.fetch??fetch
  const sleep=runtime.sleep??(ms=>new Promise((resolve,reject)=>{
    const cancel=()=>{clearTimeout(timer);reject(signal.reason??Error('请求已取消'))}
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve()},ms)
    signal?.addEventListener('abort',cancel,{once:true})
  }))
  const timeoutSec=Math.min(180,Math.max(10,Number(llm.requestTimeoutSec)||60))
  const retryValue=Number(llm.maxRetries??2)
  const maxRetries=Number.isFinite(retryValue)?Math.min(3,Math.max(0,Math.floor(retryValue))):2
  const deadline=now()+timeoutSec*1000
  let lastErr
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    signal?.throwIfAborted()
    const remaining=deadline-now()
    if(remaining<=0)throw Object.assign(Error(`模型请求超过 ${timeoutSec} 秒总时限`),{code:'MODEL_TIMEOUT'})
    let retryAfter=0
    try {
      const timeout=AbortSignal.timeout(Math.max(1,Math.ceil(remaining)))
      const r = await request(endpoint(llm), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${llm.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal?AbortSignal.any([signal,timeout]):timeout,
      })
      const text = await r.text()
      if (!r.ok) {
        const header=r.headers?.get?.('retry-after')
        if(header)retryAfter=/^\d+(\.\d+)?$/.test(header)?Number(header)*1000:Math.max(0,Date.parse(header)-now())||0
        throw Object.assign(new Error(`模型调用失败 HTTP ${r.status}`),{code:`MODEL_HTTP_${r.status}`,fatal:!(r.status===429||r.status===408||r.status>=500)})
      }
      let data
      try{data=JSON.parse(text)}catch{throw Object.assign(Error('模型返回非 JSON 响应，请检查 API 地址和网关'),{code:'MODEL_RESPONSE',fatal:true})}
      if(!Array.isArray(data?.choices)||!data.choices.length)throw Object.assign(Error('模型响应缺少 choices，请检查接口兼容性'),{code:'MODEL_RESPONSE',fatal:true})
      const choice = data?.choices?.[0]
      const content = choice?.message?.content ?? ''
      const finish = choice?.finish_reason ?? null
      return { content:normalizePersonaOutput(hideSourceURLs?hideReplyURLs(content):content,system), usage: normUsage(data.usage), finish, truncated: finish === 'length', raw: data }
    } catch (e) {
      lastErr = e
      if(signal?.aborted)throw signal.reason??e
      if(e.name==='TimeoutError'||now()>=deadline)throw Object.assign(Error(`模型请求超过 ${timeoutSec} 秒总时限`),{code:'MODEL_TIMEOUT'})
      // 不把上游响应、URL、Authorization 或网络原始异常写入日志。
      if(!e.code?.startsWith?.('MODEL_'))lastErr=Object.assign(Error('模型网络连接失败'),{code:'MODEL_NETWORK'})
      if (e.fatal || attempt===maxRetries) break
      const delay=Math.max(retryAfter,1000*2**attempt+Math.floor(random()*500))
      if(delay>=deadline-now())break
      await sleep(delay)
    }
  }
  throw lastErr
}

/**
 * 修复字符串值里的裸双引号。
 *
 * 模型很爱在 reason / comment 里写 `他说的"名台词"` —— 中文语境下的引号常被
 * 输出成 ASCII 双引号，直接把 JSON 撑坏。这里用一个状态机判断每个 " 到底是
 * 结构引号还是内容引号：在字符串内部、且后面紧跟的不是 , } ] : 的，一律转义。
 */
function repairQuotes(s) {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\') {
      out += ch + (s[i + 1] ?? '')
      i++
      continue
    }
    if (ch !== '"') {
      out += ch
      continue
    }
    if (!inStr) {
      inStr = true
      out += ch
      continue
    }
    // 在字符串内：向后看第一个非空白字符，判断是否为结构符号
    let j = i + 1
    while (j < s.length && /\s/.test(s[j])) j++
    const next = s[j]
    if (next === ',' || next === '}' || next === ']' || next === ':') {
      inStr = false
      out += ch
    } else {
      out += '\\"'
    }
  }
  return out
}

/** 从模型输出里抠出 JSON——容忍 ```json 包裹、前后废话、内容里的裸引号 */
export function parseJSON(content) {
  if (!content) return null
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates = [fenced?.[1], content]
  for (const c of candidates) {
    if (!c) continue
    const s = c.indexOf('{')
    const e = c.lastIndexOf('}')
    if (s === -1 || e <= s) continue
    const body = c.slice(s, e + 1)
    try { return JSON.parse(body) } catch { /* 试修复 */ }
    try { return JSON.parse(repairQuotes(body)) } catch { /* 继续找 */ }
  }
  return null
}
// All attempts share one deadline and propagate cancellation to transport and backoff.

// QQ command and explicit video integration, 2026-10-21.
