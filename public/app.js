const $ = (s) => document.querySelector(s)
const $$ = (s) => [...document.querySelectorAll(s)]

const state = {
  bvid: '',
  material: null,
  text: '',
  result: null,
  problems: [],
  status: null,
  busy: false,
}

/* ── 小工具 ─────────────────────────────────────────── */

async function api(path, body) {
  const opt = body === undefined
    ? { method: 'GET' }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
  const r = await fetch(path, opt)
  const data = await r.json().catch(() => ({ error: '返回的不是 JSON' }))
  if (!r.ok || data.error) throw new Error(data.error ?? `HTTP ${r.status}`)
  return data
}

function toast(msg, isErr = false) {
  const el = $('#toast')
  el.textContent = msg
  el.className = 'toast' + (isErr ? ' err' : '')
  el.hidden = false
  clearTimeout(el._t)
  el._t = setTimeout(() => { el.hidden = true }, isErr ? 5200 : 2600)
}

function fmtNum(n) {
  if (n == null) return '–'
  if (n >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿'
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万'
  return String(n)
}

/** token 数：一万以上折成 1.2k，免得数字太长把头部挤爆 */
function fmtTokens(n) {
  const v = Number(n) || 0
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(v)
}

function fmtDur(s) {
  if (!s) return '–'
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function parseBvid(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const m = s.match(/BV[0-9A-Za-z]{10}/)
  if (m) return m[0]
  const t = s.replace(/^BV/i, '')
  return /^[0-9A-Za-z]{10}$/.test(t) ? 'BV' + t : ''
}

function busy(on, which) {
  state.busy = on
  for (const id of ['#btn-collect', '#btn-compose', '#btn-dry', '#btn-send', '#btn-comment']) {
    $(id).disabled = on
  }
  if (on && which) {
    const el = $(which)
    el.dataset.label ??= el.textContent
    el.textContent = '处理中…'
  } else {
    for (const id of ['#btn-collect', '#btn-compose']) {
      const el = $(id)
      if (el.dataset.label) { el.textContent = el.dataset.label; delete el.dataset.label }
    }
  }
}

function askConfirm({ title, body, okText = '确认', danger = false }) {
  return new Promise((resolve) => {
    $('#confirm-title').textContent = title
    $('#confirm-body').innerHTML = body
    const ok = $('#confirm-ok')
    ok.textContent = okText
    ok.className = 'btn ' + (danger ? 'danger-outline' : 'primary')
    $('#confirm-mask').hidden = false

    const done = (v) => {
      $('#confirm-mask').hidden = true
      ok.removeEventListener('click', onOk)
      $('#confirm-cancel').removeEventListener('click', onNo)
      resolve(v)
    }
    const onOk = () => done(true)
    const onNo = () => done(false)
    ok.addEventListener('click', onOk)
    $('#confirm-cancel').addEventListener('click', onNo)
  })
}

/* ── 状态条 ─────────────────────────────────────────── */

async function refreshStatus() {
  try {
    const s = await api('/api/status')
    state.status = s
    $('#quota-used').textContent = s.used
    $('#quota-max').textContent = s.max
    $('#model-name').textContent = s.hasLLM ? `${s.model}` : (s.provider === 'none' ? '仅采素材' : '未配置')

    const hc = $('#hint-cookie')
    hc.textContent = s.hasCookie ? 'B站凭据已就绪' : 'B站凭据未配置（字幕和评论都用不了）'
    hc.className = 'hint-line ' + (s.hasCookie ? 'good' : 'bad')

    const hl = $('#hint-llm')
    hl.textContent = s.hasLLM ? `写作模型 ${s.provider} · ${s.model}` : '模型未配置，只能采素材'
    hl.className = 'hint-line ' + (s.hasLLM ? 'good' : 'bad')

    if (!s.groups?.length) {
      $('#group').value = ''
    } else if (!$('#group').value) {
      $('#group').value = s.groups[0]
    }
    return s
  } catch (e) {
    toast('读不到配置：' + e.message, true)
    return null
  }
}

async function pingQQ() {
  const dot = $('#qq-dot')
  const txt = $('#qq-state')
  dot.className = 'dot'
  txt.textContent = '检测中'
  try {
    await api('/api/ping')
    dot.className = 'dot on'
    txt.textContent = 'SnowLuma 在线'
    toast('SnowLuma 连接正常')
  } catch (e) {
    dot.className = 'dot off'
    txt.textContent = '连不上'
    toast('连不上 SnowLuma：' + e.message, true)
  }
}

/* ── 历史列表 ───────────────────────────────────────── */

async function refreshHistory() {
  try {
    const { items } = await api('/api/history')
    const ul = $('#history')
    if (!items.length) {
      ul.innerHTML = '<li style="cursor:default;color:#8a8780;font-size:11.5px;padding:8px 9px">还没有采过片</li>'
      return
    }
    ul.innerHTML = items.map((it) => `
      <li data-bvid="${esc(it.bvid)}" class="${it.bvid === state.bvid ? 'active' : ''}">
        <div class="h-t">${esc(it.title ?? it.bvid)}</div>
        <div class="h-m">
          <span class="s">${it.result ? it.result.score + '/20' : '—'}</span>
          <span>${esc(it.owner ?? '')}</span>
        </div>
      </li>`).join('')
  } catch { /* 首次启动没有目录，忽略 */ }
}

/* ── 渲染采集结果 ───────────────────────────────────── */

function renderMaterial(m, text) {
  state.material = m
  state.text = text
  $('#empty').hidden = true
  $('#video').hidden = false

  const v = m.video
  $('#cover').src = v.pic ?? ''
  $('#cover').alt = v.title ?? ''
  $('#title').textContent = v.title ?? ''
  $('#owner').textContent = v.owner ?? ''
  $('#pubdate').textContent = v.pubdate ?? ''
  $('#duration').textContent = fmtDur(v.duration)
  $('#st-view').textContent = fmtNum(v.stat?.view)
  $('#st-like').textContent = fmtNum(v.stat?.like)
  $('#st-danmaku').textContent = fmtNum(v.stat?.danmaku)
  $('#st-reply').textContent = fmtNum(v.stat?.reply)
  $('#tags').innerHTML = (m.tags ?? []).slice(0, 8).map((t) => `<span>${esc(t)}</span>`).join('')

  $('#c-sub').textContent = m.subtitle?.lines?.length ?? 0
  $('#c-dm').textContent = m.danmaku?.total ?? 0
  $('#c-cm').textContent = m.comments?.length ?? 0

  // 字幕
  const sub = $('#pane-subtitle')
  if (m.subtitle?.lines?.length) {
    sub.innerHTML = `<div class="sub-lines">${m.subtitle.lines.slice(0, 300).map((l) => `<p>${esc(l)}</p>`).join('')}</div>`
  } else {
    sub.innerHTML = `<div class="notice">${esc(m.subtitle?.note || '这条没有官方字幕轨')}　${
      m.whale ? '深读结果在下面。' : '可以勾上「深读」再跑一次，读画面里的硬字幕。'}</div>`
      + (m.whale ? `<pre class="pre">${esc(m.whale)}</pre>` : '')
  }

  // 弹幕
  const dm = $('#pane-danmaku')
  const hot = m.danmaku?.hot ?? []
  dm.innerHTML = hot.length
    ? `<div class="dm-cloud">${hot.map((d, i) => `<span class="${i < 14 ? 'hot' : ''}">${esc(d.text)}${d.n > 1 ? ` <em style="font-family:var(--mono);font-style:normal;opacity:.55">×${d.n}</em>` : ''}</span>`).join('')}</div>`
    : '<div class="notice">没取到弹幕</div>'

  // 热评
  const cm = $('#pane-comments')
  cm.innerHTML = (m.comments ?? []).length
    ? `<div class="cm-list">${m.comments.map((c) => `
        <div class="cm">
          <div class="u"><b>${esc(c.user)}</b><em>${fmtNum(c.like)} 赞</em></div>
          <p>${esc(c.text)}</p>
        </div>`).join('')}</div>`
    : '<div class="notice">没取到热评</div>'

  $('#pane-raw').textContent = text
}

function switchTab(name) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name))
  $$('.pane').forEach((p) => { p.hidden = p.dataset.pane !== name })
}

