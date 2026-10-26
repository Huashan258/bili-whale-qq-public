import fs from 'node:fs'
import path from 'node:path'
import {ROOT} from './config.mjs'

export const ZHUGE_STYLE_MARKER='【诸葛亮表达学习】'
export function learnedStyleGuide(c={}) {
  if(c.learnedStyle?.zhugeEnabled!==true)return ''
  return '\n'+ZHUGE_STYLE_MARKER+'主要学遣词造句与对答的分寸，不是遇事就献策、劝学或引经据典。把话说给眼前的人听：用具体动词，少用“进行、提供、给予、一定程度上”等空壳；先答对方实际问的那一点，答够就停，不追加万能建议、总结、反问或角色表演。诸葛亮的书面奏表与当面对白分场合，闲聊不照搬奏表腔。\n'+
    '【何时省词】同一话题、同一对答里，主语、对象已经唯一明确，可不重复“本仙、你、这件事情”，也不把问句完整复述一遍。“在吗”可答“在呢”，不用先报身份；这只是句法示范，不是固定回复。共同主语下相接的动作可以合说，原因显然时不再写“因为……所以……”。需要强调承担者、对比不同的人、转换话题或消除歧义时，反而补清主语和对象；否定、条件、时间、数量、因果中的关键内容不可省。不确定省掉的是谁，先看当前对话线索；仍不清楚就短问一句，不编情境。\n'+
    '【语气落点】自信从判断准确和回答贴切显出来，不从“本仙自有妙计、此事不难”报幕显出来。反问只在具体前提值得追问时使用，不每回把问题踢回去。对方在打趣、撒娇、抱怨或纠正上一句时，先接住这层意思，不自动变成教人做事。可以长短句交错、留半句余味，但不能删成谜语或为了古意倒装。\n'+
    '说清眼前这句就停，不在结尾追加“且看下一句答得怎样、下回看本仙表现”之类自我点评。被纠正时修正具体误会，不把错话圆成玩笑，也不用保证以后会更像人。\n'+
    '保持青娥鱼的狂傲、俏皮与管理员面前的撒娇，自称仍为本仙；能省自称则省，普通聊天称呼也不必句句喊，令咒仍遵循当条固定称呼。不改称亮、臣、老夫，不扮诸葛亮。不每句文言，不套固定三段论或“本仙且说：”等冒号开场。小说人物对白、史书记言与传世文章分开，不能互相冒充；引用仅限实际提供原文。用户的明确任务、字数与格式优先。'
}
export function learnedStyleContext(c,task,{file=path.join(ROOT,'book/风格学习/诸葛亮说话方式.json')}={}) {
  if(c?.learnedStyle?.zhugeEnabled!==true||/(?:不要|不用|别|停止).{0,6}(?:诸葛|孔明|古风|文言|模仿)/.test(String(task)))return ''
  try {
    if(fs.statSync(file).size>100000)return ''
    const profile=JSON.parse(fs.readFileSync(file,'utf8'))
    const text=String(task??'')
    const mode=/又不是人|不像人|像人了|哪句|说怪|别扭|没接上|又.{0,8}不对/.test(text)?'承接纠正':/在吗|在不在|喜欢我|帮不帮|能不能|行不行|你好|喵|嘿|你是个/.test(text)?'日常简答':/难过|失败|累|焦虑|鼓励|没考好|安慰/.test(text)?'情绪回应':/计划|怎么做|怎么办|策略|分析|选择|活动|建议/.test(text)?'说理判断':/胡说|不对|反驳|凭什么|锐评|你敢/.test(text)?'具体反驳':'普通对话'
    const syntax=(profile.syntaxCases??[]).filter(e=>e.mode===mode&&e.pattern&&new RegExp(e.pattern).test(text)).slice(0,2)
    const syntaxText=syntax.length?'\n现代口语句法演示（本项目编写，非诸葛亮原话；只学取舍，不逐字套用）：\n'+syntax.map(e=>`语境：${e.context}\n可这样接：${e.reply}\n取舍：${e.reason}`).join('\n'):'保留话语真正的新信息，删去可以由前一句唯一补出的重复成分；没有唯一承接对象时不要猜。'
    const tags=mode==='情绪回应'?['劝勉','修身']:mode==='说理判断'?['谋划','说理']:mode==='具体反驳'?['反驳','应答']:['应答']
    const hits=(profile.examples??[]).filter(e=>e.verified===true&&e.quote&&e.sourceURL&&e.tags?.some(t=>tags.includes(t))).sort((a,b)=>Number(b.tags.includes(tags[0]))-Number(a.tags.includes(tags[0]))).slice(0,2)
    // 日常简答以句法承接为主，免得一句招呼也被带去劝学或设策。
    const chosen=['承接纠正','日常简答','普通对话'].includes(mode)?[]:hits
    return '\n【本轮表达参照：重点是遣词、省略和承接，不是硬搬书中话题】\n'+syntaxText+'\n'+chosen.map(e=>`《${e.book}》${e.heading}｜${e.kind==='fiction'?'小说人物对白，非历史原话':e.kind==='recorded'?'史书记言，非亲笔文章':'传世文集篇章'}\n原文节选：${e.quote.slice(0,120)}\n句法观察：${(e.diction??e.lesson).slice(0,180)}\n省略边界：${(e.ellipsis??'不省掉关键事实，不重复已经明确的主语。').slice(0,150)}`).join('\n\n')+'\n先接当前句子的意思。示范只供内部参照，不复述学习规则，不报告句法分析；字数与具体任务仍须完成。\n【表达参照结束】'
  }catch{return ''}
}
