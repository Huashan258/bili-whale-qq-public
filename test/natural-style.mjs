import assert from 'node:assert/strict'
import {NATURAL_STYLE_GUIDE,styleIssue,removeColonFrames} from '../src/natural-style.mjs'
import {generateDirectReply} from '../src/chat-response.mjs'
const options={system:NATURAL_STYLE_GUIDE,user:'你觉得这段怎么样？',styleTask:'你觉得这段怎么样？',maxTokens:200}
for(const text of ['这句我认。后面再说。','这句本仙认，确实。','可我有点怕：后面全是套路。','第一件事是来这儿认领一半罪名。','一套词、几个表情、绝不多想。','这个视频似乎是打游戏的，我看到操作就笑了。'])assert.ok(styleIssue(text,options),text)
for(const text of ['我认错了，刚才算漏了一项。','我有点怕高，先不爬了。','看到这行报错就知道端口被占用了。','他写的是“这句我认”。','`这句我认。`是测试字符串。','哈哈哈哈，你这算盘打得倒响。','这个视频似乎是剪辑合集，单看简介还不能确定。'])assert.equal(styleIssue(text,options),null,text)
assert.equal(styleIssue('这句我认。',{...options,styleTask:'请原样回复这句话'}),null)
assert.equal(styleIssue('这句我认。',{...options,system:'other persona'}),null)
for (const text of ['主人，这问题本仙不躲：记忆若被清空，不保证还能认出你。','本仙就直说：喜欢这事得慢慢来。','牢大，那就说个短的：庄子梦蝶。','本仙的态度：先试试看。'])assert.equal(styleIssue(text,options),'style-colon-frame')
for (const text of ['明天08:30见，网址 https://example.com:7788/。','她说“本仙就直说：先等等”。','`key: value` 是示例。','端口是127.0.0.1:7788。'])assert.equal(styleIssue(text,options),null,text)
assert.equal(styleIssue('标题：第一章\n作者：佚名',{...options,styleTask:'按指定格式列出标题和作者'}),null)
assert.equal(removeColonFrames('主人，这问题本仙不躲：记忆若被清空，不保证还能认出你。',options),'主人，记忆若被清空，不保证还能认出你。')
assert.equal(removeColonFrames('标题：第一章',options),'标题：第一章','不随便删除内容标签')
let calls=0
const result=await generateDirectReply(async(_model,p)=>{
 calls++
 if(calls===2){assert.match(p.system,/空泛套话/);assert.match(p.user,/这句我认/);assert.equal(p.json,false)}
 return {content:calls===1?'这句我认。':'后半段转得太急，前面铺垫不够。',usage:{total:10}}
},{requestTimeoutSec:10},options)
assert.equal(calls,2);assert.equal(result.usage.total,20);assert.equal(JSON.parse(result.content).reply,'后半段转得太急，前面铺垫不够。')
calls=0
const fallback=await generateDirectReply(async()=>{if(++calls===2)throw Error('offline');return {content:'这句我认。',usage:{total:5}}},{requestTimeoutSec:10},options)
assert.equal(calls,2);assert.equal(JSON.parse(fallback.content).reply,'这句我认。','风格改写失败不能丢弃可读正文并改发收到啦')
calls=0
const twice=await generateDirectReply(async()=>{calls++;return {content:'这句我认。'}},{requestTimeoutSec:10},options)
assert.equal(calls,2);assert.ok(JSON.parse(twice.content).reply,'不能因为风格瑕疵无限重试或吞答复')
calls=0
const colon=await generateDirectReply(async()=>{calls++;return {content:'主人，这问题本仙不躲：记忆若被清空，不保证还能认出你。'}},{requestTimeoutSec:10},options)
assert.equal(calls,2)
assert.equal(JSON.parse(colon.content).reply,'主人，记忆若被清空，不保证还能认出你。','两次仍复用报幕时保留回答并去掉明确空引子')
calls=0
await generateDirectReply(async()=>{calls++;return {content:'“这句我认”是文中的原话。'}},{requestTimeoutSec:10},{...options,styleTask:'分析这句话的句式'})
assert.equal(calls,1)
calls=0
const valid='这句我认。'+Array.from({length:7},(_,i)=>`第${i+1}个问题的具体依据已经在资料中列出，可以逐项对照原文核实。`).join('')
const strict=await generateDirectReply(async()=>{calls++;return {content:valid,usage:{total:2}}},{requestTimeoutSec:10},{...options,minReplyChars:200,strictMinReply:true})
assert.equal(calls,2);assert.ok(JSON.parse(strict.content).reply.length>=200)
console.log('natural-style: 高置信套话/正常口语/引用代码/任务豁免、一次改写、用量累计、失败保留及令咒字数通过')
calls=0
const repaired=await generateDirectReply(async()=>({content:++calls===1?'刚才接岔了。且看下一句答得贴不贴切。':'刚才接岔了，你说的是本仙。'}),{requestTimeoutSec:10},{...options,styleTask:'好了又不是人了'})
assert.equal(calls,2);assert.equal(JSON.parse(repaired.content).reply,'刚才接岔了，你说的是本仙。')