/* ── 草稿面板 ───────────────────────────────────────── */

function renderDraft(result, problems = []) {
  state.result = result
  state.problems = problems

  const chip = $('#score-chip')
  if (result) {
    chip.textContent = `${result.score}/20 · ${result.verdict}`
    chip.className = 'score-chip ' + (result.verdict === '发' ? 'good' : 'bad')
  } else {
    chip.textContent = '—'
    chip.className = 'score-chip'
  }

  const gate = $('#gate')
  if (problems.length) {
    gate.hidden = false
    gate.innerHTML = `<ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
  } else {
    gate.hidden = true
  }

  $('#ta-comment').value = result?.comment ?? ''
  $('#ta-share').value = result?.share ?? ''
  updateCounts()

  const r = $('#reason')
  if (result?.reason) {
    r.hidden = false
    r.textContent = '为什么：' + result.reason
  } else {
    r.hidden = true
  }
}

function updateCounts() {
  const c = $('#ta-comment').value.length
  const s = $('#ta-share').value.length
  $('#cnt-comment').textContent = c
  $('#cnt-share').textContent = s
  $('#cnt-comment').parentElement.classList.toggle('over', c > 60)
  $('#cnt-share').parentElement.classList.toggle('over', s > 60)
}

/* ── 主流程 ─────────────────────────────────────────── */

async function doCollect() {
  const bvid = parseBvid($('#bvid').value)
  if (!bvid) return toast('BV 号不对。形如 BV1GJ411x7h7，大小写敏感', true)
  state.bvid = bvid
  busy(true, '#btn-collect')
  try {
    const d = await api('/api/collect', { bvid, whale: $('#deep').checked })
    renderMaterial(d.material, d.text)
    renderDraft(null, [])
    switchTab('subtitle')
    await refreshHistory()
    toast(`采集完成：素材 ${d.len} 字`)
  } catch (e) {
    toast(e.message, true)
  } finally {
    busy(false)
  }
}

async function doCompose() {
  const bvid = parseBvid($('#bvid').value) || state.bvid
  if (!bvid) return toast('先填 BV 号', true)
  state.bvid = bvid
  busy(true, '#btn-compose')
  try {
    const d = await api('/api/compose', { bvid, whale: $('#deep').checked })
    renderMaterial(d.material, d.text)
    renderDraft(d.result, d.problems)
    await refreshHistory()
    const cost = d.usage ? ` · ${d.usage.prompt_tokens}+${d.usage.completion_tokens} token` : ''
    toast(`草稿已生成${cost}`)
  } catch (e) {
    toast(e.message, true)
  } finally {
    busy(false)
  }
}

async function doSend(go) {
  const text = $('#ta-share').value.trim()
  if (!text) return toast('群分享文案是空的', true)
  const groupId = $('#group').value.trim()
  if (!groupId) return toast('先填群号（设置里也能配）', true)

  const preview = `<div>会发到群 <b style="font-family:var(--mono)">${esc(groupId)}</b>：</div>
    <div class="pv">${esc(text)}\n\n《${esc(state.material?.video?.title ?? state.bvid)}》\nhttps://www.bilibili.com/video/${esc(state.bvid)}</div>`

  if (!go) {
    await askConfirm({ title: '预演（不会真的发）', body: preview, okText: '知道了' })
    return
  }

  const ok = await askConfirm({ title: '确认发到群里？', body: preview, okText: '发送' })
  if (!ok) return

  busy(true)
  try {
    const d = await api('/api/send', { bvid: state.bvid, groupId, text, go: true })
    const shape = d.results?.[0]?.shape
    toast(`已发送（${shape === 'text' ? '纯文本，卡片没生效' : '分享卡片'}）· 今日 ${d.used} 条`)
    await refreshStatus()
  } catch (e) {
    toast(e.message, true)
  } finally {
    busy(false)
  }
}

async function doComment() {
  const text = $('#ta-comment').value.trim()
  if (!text) return toast('评论是空的', true)

  const ok = await askConfirm({
    title: '真的要用你的号发评论？',
    body: `<div style="color:var(--danger);margin-bottom:8px">自动化评论违反 B 站社区规则，风控会落在你自己的账号上。建议用小号，并控制频率。</div>
      <div>要发到《${esc(state.material?.video?.title ?? state.bvid)}》：</div>
      <div class="pv">${esc(text)}</div>`,
    okText: '我确认，发',
    danger: true,
  })
  if (!ok) return

  busy(true)
  try {
    const r = await api('/api/comment', { bvid: state.bvid, text, confirmRisk: true })
    toast(r?.verified === true ? '评论已发出，回查确认在评论区' : '评论已发出（回查没命中，可能还在审核）')
  } catch (e) {
    toast(e.message, true)
  } finally {
    busy(false)
  }
}

/* ── 设置 ───────────────────────────────────────────── */

/**
 * 密钥永远不回传，所以只能用掩码确认"存的是哪一把"。
 * 之前只在标签边上加了一行小灰字，用户根本没看见，以为没存上 —— 现在把状态写死。
 */
function renderKeyState(mask, hasLLM) {
  const hint = $('#s-apikey-hint')
  const el = $('#s-apikey-state')
  if (!el || !hint) return

  if (mask) {
    hint.textContent = mask
    hint.className = 'key-hint set'
    el.className = 'key-state ok'
    el.innerHTML = `<span>✓ 已保存</span><span class="k">${esc(mask)}</span>`
    $('#s-apikey').placeholder = `已保存 ${mask}，粘贴新 key 可替换`
  } else if (hasLLM) {
    hint.textContent = '已配置'
    hint.className = 'key-hint set'
    el.className = 'key-state ok'
    el.innerHTML = '<span>✓ 已配置密钥（原文不显示是正常的）</span>'
  } else {
    hint.textContent = '未配置'
    hint.className = 'key-hint'
    el.className = 'key-state bad'
    el.innerHTML = '<span>✗ 还没有密钥，粘贴 sk-... 再点保存</span>'
    $('#s-apikey').placeholder = 'sk-...'
  }
}

/* 主人 UP 的「回复评论区」开关。名单本身在 config.json 里维护，
   这里只负责把它渲染出来、并把勾选结果回写，避免在页面上误删/误加 UP。 */
function renderMasterSwitches() {
  const box = $('#master-switches')
  if (!box) return
  const list = state.status?.masters ?? []
  if (!list.length) {
    box.innerHTML = '<div class="empty-line">还没配主人 UP（config.json → bili.masters）</div>'
    return
  }
  box.innerHTML = list.map((m) => `
    <label class="switch">
      <span>${esc(m.name || '未命名')}<i class="mid">${esc(m.mid)}</i></span>
      <input type="checkbox" data-mid="${esc(m.mid)}" ${m.replyComments ? 'checked' : ''}>
      <span>回复评论区</span>
    </label>`).join('')
}

function openSettings() {
  const s = state.status
  if (!s) return
  const r = s.raw
  // 只有"从关着到打开"才清空密钥框。抽屉开着时再点一次齿轮不该
  // 把刚粘进去的 key 抹掉——之前"填了保存还是旧 key"就是这么来的。
  const wasOpen = !$('#settings').hidden

  $('#s-sessdata').placeholder = r.bili.hasSessdata ? '已配置，留空不修改' : '未配置'
  $('#s-jct').placeholder = r.bili.hasBiliJct ? '已配置，留空不修改' : '未配置'
  $('#s-buvid').placeholder = r.bili.hasBuvid3 ? '已配置，留空不修改' : '未配置'
  $('#s-apikey').placeholder = s.hasLLM ? '已配置，留空不修改' : 'sk-...'
  $('#s-token').placeholder = r.qq.accessToken ? '已配置，留空不修改' : '没有就留空'

  // 密钥不回传，只能用掩码告诉你"存的是哪一把"，否则输入框一清空就像没存
  renderKeyState(r.llm?.apiKeyMask, s.hasLLM)

  const note = $('#bili-login-note')
  if (note) {
    const b = r.bili ?? {}
    note.textContent = b.hasSessdata && b.hasBiliJct
      ? `✓ 本机已存凭据${b.mid ? `（UID ${b.mid}）` : ''}，点「检查登录」看是否还有效`
      : '还没登录。扫码后会自动写入下面三个值。'
  }

  $('#s-provider').value = r.llm.provider ?? 'deepseek'
  $('#s-model').value = r.llm.model ?? ''
  $('#s-baseurl').value = r.llm.baseUrl ?? ''
  $('#s-temp').value = r.llm.temperature ?? ''
  $('#s-onebot').value = r.qq.onebotHttp ?? ''
  $('#s-groups').value = (r.qq.groupIds ?? []).join(', ')
  $('#s-admins').value = (r.chat?.admins ?? []).join(', ')
  $('#s-max').value = r.guard.maxSharePerDay ?? 3
  $('#s-cd').value = r.guard.sameVideoCooldownDays ?? 7
  $('#s-min').value = r.guard.minScore ?? 13

  const sh = r.share ?? {}
  $('#s-bili-total').value = sh.biliCommentPerDay ?? 6
  $('#s-master-cmt').value = sh.masterCommentPerDay ?? 1
  $('#s-reply-video').value = sh.masterReplyPerVideo ?? 2
  $('#s-reply-day').value = sh.masterReplyPerDay ?? 3
  $('#s-reply-days').value = sh.masterReplyWithinDays ?? 3
  $('#s-bili-gap').value = sh.biliGapSec ?? 25
  $('#s-plugin-reserve').value = sh.pluginReservePerDay ?? 0
  renderMasterSwitches()

  $('#s-whale').value = r.whale.dir ?? ''

  for (const id of ['#s-sessdata', '#s-jct', '#s-buvid', '#s-apikey', '#s-token']) {
    if (!wasOpen) $(id).value = ''
  }
  if (!wasOpen) keyDraft = ''
  if (!wasOpen) $('#s-apikey').placeholder = r.llm?.apiKeyMask
    ? `已保存 ${r.llm.apiKeyMask}，粘贴新 key 可替换`
    : 'sk-...'

  const cp = $('#s-configpath')
  if (cp) cp.textContent = s.configFile
    ? `直接写进本机 ${s.configFile}，重启后自动沿用。`
    : '直接写进本机 config.json，重启后自动沿用。'

  $('#mask').hidden = false
  $('#settings').hidden = false
}

function closeSettings() {
  $('#mask').hidden = true
  $('#settings').hidden = true
}

/* 用户这次输入的 key 在内存里留一份。
   DOM 里的值有可能被意外清掉（重开抽屉、密码管理器、页面刷新），
   只读 DOM 会在毫无提示的情况下把 key 丢掉——这正是"填了还是旧 key"的来源。 */
let keyDraft = ''

function rememberKey() {
  const v = $('#s-apikey')?.value.trim()
  if (v) keyDraft = v
}

async function saveSettings() {
  const groups = $('#s-groups').value.split(/[,，\s]+/).filter(Boolean)
  const typedKey = $('#s-apikey').value.trim() || keyDraft
  // 额度允许填 0（= 关掉），所以不能再用 `|| 默认值` 那种写法
  const num = (sel, dft) => {
    const s = $(sel).value.trim()
    const v = Number(s)
    return s !== '' && Number.isFinite(v) ? v : dft
  }
  const masterSwitches = [...document.querySelectorAll('#master-switches input[data-mid]')]
    .map((el) => ({ mid: el.dataset.mid, replyComments: el.checked }))
  const payload = {
    bili: {
      sessdata: $('#s-sessdata').value.trim(),
      bili_jct: $('#s-jct').value.trim(),
      buvid3: $('#s-buvid').value.trim(),
    },
    llm: {
      provider: $('#s-provider').value,
      model: $('#s-model').value.trim() || 'deepseek-chat',
      baseUrl: $('#s-baseurl').value.trim() || 'https://api.deepseek.com',
      temperature: Number($('#s-temp').value) || 1.3,
      apiKey: typedKey,
    },
    chat: {
      admins: $('#s-admins').value.split(/[,，\s]+/).filter(Boolean),
    },
    qq: {
      onebotHttp: $('#s-onebot').value.trim() || 'http://127.0.0.1:3000',
      groupIds: groups,
      accessToken: $('#s-token').value.trim(),
    },
    guard: {
      maxSharePerDay: Number($('#s-max').value) || 3,
      sameVideoCooldownDays: Number($('#s-cd').value) || 7,
      minScore: Number($('#s-min').value) || 13,
    },
    share: {
      biliCommentPerDay: num('#s-bili-total', 6),
      masterCommentPerDay: num('#s-master-cmt', 1),
      masterReplyPerVideo: num('#s-reply-video', 2),
      masterReplyPerDay: num('#s-reply-day', 3),
      masterReplyWithinDays: num('#s-reply-days', 3),
      biliGapSec: num('#s-bili-gap', 25),
      pluginReservePerDay: num('#s-plugin-reserve', 0),
    },
    masters: masterSwitches,
    whale: { dir: $('#s-whale').value.trim() },
  }
  try {
    const res = await api('/api/config', payload)
    await refreshStatus()
    const st = state.status
    const mask = res?.saved?.apiKeyMask ?? st?.raw?.llm?.apiKeyMask ?? ''
    const okLLM = res?.saved?.hasLLM ?? st?.hasLLM

    // 后端把"写盘之后的真实状态"返回来了。填了新 key 却和磁盘上的不一致，
    // 就是真没写进去，必须红字说清楚，不能再用一句"已保存"糊过去。
    const wroteKey = typedKey && (res?.received ? res.received.apiKeyLen > 0 : true)
    const mismatch = wroteKey && mask.slice(-4) !== typedKey.slice(-4)

    renderKeyState(mask, okLLM)
    $('#s-apikey').value = ''
    $('#s-apikey').type = 'password'
    $('#btn-llm-eye').textContent = '显示'

    if (mismatch) {
      toast(`没写进去：你填的尾号 ${typedKey.slice(-4)}，磁盘上仍是 ${mask}`, true)
      return
    }
    if (wroteKey) keyDraft = ''
    closeSettings()
    toast(wroteKey
      ? `已写入 config.json · key ${mask} · 模型 ${res?.saved?.model ?? st?.model}`
      : okLLM
        ? `已保存（key 未改，仍是 ${mask}）`
        : '已保存，但还没有可用密钥（模型用不了）')
  } catch (e) {
    toast(e.message, true)
  }
}

function toggleKeyEye() {
  const inp = $('#s-apikey')
  const btn = $('#btn-llm-eye')
  const show = inp.type === 'password'
  inp.type = show ? 'text' : 'password'
  btn.textContent = show ? '隐藏' : '显示'
}

async function testLLM() {
  const btn = $('#btn-llm-test')
  const typed = $('#s-apikey').value.trim() || keyDraft
  btn.disabled = true
  const label = btn.textContent
  btn.textContent = '测试中'
  try {
    // 先在输入框里填了 key 就先存，不然测的还是旧的
    if (typed) await saveSettingsQuiet()
    const r = await api('/api/llm/test', {})
    toast(`通了 · ${r.model} · ${r.ms}ms · 回复「${r.reply}」`)
  } catch (e) {
    toast('不通：' + e.message, true)
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

/** 只写 llm 部分，不关抽屉、不弹 toast */
async function saveSettingsQuiet() {
  const typed = $('#s-apikey').value.trim() || keyDraft
  const res = await api('/api/config', {
    llm: {
      provider: $('#s-provider').value,
      model: $('#s-model').value.trim() || 'deepseek-chat',
      baseUrl: $('#s-baseurl').value.trim() || 'https://api.deepseek.com',
      temperature: Number($('#s-temp').value) || 1.3,
      apiKey: typed,
    },
  })
  await refreshStatus()
  const mask = res?.saved?.apiKeyMask ?? state.status?.raw?.llm?.apiKeyMask ?? ''
  renderKeyState(mask, res?.saved?.hasLLM ?? state.status?.hasLLM)
  if (typed && res?.received?.apiKeyLen > 0 && mask.slice(-4) !== typed.slice(-4)) {
    throw new Error(`密钥没写进磁盘：填的尾号 ${typed.slice(-4)}，磁盘上还是 ${mask}`)
  }
  if (typed) $('#s-apikey').value = ''
  return res
}

async function checkBalance() {
  try {
    const b = await api('/api/balance')
    const info = b.balance_infos?.[0]
    toast(info ? `余额 ${info.total_balance} ${info.currency}（可用 ${info.available_balance}）` : '已连通，返回格式不认识')
  } catch (e) {
    toast('查不到余额：' + e.message, true)
  }
}

/* ── 绑定 ───────────────────────────────────────────── */

$('#btn-collect').addEventListener('click', doCollect)
$('#btn-compose').addEventListener('click', doCompose)
$('#btn-dry').addEventListener('click', () => doSend(false))
$('#btn-send').addEventListener('click', () => doSend(true))
$('#btn-comment').addEventListener('click', doComment)
$('#btn-ping').addEventListener('click', pingQQ)
$('#btn-settings').addEventListener('click', () => switchView('settings'))
$('#settings-connections').addEventListener('click', openSettings)
$('#btn-close-settings').addEventListener('click', closeSettings)
$('#mask').addEventListener('click', closeSettings)
$('#btn-save').addEventListener('click', saveSettings)
$('#btn-balance').addEventListener('click', checkBalance)
$('#btn-llm-test').addEventListener('click', testLLM)
$('#btn-llm-eye').addEventListener('click', toggleKeyEye)
// 输入/粘贴时留一份在内存里，防止 DOM 值被意外清掉后静默丢失
$('#s-apikey').addEventListener('input', rememberKey)
$('#s-apikey').addEventListener('change', rememberKey)
$('#s-apikey').addEventListener('paste', () => setTimeout(rememberKey, 0))
$('#btn-refresh').addEventListener('click', refreshHistory)

$('#bvid').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doCollect()
})

$('#ta-comment').addEventListener('input', updateCounts)
$('#ta-share').addEventListener('input', updateCounts)

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]')
  if (b) switchTab(b.dataset.tab)
})

