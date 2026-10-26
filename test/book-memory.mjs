import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-books-'));process.env.BILI_WHALE_DATA=dir
const {bookContext}=await import('../src/book-memory.mjs')
try {
  fs.mkdirSync(path.join(dir,'未索引'))
  fs.writeFileSync(path.join(dir,'BOOK_HANDOVER.md'),'交接文件不得当作书籍索引')
  fs.writeFileSync(path.join(dir,'未索引','论语测试.txt'),'学而第一\n子曰：学而时习之，不亦说乎？有朋自远方来，不亦乐乎？\n'+('君子以仁义修身，学习朋友之道。\n'.repeat(100)))
  const run=(...args)=>execFileSync('python',['scripts/book-library.py',...args],{cwd:path.resolve('.'),env:{...process.env,WHALE_BOOK_ROOT:dir},encoding:'utf8',stdio:'pipe'})
  const result=JSON.parse(run('index'));assert.equal(result.books,1)
  assert.ok(fs.existsSync(path.join(dir,'BOOK_HANDOVER.md')))
  fs.writeFileSync(path.join(dir,'未索引','新书.txt'),'不允许被自动读取的下一本书')
  const before=fs.statSync(path.join(dir,'索引','library.sqlite')).mtimeMs
  const found=JSON.parse(run('search','论语 学习朋友'));assert.ok(found.hits.length);assert.ok(found.selectedBooks.length)
  const quote=JSON.parse(run('get',found.hits[0].id));assert.equal(quote.text,found.hits[0].text)
  assert.ok(fs.existsSync(path.join(dir,'未索引','新书.txt')));assert.equal(fs.statSync(path.join(dir,'索引','library.sqlite')).mtimeMs,before)
  assert.deepEqual(JSON.parse(run('search','你好呀今天怎么样')).hits,[])
  const context=await bookContext('论语 学习朋友',{runner:async()=>({stdout:JSON.stringify(found)})});assert.match(context,/《/);assert.doesNotMatch(context,/\[书库:|\[文章:/);assert.ok(context.length<2600)
  assert.equal(await bookContext('论语',{runner:async()=>{throw Error('不可用')}}),'')
  fs.writeFileSync(path.join(dir,'未索引','作者测试.txt'),'李白　喜悦\n欢喜欢乐，长风破浪，喜悦之情。\n'+'明月山水，宴饮春风。'.repeat(8)+'\n杜甫　愤怒\n愤怒怨恨，百姓饥荒，忧愁泪下。\n'+'秋夜思乡，修身养性。'.repeat(8))
  // Explicitly authorize only this fixture; neither short nor indexable unrelated books may be ingested.
  fs.writeFileSync(path.join(dir,'未索引','待处理.txt'),'未经授权不能索引。'.repeat(30))
  run('index','作者测试');assert.ok(fs.existsSync(path.join(dir,'未索引','待处理.txt')))
  run('retag');const first=JSON.parse(fs.readFileSync(path.join(dir,'索引','多标签汇总.json'),'utf8'))
  const stats=first.find(x=>x.title==='作者测试');assert.ok(stats.dimensions.作者.includes('李白'));assert.ok(stats.dimensions.作者.includes('杜甫'));assert.ok(stats.dimensions.情感.includes('喜悦'));assert.ok(stats.dimensions.情感.includes('愤怒'))
  assert.equal(stats.tags.find(x=>x.tag==='李白').articles,1)
  const articleSearch=JSON.parse(run('search','李白 喜悦'));assert.ok(articleSearch.selectedArticles.length);assert.ok(articleSearch.hits[0].articles.some(a=>a.heading.includes('李白')))
  const article=JSON.parse(run('get',articleSearch.selectedArticles[0]));assert.ok(JSON.parse(article.tags).includes('李白'));assert.ok(article.text.includes('欢喜'))
  run('retag');assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,'索引','多标签汇总.json'),'utf8')),first);assert.ok(fs.existsSync(path.join(dir,'未索引','新书.txt')))
  fs.mkdirSync(path.join(dir,'未索引','文献'));fs.mkdirSync(path.join(dir,'未索引','其他'))
  fs.writeFileSync(path.join(dir,'未索引','文献','目录限定.txt'),'修身养性，仁义礼智。'.repeat(30))
  fs.writeFileSync(path.join(dir,'未索引','其他','目录限定.txt'),'其他目录不可被读取或索引。'.repeat(30))
  const scoped=JSON.parse(run('index-dir','文献'));assert.equal(scoped.books,3);assert.ok(fs.existsSync(path.join(dir,'未索引','其他','目录限定.txt')));assert.ok(fs.existsSync(path.join(dir,'未索引','待处理.txt')))
  assert.throws(()=>run('index-dir','../已索引'))
  execFileSync('python',['-c',`import runpy,sys,types;from pathlib import Path
x=runpy.run_path('scripts/book-library.py')
sys.modules['pypdf']=types.SimpleNamespace(PdfReader=lambda p:types.SimpleNamespace(pages=[types.SimpleNamespace(extract_text=lambda:'古籍站')]*30))
try:x['extract'](Path('watermark.pdf'));raise AssertionError('watermark-only PDF accepted')
except ValueError as e:assert 'OCR' in str(e)
assert x['decode'](b'\\x80')==('€','cp936-ms-euro')`],{encoding:'utf8'})
  console.log('书库通过：显式索引/分类移动、标签先选书再取片段、原文ID回查、检索只读/新书保持未索引、闲聊不注入、引用预算和故障降级。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
