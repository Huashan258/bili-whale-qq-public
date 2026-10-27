// Scope comes only from the current selected message, never from chat history.
export const CONCISE_REPLY_GUIDE='\n【日常篇幅】普通闲聊通常20至60字、一两句，能少半句就少半句；语气词、孔明口吻和一点闲话仍可留，不为显人味重复意思或追加收尾感想。只是接梗或笑一声就更短。需要解释的具体问题按需要展开，明确的字数、长文、令咒和严格格式优先；不要为了凑篇幅删掉关键事实或把句子截断。五段只是发送上限，不是要凑五段。'
export function shortInteraction(task,options={}) {
  if(options.replyCommand||options.minReplyChars>0||options.replyMaterial)return null
  const text=String(task??'').replace(/\[CQ:at,[^\]]*\]|@\d+/g,'').trim().replace(/^(?:青娥鱼|鱼鱼|小鱼|大肥鱼)[，,、\s]*/,'').replace(/[\s，,。.!！?？~～…]/g,'')
  if(/^(?:请|麻烦)?(?:给我|帮我)?笑(?:一声|一下|一个|两声)$/.test(text))return {kind:'laugh',maxChars:18,fallback:'哈哈哈～'}
  if(/^(?:咕咕嘎嘎|咕嘎|喵呜?|汪汪|嗷呜|[哈呵嘿]{2,12})$/.test(text))return {kind:'playful',maxChars:24,fallback:text+'～'}
  if(/^(?:你|本仙)(?:的)?(?:爹|爸(?:爸)?|父亲|妈(?:妈)?|母亲|父母)(?:到底|究竟)?是谁$/.test(text))return {kind:'identity-banter',maxChars:60,fallback:'本仙可没认过这门亲，别乱安辈分呀。'}
  return null
}
export const SHORT_INTERACTION_GUIDE='\n【本条是短互动】只接当前这句短互动（招呼、拟声、笑声或关系打趣），一声或一个短句便够；小废话只留一点点。不得续答历史问题、重讲身份主次、分析梗来源、点评对方意图或交代搜索过程。检索和历史仅供内部理解，不是本条待办事项。用户要笑就直接笑，不问满意不满意，不解释为什么笑。问本仙的亲属只按已有设定简答，现有资料没有给本仙的父母身份或去向，不推测父母是谁、在不在群里；可接一句不乱认亲的玩笑，不拿管理员冒充父母，也不展开同名游戏剧情。'
export function boundShortInteraction(reply,scope) {
  if(!scope)return reply
  const text=String(reply??'').trim()
  if([...text.replace(/\s/g,'')].length<=scope.maxChars)return text
  const first=text.match(/^[\s\S]*?[。！？!?～~](?:[”」』])?/u)?.[0]?.trim()
  if(first&&[...first.replace(/\s/g,'')].length<=scope.maxChars&&(scope.kind!=='laugh'||/[哈呵嘿]/.test(first)))return first
  return scope.fallback
}
