/**
 * 单实例锁。
 *
 * 为什么要这个：qq 的 OneBot 是「一条消息推给所有 WS 客户端」的模式，
 * 两个 agent 同时连着，同一条群消息就会被各回一遍——看起来像机器人抽风。
 * 之前反复出现「以为没在跑、又起一个」，结果老的其实还活着。
 *
 * 锁文件里只放 pid + 启动时间；判断存活的依据是 process.kill(pid, 0)，
 * 进程被强杀留下过期锁也能自动接管。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DATA } from './config.mjs'

function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = 进程在，但没有权限发信号（Windows 上少见），仍算活着
    return e.code === 'EPERM'
  }
}

/**
 * @returns {{ok:boolean, file:string, pid?:number, since?:string, owner?:string}}
 */
export function acquireLock(name = 'agent', { owner = 'standalone' } = {}) {
  fs.mkdirSync(DATA, { recursive: true })
  const file = path.join(DATA, `${name}.lock`)

  let prev = null
  try {
    prev = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch { /* 没锁 / 内容坏了，都按没有处理 */ }

  if (prev?.pid && prev.pid !== process.pid && isAlive(prev.pid)) {
    return { ok: false, file, pid: prev.pid, since: prev.at, owner: prev.owner ?? 'standalone' }
  }

  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), owner }))
  return { ok: true, file }
}

export function releaseLock(file) {
  if (!file) return
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j.pid === process.pid) fs.unlinkSync(file)
  } catch { /* 文件没了就算了 */ }
}

/** 看看现在有没有人在跑（不改锁） */
export function lockHolder(name = 'agent') {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(DATA, `${name}.lock`), 'utf8'))
    if (j?.pid && isAlive(j.pid)) return j
  } catch { /* 没有锁 */ }
  return null
}
