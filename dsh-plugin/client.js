/**
 * dsh-whale —— 浏览器半端（**设置在「设置」里的一页**）
 * ============================================================================
 * ⭐ 写法抄自 dsh-bili-scroll/client.js（它那份注释里记着从官方包挖到的约定）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<包名>',                       // 必须等于 package.json 的 name
 *       factory: (require) => { ... return { inject: ['slots'], apply(ctx) {...} } },
 *     })
 *
 * ⭐ 怎么进「设置」：
 *
 *     const slots = ctx.get('slots')
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'whale', order: 35, label: '群聊' },  // label = 左侧导航那一项
 *       () => h(Panel),
 *     ))
 *
 * ⭐ 数据走 `/api/whale/*`（后端在 index.js 里用 ctx.webServer.register 挂的）。
 *    UI 改的值落在 `.data/whale-ui.json`（**覆盖层**）—— 因为 cordis 的 volatile
 *    字段写不回去，直接写设置会哑；覆盖层是 bili-scroll 那套「家目录 config.json 兜底」的同款思路。
 *
 * ⭐ 「留空 = 不动」：文本项空着表示沿用 config.json 里的现值，避免把人设那种长文本冲掉。
 *
 * ⚠️ 写法上的一条硬教训：别把整页写成一坨深层 `h()` 嵌套 —— 漏一个闭括号时
 *    报错会落在最外层（`missing ) after argument list`），极难定位。
 *    ⇒ 每个区段单独赋一个变量，括号只到自己的闭合。
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-whale',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const useState = React.useState
    const useEffect = React.useEffect
    const useCallback = React.useCallback

    const API = '/api/whale'
    /* ⚠️ 一定要看 res.ok：HTTP 500 的 {ok:false} 被当成功的话，绿色提示会把故障盖掉 */
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-wh-intro]{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px 24px;border:1px solid #7ca7ef44;border-radius:18px;background:linear-gradient(120deg,#3e7ff011,#6ac7eb1a);}
[data-wh-intro] h2{margin:7px 0;font-size:21px;line-height:1.4;}
[data-wh-intro] p{font-size:12px;opacity:.7;margin:0 0 9px;}
[data-wh-intro] small{font-size:9px;letter-spacing:1.7px;color:#7a94b9;}
[data-wh-intro] a{font-size:9px;color:#6c8fbe;text-decoration:none;}
[data-wh-intro] img{object-fit:contain;flex-shrink:0;filter:drop-shadow(0 6px 9px #4978bf20);}
[data-wh-metrics]{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;}
[data-wh-metrics]>div{padding:15px;border:1px solid var(--separator-color,#8899aa30);border-radius:13px;display:flex;flex-direction:column;gap:6px;}
[data-wh-metrics] strong{font-size:17px;font-weight:600;}
[data-wh-metrics] small{font-size:10px;opacity:.6;}
@media(max-width:480px){[data-wh-intro]{padding:16px;}[data-wh-intro] h2{font-size:17px;}[data-wh-intro] img{width:95px;height:115px;}[data-wh-metrics]>div{padding:10px;}[data-wh-metrics] strong{font-size:14px;}}

[data-wh-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 8px;max-width:660px;}
[data-wh-sec]{display:flex;flex-direction:column;gap:8px;}
[data-wh-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wh-row]{display:flex;align-items:center;gap:10px;}
[data-wh-grow]{flex:1;min-width:0;}
[data-wh-label]{font-size:13px;}
[data-wh-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wh-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-wh-sw][data-on]{background:#3b82f6;}
[data-wh-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-wh-sw][data-on] i{left:19px;}
[data-wh-sw][disabled]{opacity:.45;cursor:default;}
[data-wh-sub]{margin-left:14px;padding-left:12px;border-left:2px solid var(--dsw-alias-border-l2,rgba(255,255,255,.1));
  display:flex;flex-direction:column;gap:10px;}
[data-wh-input]{width:220px;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-wh-input]:focus{outline:none;border-color:#3b82f6;}
[data-wh-num]{width:110px;text-align:center;}
[data-wh-ta]{width:100%;min-height:110px;resize:vertical;line-height:17px;}
[data-wh-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-wh-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-wh-btn][disabled]{opacity:.5;cursor:default;}
[data-wh-msg]{font-size:11px;line-height:16px;padding:7px 9px;border-radius:8px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wh-msg][data-good]{color:#22c55e;}
[data-wh-msg][data-warn]{color:#f59e0b;}
[data-wh-msg][data-bad]{color:#ef4444;}
[data-wh-pre]{margin:0;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:11px;
  line-height:16px;padding:9px;border-radius:8px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-wh-kv]{font-size:12px;line-height:18px;}
[data-wh-pill]{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.16));}
`

    /* ── 小部件 ───────────────────────────────────────────── */

    /** 开关：点一下就存 */
    const Switch = (props) =>
      h('div', { 'data-wh-row': '' },
        h('div', { 'data-wh-grow': '' },
          h('div', { 'data-wh-label': '' }, props.label),
          props.note ? h('div', { 'data-wh-note': '' }, props.note) : null),
        h('button', {
          'data-wh-sw': '',
          'data-on': props.on ? '' : undefined,
          disabled: !!props.disabled,
          onClick: props.onClick,
          'aria-label': props.label,
        }, h('i', null)))

    /** 一行「左边说明 + 右边控件」 */
    const Row = (props) =>
      h('div', { 'data-wh-row': '' },
        h('div', { 'data-wh-grow': '' },
          h('div', { 'data-wh-label': '' }, props.label),
          props.note ? h('div', { 'data-wh-note': '' }, props.note) : null),
        props.control)

    const Num = (props) =>
      h('input', {
        'data-wh-input': '',
        'data-wh-num': '',
        type: 'number',
        step: props.step || 1,
        defaultValue: props.value,
        placeholder: props.placeholder || '',
        onBlur: props.onBlur,
      })

    const Text = (props) =>
      h('input', {
        'data-wh-input': '',
        type: 'text',
        defaultValue: props.value,
        placeholder: props.placeholder || '',
        onBlur: props.onBlur,
      })

    const Area = (props) =>
      h('textarea', {
        'data-wh-input': '',
        'data-wh-ta': '',
        defaultValue: props.value,
        placeholder: props.placeholder || '',
        onBlur: props.onBlur,
      })

    /* ── 主面板 ───────────────────────────────────────────── */

    const Panel = () => {
      const [st, setSt] = useState(null)
      const [status, setStatus] = useState(null)
      const [msg, setMsg] = useState(null)
      const [tone, setTone] = useState('')
      const [busy, setBusy] = useState('')

      const load = useCallback(async () => {
        try {
          setSt(await jget('/config'))
        } catch (e) {
          setMsg('读不到设置：' + (e.message || e))
          setTone('bad')
        }
        try {
          setStatus(await jget('/status'))
        } catch (_e) { /* 状态读不到不影响配置页 */ }
      }, [])

      useEffect(() => {
        load()
        let disposed=false,pending=false
        const timer=setInterval(async()=>{
          if(document.hidden||pending)return
          pending=true
          try {const fresh=await jget('/status');if(!disposed)setStatus(fresh)}catch{}finally{pending=false}
        },15000)
        return()=>{disposed=true;clearInterval(timer)}
      }, [load])

      const save = async (patch, why) => {
        setBusy(why || 'save')
        setMsg(null)
        try {
          const r = await jpost('/config', patch)
          setMsg('已保存' + (why ? '（' + why + '）' : '') + ' —— 已写进 config.json，下一句话就按新设置走')
          setTone('good')
          if (r && r.ui) setSt((prev) => (prev ? { ...prev, ui: r.ui } : prev))
          try {setSt(await jget('/config'))}catch{}
          try { setStatus(await jget('/status')) } catch (_e) { /* 忽略 */ }
        } catch (e) {
          setMsg('保存失败：' + (e.message || e))
          setTone('bad')
          try {setSt(await jget('/config'))}catch{}
        } finally {
          setBusy('')
        }
      }

      /* 还没读到的时候就这一行。
         ⚠️ 这段**不要**用 `data-wh-page` 那个类名 —— 按类名批量替换时误伤过这里。 */
      if (!st) {
        return h('div', { 'data-wh-msg': '', 'data-bad': tone === 'bad' ? '' : undefined },
          msg || '正在读设置…')
      }

      const cfg = st.config || {}
      const ui = st.ui || {}

      /** 文本项：设置页填过就用填的，否则留空（placeholder 显示现值） */
      const v = (k) => (ui[k] === undefined || ui[k] === null ? '' : String(ui[k]))
      const ph = (k) => {
        const cur = cfg[k]
        if (cur === undefined || cur === null || cur === '' || cur === -1) return '沿用现在的'
        return '现在：' + String(cur)
      }

      const on = (k) => Boolean(cfg[k])
      /** 开关：先本地翻（界面立刻有反应），再存 */
      const flip = (k, label) => () => {
        const patch = { [k]: !on(k) }
        setSt((prev) => ({ ...prev, config: { ...prev.config, ...patch } }))
        save(patch, label)
      }

      const blurNum = (k, lo, hi) => (e) => {
        const raw = e.target.value
        if (raw === '') return
        const n = Number(raw)
        if(k==='replyPatrolMinutes' && n>0 && n<5){setMsg('巡检开启时至少间隔 5 分钟');setTone('warn');return}
        if (!Number.isFinite(n) || n < lo || n > hi) {
          setMsg(k + ' 要在 ' + lo + '~' + hi + ' 之间')
          setTone('warn')
          return
        }
        save({ [k]: n }, k)
      }
      const blurText = (k) => (e) => save({ [k]: e.target.value }, k)

      const running = status && status.running
      const tail = (status && status.logTail) || ''

      const secSwitch = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '开关'),
        h(Switch, {
          on: on('enabled'),
          label: '启用',
          note: '关掉就整个停：清定时器、关 WebSocket、放锁',
          onClick: flip('enabled', '启用'),
        }),
        h('div', { 'data-wh-sub': '' },
          h(Switch, {
            on: on('dry'),
            disabled: !on('enabled'),
            label: '预演（只写日志，一个字都不发）',
            note: '想先看它打算说什么就开着；确认没问题再关掉',
            onClick: flip('dry', '预演'),
          }),
          h(Switch, {
            on: on('qqEnabled'),
            disabled: !on('enabled'),
            label: 'QQ 群聊',
            note: '关掉就不连 OneBot（SnowLuma）',
            onClick: flip('qqEnabled', 'QQ'),
          }),
          h(Row, {
            label: 'B站评论区巡检间隔（分钟）',
            note: '0 关闭；开启时至少 5 分钟，每轮分批读一页',
            control: h(Num, {
              value: cfg.replyPatrolMinutes,
              step: 5,
              onBlur: blurNum('replyPatrolMinutes', 0, 1440),
            }),
          })))

      /* 刷B站 —— 从 dsh-bili-scroll 移植过来的那一轮（Node 原生实现，不再需要 Python venv） */
      const secScroll = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '刷B站'),
        h('div', { 'data-wh-note': '' },
          '温和模式：每小时最多观看 10 个视频、分享 1 个，观看至少相隔 6 分钟；仅在谷时检查。'),
        h(Switch, {
          on: on('scrollEnabled'),
          label: '启用',
          note: '按谷时与持久化小时额度运行，不集中连发',
          onClick: flip('scrollEnabled', '刷B站'),
        }),
        h('div', { 'data-wh-sub': '' },
          h(Row, {
            label: '候检间隔（分钟）',
            note: '每轮最多采集一个视频，至少间隔 6 分钟',
            control: h(Num, {
              value: cfg.scrollMinutes,
              step: 10,
              onBlur: blurNum('scrollMinutes', 6, 1440),
            }),
          }),
          h(Row, {
            label: '每日推荐视频上限',
            note: '小时分享最多 1 个；评论区模式另受账号评论额度约束',
            control: h(Num, {
              value: cfg.scrollPerDay,
              step: 1,
              onBlur: blurNum('scrollPerDay', 0, 50),
            }),
          }),
          h(Row, {
            label: '评论里 @ 谁',
            note: '留空 = 沿用 config.json 现值',
            control: h(Text, { value: v('scrollMention'), placeholder: ph('scrollMention'), onBlur: blurText('scrollMention') }),
          }),
          h(Row, {
            label: '搜索关键词（逗号分隔）',
            note: '留空 = 只看热门/排行榜 + 关注的 UP 主',
            control: h(Text, { value: v('scrollKeywords'), placeholder: ph('scrollKeywords'), onBlur: blurText('scrollKeywords') }),
          }),
          h(Row, {
            label: '每轮最多采集几个视频',
            note: '温和模式每轮最多 1 个；-1 沿用设置，每小时合计最多 10 个',
            control: h(Num, {
              value: cfg.scrollMaxVideos,
              step: 1,
              onBlur: blurNum('scrollMaxVideos', -1, 1),
            }),
          }),
          h(Row, {
            label: '我常看的题材 tag（逗号分隔）',
            note: '既当搜索词，也告诉它你喜欢哪些题材',
            control: h(Text, { value: v('scrollTags'), placeholder: ph('scrollTags'), onBlur: blurText('scrollTags') }),
          })),
        h('div', { 'data-wh-note': '' },
          '视频偏好：一段话说清楚你喜欢看什么样的（比如「喜欢有真人经历的、讨厌纯营销」）。它会照着这个挑。'),
        h(Area, { value: v('scrollPreferences'), placeholder: ph('scrollPreferences'), onBlur: blurText('scrollPreferences') }))

      const secSpeak = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '说话方式'),
        h('div',{'data-wh-note':''},'自由聊天模式开启时，普通QQ输出合计每分钟60条，管理员回复豁免；下面的旧冷却和小时限额不生效。可在完整工作台设置中切换。'),
        h('div', { 'data-wh-note': '' }, '文本项留空 = 不动（沿用 config.json 里现在的）；填了就以这里为准。'),
        h(Row, {
          label: '昵称',
          note: '它自称什么',
          control: h(Text, { value: v('nick'), placeholder: ph('nick'), onBlur: blurText('nick') }),
        }),
        h(Row, {
          label: '接话概率（0 不主动，1 全部回应）',
          note: '1 = 每句都接（很吵），建议 0.3 左右',
          control: h(Num, {
            value: v('speakChance') ?? '',
            step: 0.05,
            placeholder: ph('speakChance'),
            onBlur: blurNum('speakChance', 0, 1),
          }),
        }),
        h(Row, {
          label: '两次发言的冷却（秒）',
          note: '0 = 不冷却；建议 60',
          control: h(Num, {
            value: v('minGapSec') || '',
            step: 10,
            placeholder: ph('minGapSec'),
            onBlur: blurNum('minGapSec', 0, 3600),
          }),
        }),
        h(Row, {
          label: '每小时最多说几句',
          note: '0 = 不限；建议 10',
          control: h(Num, {
            value: v('maxPerHour') || '',
            step: 5,
            placeholder: ph('maxPerHour'),
            onBlur: blurNum('maxPerHour', 0, 1440),
          }),
        }),
        h(Row, {
          label: '静默时段（两个整点，逗号分隔）',
          note: '如 1,2 表示 1 点到 2 点不接话',
          control: h(Text, {
            value: v('quietHours'),
            placeholder: ph('quietHours'),
            onBlur: blurText('quietHours'),
          }),
        }),
        h(Row, {
          label: '闲聊温度 0.1~2',
          note: '越高越跳脱。1.5~1.7 = 活泼但容易跑偏；1.0 = 稳',
          control: h(Num, {
            value: v('temperature') || '',
            step: 0.1,
            placeholder: ph('temperature'),
            onBlur: blurNum('temperature', 0.1, 2),
          }),
        }))

      /* 记忆与长文 —— 这两组是「省 token」和「能写长东西」的两个旋钮 */
      const secMemory = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '记忆与长文'),
        h('div', { 'data-wh-note': '' },
          '记忆填 0 或 1 = 只把「当前这一句」加人设发过去，一条历史都不带（主人说过的话也不记），最省 token。'),
        h(Row, {
          label: '聊天记忆条数',
          note: '0/1 = 不记忆；14 = 带最近 14 条（默认）',
          control: h(Num, {
            value: v('contextMessages') || '',
            step: 1,
            placeholder: ph('contextMessages'),
            onBlur: blurNum('contextMessages', 0, 50),
          }),
        }),
        h(Row, {
          label: '重启后恢复几条',
          note: '0 = 不恢复上次的聊天（也就不会追着旧话补回复）',
          control: h(Num, {
            value: v('historyRestore') || '',
            step: 1,
            placeholder: ph('historyRestore'),
            onBlur: blurNum('historyRestore', 0, 50),
          }),
        }),
        h('div', { 'data-wh-note': '' },
          '主人（管理员）点名要长内容时（说了字数 / 读后感 / 锐评 / 写一篇），会自动切到下面这套 —— 平台规则里「通常 30 字以内」那条本次不生效。'),
        h(Row, {
          label: '长文温度 0.1~2',
          note: '长文必须稳，0.8~1.0 最好；跟闲聊分开调',
          control: h(Num, {
            value: v('longFormTemperature') || '',
            step: 0.1,
            placeholder: ph('longFormTemperature'),
            onBlur: blurNum('longFormTemperature', 0.1, 2),
          }),
        }),
        h(Row, {
          label: '长文输出上限（token）',
          note: '400+100 字至少给 2000，别卡太小会截断',
          control: h(Num, {
            value: v('longFormMaxOutputTokens') || '',
            step: 200,
            placeholder: ph('longFormMaxOutputTokens'),
            onBlur: blurNum('longFormMaxOutputTokens', 200, 8000),
          }),
        }))

      const secWhere = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '在哪说、叫谁'),
        h(Row, {
          label: '唤醒别名（逗号分隔）',
          note: '有人这么叫它才接话',
          control: h(Text, { value: v('aliases'), placeholder: ph('aliases'), onBlur: blurText('aliases') }),
        }),
        h(Row, {
          label: '群号（逗号分隔）',
          note: '只在这些群里说话',
          control: h(Text, { value: v('groups'), placeholder: ph('groups'), onBlur: blurText('groups') }),
        }),
        h(Row, {
          label: '管理员 QQ（逗号分隔）',
          note: '管理员不受平台约束、不套频率限制',
          control: h(Text, { value: v('admins'), placeholder: ph('admins'), onBlur: blurText('admins') }),
        }))

      const secPersona = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '人设'),
        h('div', { 'data-wh-note': '' }, '很长的话建议直接改 config.json —— 这里也能改，但输入框窄。'),
        h(Area, { value: v('persona'), placeholder: ph('persona'), onBlur: blurText('persona') }),
        h(Row, {
          label: '禁忌话题',
          control: h(Text, { value: v('taboo'), placeholder: ph('taboo'), onBlur: blurText('taboo') }),
        }))

      const secNow = h('div', { 'data-wh-sec': '' },
        h('div', { 'data-wh-h': '' }, '现在'),
        h('div', { 'data-wh-kv': '' },
          h('span', { 'data-wh-pill': '' },
            running ? '在跑' : (on('enabled') ? '让位中（锁被别人占着）' : '已停')),
          '  宿主 pid ' + (status && status.pid),
          status && status.startedAt ? '  起于 ' + String(status.startedAt).slice(11, 19) : null,
          h('br'),
          '日志文件：' + ((status && status.logFile) || '-')),
        h('div', { 'data-wh-row': '' },
          h('button', { 'data-wh-btn': '', disabled: busy === 'refresh', onClick: load }, '刷新'),
          h('div', { 'data-wh-note': '' }, '让位中不用管 —— 对方一停，最多 30 秒自动接管')),
        tail ? h('div', null,
          h('div', { 'data-wh-note': '' }, '最近的日志（末尾）：'),
          h('pre', { 'data-wh-pre': '' }, tail)) : null)

      const msgBox = msg ? h('div', {
        'data-wh-msg': '',
        'data-good': tone === 'good' ? '' : undefined,
        'data-warn': tone === 'warn' ? '' : undefined,
        'data-bad': tone === 'bad' ? '' : undefined,
      }, msg) : null

      const budget=status?.bili
      const budgetRows=h('div',{'data-wh-metrics':''},
        h('div',null,h('strong',null,status?.running?'运行中':'等待启动'),h('small',null,status?.chat?.connected?'QQ 已连接':'QQ 状态待确认')),
        h('div',null,h('strong',null,`${budget?.videos??'—'} / 10`),h('small',null,'本小时观看')),
        h('div',null,h('strong',null,`${budget?.shares??'—'} / 1`),h('small',null,'本小时分享')))
      const intro=h('section',{'data-wh-intro':''},
        h('div',null,h('small',null,'WHALE WORKSPACE'),h('h2',null,'鲸屿 · 鲸鱼娘工作台'),h('p',null,status?.chat?.replyEveryMessage?'逐条必回已开启 · 待处理 '+(status.chat.queuedMessages??0)+' 条消息':'慢慢看，好好聊。温和限额始终生效。'),
          cfg.webUi?h('a',{href:'http://127.0.0.1:'+Number(cfg.webUiPort||7788)+'/#overview',target:'_blank',rel:'noopener noreferrer','data-wh-open':''},'打开完整工作台 ↗'):null,
          h('a',{href:'https://github.com/YunYueSama/codex-deepseek-pet',target:'_blank',rel:'noopener noreferrer'},'角色素材：YunYueSama · 社区二创 ↗')),
        h('img',{src:API+'/mascot',alt:'社区鲸鱼娘',width:130,height:130}))
      const cooldown=budget?.cooldownUntil>Date.now()?h('div',{'data-wh-msg':'','data-warn':''},'B站全局冷却至 '+new Date(budget.cooldownUntil).toLocaleString('zh-CN')+'，QQ 聊天不受影响。'):null
      return h('div', { 'data-wh-page': '' },
        intro,
        budgetRows,
        cooldown,
        secSwitch,
        secScroll,
        secSpeak,
        secMemory,
        secWhere,
        secPersona,
        secNow,
        msgBox)
    }

    function DicePanel(){
      const [config,setConfig]=useState(null),[message,setMessage]=useState(''),[busy,setBusy]=useState(false)
      useEffect(()=>{let alive=true;jget('/config').then(r=>{if(alive)setConfig(r.config)}).catch(e=>{if(alive)setMessage(e.message)});return()=>{alive=false}},[])
      if(!config)return h('div',{'data-wh-page':''},message||'正在读取骰子设置…')
      const url='http://127.0.0.1:'+Number(config.webUiPort||7788)+'/dice-lab.html'
      const toggle=async()=>{setBusy(true);try{await jpost('/config',{diceEnabled:!config.diceEnabled});setConfig((await jget('/config')).config);setMessage('骰子开关已保存，即时生效')}catch(e){setMessage('保存失败：'+e.message)}finally{setBusy(false)}}
      return h('div',{'data-wh-page':''},h('h2',null,'骰子与跑团'),h('label',{'data-wh-row':''},h('input',{type:'checkbox',checked:!!config.diceEnabled,disabled:busy,onChange:toggle}),'启用跑团骰子插件'),h('p',{'data-wh-note':''},'角色卡、共享NPC、多人互动、记忆编辑与剧本记录统一在airunning目录维护。'),h('a',{href:url,target:'_blank',rel:'noopener noreferrer'},'单独打开骰子工作台 ↗'),message?h('p',{'data-wh-note':''},message):null,h('iframe',{src:url,title:'骰子工作台',style:{width:'100%',height:'75vh',border:'1px solid #425064',borderRadius:16,marginTop:16}}))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-whale')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-whale: 设置页样式')

        // ⭐ 进「设置」：label 就是左侧导航里那一项（跟 bili-scroll 的「刷B站」同位）
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'whale', order: 35, label: '群聊' },
          () => h(Panel),
        ))
        slots.inject('settings.section', () => slots.register(
          {name:'settings.section',id:'whale-dice',order:36,label:'骰子'},
          () => h(DicePanel),
        ))
      },
    }
  },
})
