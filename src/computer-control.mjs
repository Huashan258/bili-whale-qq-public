import fs from 'node:fs'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'
import {DATA} from './config.mjs'
const exec=promisify(execFile),bridge=fileURLToPath(new URL('../scripts/computer-bridge.ps1',import.meta.url))
const settings=cfg=>({enabled:false,allowActions:false,maaDir:'',fileRoots:[],screenshotProcesses:['MAA'],...(cfg.computer??cfg.raw?.computer??{})})
const bytes=n=>{n=Number(n)||0;const i=Math.min(3,Math.floor(Math.log(Math.max(1,n))/Math.log(1024)));return `${(n/1024**i).toFixed(i?1:0)} ${['B','KiB','MiB','GiB'][i]}`}
export function computerIntent(message){
 const text=(Array.isArray(message)?message.filter(s=>s?.type==='text').map(s=>s.data?.text??'').join(''):String(message??'').replace(/\[CQ:[^\]]+\]/g,'')).trim()
 const m=text.match(/^(程序查询|系统查询|电脑查询|程序截图|程序操作|文件查询|文件读取|文件列表)[：:]\s*([\s\S]+)$/);if(!m)return null
 const [,kind,body]=m
 if(kind.startsWith('文件'))return {kind:kind==='文件列表'?'list':'file',path:body.trim()}
 if(kind==='程序操作'){
  const a=body.trim().match(/^maa\s*(开始|启动|停止|勾选自动肉鸽|开启自动肉鸽|取消自动肉鸽|关闭自动肉鸽)$/i)
  if(!a)return {kind:'invalid',error:'操作格式：程序操作：Maa 开始 / 停止 / 勾选自动肉鸽 / 取消自动肉鸽'}
  return {kind:'action',action:/^(开始|启动)$/.test(a[1])?'maa-start':a[1]==='停止'?'maa-stop':/^(勾选|开启)/.test(a[1])?'maa-rogue-on':'maa-rogue-off',process:'MAA'}
 }
 if(kind==='系统查询'||kind==='电脑查询'||/CPU|内存|网络|流量|资源|性能/i.test(body))return {kind:'resources'}
 const screenshot=kind==='程序截图'||/截图/.test(body),name=body.replace(/(?:的)?运行状态|状态|截图|并发给我|发给我|[，,、]/g,'').trim().replace(/\.exe$/i,'')
 if(!/^[\w.-]{1,80}$/.test(name))return {kind:'invalid',error:'请使用准确进程名，例如：程序查询：Maa运行状态；程序截图：Maa'}
 return {kind:name.toLowerCase()==='maa'?'maa':'program',process:name.toLowerCase()==='maa'?'MAA':name,screenshot}
}
export async function runComputerBridge(action,{processName='MAA',maaDir='',outputFile='',signal}={}){
 if(process.platform!=='win32')throw Error('本机程序查询需要 Windows 交互桌面；服务器只能查询其自身状态')
 const args=['-NoLogo','-NoProfile','-NonInteractive','-File',bridge,'-Action',action,'-ProcessName',processName];if(maaDir)args.push('-MaaDir',maaDir);if(outputFile)args.push('-OutputFile',outputFile)
 let stdout;try{({stdout}=await exec('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:40000,maxBuffer:2*1024*1024,signal}))}catch(e){let d;try{d=JSON.parse(String(e.stdout).replace(/^\uFEFF/,''))}catch{}throw Error(d?.error||'本机检测超时或未能完成，请检查桌面会话和程序权限')}
 const data=JSON.parse(stdout.replace(/^\uFEFF/,''));if(!data.ok)throw Error(data.error);return data
}
const sensitivePath=/(?:^|[\\/])(?:\.env(?:\..*)?|\.ssh|\.aws|\.credentials.*|credentials.*|cookies?.*|config\.json|whale-ui\.json|Login Data|Cookies|api[-_]?key.*|[^\\/]*凭据[^\\/]*)(?:[\\/]|$)/i
function redact(text){return text.replace(/\b(?:sk-[\w.-]{12,}|Bearer\s+[\w.=-]{12,})\b/gi,'[凭据已隐藏]').replace(/((?:api[_-]?key|access[_-]?token|password|passwd|secret|sessdata|bili_jct|authorization)\s*["']?\s*[:=]\s*["']?)[^\s,"'\r\n}]+/gi,'$1[凭据已隐藏]')}
export function readComputerFile(intent,cfg){
 const opts=settings(cfg),requested=path.resolve(intent.path.replace(/^"|"$/g,''));if(sensitivePath.test(requested))throw Error('该路径包含凭据或账号配置，不通过QQ读取')
 const real=fs.realpathSync(requested),roots=opts.fileRoots.map(p=>{try{return fs.realpathSync(p)}catch{return null}}).filter(Boolean)
 if(!roots.some(root=>{const relative=path.relative(root,real);return relative===''||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))}))throw Error('路径不在允许读取的目录内，请在电脑工作台配置目录')
 if(sensitivePath.test(real))throw Error('该路径指向凭据文件，不通过QQ读取')
 const stat=fs.statSync(real)
 if(intent.kind==='list'||stat.isDirectory()){
  if(!stat.isDirectory())throw Error('这不是目录')
  const items=fs.readdirSync(real,{withFileTypes:true}).filter(e=>!sensitivePath.test(path.join(real,e.name))).slice(0,80).map(e=>(e.isDirectory()?'[目录] ':'')+e.name)
  return `目录：${real}\n${items.join('\n')||'空目录'}\n（最多显示80项）`
 }
 if(!/\.(txt|md|log|csv|json|yaml|yml|ini|xml)$/i.test(real))throw Error('当前支持文本、日志、Markdown、CSV等文本文件；暂不读取二进制文档')
 if(stat.size>2*1024*1024)throw Error('文件大于2MiB，请指定较小的文本或日志文件')
 const buffer=fs.readFileSync(real);let text=buffer[0]===255&&buffer[1]===254?buffer.subarray(2).toString('utf16le'):buffer.toString('utf8').replace(/^\uFEFF/,'');if(text.includes('\0'))throw Error('文件不是可读取的文本')
 text=redact(text);return `文件：${real}（${bytes(stat.size)}）\n${text.slice(0,4000)}${text.length>4000?'\n（内容已截断至4000字符）':''}`
}
export function formatComputerResult(intent,d){
 if(intent.kind==='resources')return `CPU 当前使用率：${d.cpu}%\n内存：${bytes(d.memoryTotal-d.memoryAvailable)} / ${bytes(d.memoryTotal)}（${((d.memoryTotal-d.memoryAvailable)/d.memoryTotal*100).toFixed(1)}%）\n网卡采样约${Number(d.sampleSeconds).toFixed(1)}秒：\n${(d.network??[]).map(n=>`${n.name}：下载 ${bytes(n.receivePerSec)}/s，上传 ${bytes(n.sendPerSec)}/s\n累计接收 ${bytes(n.received)}，发送 ${bytes(n.sent)}`).join('\n')||'未检测到可用网卡'}\n累计为网卡启动/重置以来的计数，并非今日或计费流量。${d.networkMode==='all-up'?'当前包含虚拟网卡，可能存在重复统计。':''}`
 if(!d.running)return `${intent.process} 未运行`
 const processes=(d.processes??[]).map(p=>`PID ${p.pid} · 内存 ${bytes(p.memory)} · ${p.responding?'响应正常':'无响应'}`).join('\n')
 if(intent.kind==='program')return `${intent.process} 已运行\n${processes}`
 const run={running:'任务运行中',stopped:'任务已停止',unknown:'无法确定（当前按钮不可读或被弹窗阻挡）'}[d.taskState]??'无法确定'
 const rogue={On:'已勾选',Off:'未勾选',Indeterminate:'混合状态'}[d.roguelike]??'无法读取'
 return `Maa 进程已启动\n${processes}\n任务：${run}\n自动肉鸽：${rogue}${d.modals?.length?'\n当前弹窗：'+d.modals.join('、'):''}${intent.kind==='action'?'\n操作请求已提交，以上为随后读取的状态；启动任务可能仍在连接模拟器。':''}`
}
export function createComputerControl({run=runComputerBridge,readFile=readComputerFile,dataDir=DATA,now=Date.now}={}){
 let tail=Promise.resolve()
 return async function handle(message,cfg,{admin=false,signal,requestId='',messageTime}={}){
  const intent=computerIntent(message);if(!intent)return null
  if(!admin)return {handled:true,denied:true,text:'本机查询与操作仅限机器人管理员使用'}
  let opts=settings(cfg);if(!opts.enabled)return {handled:true,text:'本机助手未开启，请在电脑工作台开启'}
  const task=tail.catch(()=>{}).then(async()=>{
   let outputFile,lockFd,lockFile
   try{
    opts=settings(cfg);if(!opts.enabled)throw Error('本机助手已关闭，取消排队请求')
    signal?.throwIfAborted();if(intent.kind==='invalid')throw Error(intent.error)
    if(intent.kind==='action'&&!opts.allowActions)throw Error('Maa按钮操作未开启，请在电脑工作台开启')
    if(intent.kind==='action'){
     if(!requestId)throw Error('操作消息缺少唯一编号，未执行')
     if(messageTime&&Math.abs(now()-Number(messageTime)*1000)>120000)throw Error('操作消息超过两分钟，不执行过期或历史指令')
     fs.mkdirSync(dataDir,{recursive:true});lockFile=path.join(dataDir,'computer-actions.lock')
     try{
      try{const content=fs.readFileSync(lockFile,'utf8'),pid=Number(content);if(Number.isInteger(pid)&&pid>0){try{process.kill(pid,0)}catch(e){if(e.code==='ESRCH'&&fs.readFileSync(lockFile,'utf8')===content)fs.unlinkSync(lockFile)}}}catch{}
      lockFd=fs.openSync(lockFile,'wx');fs.writeFileSync(lockFd,String(process.pid))
     }catch{throw Error('另一个本机操作正在处理，未执行本次操作')}
     fs.mkdirSync(dataDir,{recursive:true});const receipt=path.join(dataDir,'computer-actions.json');let records={};try{records=JSON.parse(fs.readFileSync(receipt,'utf8'))}catch(e){if(e.code!=='ENOENT')throw Error('操作回执记录不可读，未执行')}
     if(records[requestId])throw Error('该操作消息已处理或结果未明，不重复执行')
     records[requestId]={at:now(),action:intent.action,status:'reserved'};const tmp=receipt+'.tmp';fs.writeFileSync(tmp,JSON.stringify(records));fs.renameSync(tmp,receipt)
    }
    if(['file','list'].includes(intent.kind))return {handled:true,text:readFile(intent,cfg)}
    if(intent.screenshot){if(!(opts.screenshotProcesses??[]).some(p=>p.toLowerCase()===intent.process.toLowerCase()))throw Error('该程序未加入允许截图的进程名单');const dir=path.join(dataDir,'computer-captures');fs.mkdirSync(dir,{recursive:true});outputFile=path.join(dir,`${now()}-${randomUUID()}.png`)}
    const d=await run(intent.kind==='action'?intent.action:intent.screenshot&&intent.kind==='program'?'screenshot':intent.kind,{processName:intent.process,maaDir:intent.process==='MAA'?opts.maaDir:'',outputFile,signal})
    let image;if(outputFile&&d.screenshot){const stat=fs.statSync(outputFile);if(stat.size>12*1024*1024)throw Error('截图过大，未发送');image=fs.readFileSync(outputFile)}
    return {handled:true,text:formatComputerResult(intent,d),image}
   }catch(e){return {handled:true,text:'本机查询未完成：'+e.message}}finally{if(outputFile)try{fs.unlinkSync(outputFile)}catch{};if(lockFd!==undefined){fs.closeSync(lockFd);try{fs.unlinkSync(lockFile)}catch{}}}
  });tail=task;return task
 }
}
