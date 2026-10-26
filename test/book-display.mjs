import assert from 'node:assert/strict'
import {stripBookReferences,libraryJargon,humanizeBookReply} from '../src/book-display.mjs'
import {generateDirectReply} from '../src/chat-response.mjs'
import {NATURAL_STYLE_GUIDE} from '../src/natural-style.mjs'
const id='17f0442adb8fa1a3:article:000070'
assert.equal(stripBookReferences(`《诗经》木瓜 [书库:${id}] [文章:${id}]。`),'《诗经》木瓜。')
assert.equal(stripBookReferences('`abc:123` 是代码。'),'`abc:123` 是代码。')
assert.equal(libraryJargon('医书没索引到就是没有。','讲个医家故事'),true)
assert.equal(libraryJargon('这里用索引加速查询。','知识库索引怎么建立？'),false)
assert.equal(humanizeBookReply('医书没索引到就是没有。','讲个医家故事'),'医书这次还没查到合适内容。')
let calls=0
const opts={system:NATURAL_STYLE_GUIDE,user:'讲个医家故事',styleTask:'讲个医家故事'}
const r=await generateDirectReply(async()=>({content:++calls===1?'正经医书还没索引到。':'眼下还没查到合适的医书内容，本仙再翻翻。'}),{},opts)
assert.equal(calls,2);assert.equal(JSON.parse(r.content).reply,'眼下还没查到合适的医书内容，本仙再翻翻。')
const clean=await generateDirectReply(async()=>({content:`可参考《诗经》木瓜。[书库:${id}]`}),{},opts)
assert.equal(JSON.parse(clean.content).reply,'可参考《诗经》木瓜。')
console.log('book-display: 自然书目表达/内部ID清理/技术问答不误改/一次重写及降级保留通过')