$('#history').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-bvid]')
  if (!li) return
  state.bvid = li.dataset.bvid
  $('#bvid').value = li.dataset.bvid.slice(2)
  $$('#history li').forEach((x) => x.classList.toggle('active', x === li))
  try {
    const { items } = await api('/api/history')
    const rec = items.find((x) => x.bvid === state.bvid)
    if (!rec) return
    $('#empty').hidden = true
    $('#video').hidden = false
    $('#title').textContent = rec.title ?? rec.bvid
    $('#owner').textContent = rec.owner ?? ''
    $('#cover').src = rec.cover ?? ''
    $('#duration').textContent = fmtDur(rec.duration)
    $('#st-view').textContent = fmtNum(rec.stats?.view)
    $('#st-like').textContent = fmtNum(rec.stats?.like)
    $('#st-danmaku').textContent = fmtNum(rec.stats?.danmaku)
    $('#st-reply').textContent = fmtNum(rec.stats?.reply)
    $('#c-sub').textContent = rec.counts?.subtitle ?? 0
    $('#c-dm').textContent = rec.counts?.danmaku ?? 0
    $('#c-cm').textContent = rec.counts?.comments ?? 0
    if (rec.result) renderDraft(rec.result, [])
    toast('已载入历史，素材需要重新采集才能看全文')
  } catch { /* 忽略 */ }
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeSettings()
    $('#confirm-mask').hidden = true
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doCompose()
})

