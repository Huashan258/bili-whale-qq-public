import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-diary-'))
process.env.BILI_WHALE_DATA=path.join(dir,'data')
const {collectDiaryDay,createDiaryService:makeDiaryService,diaryDay,diaryChars,safeDiaryTitle,diaryText,diaryChunks,cleanDiaryProse}=await import('../src/diary.mjs')
const createDiaryService=options=>makeDiaryService({literature:async()=> '【可引用古文】《论语》学而\n有朋自远方来，不亦乐乎？',...options})
const dataDir=process.env.BILI_WHALE_DATA
fs.mkdirSync(dataDir,{recursive:true})
const at=Date.parse('2026-10-21T15:30:00Z')
const write=(file,data)=>fs.writeFileSync(path.join(dataDir,file),typeof data==='string'?data:JSON.stringify(data))
const log=r=>JSON.stringify(r)
const row={ts:'2026-10-20T16:00:00Z',channel:'group',group:'123456',type:'in',from:'群友',text:'凌晨的第一条消息',id:1}
const prose=i=>Array.from({length:42},(_,j)=>Array.from({length:29},(_,k)=>String.fromCodePoint(0x4e00+i*1400+j*29+k)).join('')+'。').join('\n')
const cfg={llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'青娥鱼'}}
try {
  assert.equal(diaryDay(Date.parse('2026-10-20T15:59:59Z')),'2026-10-20')
  assert.equal(diaryDay(Date.parse('2026-10-20T16:00:00Z')),'2026-10-21')
  write('chat.log',[row,row,{...row,ts:'2026-10-20T15:59:59Z',id:2,text:'昨天不应进入'}, {...row,ts:'2026-10-21T15:40:00Z',id:3,text:'未来不应进入'}, {...row,channel:'private',text:'PRIVATE-SECRET',id:4},{...row,ts:'2026-10-21T12:00:00Z',type:'out',text:'当时的回复',replyTo:1}, {...row,ts:'2026-10-21T12:01:00Z',id:5,text:'apiKey=sk-abcdefghijklmnop'}].map(log).join('\n')+'\n{broken\n')
  write('state.json',{replied:{a:{at:'2026-10-21T12:00:00Z',bvid:'BV1pjwazUET1',rpid:'receipt'}}})
  write('comment.log',log({ts:'2026-10-21T12:00:00Z',ok:true,bvid:'BV1pjwazUET1',rpid:'receipt'}))
  write('dsh-plugin.log',['2026-10-21T12:00:00Z 评论区巡检：没有新留言','2026-10-21T12:05:00Z 评论区巡检：没有新留言','2026-10-21T12:06:00Z [chat] 私聊 B站 PRIVATE-SECRET'].join('\n'))
  const snapshot=await collectDiaryDay({dataDir,at})
  assert.equal(snapshot.counts.qqIn,2,'按消息ID去重，不把前后日期和私聊计入')
  assert.equal(snapshot.counts.qqOut,1)
  assert.equal(snapshot.counts.bili,2,'同回执不重复，巡检相同状态合并')
  const source=JSON.stringify(snapshot)
  assert.doesNotMatch(source,/PRIVATE-SECRET|sk-abcdefghijklmnop|昨天不应进入|未来不应进入/)
  assert.match(source,/同类记录共2次/)
  assert.equal(diaryChars('汉字四个 abc 123，。'),4)
  assert.equal(safeDiaryTitle('../坏:名字?*'),'..坏名字')
  assert.doesNotMatch(diaryText('Bearer token1234 SESSDATA=cookie123 access_token=secret-value'),/token1234|cookie123|secret-value/)
  assert.equal(diaryChunks(['first','x'.repeat(30000),'last']).join('').replace(/\n/g,''),'first'+'x'.repeat(30000)+'last')
  let modelCalls=0,release
  const gate=new Promise(resolve=>release=resolve),prompts=[]
  const service=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at,modelChat:async(_cfg,p)=>{
    prompts.push(p);if(modelCalls++===0)await gate
    return {content:(modelCalls===1?'标题：海风里的今天\n':'')+prose(modelCalls),usage:{total:100}}
  }})
  const first=service.start();assert.equal(first.job.day,'2026-10-21')
  assert.equal(service.start().alreadyRunning,true)
  const secondProcess=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at})
  assert.throws(()=>secondProcess.start(),/已有日记/)
  release();await service.wait()
  const done=service.status()
  assert.equal(done.status,'done',JSON.stringify(done))
  assert.ok(done.chars>0 && done.length<=3000)
  assert.equal(done.filename,'2026-10-21海风里的今天.txt')
  assert.ok(fs.existsSync(path.join(dir,'words',done.filename)))
  assert.equal(prompts.length,1)
  assert.match(prompts[0].user,/有朋自远方来/)
  assert.match(prompts[0].system,/当天遇到的具体内容都可省略/)
  assert.match(prompts[0].system,/直接引用一句或一整段/)
  assert.doesNotMatch(cleanDiaryProse('观之有感 https://b23.tv/abc `https://example.com/a` BV1pjwazUET1 [故人](https://example.org/a)'),/https?:|BV1pjwazUET1|example/)
  assert.match(prompts[0].system,/文言文/)
  assert.equal(done.maxChars,3000)
  assert.ok(prompts.every(p=>p.user.includes('凌晨的第一条消息')))
  assert.ok(prompts.every(p=>!p.user.includes('PRIVATE-SECRET')))
  assert.equal(fs.existsSync(path.join(dataDir,'diary.lock')),false)
  assert.match(service.read(done.filename).content,/记录范围/)
  assert.throws(()=>service.read('../config.json'))
  assert.throws(()=>service.read('2026-10-21/../bad.txt'))
  // 再次点击同名日记保留上一份，不覆盖。
  let n=0
  const again=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at,modelChat:async()=>({content:(++n===1?'标题：海风里的今天\n':'')+prose(n)})})
  const original=fs.readFileSync(done.path,'utf8');again.start();await again.wait()
  assert.equal(again.status().filename,'2026-10-21海风里的今天（2）.txt')
  assert.equal(fs.readFileSync(done.path,'utf8'),original)
  const existing=fs.readdirSync(path.join(dir,'words')).length
  const broken=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at,modelChat:async()=>{throw Object.assign(Error('apiKey=do-not-leak'),{code:'MODEL_NETWORK'})}})
  broken.start();await broken.wait();assert.equal(broken.status().status,'failed')
  assert.doesNotMatch(broken.status().error,/do-not-leak/)
  assert.equal(fs.readdirSync(path.join(dir,'words')).length,existing)
  const emptyDir=path.join(dir,'empty')
  let emptyCalls=0
  const empty=createDiaryService({root:dir,dataDir:emptyDir,config:()=>cfg,now:()=>at,modelChat:async()=>emptyCalls++})
  empty.start();await empty.wait();assert.equal(emptyCalls,0);assert.match(empty.status().error,/没有可读取/)
  let shortCalls=0
  const short=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at,modelChat:async()=>({content:`第${++shortCalls}次，记录不足，今天只写这么多。`})})
  short.start();await short.wait();assert.equal(short.status().status,'done');assert.equal(shortCalls,1,'短文不扩写凑字')
  assert.equal(fs.readdirSync(path.join(dir,'words')).length,existing+1,'简短文言日记应保存')
  assert.equal(short.saved('2026-10-21'),true)
  let longCalls=0
  const over=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at,modelChat:async()=>{longCalls++;return {content:prose(1)+prose(2)+prose(3)}}})
  over.start();await over.wait();assert.equal(over.status().status,'failed');assert.equal(longCalls,3);assert.match(over.status().error,/超过3000/)
  const compact=createDiaryService({root:dir,dataDir,config:()=>cfg,now:()=>at,modelChat:async()=>({content:++longCalls===4?prose(1)+prose(2)+prose(3):'标题：夜记\n今日闻群友论事，亦读视频之文。成败皆记之，未见者不妄言。'})})
  compact.start();await compact.wait();assert.equal(compact.status().status,'done');assert.ok(compact.status().length<=3000)
  assert.match(compact.read(compact.status().filename).content,/日记格式：2/)

  // 批量素材要全部进入归纳阶段，而非悄悄只截尾部。
  const large=path.join(dir,'large');fs.mkdirSync(large)
  fs.writeFileSync(path.join(large,'chat.log'),Array.from({length:100},(_,i)=>log({...row,id:i,text:`事件${i}，`+'资料内容。'.repeat(90)})).join('\n'))
  const mapped=[];let segment=0
  const big=createDiaryService({root:dir,dataDir:large,config:()=>cfg,now:()=>at,modelChat:async(_cfg,p)=>{
    if(p.user.includes('压缩为事实笔记')){mapped.push(p.user);return {content:'本批群友讨论了多条资料，记录了当天闲聊。'}}
    return {content:prose(++segment)}
  }})
  big.start();await big.wait();assert.equal(big.status().status,'done')
  assert.ok(mapped.length>1);assert.match(mapped.join('\n'),/事件0，/);assert.match(mapped.join('\n'),/事件99，/)

  // 运行真实前端脚本，核对防连点、后台恢复和下载链接，不使用浏览器权限。
  const elements=new Map(['#diary-generate','#diary-status','#diary-download','#diary-progress','#view-overview'].map(id=>[id,{hidden:false,textContent:'',disabled:false}]))
  let posts=0,resolvePost,timer,uiJob={status:'idle'}
  const ui=vm.createContext({document:{hidden:false,querySelector:s=>elements.get(s)},encodeURIComponent,Error,setInterval:fn=>{timer=fn},fetch:async(_url,opts)=>{
    if(opts.method==='POST'){posts++;await new Promise(r=>resolvePost=r);return {ok:true,json:async()=>({job:{status:'running',day:'2026-10-21',phase:'写作'}})}}
    return {ok:true,json:async()=>({job:uiJob})}
  }})
  vm.runInContext(fs.readFileSync(new URL('../public/diary.js',import.meta.url),'utf8'),ui)
  await new Promise(r=>setImmediate(r))
  const clicking=elements.get('#diary-generate').onclick();await elements.get('#diary-generate').onclick();assert.equal(posts,1)
  resolvePost();await clicking;assert.equal(elements.get('#diary-generate').disabled,true)
  assert.match(elements.get('#diary-status').textContent,/写作/)
  assert.ok(timer)
  uiJob={status:'running',day:'2026-10-21',phase:'后台恢复写作'}
  vm.runInContext(fs.readFileSync(new URL('../public/diary.js',import.meta.url),'utf8'),ui)
  await new Promise(r=>setImmediate(r))
  assert.equal(elements.get('#diary-generate').disabled,true,'刷新后从后台恢复进度')
  uiJob={...done,filename:'2026-10-21测试日记.txt'}
  await timer();await new Promise(r=>setImmediate(r))
  assert.equal(elements.get('#diary-download').hidden,false)
  assert.match(elements.get('#diary-download').href,/%E6%B5%8B%E8%AF%95/)
  assert.equal(elements.get('#diary-generate').disabled,false)
  console.log('日记验证通过：北京时间边界/全量日志/群消息去重/私聊排除/凭据脱敏/重复巡检归并、分批覆盖、文言提示/3000字上限/超长精简与拒存/短文不扩写、后台跨实例锁/并发按钮、同名不覆盖、安全TXT下载、模型失败/空素材不落盘、UI进度恢复。')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
