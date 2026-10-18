// 验证生成的 PowerShell 辅助脚本**语法正确且能跑起来**。
//
// 不真的杀进程：把脚本里的目标映像名换成一个不存在的名字（fake-app-xyz.exe），
// 其余结构原样保留。这样能验证：
//   - 脚本文本在 PowerShell 里没有语法错误；
//   - 日志文件确实被写到（证明「辅助进程跑起来了」这件事可观测）；
//   - 结尾会删掉自己。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, report } from './assert.mjs'

const mod = await import(new URL('../src/index.js', import.meta.url).href)
const { installerScript } = mod.__testing

const stamp = Date.now()
const logPath = join(tmpdir(), `restart-check-${stamp}.log`)
const scriptPath = join(tmpdir(), `restart-check-${stamp}.ps1`)

// 生成真实脚本，然后把「应用映像名」和「可执行文件」换成一个无害的假目标。
let source = installerScript({
  executable: 'C:\\Windows\\System32\\notepad.exe',
  imageName: 'fake-app-xyz.exe',
  logPath,
})
console.log('=== generated script ===')
console.log(source)
console.log('=== end ===\n')

writeFileSync(scriptPath, source, 'utf8')

const run = spawnSync('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
], { encoding: 'utf8', windowsHide: true, timeout: 60000 })

console.log('exit code:', run.status)
console.log('stderr:', JSON.stringify((run.stderr ?? '').trim().slice(0, 800)))
console.log('stdout:', JSON.stringify((run.stdout ?? '').trim().slice(0, 400)))

const logText = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
console.log('\n=== log written ===')
console.log(logText === '' ? 'MISSING — helper produced no log' : logText)

const deleted = !existsSync(scriptPath)
console.log('=== self-cleanup ===')
console.log('script deleted itself:', deleted)

// ── 断言 ────────────────────────────────────────────────────────────────────
// 脚本本身不能有语法错误，否则 PowerShell 会直接拒绝执行。
check(run.status === 0, 'helper script exits cleanly', run.status)
check(logText !== '', 'helper wrote a log (proves it really ran)')
check(logText.includes('helper started'), 'helper announced startup')
check(logText.includes('environment cleaned'), 'helper cleared ELECTRON_RUN_AS_NODE before relaunch')
check(/clearing ELECTRON_RUN_AS_NODE=/.test(logText), 'helper logged the clearing step')
check(logText.includes('replacement started'), 'helper relaunched the app')
check(deleted, 'helper deleted its own script')
// 绝不能带 /T：辅助进程自己就在这条进程树里
check(!/taskkill[^\r\n]*\/T\b/.test(logText + source), 'taskkill never uses /T')
check(/Remove-Item Env:ELECTRON_RUN_AS_NODE/.test(source), 'script strips the node-mode variable')
check(/Remove-Item -LiteralPath \$selfPath/.test(source), 'script cleans up via $selfPath')

try { rmSync(logPath, { force: true }) } catch {}
report()