/* ── 启动 ───────────────────────────────────────────── */

;(async () => {
  await refreshStatus()
  await refreshHistory()
  switchView(['overview','review','chat','persona','settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview')
})()

/* ── 群聊视图 ───────────────────────────────────────── */

let chatPoll = null
let chatHistoryBefore=null,chatHistoryMore=false,chatHistoryPinned=false,chatHistoryRows=[],chatHistoryQuery='',chatHistoryBusy=false,chatHistoryNick='青娥鱼',chatScrollLatest=false

function switchView(view) {
  if(!['overview','review','chat','persona','settings'].includes(view))view='overview'
  history.replaceState(null,'','#'+view)
  $('#view-overview').hidden = view !== 'overview'
  document.dispatchEvent(new CustomEvent('view:changed',{detail:{view}}))
  $$('#viewswitch button').forEach((b) => b.classList.toggle('active', b.dataset.view === view))
  $('#view-review').hidden = view !== 'review'
  $('#view-chat').hidden = view !== 'chat'
  $('#view-persona').hidden = view !== 'persona'
  $('#view-settings').hidden = view !== 'settings'
  if (view === 'settings') document.dispatchEvent(new Event('settings:open'))
  clearInterval(chatPoll)
  chatPoll = null
  if (view === 'chat') {
    loadChat()
    chatPoll = setInterval(loadChat, 6000)
  }
  if (view === 'persona') loadPersona()
}

function hhmm(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '--:--'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function chatRow(entry, nick) {
  const time = `<div class="chat-time">${hhmm(entry.ts)}</div>`
  const where = entry.channel === 'private'
    ? (entry.admin ? '私聊 · 管理员' : '私聊 · 访客')
    : (entry.groupName ? `#${esc(entry.groupName)}` : `#${esc(entry.group ?? '')}`)

  if(entry.type==='forward-read')return `<div class="chat-row sys">${time}<div class="chat-body"><span class="chat-meta">${where}</span><div class="chat-text">合并转发${entry.ok?'已读取':'读取失败'} · ${Number(entry.nodes)||0}条 · 含${Number(entry.images)||0}张图片${entry.truncated?' · 部分内容未展开':''}${entry.failed?' · 有子记录读取失败':''}</div></div></div>`

  if (entry.type === 'out') {
    return `<div class="chat-row out">${time}<div class="chat-body">
      <span class="chat-name">${esc(nick || '我')}</span><span class="chat-meta">${where}</span>
      <div class="chat-text">${esc(entry.text)}</div></div></div>`
  }
  if (entry.type === 'in') {
    const q=entry.quote
    const quote=q?`<div class="chat-meta">↪ ${esc(q.verified?(q.self?'回复本仙':`回复 ${q.name||q.uid}`):'引用对象未能核验')} · ${esc(q.text||'')} <small>#${esc(q.id)}</small></div>`:''
    return `<div class="chat-row">${time}<div class="chat-body">
      <span class="chat-name">${esc(entry.from || entry.uid || '')}</span><span class="chat-meta">${where}</span>
      ${quote}<div class="chat-text">${esc(entry.text)}</div></div></div>`
  }
  if (entry.type === 'guest') {
    return `<div class="chat-row sys">${time}<div class="chat-body">
      <span class="chat-name">${where}</span>
      <div class="chat-text">${esc(entry.note || '访客消息（未记录）')}</div></div></div>`
  }
  return `<div class="chat-row sys">${time}<div class="chat-body">
    <div class="chat-text">${esc(entry.why || entry.type)}</div></div></div>`
}

async function loadChat() {
  const log = $('#chat-log')
  try {
    const d = await api('/api/chat')
      try{window.renderChatDiagnostics(d)}catch(e){console.warn('消息诊断显示失败，继续显示聊天记录')}
    const online = d.online
    $('#agent-dot').className = 'dot ' + (online ? 'on' : 'off')
    $('#agent-state').textContent = online ? d.connected === false ? 'QQ 断开 · 正在自动恢复 SnowLuma' : `${d.nick || 'agent'} 在线` : '未运行'
    const sh = d.shield ?? null
    const budget = sh
      ? ` · 今日 ${fmtTokens(sh.todayTokens)}${sh.dailyLimit ? '/' + fmtTokens(sh.dailyLimit) : ''} tokens`
        + (sh.blocked ? ` · 拦截 ${sh.blocked}` : '')
      : ''
    $('#agent-meta').textContent = online
      ? `${(d.groups || []).length} 个群 · ${d.outputRate ? '普通输出 ' + d.outputRate.used + '/60 条/分钟' : d.maxPerHour > 0 ? '上限 ' + d.maxPerHour + ' 条/小时' : '不限次数'}`
        + `${d.replyEveryMessage ? ' · 逐条必回' : d.catchUp === false ? '' : ` · 补话 ${d.catchUpSec ?? 45}s`}${d.queuedMessages ? ' · 待处理 ' + d.queuedMessages + ' 条' : ''}${budget}${d.paused ? ' · 已暂停' : ''}`
      : ''
    const btn = $('#btn-chat-pause')
    btn.textContent = d.paused ? '继续接话' : '暂停接话'
    btn.classList.toggle('danger-outline', !d.paused)
    btn.disabled = !online

    const rows = (d.log || [])
      .filter((e) => ['in', 'out', 'guest','forward-read'].includes(e.type) || (e.type === 'error' && e.why))
      .slice(-200)

    chatHistoryNick=d.nick||'青娥鱼'
    if(chatHistoryPinned){await refreshAgent();return}
    chatHistoryRows=rows;chatHistoryBefore=d.history?.nextBefore??null;chatHistoryMore=Boolean(d.history?.hasMore);chatHistoryControls()
    if (!rows.length) {
      log.innerHTML = '<div class="chat-empty">还没有对话。让人在群里说句话，它就会出现在这里。</div>'
      return
    }

    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60
    log.innerHTML = rows.map((e) => chatRow(e, d.nick)).join('')
    if (atBottom||chatScrollLatest) log.scrollTop = log.scrollHeight
    chatScrollLatest=false
  } catch (e) {
    $('#agent-dot').className = 'dot off'
    $('#agent-state').textContent = '控制台读不到状态'
    $('#agent-meta').textContent = e.message
  }
  await refreshAgent()
}

function chatHistoryControls(){
  $('#btn-chat-older').disabled=chatHistoryBusy||!chatHistoryMore
  $('#btn-chat-search').disabled=chatHistoryBusy
  $('#btn-chat-latest').disabled=chatHistoryBusy
  $('#chat-history-note').textContent=(chatHistoryPinned?(chatHistoryQuery?'搜索结果':'历史浏览'):'实时记录')+` · ${chatHistoryRows.length}条`+(chatHistoryMore?' · 可继续向前加载':' · 已到记录起点')
}
async function loadOlderChat(search=false){
 if(chatHistoryBusy)return
 chatHistoryBusy=true;chatHistoryControls()
 try{
  const query=search?$('#chat-history-query').value.trim():chatHistoryQuery
  const p=new URLSearchParams();if(query)p.set('q',query)
  if(!search&&chatHistoryBefore!==null)p.set('before',String(chatHistoryBefore))
  const data=await api('/api/chat/history?'+p)
  const log=$('#chat-log')
  chatHistoryPinned=true;chatHistoryQuery=query;chatHistoryRows=search?data.rows:[...data.rows,...chatHistoryRows];chatHistoryBefore=data.nextBefore;chatHistoryMore=data.hasMore
  log.innerHTML=chatHistoryRows.length?chatHistoryRows.map(e=>chatRow(e,chatHistoryNick)).join(''):'<div class="chat-empty">未找到记录。可调整关键词，或继续向前查找。</div>'
  log.scrollTop=0
 }catch(e){toast('读取聊天历史失败：'+e.message,true)}finally{chatHistoryBusy=false;chatHistoryControls()}
}
$('#btn-chat-older').addEventListener('click',()=>loadOlderChat())
$('#btn-chat-search').addEventListener('click',()=>loadOlderChat(true))
$('#chat-history-query').addEventListener('keydown',e=>{if(e.key==='Enter')loadOlderChat(true)})
$('#btn-chat-latest').addEventListener('click',()=>{chatHistoryPinned=false;chatHistoryQuery='';chatScrollLatest=true;$('#chat-history-query').value='';loadChat()})

/** 群聊进程由控制台带着；这里看它的状态和原始输出 */
async function refreshAgent() {
  let a
  try {
    a = await api('/api/agent')
  } catch (e) {
    return
  }
  const btn = $('#btn-agent')
  const hint = $('#chat-hint')

  if (a.running) {
    btn.dataset.on = '1'
    btn.textContent = '停止'
    btn.classList.add('danger-outline')
    hint.hidden = true
  } else {
    btn.dataset.on = '0'
    btn.textContent = '启动'
    btn.classList.remove('danger-outline')
    if (a.external) {
      btn.disabled = true
      hint.hidden = false
      hint.innerHTML = a.source === 'dsh' ? `正在跟随 DSH（pid ${esc(a.external.pid)}），本页读取其聊天记录与运行输出。` : `别处已经有一个群聊进程在跑（pid ${esc(a.external.pid)}）。`
        + (a.source === 'dsh' ? '' : '要交给这个控制台管，先去那边停掉，再点这里的「启动」。')
    } else {
      btn.disabled = false
      hint.hidden = false
      const why = a.lastExit?.why
      const showWhy = why && why !== '手动停止'
      hint.innerHTML = `群聊进程没在跑。点右上角「启动」让控制台把它带起来。`
        + (showWhy ? `<br>上次退出：${esc(why)}${a.lastExit.life ? `，存活 ${(a.lastExit.life / 1000).toFixed(1)}s` : ''}。展开下面的「进程输出」看原因。` : '')
    }
  }

  const body = $('#agent-console-body')
  const lines = (a.tail ?? []).slice(-120)
  if (lines.length) {
    body.innerHTML = lines.map((l) => {
      const bad = l.startsWith('⨯ ')
      return `<div${bad ? ' class="err"' : ''}>${esc(bad ? l.slice(2) : l)}</div>`
    }).join('')
    body.scrollTop = body.scrollHeight
    $('#agent-console-note').textContent = a.running
      ? `pid ${a.pid} · 实时输出`
      : '控制台会把群聊进程的输出原样留在这里'
  }
}

$('#btn-agent').addEventListener('click', async () => {
  const btn = $('#btn-agent')
  const on = btn.dataset.on === '1'
  btn.disabled = true
  try {
    if (on) {
      await api('/api/agent/stop', {})
      toast('群聊进程已停止')
    } else {
      const r = await api('/api/agent/start', {})
      toast(`群聊进程已启动（pid ${r.pid}）`)
    }
  } catch (e) {
    toast(e.message, true)
  } finally {
    btn.disabled = false
  }
  await refreshAgent()
  loadChat()
})

$('#viewswitch').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-view]')
  if (b) switchView(b.dataset.view)
})

