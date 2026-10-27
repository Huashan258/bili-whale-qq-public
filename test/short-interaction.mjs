import assert from 'node:assert/strict'
import {shortInteraction,boundShortInteraction} from '../src/reply-scope.mjs'
import {generateDirectReply,decodeChatReply} from '../src/chat-response.mjs'
import {prepareDeepReply} from '../src/deep-reply.mjs'
for(const input of ['给我笑一声','@123456 给我笑一声','鱼鱼，咕咕嘎嘎','咕咕嘎嘎'])assert.ok(shortInteraction(input))
for(const input of ['咕咕嘎嘎是什么梗','给我笑一声再解释原因','写200字的咕咕嘎嘎故事','讲个笑话','我今天很难过'])assert.equal(shortInteraction(input),null)
assert.equal(shortInteraction('给我笑一声',{replyCommand:true}),null)
assert.equal(shortInteraction('给我笑一声',{minReplyChars:200}),null)
assert.equal(shortInteraction('给我笑一声',{replyMaterial:'图片观察'}),null)
const scope=shortInteraction('给我笑一声')
assert.equal(boundShortInteraction('哈哈！然后回到前面的主次问题。'.repeat(8),scope),'哈哈！')
const cfg={chat:{deepReply:{enabled:true},learnedStyle:{zhugeEnabled:true}}}
const prepared=await prepareDeepReply({}, {system:'原人设',user:'历史提过主次关系；当前用户只说给我笑一声',styleTask:'给我笑一声',replyConfig:cfg,replyLookup:async()=>({ok:false,results:[]})})
assert.equal(prepared.thinking,'enabled');assert.equal(prepared.maxReplyChars,18)
assert.match(prepared.system,/不得续答历史问题/);assert.doesNotMatch(prepared.system,/【本轮对答口吻】/)
let calls=0
const r=await generateDirectReply(async()=>{calls++;return {content:'哈哈——这一声够不够亮？前头的主次关系本仙记着呢。'.repeat(4),usage:{total:3}}},{provider:'fixture'},{...prepared})
assert.equal(calls,2);assert.equal(r.usage.total,6);assert.ok([...decodeChatReply(r.content).reply].length<=18)
let count=0
const failed=await generateDirectReply(async()=>{if(++count===2)throw Error('fixture');return {content:'主次关系还没有说完，本仙继续详细解释。'.repeat(5)}},{provider:'fixture'},prepared)
assert.equal(decodeChatReply(failed.content).reply,'哈哈哈～')
console.log('短互动通过：笑声/拟声识别、当前消息隔离、不限制解释及长文/令咒/图片、保留深度检索、超长最多修订一次、失败仍短答。')
