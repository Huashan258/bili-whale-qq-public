#!/usr/bin/env node
/**
 * dsh-bili-scroll 的「装主依赖」手动版。
 *
 * 为什么要有它：插件设置页里那个「装主依赖」按钮在桌面版上经常卡住
 * （它先要下 uv，下不到就装不动）。这个脚本直接用系统 Python 建 venv，
 * 按插件**自带**的 requirements.txt 装，装完把该填的 pythonPath 打出来。
 *
 * 用法：
 *   node scripts/dsh-setup.mjs                 # 建/补 venv
 *   node scripts/dsh-setup.mjs --check         # 只体检，不装
 *
 * 装完还要做的两件事（自动化不了，必须人来做）：
 *   1. 在 DSH 桌面版插件设置页点「扫码登录」，手机 B站 扫，选「记住我 / 长期」；
 *   2. 重启一次 DSH 桌面版。
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

const isWin = platform() === 'win32'
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PLUGIN = process.env.DSH_BILI_SCROLL_DIR
  || join(HOME, 'profiles', 'desktop', 'node_modules', 'dsh-bili-scroll')
const STATE = join(HOME, 'bili-duty')
const VENV = join(STATE, '.venv')
const VENV_PY = isWin ? join(VENV, 'Scripts', 'python.exe') : join(VENV, 'bin', 'python')
const REQS = join(PLUGIN, 'vendor', 'bilibili-mcp', 'requirements.txt')
// 清华源对部分 IP 回 403（pip 会误报成"包不存在"），所以一个不行就换下一个
const MIRRORS = [
  process.env.BILI_DUTY_PIP_MIRROR || 'https://mirrors.aliyun.com/pypi/simple/',
  'https://mirrors.ustc.edu.cn/pypi/simple',
  '', // 最后退回官方源
]

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: isWin, ...opts })
  p.on('exit', (code) => resolve(code ?? 1))
  p.on('error', () => resolve(1))
})

const log = (...a) => console.log(...a)

/** 插件 index.js 里 venvReadyNow() 的判据：venv python 在 + site-packages 里有 bilibili_api */
function venvReady() {
  if (!existsSync(VENV_PY)) return false
  let dir = join(VENV, 'Lib', 'site-packages')
  if (!existsSync(dir)) {
    const lib = join(VENV, 'lib')
    try {
      const sub = readdirSync(lib).find((n) => n.startsWith('python'))
      if (sub) dir = join(lib, sub, 'site-packages')
    } catch { /* 非 Windows 且读不到就算了 */ }
  }
  try {
    return readdirSync(dir).some((n) => n.startsWith('bilibili_api'))
  } catch {
    return false
  }
}

async function main() {
  const checkOnly = process.argv.includes('--check')
  log('')
  log('  插件目录  ' + PLUGIN)
  log('  家目录    ' + STATE)
  log('  venv      ' + VENV_PY)
  log('')

  if (checkOnly) {
    log(`  环境就绪：${venvReady() ? '是 ✓' : '否 ✗（跑一次 node scripts/dsh-setup.mjs）'}`)
    log('')
    process.exit(venvReady() ? 0 : 1)
  }

  if (!existsSync(PLUGIN)) {
    log(`  ✗ 找不到插件目录 ${PLUGIN}`)
    log('    先装插件，或用 DSH_BILI_SCROLL_DIR 指过去。')
    process.exit(1)
  }
  if (!existsSync(REQS)) {
    log(`  ✗ 找不到依赖清单 ${REQS}`)
    process.exit(1)
  }
  if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true })

  if (!existsSync(VENV_PY)) {
    log('  建 venv …')
    const code = await run('python', ['-m', 'venv', VENV])
    if (code !== 0 || !existsSync(VENV_PY)) {
      log('  ✗ 建 venv 失败。确认 python 在 PATH 里且版本 >= 3.10（插件要 3.10+）。')
      process.exit(1)
    }
    log('  ✓ venv 建好了')
  } else {
    log('  · venv 已存在，跳过建环境')
  }

  let ok = false
  for (const m of MIRRORS) {
    const args = ['-m', 'pip', 'install', '-r', REQS]
    if (m) args.push('-i', m)
    log(`\n  装依赖${m ? `（镜像 ${m}）` : '（官方源）'} …`)
    if (await run(VENV_PY, args) === 0) { ok = true; break }
    log('  · 这个源不行，换下一个')
  }
  if (!ok) {
    log('\n  ✗ 装依赖失败。看看上面的报错，或手动跑：')
    log(`    ${VENV_PY} -m pip install -r "${REQS}"`)
    process.exit(1)
  }

  const ready = venvReady()
  log('')
  log(`  环境就绪：${ready ? '是 ✓' : '否 ✗'}`)
  log('')
  log('  下一步（这两步自动化不了）：')
  log('    1. 把插件设置里的 pythonPath 填成（脚本不会替你改配置）：')
  log(`       ${VENV_PY}`)
  log('    2. 重启 DSH 桌面版 → 插件设置页点「扫码登录」→ 手机 B站 扫，选「记住我 / 长期」')
  log('')
  process.exit(ready ? 0 : 1)
}

main()