$('#btn-chat-refresh').addEventListener('click', loadChat)

$('#btn-chat-pause').addEventListener('click', async () => {
  const paused = $('#btn-chat-pause').textContent.includes('暂停')
  try {
    await api('/api/chat/pause', { paused })
    toast(paused ? '已暂停接话' : '已恢复接话')
    loadChat()
  } catch (e) {
    toast(e.message, true)
  }
})

/* ── 人设视图 ───────────────────────────────────────── */

let personaLoaded = false

function personaState(text, cls) {
  const el = $('#persona-state')
  el.textContent = text
  el.className = 'persona-state' + (cls ? ' ' + cls : '')
}

function readPersonaForm() {
  const qf = Number($('#p-quiet-from').value)
  const qt = Number($('#p-quiet-to').value)
  const quiet = Number.isInteger(qf) && Number.isInteger(qt) && qf !== qt ? [qf, qt] : []

  return {
    nick: $('#p-nick').value.trim(),
    aliases: $('#p-aliases').value.split(/[,，\s]+/).filter(Boolean),
    persona: $('#p-persona').value,
    taboo: $('#p-taboo').value,
    admins: $('#p-admins').value.split(/[,，\s]+/).filter(Boolean),
    adminTitles: $('#p-admin-titles').value.split(/[,，\s]+/).filter(Boolean),
    minGapSec: Number($('#p-gap').value),
    maxPerHour: Number($('#p-maxhour').value),
    quietHours: quiet,
    speakChance: Number($('#p-chance').value),
    temperature: Number($('#p-temp').value),
    catchUp: $('#p-catchup').checked,
    catchUpSec: Number($('#p-catchup-sec').value),
    shield: {
      enabled: $('#p-shield-on').checked,
      adminBypass: $('#p-shield-bypass').checked,
      teaseWhenForced: $('#p-shield-tease-on').checked,
      maxInputChars: Number($('#p-shield-maxinput').value),
      maxOutputTokens: Number($('#p-shield-maxtokens').value),
      adminMaxOutputTokens: Number($('#p-shield-maxtokens').value)*3,
      perCallTokens: Number($('#p-shield-percall').value),
      dailyTokens: Number($('#p-shield-daily').value),
      guestHourlyTokens: Number($('#p-shield-hourly').value),
      userWindowSec: Number($('#p-shield-window').value) * 60,
      userWindowTokens: Number($('#p-shield-windowtokens').value),
      userCooldownSec: Number($('#p-shield-cooldown').value) * 60,
      tease: $('#p-shield-tease').value.split('\n').map((s) => s.trim()).filter(Boolean),
    },
  }
}

