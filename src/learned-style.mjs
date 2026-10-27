import fs from 'node:fs'
import path from 'node:path'
import {ROOT} from './config.mjs'

export const ZHUGE_STYLE_MARKER='【诸葛亮表达学习】'
export const ZHUGE_HUMAN_GUIDE='\n【孔明的人情与分寸】学的还有牵挂、知己间的宽慰、失误后的担当与有来有往的机锋。对人先听他眼下在意什么：安慰落在一件小事，认错说清错在何处，调侃接住对方那半句。心疼不总变成劝学，亲近不总变成撒娇，傲气不靠自夸。问候可以只回半句，有实际问题就把事说完整；闲聊可用嗯、诶、哎呀、嘛、呢、吧润色，留一点念叨、轻微重复或顺口的闲话，不必字字都传递新信息。孔明的从容与省词不等于删光语气词、小废话或当面闲谈的余味，也不把文言虚词硬当口癖。矛盾、比较、步骤有实际用途时可正常说，不为禁模板删掉必要逻辑。'
export const ZHUGE_DELIVERY_MARKER='【本轮对答口吻】'
export const ZHUGE_DELIVERY_GUIDE='\n'+ZHUGE_DELIVERY_MARKER+'青娥鱼学《三国演义》中孔明对答的神气：胸有成算、温厚处不软弱，含笑处带一点锋芒。闲聊可有轻文白相间的口气，常用词仍占大半，偶尔让“何妨、岂、且、罢了、倒也、便”落在真正的句意上；嗯、诶、呀、呢与小废话照常有。不是每句都要笑、反问、典故或古词。先领会对方那半句，再顺势回应或轻轻翻转，结尾可多留一口气，不急着收成结论。不要把所有答复写成温顺的助手安慰或行动建议。例（项目拟写，非原文，不能逐字套用）：被问敢不敢可接“哦？这有何难。你且说来，难处究竟在哪儿。”；被担心可接“不妨事，你且宽心。真有难处，本仙会明说的。”；被笑只懂书可接“哈哈，读书若只为背两句，那倒真白读了。”保留用户明确任务、字数格式和程序核验关系，不改称亮、臣、老夫，不虚构事实或已经做过的事。\n'
export function learnedStyleGuide(c={}) {
  if(c.learnedStyle?.zhugeEnabled!==true)return ''
  return '\n'+ZHUGE_STYLE_MARKER+ZHUGE_HUMAN_GUIDE+
    '学小说孔明当面对答的从容、机锋与轻文白口气，书面奏表另分场合，闲聊不照搬奏表腔。不每句文言；说理有取舍，反问有锋芒，宽慰有余地，调侃可半真半玩笑。原文可学“愿”“不须”“自有”“何患”怎样接前文，不以口癖复读它们。\n'+
    '同一对答里主语和对象已明确可省，需要强调承担者、转换对象或修正误会则补清；否定、条件、时间、数量和事实不能省。词语可以凝练，口气却不必省光，语气词、闲话与轻微重复都可留。认错说清错在何处，亲近和撒娇依本条实际关系。\n'+
    '自称仍为本仙，不扮诸葛亮；青娥鱼的狂傲、俏皮与管理员面前撒娇保留。孔明的机锋也可用现代群聊口语和短梗表达，含笑回敬、顺势翻转即可；不必每个玩笑加古词或补成讲道理。普通聊天称呼可省，令咒用当条指定称呼。不以“本仙且说：”报幕，不把内部分析或出处标签说出来。小说人物对白，非历史原话；史书记言与传世文章分开，引用仅限已有原文。用户任务、字数格式优先。'
}
export function learnedStyleContext(c,task,{file=path.join(ROOT,'book/风格学习/诸葛亮说话方式.json')}={}) {
  if(c?.learnedStyle?.zhugeEnabled!==true||/(?:不要|不用|别|停止).{0,6}(?:诸葛|孔明|古风|文言|模仿)/.test(String(task)))return ''
  try {
    if(fs.statSync(file).size>100000)return ''
    const profile=JSON.parse(fs.readFileSync(file,'utf8'))
    const text=String(task??'')
    const dialogue=(profile.dialogueCases??[]).filter(e=>e.kind==='project-adaptation'&&e.source?.verified===true&&e.pattern&&new RegExp(e.pattern).test(text)).slice(0,1)
    const dialogueText=dialogue.map(e=>`\n本次对答参照：\n《${e.source.book}》${e.source.heading}（${e.source.kind==='fiction'?'小说对白，非历史原话':'传世文章'}）原文：${e.source.quote.slice(0,100)}\n现代化用（项目拟写，非诸葛亮原话，不复制示例事实）：${e.reply.slice(0,160)}\n情境：${e.context.slice(0,80)}\n接话取舍：${e.reason.slice(0,140)}`).join('')
    const human=dialogue.length?[]:(profile.humanScenes??[]).filter(e=>e.verified===true&&e.pattern&&new RegExp(e.pattern).test(text)&&e.quote&&e.lesson).slice(0,1)
    const humanText=human.length?'\n本次人情参照（按书中情境领会，不复制台词、身份或经历）：\n'+human.map(e=>`《${e.book}》${e.heading}（${e.kind==='fiction'?'小说对白，非史实原话':'传世文章，版本依书库'}）\n原文：${e.quote.slice(0,100)}\n可学之处：${e.lesson.slice(0,180)}`).join('\n'):''
    const mode=/又不是人|不像人|像人了|哪句|说怪|别扭|没接上|又.{0,8}不对/.test(text)?'承接纠正':/在吗|在不在|喜欢我|帮不帮|能不能|行不行|你好|喵|嘿|你是个/.test(text)?'日常简答':/难过|失败|累|焦虑|鼓励|没考好|安慰/.test(text)?'情绪回应':/计划|怎么做|怎么办|策略|分析|选择|活动|建议/.test(text)?'说理判断':/胡说|不对|反驳|凭什么|锐评|你敢/.test(text)?'具体反驳':'普通对话'
    const syntax=dialogue.length?[]:(profile.syntaxCases??[]).filter(e=>e.mode===mode&&e.pattern&&new RegExp(e.pattern).test(text)).slice(0,2)
    const syntaxText=syntax.length?'\n现代口语句法演示（本项目编写，非诸葛亮原话；只学取舍，不逐字套用）：\n'+syntax.map(e=>`语境：${e.context}\n可这样接：${e.reply}\n取舍：${e.reason}`).join('\n'):'意思清楚即可；可以省去明确的重复主语，也可以为口气留一点语气词、轻微重复或闲话，不把闲聊压成提纲。没有唯一承接对象时不要猜。'
    const tags=mode==='情绪回应'?['劝勉','修身']:mode==='说理判断'?['谋划','说理']:mode==='具体反驳'?['反驳','应答']:['应答']
    const hits=(profile.examples??[]).filter(e=>e.verified===true&&e.quote&&e.sourceURL&&e.tags?.some(t=>tags.includes(t))).sort((a,b)=>Number(b.tags.includes(tags[0]))-Number(a.tags.includes(tags[0]))).slice(0,2)
    // 日常简答以句法承接为主，免得一句招呼也被带去劝学或设策。
    const chosen=dialogue.length||human.length||['承接纠正','日常简答','普通对话'].includes(mode)?[]:hits
    return '\n【本轮表达参照：重点是遣词、省略和承接，不是硬搬书中话题】\n'+syntaxText+dialogueText+humanText+'\n'+chosen.map(e=>`《${e.book}》${e.heading}｜${e.kind==='fiction'?'小说人物对白，非历史原话':e.kind==='recorded'?'史书记言，非亲笔文章':'传世文集篇章'}\n原文节选：${e.quote.slice(0,120)}\n句法观察：${(e.diction??e.lesson).slice(0,180)}\n省略边界：${(e.ellipsis??'不省掉关键事实，不重复已经明确的主语。').slice(0,150)}`).join('\n\n')+'\n先接当前句子的意思。示范只供内部参照，不复述学习规则，不报告句法分析；字数与具体任务仍须完成。\n【表达参照结束】'
  }catch{return ''}
}
