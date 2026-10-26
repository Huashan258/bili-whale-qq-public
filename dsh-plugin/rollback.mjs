/**
 * rollback.mjs —— 把 dsh-whale 从 desktop profile 上摘干净
 * ============================================================================
 *   node C:\apps\bili-whale-qq\dsh-plugin\rollback.mjs
 *   node C:\apps\bili-whale-qq\dsh-plugin\rollback.mjs --dry   （只打印要做什么）
 *
 * 四步（顺序有讲究）：
 *   ① 先从 bundles 里摘 —— 摘了之后 DSH 下次启动就不会加载插件，
 *      正在跑的那一个不受影响（配置树是启动时组装的），所以这步**随时可做**。
 *   ② 删 node_modules 里的链接
 *   ③ 卸依赖（pnpm remove）—— 会动 package.json 和 pnpm-lock.yaml
 *   ④ 打印备份文件路径（兜底用）
 *
 * ⚠️ 它**不会**重启 DSH，也不会杀任何进程。摘完要生效请自己重启 DSH。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DRY = process.argv.includes('--dry')
const PROFILE_DIR = join(homedir(), '.dsh', 'profiles', 'desktop')
const PKG = join(PROFILE_DIR, 'package.json')
const LINK = join(PROFILE_DIR, 'node_modules', 'dsh-whale')
const PLUGIN_ID = 'dsh-whale'

const act = (msg, fn) => {
  if (DRY) { console.log(`  [预演] ${msg}`); return }
  try { fn(); console.log(`  ✓ ${msg}`) } catch (e) { console.log(`  ✗ ${msg} —— ${e?.message ?? e}`) }
}

/** 本地时间戳 YYYYMMDDHHMMSS */
function localStamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

console.log(`\n== 回滚 dsh-whale（profile: ${PROFILE_DIR}）==\n`)

/* ① bundles */
if (existsSync(PKG)) {
  const raw = readFileSync(PKG, 'utf8')
  const pkg = JSON.parse(raw)
  const bundles = pkg?.dsh?.profile?.bundles ?? []
  if (bundles.includes(PLUGIN_ID)) {
    // ⚠️ 用**本地时间**拼时间戳：toISOString() 是 UTC，跟 profile 里已有的两份
    //    本地时间戳备份（package.json.bak-20261020-082841 那种）混在一起会排错序。
    const stamp = localStamp()
    act(`备份 package.json → package.json.bak-${stamp}-rollback`, () => {
      writeFileSync(join(PROFILE_DIR, `package.json.bak-${stamp}-rollback`), raw)
    })
    act('从 dsh.profile.bundles 里摘掉 dsh-whale', () => {
      pkg.dsh.profile.bundles = bundles.filter((b) => b !== PLUGIN_ID)
      writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    })
  } else {
    console.log('  · bundles 里本来就没有 dsh-whale，跳过')
  }
  if (pkg?.dependencies?.[PLUGIN_ID]) {
    console.log('  ⚠️ package.json 的 dependencies 里还有 dsh-whale —— 下一步删链接，然后跑：')
    console.log(`     dsh plugin --profile desktop remove ${PLUGIN_ID}`)
  }
} else {
  console.log(`  ✗ 找不到 ${PKG}`)
}

/* ② 链接 */
if (existsSync(LINK)) {
  act(`删掉链接 ${LINK}`, () => rmSync(LINK, { recursive: true, force: true }))
} else {
  console.log('  · node_modules/dsh-whale 不存在，跳过')
}

/* ③ 备份清单 */
console.log('\n可用备份（要全量还原就把文件覆盖回 package.json）：')
try {
  const baks = readdirSync(PROFILE_DIR).filter((f) => f.startsWith('package.json.bak'))
  if (!baks.length) console.log('  （没有）')
  for (const b of baks.sort()) console.log(`  · ${join(PROFILE_DIR, b)}`)
} catch { /* 读不到就算了 */ }

console.log('\n剩下的手活：')
console.log('  1. dsh plugin --profile desktop remove dsh-whale     （卸依赖）')
console.log('  2. 重启 DSH 让配置树重新组装')
console.log('  3. 想连镜像 profile 一起清：rm -rf C:\\Users\\ExampleUser\\.dsh\\profiles\\whalecheck\n')