async function loadPersona() {
  try {
    const r = await api('/api/persona')
    $('#p-nick').value = r.nick ?? ''
    $('#p-aliases').value = (r.aliases ?? []).join(', ')
    $('#p-persona').value = r.persona ?? ''
    $('#p-taboo').value = r.taboo ?? ''
    $('#p-admins').value = (r.admins ?? []).join(', ')
    $('#p-admin-titles').value = (r.adminTitles ?? []).join(', ')
    $('#p-gap').value = r.minGapSec ?? 75
    $('#p-maxhour').value = r.maxPerHour ?? 20
    $('#p-chance').value = r.speakChance ?? 0.55
    $('#p-temp').value = r.temperature ?? 1.2
    $('#p-catchup').checked = r.catchUp !== false
    $('#p-catchup-sec').value = r.catchUpSec ?? 45

    const sh = r.shield ?? {}
    $('#p-shield-on').checked = sh.enabled !== false
    $('#p-shield-bypass').checked = sh.adminBypass !== false
    $('#p-shield-tease-on').checked = sh.teaseWhenForced !== false
    $('#p-shield-maxinput').value = sh.maxInputChars ?? 800
    $('#p-shield-maxtokens').value = sh.maxOutputTokens ?? 260
    $('#p-shield-adminmaxtokens').value = (sh.maxOutputTokens ?? 260)*3
    $('#p-shield-adminmaxtokens').readOnly=true
    $('#p-shield-maxtokens').oninput=()=>{$('#p-shield-adminmaxtokens').value=Number($('#p-shield-maxtokens').value)*3}
    $('#p-shield-percall').value = sh.perCallTokens ?? 3000
    $('#p-shield-daily').value = sh.dailyTokens ?? 200000
    $('#p-shield-hourly').value = sh.guestHourlyTokens ?? 400000
    $('#p-shield-window').value = Math.round((sh.userWindowSec ?? 600) / 60)
    $('#p-shield-windowtokens').value = sh.userWindowTokens ?? 12000
    $('#p-shield-cooldown').value = Math.round((sh.userCooldownSec ?? 600) / 60)
    $('#p-shield-tease').value = (sh.tease ?? []).join('\n')

    const q = r.quietHours ?? []
    $('#p-quiet-from').value = q[0] ?? 0
    $('#p-quiet-to').value = q[1] ?? 0

    personaLoaded = true
    // 老进程没有这些字段，表单会显示默认值——这时候点保存会把默认值写回去，
    // 把回话池清空。宁可先禁用，也别让人误存。
    const stale = r.shield === undefined || r.adminTitles === undefined
    const saveBtn = $('#btn-persona-save')
    if (saveBtn) saveBtn.disabled = stale
    personaState(stale
      ? '控制台是旧版本，重启 WebUI 后这里才能改'
      : (r.online ? '进程在跑 · 保存后 2 秒内生效' : '进程没在跑'),
    stale ? 'dirty' : '')
  } catch (e) {
    personaState('读取失败：' + e.message, 'dirty')
  }
}

