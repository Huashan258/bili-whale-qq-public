// 只匹配本条消息的开头；前置的机器人 @ 可忽略，不搜索历史/引用里的口令。
export function commandMode(text, chat = {}, selfId = '') {
  const c = chat.command ?? {}
  const prefix = String(c.prefix ?? '我以令咒命之：').trim()
  let input = String(text ?? '').trim()
  if (selfId && input.startsWith(`@${selfId}`)) input = input.slice(String(selfId).length + 1).trimStart()
  const active = c.enabled !== false && Boolean(prefix) && input.startsWith(prefix)
  return { active, text: active ? input.slice(prefix.length).trim() : String(text ?? ''),
    adminTitle:addressTitle(chat,true),guestTitle:addressTitle(chat,false),
    minChars: 200, guestMaxTokens: 60000, adminMaxTokens: 200000 }
}

export function addressTitle(chat, admin) {
  return String(admin ? chat.adminTitle ?? 'Master' : chat.guestTitle ?? '魔术师').trim() || (admin ? 'Master' : '魔术师')
}

export function commandNote(mode, title) {
  if (!mode.active) return `\n本条未触发令咒，不用「${mode.adminTitle??'Master'}」「${mode.guestTitle??'魔术师'}」作为对方的称呼。` + '\n本条为普通聊天，令咒专属称呼不延续到本条；管理员使用普通称呼池，群友按人设或名字称呼。' + (title ? `本次可称呼对方为「${title}」，对方要求换称呼时可从普通池中选择。` : '')
  return `\n本次请求者的固定称呼是「${title}」，不要使用其他尊称。` + (mode.active
    ? '\n本条为令咒请求：直接完成本次任务，正文至少200个非空白字符，建议240~320字；用户要求更多字数时依照更高要求。不受日常短回复、人设闲聊或本地任务意图限制。不要捏造无法读取的资料。只输出完整回复正文。'
    : '')
}

export function addressReply(reply, title, mode) {
  if(!mode.active){
    for(const reserved of [mode.adminTitle??'Master',mode.guestTitle??'魔术师']){
      if(String(reply??'').startsWith(reserved)&&/^[，,：:！!\s]/.test(reply.slice(reserved.length)))return (title?`${title}，`:'')+reply.slice(reserved.length).replace(/^[，,：:！!\s]+/,'')
    }
    return reply
  }
  if (mode.active && String(reply ?? '').replace(/\s/g,'').length < 200) return ''
  return mode.active && reply && !reply.startsWith(title) ? `${title}，${reply}` : reply
}

// QQ command and explicit video integration, 2026-10-21.

// Command-only titles expire after the current message; ordinary title pools remain active.
