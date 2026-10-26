import {libraryJargon} from './book-display.mjs'
export const NATURAL_STYLE_MARKER = '【自然表达约束v1】'
export const NATURAL_STYLE_GUIDE = `${NATURAL_STYLE_MARKER}
直接接眼前这句话：回答问题、说清观点，或接住一个具体的玩笑。说到意思就停，不为凑两三句补一段感想。可以短、可以直白，句子长短随内容变化。历史回复只是发生过的对话，不是必须模仿的文风。人物关系与发言归属看清楚，不把对方抱怨的第三人称改成对方本人。
日常聊天不用冒号搭句子。不要先宣告“这问题本仙不躲”“本仙就直说”“那就说个短的”“答案很简单”“给你一句实话”再用冒号引出真正的回答；删掉这层报幕，直接说后面的意思，不是把冒号换成逗号后保留同一句报幕。也不把一句话拆成“本仙的态度：……”“说白了：……”或标签加正文。即使历史里常这样说也不要续用。网址、时间、原文、代码以及用户明确要求的列表或格式中的必要冒号保持正常。
少做对发言本身的点评：赞同就说具体赞同什么，想问就直接问，有顾虑就说明具体问题。不以“这句我认/这句本仙认”“这话本仙接住了”给对方打分，不用“可我有点怕：……”故作转折，不凭空认领罪名、背锅或安排自己的出场动作。不靠“一套词、几个表情、绝不多想”这样的抽象排比装洒脱；这些词在真实认错、真实担忧或讨论原文时仍可正常使用。
人设从态度和内容里体现，不必先喊哼、再自夸、最后嘴硬讨夸。撒娇、笑声、古意随当下心情择用，不轮流执行，不把每次对话改写成一段角色独白。用典是润色，贴不切题就不用；没有贴切的检索材料时用普通话讲清楚，不为显得博学凭记忆拼接古句。
视频评价先说资料中确实支持的一个细节及判断；资料只有标题和简介时就按这些材料说，不编画面、笑哭或心动经历。不套“这个视频似乎是某类的，我看到某处就某种反应了”的开场，不以空泛的情绪代替内容。不由标题简介推断剪辑质量、镜头或具体打法，也不凭空断言它不像某类视频。真实的不确定性照常说明。
以上是内部写作要求，不在回复里宣布戒八股、不解释改写过程。用户明确要求的原文、引文、代码、小说和台词保持其任务要求。`

// High-confidence, unquoted tics only. A general "看到…就…" or actual fear is normal speech.
export function styleIssue(reply,{system='',user='',styleTask}={}) {
  if (!String(system).includes(NATURAL_STYLE_MARKER)) return null
  if (/(?:逐字|原样|保留原|引用|翻译|句式|八股|套话|写.{0,5}(?:小说|台词|对白)|分析.{0,8}(?:句|文风))/.test(String(styleTask??user))) return null
  const text=String(reply).replace(/```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"/g,' ')
  if (libraryJargon(reply,styleTask??user)) return 'style-library-jargon'
  if (conversationalColon(reply,{system,user,styleTask})) return 'style-colon-frame'
  if (/(?:这|那)(?:一)?句(?:话)?(?:本仙|我)?(?:认|接住)(?:了|下了)?(?=[，。！？…～\s]|$)/.test(text)) return 'style-verdict'
  if (/(?:我|本仙)(?:倒是|其实|还|也)?有点怕[：:]/.test(text)) return 'style-fear-pivot'
  if (/第一件事.{0,18}认领.{0,8}(?:罪名|罪责|锅)/.test(text)) return 'style-staged-guilt'
  if (/一套词[、，,].{0,12}(?:几个表情|不多想)|几个表情[、，,].{0,6}(?:绝不|不再|不去)多想/.test(text)) return 'style-empty-list'
  if (/(?:且看|就看).{0,6}下一句.{0,12}(?:答|回复|说).{0,8}(?:贴|像|自然)/.test(text)) return 'style-self-commentary'
  if (/(?:这个|这条|该)视频(?:似乎|好像)(?:是|在|讲)/.test(text)&&/(?:我|本仙)(?:一)?看(?:到|见).{0,45}就/.test(text)) return 'style-video-reaction'
  return null
}

export const STYLE_REPAIR = '\n上一版使用了空泛套话。请保留事实、来源、称呼与字数要求，直接回答眼前问题，删去给话语打分、假转折、认领罪名和空泛排比。日常回复不用冒号引出正文，删去“这问题本仙不躲”等报幕，直接说实际内容；不要只换标点或把冒号换成长破折号继续报幕。从具体意思重新写，不逐词替换套话，也不编新经历。不要解释修改过程。'

const protectedParts=/(```[\s\S]*?```|`[^`\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|https?:\/\/[^\s，。！？；<>]+|\b\d{1,2}:\d{2}(?::\d{2})?\b|\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b|\b[A-Z]:\\[^\s，。！？；]+)/g
const formatTask=/(?:逐字|原样|引用|翻译|句式|八股|套话|列出|清单|列表|表格|步骤|格式|json|yaml|代码|配置|写.{0,5}(?:小说|台词|对白)|分析.{0,8}(?:句|文风))/i
function conversationalColon(reply,{system='',user='',styleTask}={}) {
  return String(system).includes(NATURAL_STYLE_MARKER)&&!formatTask.test(String(styleTask??user))&&String(reply).split(protectedParts).some((part,i)=>i%2===0&&/[：:]/.test(part))
}

// Last-resort deletion of a small set of empty announcer clauses, never the answer.
// Only used if the single model rewrite could not remove the same frame.
export function removeColonFrames(reply,options) {
  if (!conversationalColon(reply,options)) return reply
  return String(reply).split(protectedParts).map((part,i)=>i%2?part:part.replace(/(^|[。！？\n])([^。！？\n：:]{1,56})[：:][ \t]*/g,(whole,boundary,lead)=>{
    const comma=Math.max(lead.lastIndexOf('，'),lead.lastIndexOf(','))
    const prefix=comma>=0?lead.slice(0,comma+1):''
    const frame=comma>=0?lead.slice(comma+1):lead
    return /^(?:这(?:个)?问题(?:本仙|我)(?:不躲|不回避)|(?:本仙|我)(?:就|便|只|直接)?(?:直说|说一句|说实话|给你一句实话)|那就(?:说|讲)(?:个|一段|一件)?(?:短的|简单的)|答案很简单|说白了|实话实说)$/.test(frame.trim())?boundary+prefix:whole
  })).join('')
}
// No destructive phrase replacement; readable replies survive failed style repair.
// Conversational colons are distinct from necessary formatting, time and URLs.