$('#view-persona').addEventListener('input', (event) => {
  if(event.target.closest('.sticker-library'))return
  if (personaLoaded) personaState('有未保存的改动', 'dirty')
})

$('#btn-persona-reload').addEventListener('click', loadPersona)

$('#btn-persona-save').addEventListener('click', async () => {
  const btn = $('#btn-persona-save')
  btn.disabled = true
  personaState('保存中…')
  try {
    await api('/api/persona', readPersonaForm())
    personaState('已保存 · 约 2 秒内热更新', 'saved')
    toast('人设已保存，约 2 秒内生效')
  } catch (e) {
    personaState('保存失败：' + e.message, 'dirty')
    toast(e.message, true)
  } finally {
    btn.disabled = false
  }
})

/* ── B 站扫码登录 ───────────────────────────────────── */

let qrTimer = null
let qrDeadline = 0
let qrPolling = false

function qrState(text, cls) {
  const el = $('#qr-state')
  el.textContent = text
  el.className = 'qr-state' + (cls ? ' ' + cls : '')
}

function qrOverlay(text) {
  const o = $('#qr-overlay')
  if (!text) { o.hidden = true; o.textContent = ''; return }
  o.hidden = false
  o.textContent = text
}

function qrStop() {
  if (qrTimer) clearInterval(qrTimer)
  qrTimer = null
}

