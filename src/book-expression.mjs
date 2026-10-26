// Intent routing only; it does not diagnose emotions or call another model.
export const expressionOptOut=input=>/不要(?:用|引|提).{0,6}(?:诗|典故|古文|文献)|别(?:用|引).{0,4}(?:诗|典故|古文)|只说白话/.test(String(input||''))
export function expressionIntent(input) {
  const text=String(input||'').trim()
  if(!text||expressionOptOut(text))return null
  const explicit=/(?:用|借|引用|化用).{0,10}(?:诗|古文|典故|文献).{0,12}(?:表达|安慰|感情|鼓励|思念)|(?:诗意|有文采).{0,8}(?:表达|安慰|回复)/.test(text)
  // Factual requests retain normal source retrieval, rather than becoming emotional performance.
  if(!explicit&&/代码|报错|数据库|端口|接口|配置|token|怎么安装|查询|分析|点评|解释|原文|出处|翻译|论文/.test(text))return null
  // Speech acts: affection, playful rhetorical questions and challenges need imagery too.
  // These are contextual hints, never proof of affection, hostility or administrator identity.
  if (!/我(?:并不|不|没那么|不再)喜欢(?:你|鱼)/.test(text) && /(?:喜欢|喜不喜欢|喜爱|疼|在乎|爱不爱)(?:本仙|你|我|鱼鱼|小鱼)|你.{0,4}(?:喜欢|在乎).{0,3}我/.test(text))
    return {mood:'亲近试探',tone:'亲近、询问心意，可能带撒娇或玩笑',goal:'先直接回应是否喜欢相处，再借相知、投桃报李的意象轻轻润色；保持已核验的关系，不升级成人恋爱',emotions:['喜悦','思念'],topics:['友情'],theme:'mutual-care',explicit}
  if (/(?:吃|蹭|光吃|白吃).{0,6}(?:白饭|闲饭|软饭)|(?:白饭|闲饭).{0,12}(?:心疼|养|主人)|(?:没|没有|有啥|有什么|有何).{0,3}(?:本事|用处|能耐)|你也配/.test(text))
    return {mood:'打趣反问',tone:/不.{0,8}吗|不会|难道|莫非/.test(text)?'反问、揶揄；可能是打趣，不能直接判为恶意':'调侃或挑战，先轻松接招',goal:'回答对方的具体玩笑，用安贫乐道、腹有诗书或以学识回馈的意思机灵回敬；不训人、不虚构现实吃饭和供养经历',emotions:['喜悦','豪迈'],topics:['哲思'],theme:'inner-richness',explicit}
  if (!/难过|伤心|想哭|不开心|很累|撑不住/.test(text) && /哈哈|嘿嘿|嘻嘻|逗你|开玩笑|吹牛|得意|厉害了|好狂|好嚣张/.test(text))
    return {mood:'戏谑欢笑',tone:'轻松、打趣，顺着语境接梗',goal:'爽朗接话，必要时借一个文献意象；可以适量哈哈哈哈、哼、呀，不反复套固定口癖',emotions:['喜悦','豪迈'],topics:['友情'],explicit}
  const rules=[
    ['低落','接住难过，温柔陪伴',/不开心|不高兴|开心不起来|一点也不开心|难过|伤心|想哭|哭了|很丧|心情低落|失落|委屈/,['宁静','豪迈'],['友情','仁爱']],
    ['孤独','表达陪伴，不替对方否定感受',/孤独|寂寞|没人陪|没人理我|只有我一个|一个人好累/,['孤独','思念'],['友情']],
    ['思念','回应想念和牵挂，不擅自升级关系',/想你|想念|思念|好久不见|舍不得|想家|离别/,['思念'],[/想家|父母|妈妈|爸爸/.test(text)?'亲情':'友情','离别']],
    ['愤怒','理解不满，表达有分寸的态度',/生气|气死|气坏|愤怒|不公平|讨厌死|恼火/,['愤怒','宁静'],['仁爱']],
    ['疲惫','体谅辛苦，轻轻鼓励，避免说教',/好累|很累|累了|撑不住|压力好大|焦虑|紧张|我.{0,5}(?:失败|考砸|没考好)/,['忧愁','豪迈','宁静'],['友情']],
    ['喜悦','和对方一起高兴，表达珍惜',/好开心|很开心|高兴|太棒了|成功了|成功啦|考上了|通过了|我赢了|好耶|我回来了|谢谢你|感谢你/,['喜悦'],['友情']],
  ]
  const cues=text.replace(/(?:并不|没有|不)(?:难过|伤心|生气|孤独|想你|思念|焦虑|紧张)/g,'')
  const found=rules.find(([, ,re])=>re.test(cues))
  if(!found&&!explicit)return null
  const [mood,goal,,emotions,topics]=found||['温柔','用文献意象自然表达当下感情',null,['宁静','喜悦'],['友情']]
  return {mood,goal,emotions,topics,explicit}
}

export const EXPRESSION_GUIDE='文献是表达感情和机智接话的素材，不是要求用户背书。先回应这条消息的具体感受或问题，再决定是否借一个意象、化用一句或短引一句；最多一个，不罗列、不讲课、不凑字数。结合完整句子的亲近、反问、调侃、否定和上下文判断，语气提示可能有误，不把疑问句当事实，不把玩笑一律当攻击。优先把文献的意思、意象揉进自己的话，而不是把原句贴在回复末尾。化用用自己的话，不加引号，不冒称古人原话；未改写的连续原句即使没加引号也属于直引，需简短注明书名。逐字引用只能使用提供原文中确实存在的连续文字，简短注明书名即可，片段ID留在内部资料，不把索引串贴到日常聊天里。用户追问出处时再给章节和可核对的原文。保留现有人设、称呼和亲疏关系，不改扮作者，不自动表白，不虚构共同经历。可以自然、直接地回应喜欢相处和珍惜陪伴；关系边界在内部遵守，不主动插入“别把喜欢当定情”等突兀的训诫，不因一句喜欢就改变真实身份和关系。语气词按情境选用：爽朗得意可哈哈哈哈，嘴硬可哼，亲切可呀、啦；不必句句有，不在严肃或悲伤时硬笑。不用“你应该/古人说你必须”压过用户的感受，不用凄惨诗句加重低落，不借兵刑或怨毒文字攻击他人。不合适就用普通话真诚回应，不能为了用典牺牲自然和准确。'
// Includes affectionate questions, teasing and playful rhetorical tone.
