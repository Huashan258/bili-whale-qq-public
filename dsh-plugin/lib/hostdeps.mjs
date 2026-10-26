/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/schemastery`
 * ============================================================================
 * 🔴 为什么不能直接 `import '@deepseek-ai/schemastery'`（抄 dsh-bili-scroll 的血泪）：
 *    本包用 `link:` 装进 profile，Node 按 **realpath** 解析裸导入 ⇒
 *    从 `C:/apps/bili-whale-qq/dsh-plugin/node_modules` 往上找，而那儿没有 node_modules；
 *    profile 树里的那份（desktop 上有）**压根不在解析路径上**。
 *    ⇒ 裸 import 会抛 ERR_MODULE_NOT_FOUND，而它写在模块顶层 ⇒ **整条插件不激活** ✗。
 *
 * ⭐ 策略：按绝对路径从候选根里挨个试；彻底拿不到就返回 null，
 *    **插件照常加载**（只是没有 Config，设置页降级）——
 *    绝不因为一个 import 让整条插件不激活。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 可能藏着宿主 `@deepseek-ai` 包的地方（不写死某一台机器，按可能性排序） */
export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }

  push(process.env.DSH_HOST_MODULES)

  // ① DSH 自己的 profile 树 —— desktop 上就有一份 @deepseek-ai/schemastery
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  // ② npm 全局安装的 dsh（以及它下面任何 @deepseek-ai/* 子包的 node_modules）
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }

  // ③ POSIX 上的常见全局位置
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')

  // ④ 插件自己那棵树（万一有人给它装了依赖）
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    push(join(d, 'node_modules', '@deepseek-ai'))
    const up = dirname(d)
    if (up === d) break
    d = up
  }

  return out
}

/** 按包的 exports['.'] 找入口文件，返回 file:// URL */
function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string'
      ? dot
      : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/**
 * 取回宿主半端要用的一点点东西（目前只有 schemastery 的 z）
 * @returns {Promise<{z: any|null, notes: string[]}>}
 */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  let zMod = null
  for (const root of candidateRoots()) {
    const url = entryUrlFor(root, 'schemastery')
    if (!url) continue
    try {
      zMod = await import(url)
      log(`schemastery：解析到 ${url.replace(/^file:\/\/\//, '')}`)
      break
    } catch (e) {
      log(`schemastery：${root} 加载失败（${e?.code || 'ERR'}）`)
    }
  }
  if (!zMod) {
    try {
      zMod = await import('@deepseek-ai/schemastery')
      log('schemastery：用裸导入那份')
    } catch (e) {
      log(`⚠️ schemastery 彻底拿不到（${e?.code || ''} ${String(e?.message || '').slice(0, 120)}）—— 这一份插件没有 Config，设置页会降级（插件本体照常跑）`)
    }
  }

  return { z: zMod?.default ?? zMod ?? null, notes }
}
