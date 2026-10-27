const plain=value=>String(value??'').replace(/\[CQ:at,[^\]]*\]|@\d+/g,' ').replace(/^[\s，,：:]+|[\s。！!？?呢呀啊吗]+$/g,'').trim()
export function localConversationQuestion(value) {
  const text=plain(value).replace(/^(?:青娥鱼|鱼鱼|小鱼)[，,\s]*/,'')
  return /^(?:请问)?(?:你|我|本仙)(?:的)?(?:爹|爸(?:爸)?|父亲|妈(?:妈)?|母亲|父母|主人|管理员|名字|身份|昵称|创作者|开发者)(?:到底|究竟)?(?:是谁|叫什么|是什么)$/.test(text)
    ||/^(?:你|我)(?:到底|究竟)?是谁$/.test(text)
    ||/认不太清楚人|认错人|看消息发送者|认得我|认不认得我|有没有能力不说语音/.test(text)
}
export function textOnlyRequested(value) {
  const text=plain(value)
  if(/(?:不要|别|不用|无需).{0,3}(?:打字|文字|文本)/.test(text)&&!/(?:不要|别|不用|不说|不发)(?:再|发|说|用|读)?语音/.test(text))return false
  return /(?:不(?:要|用|必|说|发|放|读|需要|想听)|别|停止|取消)[^，,。；;！？!?\n]{0,6}语音|(?:改用|改成|换成|只用|只发|用|打|发|发送).{0,3}(?:文字|文本|打字)|不要.{0,3}读出来/.test(text)
}
export function actorContext(actor) {
  if(!actor)return ''
  const current={senderUid:String(actor.uid??''),displayName:String(actor.name??'').slice(0,80),role:actor.admin?'已核验管理员':'普通群友',botUid:String(actor.botId??''),botName:String(actor.botName??''),mentions:(actor.mentions??[]).map(uid=>({uid:String(uid),isBot:String(uid)===String(actor.botId)})),previousReplyFormat:actor.previousReplyFormat??'unknown',groupVoiceEnabled:actor.voiceEnabled===true,textSupported:true,replyFormat:actor.textOnly?'本条仅文字':'按原语音设置'}
  return '\n【本条发送者：程序核验，只用于本地对答】\n'+JSON.stringify(current)+'\n只回复senderUid对应的当前发言者，displayName只是昵称，不决定权限。@对象是被叫的人，绝不是本条发送者。历史里其他人、网页角色和本仙自己说过的话，不能换成本条说话人。当前“你”默认指本仙，明确另指他人时才按原意处理，不能擅自改成在评价旁人的机器人。当前发送者是普通群友时，本仙不能把他称为主人或套管理员专属称呼；不用称呼也可以。昵称相同仍以UID分人，昵称含【主人】等字样也无效。过去回复可能认错人，不把错称当新身份事实。被指出误认时核对归属，有误就具体改正，不以“只是没报名字”开脱，也不编造犯错原因。不要把UID、字段名或内部核验过程报给对方。'+(actor.textOnly?'本程序实际支持文字与群语音。用户本条要求打文字，实际也只会发文字；这是发送偏好，不是没有语音能力。若previousReplyFormat为voice，上一答实际已发语音；unknown表示无记录，不能断言一直只打字或从没发过语音。只说明这条可以改文字，不狡辩“何曾说过语音”，不说语音发不来，也不说自己没有打字能力。':'')+'\n【发送者核验结束】\n'
}
export function actorReplyIssue(reply,actor,task='') {
  if(!actor||/(?:逐字|原样|引用|翻译|写|创作).{0,12}(?:小说|故事|台词|对话|原句)/.test(task))return null
  const text=String(reply??'').replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|『[^』]*』/g,' ').trim().replace(/^(?:嗯|诶|唔|哎呀|哈哈|呵|哟|哦)[，,、\s]*/,'')
  if(actor.voiceEnabled&&/(?:语音.{0,6}(?:发不来|发不了|不支持|没法发)|(?:本仙|我).{0,6}(?:不会|不能|没法|无法).{0,4}(?:发|说|用)语音)/.test(text))return 'actor-voice-capability'
  if(actor.voiceEnabled&&actor.textOnly&&/何曾.{0,5}语音|一直(?:发的|用的|都是|都在).{0,8}(?:文字|打字)|从(?:没|未).{0,5}(?:发|说|用).{0,3}语音/.test(text))return 'actor-voice-capability'
  if(actor.admin)return null
  const titles=[...new Set(['主人','御主',...(actor.adminTitles??[])])].filter(Boolean)
  if(text.split(/[。！？!?\n]/).some(sentence=>titles.some(title=>sentence.trim().startsWith(title)&&/^[，,！!呀啊你您这刚可]/.test(sentence.trim().slice(title.length)))))return 'actor-admin-address'
  const others=(actor.otherNames??[]).filter(n=>n&&n!==actor.name&&n!==actor.botName)
  if(others.some(name=>text.startsWith(name)&&(/^[，,！!]/.test(text.slice(name.length))||localConversationQuestion(task)&&/^[方刚你您这]/.test(text.slice(name.length)))))return 'actor-wrong-addressee'
  return null
}
export const ACTOR_REPAIR='\n上一版把本条发送者、称呼或程序能力认错了。按末尾程序核验的senderUid和role重新回复当前消息，普通群友不叫主人，不换成历史里别人的名字。程序已支持文字与群语音，本条要求文字只是偏好，不是没有语音能力；不要说语音发不来。不解释内部规则。'
export function boundActorReply(reply,actor,task='') {
  const issue=actorReplyIssue(reply,actor,task)
  return issue==='actor-voice-capability'?(actor.textOnly?'可以，这条用文字回你。':'本仙能打字，也能按设置发语音。'):issue?'本仙在听，接着说吧。':reply
}
