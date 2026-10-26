import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const root=fs.mkdtempSync(path.join(os.tmpdir(),'diary-auto-'))
const dataDir=path.join(root,'data');fs.mkdirSync(dataDir)
process.env.BILI_WHALE_DATA=dataDir
const {createDiaryService:makeDiaryService,diaryDayEnd}=await import('../src/diary.mjs')
const createDiaryService=options=>makeDiaryService({literature:async()=> '【可引用古文】《论语》学而\n有朋自远方来，不亦乐乎？',...options})
const {createDiaryScheduler,diaryRecordDays}=await import('../src/diary-auto.mjs')
let now=Date.parse('2026-10-22T02:00:00Z'),enabled=true,calls=0
const cfg=()=>({diary:{autoEnabled:enabled},llm:{provider:'fixture',apiKey:'fixture'},chat:{nick:'测试鱼'}})
const row=(day,id,text='这一天发生的真实对话')=>JSON.stringify({ts:`${day}T00:01:00+08:00`,type:'in',channel:'group',group:'123456',from:'群友',text,id})
const logs=path.join(dataDir,'chat.log')
fs.writeFileSync(logs,['2026-10-19','2026-10-20','2026-10-21','2026-10-22'].map((d,i)=>row(d,i)).join('\n')+'\n'+JSON.stringify({ts:'2026-10-18T00:01:00+08:00',type:'in',channel:'private',text:'私聊不能触发补写'})+'\n'+row('2026-10-24',99))
const prose=i=>Array.from({length:40},(_,j)=>Array.from({length:30},(_,k)=>String.fromCodePoint(0x4e00+(i%10)*1300+j*30+k)).join('')+'。').join('\n')
fs.writeFileSync(path.join(dataDir,'bili-private.json'),JSON.stringify({peers:{neverSent:{lastSentAt:0}}}))
const words=path.join(root,'words');fs.mkdirSync(words)
fs.writeFileSync(path.join(words,'2026-10-20已有日记.txt'),'2026-10-20 已有日记\n\n'+prose(0).repeat(4)+'\n——记录范围——\n截至北京时间23:59:59')
fs.writeFileSync(path.join(words,'2026-10-21半天的日记.txt'),'2026-10-21 半天\n\n'+prose(1).repeat(4)+'\n——记录范围——\n截至北京时间12:00:00')
const prompts=[]
const model=async(_cfg,p)=>{prompts.push(p);return {content:(calls%4===0?'标题：当日回声\n':'')+prose(++calls)}}
const service=createDiaryService({root,dataDir,config:cfg,now:()=>now,modelChat:model})
const peer=createDiaryService({root,dataDir,config:cfg,now:()=>now,modelChat:model})
const scheduler=createDiaryScheduler({service,dataDir,config:cfg,now:()=>now})
const other=createDiaryScheduler({service:peer,dataDir,config:cfg,now:()=>now})
try {
  assert.deepEqual(await diaryRecordDays({dataDir,at:now}),['2026-10-19','2026-10-20','2026-10-21','2026-10-22'])
  await Promise.all([scheduler.tick(),other.tick()]);await service.wait();await peer.wait()
  assert.equal(calls,1,'两控制台不能重复为同一天自动写作')
  assert.equal(service.status().day,'2026-10-19','先补最早缺失日期')
  assert.equal(service.status().snapshotAt,diaryDayEnd('2026-10-19'))
  assert.equal(service.status().startedAt,now,'工作启动时间与历史快照日期分开')
  assert.equal(service.saved('2026-10-20',true),true,'兼容旧日记无需重新生成')
  assert.equal(service.saved('2026-10-21',true),false,'半日版本不等于完整归档')
  await scheduler.tick();await service.wait()
  assert.equal(service.status().day,'2026-10-21')
  assert.equal(service.saved('2026-10-21',true),true)
  assert.ok(fs.existsSync(path.join(words,'2026-10-21半天的日记.txt')),'保留原半日版本')
  await scheduler.tick();await service.wait()
  assert.equal(service.status().day,'2026-10-22')
  assert.equal(service.status().automatic,true)
  assert.equal(service.saved('2026-10-22',true),false)
  const before=calls
  await scheduler.tick();assert.equal(calls,before,'重启/重复轮询不会重新写今日半日版')
  const restarted=createDiaryScheduler({service:peer,dataDir,config:cfg,now:()=>now})
  await restarted.tick();assert.equal(calls,before,'重启仍识别已有文件和归档')
  assert.equal(service.start({day:'2026-10-19',automatic:true}).skipped,true)
  assert.throws(()=>service.start({day:'2026-02-30'}),/日期无效/)
  assert.throws(()=>service.start({day:'2026-10-25'}),/晚于今天/)
  // 跨北京时间午夜：只补刚结束的完整一天，不能把历史素材套到新日期。
  fs.appendFileSync(logs,'\n'+JSON.stringify({ts:'2026-10-22T23:59:50+08:00',type:'in',channel:'group',group:'123456',id:'late',text:'午夜前最后的消息'}))
  now=Date.parse('2026-10-22T16:00:05Z')
  await scheduler.tick();await service.wait()
  assert.equal(service.status().day,'2026-10-22')
  assert.equal(service.status().snapshotAt,diaryDayEnd('2026-10-22'))
  assert.equal(service.saved('2026-10-22',true),true)
  assert.match(prompts.slice(-4).map(p=>p.user).join('\n'),/午夜前最后的消息/)
  await other.tick();assert.equal(calls,before+1,'跨日完整归档只做一次')
  enabled=false
  fs.appendFileSync(logs,'\n'+row('2026-10-23','new','今天的新消息'))
  await scheduler.tick();assert.equal(calls,before+1)
  assert.equal(scheduler.status().enabled,false)
  now+=120000
  enabled=true;await scheduler.tick();await service.wait()
  assert.equal(service.status().day,'2026-10-23','设置重新开启后重新发现记录')
  assert.equal(service.status().snapshotAt,now)

  const badDir=path.join(root,'bad-data');fs.mkdirSync(badDir);fs.writeFileSync(path.join(badDir,'chat.log'),row('2026-10-23',1))
  let failures=0
  const broken=createDiaryService({root:path.join(root,'bad-root'),dataDir:badDir,config:cfg,now:()=>now,modelChat:async()=>{failures++;throw Object.assign(Error('unavailable'),{code:'MODEL_NETWORK'})}})
  const retry=createDiaryScheduler({service:broken,dataDir:badDir,config:cfg,now:()=>now})
  await retry.tick();await broken.wait();assert.equal(failures,1)
  await retry.tick();assert.equal(failures,1,'失败不能每分钟反复烧模型')
  now+=30*60000;await retry.tick();await broken.wait();assert.equal(failures,2,'退避后恢复尝试')

  let scheduled=0,cleared=0,firstTick
  const scheduledWorker=createDiaryScheduler({service,dataDir,config:cfg,now:()=>now,timers:{setTimeout:fn=>{firstTick=fn;scheduled++;return 1},setInterval:()=>{scheduled++;return 2},clearTimeout:()=>cleared++,clearInterval:()=>cleared++}})
  scheduledWorker.start();scheduledWorker.start();assert.equal(scheduled,2)
  scheduledWorker.stop();await firstTick();assert.equal(cleared,2)
  console.log('自动日记通过：历史缺日与当前日补写、旧日记识别、半日版跨日完整归档、北京时间/历史快照、双实例与手动互斥、重启不重复、未来/无效日期排除、设置热开关、失败30分钟退避、启动/停止定时器。')
}finally{scheduler.stop();other.stop();fs.rmSync(root,{recursive:true,force:true})}
