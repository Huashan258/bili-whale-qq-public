import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'learned-style-'));process.env.BILI_WHALE_DATA=dir
const {learnedStyleGuide,learnedStyleContext,ZHUGE_STYLE_MARKER}=await import('../src/learned-style.mjs')
const {personaPrompt,QINGE_PERSONA}=await import('../src/persona.mjs')
const {prepareDeepReply}=await import('../src/deep-reply.mjs')
const {generateDirectReply}=await import('../src/chat-response.mjs')
try{
 const c={persona:QINGE_PERSONA,learnedStyle:{zhugeEnabled:true}}
 assert.match(personaPrompt(c),/诸葛亮表达学习/)
 assert.match(personaPrompt(c),/自称仍为本仙/)
 assert.match(personaPrompt(c),/不每句文言/)
 assert.equal(learnedStyleGuide({}),'')
 assert.equal(learnedStyleContext(c,'不要模仿诸葛亮'),'')
 const profile=JSON.parse(fs.readFileSync(new URL('../book/风格学习/诸葛亮说话方式.json',import.meta.url),'utf8'))
 assert.equal(profile.humanScenes.length,7)
 assert.ok(profile.humanScenes.every(e=>e.verified&&e.sourceChunk!==undefined&&e.sourceTextSHA256?.length===64))
 const reassure=learnedStyleContext(c,'你别担心，本仙能处理好')
 assert.match(reassure,/人情参照|表达参照/)
 assert.match(learnedStyleGuide(c),/认错说清错在何处/)
 const examples=JSON.parse(fs.readFileSync(new URL('../book/风格学习/诸葛亮说话方式.json',import.meta.url),'utf8')).examples
 assert.equal(examples.length,7);assert.ok(examples.every(e=>e.verified&&e.sourceURL.startsWith('https://www.diancang.xyz/')))
 const manifest=JSON.parse(fs.readFileSync(new URL('../book/诸葛亮学习来源.json',import.meta.url),'utf8'))
 for(const e of examples){const source=manifest.sources.find(r=>r.title===e.book);const body=fs.readFileSync(path.resolve('book',source.file),'utf8');assert.ok(body.includes(e.quote),'示范必须逐字存在于实际来源')}
 const comfort=learnedStyleContext(c,'今天没考好，难过，安慰一下')
 assert.match(comfort,/虽有淹留/);assert.match(comfort,/现代化用（项目拟写，非诸葛亮原话/);assert.doesNotMatch(comfort,/腐儒/)
 assert.match(learnedStyleContext(c,'你只会吃白饭吗'),/寻章摘句|何能兴邦立事/)
 assert.equal(profile.dialogueCases.length,7)
 const debate=learnedStyleContext(c,'这个观点不对，请反驳')
 assert.match(debate,/小说人物对白，非历史原话/)
 assert.match(learnedStyleGuide(c),/否定、条件、时间、数量/)
 assert.match(learnedStyleGuide(c),/需要强调承担者/)
 assert.match(learnedStyleContext(c,'在吗'),/在呢/)
 assert.doesNotMatch(learnedStyleContext(c,'你好呀'),/愿闻将军之志|诫子书|作文/,'日常招呼不被原文带去问目标或劝学')
 assert.doesNotMatch(learnedStyleContext(c,'能不能陪我聊聊'),/作文|先看这一段/,'现代句法示例也要匹配实际话题')
 assert.match(learnedStyleContext(c,'好了又不是人了'),/不能擅自改成在评价对方本人/)
 const {privateUserPrompt}=await import('../src/prompt.mjs')
 assert.doesNotMatch(privateUserPrompt({name:'测试',lines:[],admin:true,title:'主人',optionalAddress:true}),/别整段不喊/)
 assert.match(privateUserPrompt({name:'测试',lines:[],admin:true,title:'Master'}),/Master/)
 for(const task of ['今天如何安排学习计划','你好呀','请分析一下我的选择']){
  const text=learnedStyleContext(c,task)
  assert.ok(text.length<1200);assert.ok((text.match(/原文节选：/g)||[]).length<=2)
 }
 const opts={replyConfig:{chat:c},styleTask:'你好呀',system:personaPrompt(c),user:'用户当前话语'}
 const prepared=await prepareDeepReply({},opts)
 assert.equal(prepared.system.split(ZHUGE_STYLE_MARKER).length-1,1)
 assert.equal(prepared.system.split('【本轮对答口吻】').length-1,1)
 assert.match(prepared.system,/轻文白相间/)
 assert.match(prepared.user,/表达参照/)
 const twice=await prepareDeepReply({},prepared)
 assert.equal(twice.user,prepared.user,'底层与修订轮不重复塞入风格素材')
 let calls=0
 await generateDirectReply(async(_m,o)=>{calls++;assert.match(o.system,/自称仍为本仙/);assert.match(o.user,/表达参照/);return {content:'本仙先听听，你想把哪件事办成？'}},{provider:'fixture'},opts)
 assert.equal(calls,1)
 console.log('诸葛亮表达学习通过：七则真实出处逐字核对/小说与记言及文章分辨/语境最多两则/安慰不选骂辞/身份自称保留/开关与退出/独立于联网开关/修订不重复。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
