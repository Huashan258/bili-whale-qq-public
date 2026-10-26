import { spawn } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { probeConsole } from './webui-probe.mjs'

export function createWebUiHost({root,dataDir,logger=()=>{},nodeBinary,probe=probeConsole,intervalMs=5000} = {}) {
  const installedNode=process.platform==='win32' && process.env.ProgramFiles ? path.join(process.env.ProgramFiles,'nodejs','node.exe') : ''
  const binary=nodeBinary || process.env.BILI_WHALE_NODE || (/^node(?:\.exe)?$/i.test(path.basename(process.execPath)) ? process.execPath : installedNode && existsSync(installedNode) ? installedNode : 'node')
  let child=null, enabled=false, port=7788, generation=0, pending=false, timer=null, disposed=false, external=false
  const log=text=>{try{logger(text)}catch{}}
  function stopChild() {
    const old=child; child=null
    try{old?.kill()}catch{}
  }
  async function ensure() {
    if (!enabled || disposed || pending || child) return
    pending=true
    const gen=generation, targetPort=port
    try {
      const verdict=await probe(targetPort,{timeoutMs:1500})
      if (!enabled || disposed || gen!==generation) return
      if (verdict==='ours') {
        if(!external) log(`WebUI 已由其他进程提供，复用 http://127.0.0.1:${targetPort}（不接管 WebUI）`)
        external=true;return
      }
      external=false
      if(verdict!=='free') {log(`WebUI 端口 ${targetPort} 被其他服务占用，等待释放后自动启动`);return}
      const env={...process.env,BILI_WHALE_DATA:dataDir,PORT:String(targetPort)}
      delete env.ELECTRON_RUN_AS_NODE
      child=spawn(binary,[path.join(root,'src','server.mjs'),'--no-services','--port',String(targetPort),'--parent-pid',String(process.pid)],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
      const current=child
      log(`WebUI Node 已自动启动：pid ${current.pid}，http://127.0.0.1:${targetPort}`)
      current.stdout.on('data',buf=>{for(const line of String(buf).split('\n')) if(/控制台|启动失败|被占用/.test(line)) log(`[WebUI] ${line.trim()}`)})
      current.stderr.on('data',buf=>{for(const line of String(buf).split('\n')) if(line.trim())log(`[WebUI] ${line.trim()}`)})
      current.on('error',e=>{if(child===current)child=null;log(`WebUI Node 启动失败：${e.message}；将自动重试`)})
      current.on('exit',(code,signal)=>{if(child===current){child=null;log(`WebUI Node 已退出（${signal || code}），将自动拉起`)}})
    } catch(e) {log(`WebUI 自动启动检查失败：${e.message}`)}
    finally {pending=false}
  }
  return {
    configure({enabled:want,port:desired=7788}) {
      if(disposed)return
      const nextPort=Math.max(1,Math.min(65535,Math.trunc(Number(desired)||7788)))
      if(enabled!==Boolean(want)||port!==nextPort){generation++;if(!want||port!==nextPort)stopChild();external=false}
      enabled=Boolean(want);port=nextPort
      if(enabled&&!timer){timer=setInterval(()=>{ensure().catch(()=>{})},intervalMs);timer.unref?.()}
      if(!enabled&&timer){clearInterval(timer);timer=null}
      ensure().catch(()=>{})
    },
    status:()=>({enabled,port,pid:child?.pid ?? null,external}),
    stop(){disposed=true;enabled=false;generation++;if(timer)clearInterval(timer);timer=null;stopChild()},
  }
}