async function qrStart() {
  qrStop()
  qrOverlay('')
  const box = $('#qr-canvas')
  box.innerHTML = ''
  qrState('正在获取二维码…')

  if (typeof QRCode === 'undefined') {
    qrState('二维码库没加载，刷新页面再试', 'bad')
    return
  }

  try {
    const r = await api('/api/bili/qr')
    new QRCode(box, {
      text: r.url,
      width: 216,
      height: 216,
      correctLevel: QRCode.CorrectLevel.M,
    })
    qrState('等待扫码')
    // 二维码有效期约 3 分钟，2.5 分钟后主动停，避免一直空转
    qrDeadline = Date.now() + 150_000
    qrTimer = setInterval(() => qrPoll(r.key), 30000)
  } catch (e) {
    qrState('取二维码失败：' + e.message, 'bad')
  }
}

async function qrPoll(key) {
  if (Date.now() > qrDeadline) {
    qrStop()
    qrState('二维码已超时', 'bad')
    qrOverlay('超时了，点「换一张」重新生成')
    return
  }
  if(qrPolling)return
  qrPolling=true
  try {
    const s = await api('/api/bili/qr/poll?key=' + encodeURIComponent(key))
    if (s.status === 'waiting') qrState('等待扫码')
    else if (s.status === 'scanned') qrState('已扫码，请在手机上点确认', 'scanned')
    else if (s.status === 'expired') {
      qrStop()
      qrState('二维码已失效', 'bad')
      qrOverlay('二维码失效，点「换一张」')
    } else if (s.status === 'ok') {
      qrStop()
      const missing = s.missing ?? []
      if (missing.length) {
        // 扫码成功了但没写全，必须说清楚缺哪一件，不能只弹一句"成功"
        qrState('扫码成功，但没拿到：' + missing.join(' / '), 'bad')
        qrOverlay('缺凭据')
        toast('B 站凭据没写全：缺 ' + missing.join('、'), true)
        return
      }
      const who = s.user
        ? `${s.user.name}（${s.user.mid}）`
        : s.navCode === -101
          ? '凭据已存，但 B 站说不算登录'
          : '凭据已写入'
      qrState('登录成功：' + who, s.user ? 'ok' : 'scanned')
      qrOverlay('✓')
      $('#bili-login-note').textContent = s.user
        ? `✓ 已登录 ${who}`
        : `凭据已写入 config.json（${s.source === 'url' ? '来自回跳地址' : '来自 Set-Cookie'}），点「检查登录」再确认`
      $('#s-sessdata').value = ''
      $('#s-jct').value = ''
      $('#s-buvid').value = ''
      toast(s.user ? `B 站登录成功：${who}` : 'B 站凭据已写入 config.json')
      refreshStatus()
      setTimeout(() => { $('#qr-mask').hidden = true; qrOverlay('') }, s.user ? 1200 : 2500)
    } else {
      qrStop()
      qrState(s.message || '登录失败', 'bad')
    }
  } catch {
    /* 单次轮询失败不打断，下一轮再来 */
  } finally {qrPolling=false}
}

async function checkBiliLogin() {
  const note = $('#bili-login-note')
  const btn = $('#btn-bili-check')
  btn.disabled = true
  const label = btn.textContent
  btn.textContent = '检查中'
  note.textContent = '正在问 B 站这个 cookie 还有效吗…'
  try {
    const r = await api('/api/bili/me')
    if (r.loggedIn) {
      note.textContent = `✓ 已登录 ${r.name}（${r.mid}）`
      toast(`B 站：${r.name}（${r.mid}）`)
    } else {
      note.textContent = `✗ 没登录：${r.message ?? r.reason ?? 'cookie 可能过期了，重新扫码'}`
      toast('B 站 cookie 无效：' + (r.message ?? r.reason ?? '重新扫码'), true)
    }
  } catch (e) {
    note.textContent = '检查失败：' + e.message
    toast('检查失败：' + e.message, true)
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

$('#btn-bili-login').addEventListener('click', () => {
  $('#qr-mask').hidden = false
  qrStart()
})

$('#qr-refresh').addEventListener('click', qrStart)
$('#btn-bili-check').addEventListener('click', checkBiliLogin)

$('#qr-close').addEventListener('click', () => {
  qrStop()
  qrOverlay('')
  $('#qr-mask').hidden = true
})

$('#qr-mask').addEventListener('click', (e) => {
  if (e.target.id === 'qr-mask') {
    qrStop()
    $('#qr-mask').hidden = true
  }
})

document.addEventListener('navigate:view',e=>switchView(e.detail.view))
window.addEventListener('hashchange',()=>switchView(location.hash.slice(1)))
