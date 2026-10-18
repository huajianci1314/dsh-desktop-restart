/**
 * dsh-desktop-restart — Host 半边。
 *
 * 只做三件事：
 *   1. 认门：只有「DSH 桌面端宿主」这一种进程能真的重启整个应用，别处一律拒绝；
 *   2. 派活：把一个**独立**的 PowerShell 辅助进程拉起来，由它结束 DeepSeek
 *      Harness 的应用进程，再按原可执行文件重新拉起；
 *   3. 出脚本：把浏览器端那段脚本从本包同目录读出来，回给页面。
 *
 * 为什么必须走「独立辅助进程 + 结束应用进程」这条路：
 *
 *   - 插件跑在 Electron 用 ELECTRON_RUN_AS_NODE 拉起的 Host 子进程里，本身没有
 *     `app.relaunch()`；桌面端也没有给插件暴露任何重启 IPC 或服务。
 *   - 只结束 Host 子进程没有意义：Electron 侧会把「子进程意外退出」当成致命错误，
 *     弹恢复对话框，甚至直接退出，而不会自愈成新的一轮启动。
 *   - 所以「重启整个应用」正是用户按这个按钮的本意：配置改过、插件刚装好，都需要
 *     一次干净的整机重启。
 *
 * 安全性：这是杀进程的接口，门开得极小 —— 必须同时满足「宿主由 Electron 以 Node
 * 模式拉起」+「Electron 可执行文件存在」+「确实是桌面端宿主」+ 调用方是本机同源的
 * 已登录页面（webServer 自身的 Host/Origin 栅栏）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { registerClientInjection } from './inject.js'

const name = 'desktop-restart'

/** 路由前缀；Host 与浏览器端脚本共用这一个常量。 */
const ROUTE_BASE = '/desktop-restart'

/** 浏览器端脚本的磁盘位置（与本文件同目录）。 */
const CLIENT_FILE = join(dirname(fileURLToPath(import.meta.url)), 'client.js')

/**
 * 响应写完之后、真正结束应用之前的一点余量由第一段脚本自己控制（它会立刻返回），
 * 这里不再需要近似延时。
 */

/** 任务号 → 结果的保留时长，够页面在重启失败后回读即可。 */
const TASK_RETENTION_MS = 5 * 60_000

/**
 * 辅助进程「一行日志都没写」的容忍上限。
 *
 * 正常的辅助进程 1 秒内就会写下第一行；超过这个时间还没有任何输出，就是它根本没
 * 起来 —— 与其让页面永远转圈，不如明确告诉用户重启没有生效。
 */
const HELPER_START_TIMEOUT_MS = 12_000

/**
 * 辅助进程从派发到收工的总上限。
 *
 * 路径是「关窗口 → taskkill → 等进程退干净 → 拉起新实例」，正常 3～6 秒。放宽到
 * 30 秒是为了容纳杀毒软件或索引服务拖慢的 taskkill，同时保证再慢也会给页面一个
 * 明确的结论，而不是无限“正在重启中”。
 */
const HELPER_TOTAL_TIMEOUT_MS = 30_000

/**
 * 第一段（派发脚本）的同步等待上限。
 *
 * 它只做一次 `Start-Process` 并打印 `dispatched`，正常几十到几百毫秒。给到 10 秒是
 * 为了容纳冷启动的 PowerShell（首包加载、AV 扫描），同时保证请求不会无限挂住。
 */
const LAUNCHER_TIMEOUT_MS = 10_000

/** 本进程里每个任务的最新状态：'pending' | 'failed'。 */
const tasks = new Map()

// ── 环境识别 ─────────────────────────────────────────────────────────────────

/**
 * 判断本进程是不是 DSH 桌面端的宿主，是则返回重启所需的事实。
 *
 * 硬条件（缺一不可）：
 *   - `ELECTRON_RUN_AS_NODE=1`：Electron 以 Node 模式拉起子进程时才会设置；
 *   - `process.execPath` 是 Electron 应用本体，不是 node.exe，且文件确实存在。
 *
 * 再加一条佐证（任一即可），把「碰巧也是 Electron 的别的宿主」挡在外面：
 *   - 入口是 dsh 的 desktop-host（`/dsh-desktop-host/lib/index.js`）；
 *   - 环境里带着桌面端注入的 `DSH_CLIENT_VERSION`；
 *   - 可执行文件名里带 deepseek / dsh。
 *
 * 普通 `dsh web`、终端里的 dsh 都不满足，于是按钮对它们只报「不支持」。
 *
 * @returns {{executable: string, imageName: string, evidence: string[]} | null}
 */
function desktopLauncher() {
  if (process.platform !== 'win32') return null
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null
  const executable = process.execPath
  if (typeof executable !== 'string' || !/\.exe$/iu.test(executable)) return null
  if (/[\\/]node\.exe$/iu.test(executable)) return null
  let exists = false
  try {
    exists = existsSync(executable)
  } catch {
    exists = false
  }
  if (!exists) return null

  const evidence = []
  const entry = process.argv[1] ?? ''
  if (typeof entry === 'string' && /[\\/]dsh-desktop-host[\\/]/u.test(entry)) evidence.push('desktop-host-entry')
  if ((process.env.DSH_CLIENT_VERSION ?? '') !== '') evidence.push('client-version-env')
  const imageName = basename(executable)
  if (/deepseek|dsh/iu.test(imageName)) evidence.push('image-name')
  if (evidence.length === 0) return null

  return { executable, imageName, evidence }
}

// ── HTTP 小工具 ───────────────────────────────────────────────────────────────

function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  response.end(text)
}

/**
 * 复用 Connection 服务的 Host/Origin 栅栏与登录校验。
 *
 * webServer 的契约是「路由自己负责请求策略」，省掉它就是开了个匿名杀进程的接口。
 * 栅栏缺失或抛错时一律失败关闭。
 */
function rejectUnauthenticated(ctx, request) {
  const connection = ctx.get('connection')
  if (connection === undefined || connection === null) return 401
  if (typeof connection.requestRejection !== 'function') return 401
  try {
    const rejection = connection.requestRejection({ headers: request.headers })
    return rejection === 401 || rejection === 403 ? rejection : undefined
  } catch {
    return 403
  }
}

async function readBody(request) {
  return new Promise((resolve, reject) => {
    let text = ''
    request.on('data', (chunk) => {
      text += chunk
      if (text.length > 1e5) {
        request.destroy()
        reject(new Error('request body too large'))
      }
    })
    request.on('end', () => resolve(text))
    request.on('error', reject)
    request.on('aborted', () => reject(new Error('aborted')))
  })
}

// ── 辅助进程脚本 ──────────────────────────────────────────────────────────────

/** PowerShell 单引号字面量：只有单引号本身需要写两遍。 */
function psLiteral(text) {
  return `'${String(text).replace(/'/gu, "''")}'`
}

/**
 * 剥掉会让 Electron 以 Node 模式运行的环境变量，得到一份「能正常启动桌面端」的环境。
 *
 * `ELECTRON_RUN_AS_NODE` 是桌面端为了把 Host 当 Node 子进程跑而设置的；它一旦遗传到
 * 最终那次 `Start-Process`，`DeepSeek Harness.exe` 就会被当成 node 解释器启动：
 * 不建窗口、不初始化 app，解析完参数立刻退出。用户看到的现象正是「关掉了但没重启」。
 *
 * 同时清掉 `ELECTRON_NO_ATTACH_CONSOLE` 之类的伴随标记，避免把 Node 模式的其他副作用
 * 一起带过去。
 *
 * @returns {NodeJS.ProcessEnv} 一份去掉相关变量的环境副本。
 */
function cleanLaunchEnvironment() {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key]
  }
  delete env.ELECTRON_NO_ATTACH_CONSOLE
  return env
}

/**
 * 第一段：把真正干活的脚本重挂成一个**完全独立**的隐藏进程，然后立刻返回。
 *
 * 这一段由 Host 同步调用，必须在几百毫秒内结束，否则会拖住「重启」请求的收尾。
 * 它自己什么也不杀，只做 `Start-Process`，所以父进程随后被杀也不影响第二段。
 *
 * 输出 `dispatched` 是给 Node 侧的成功信号：只有亲眼看到它，才敢对用户说「已经派发」。
 *
 * @param {{workerPath: string, logPath: string}} paths - 第二段脚本与日志路径。
 * @returns {string} 脚本正文（CRLF）。
 */
function launcherScript({ workerPath, logPath }) {
  const log = psLiteral(logPath)
  // Start-Process 的 -ArgumentList 是一个**字符串数组**，每项不再自动加引号，
  // 所以路径带空格时必须自己包上引号，否则 PowerShell 会把路径从空格处截断。
  const workerArg = psLiteral(`-File "${workerPath}"`)
  return [
    '$ErrorActionPreference = "Stop"',
    `$log = ${log}`,
    'try {',
    `  Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',${workerArg}) -WindowStyle Hidden -ErrorAction Stop | Out-Null`,
    '  Write-Output "dispatched"',
    '} catch {',
    '  try { Add-Content -LiteralPath $log -Value ("launcher failed: " + $_.Exception.Message) } catch {}',
    '  Write-Error $_.Exception.Message',
    '  exit 1',
    '}',
  ].join('\r\n')
}

/**
 * 第二段：真正执行重启的脚本。
 *
 * 顺序是有讲究的：
 *   1. **先礼貌关闭**主窗口 —— 桌面端可能正弹着模态框，硬杀会留下半截状态；
 *   2. **再按映像名强杀，但绝不带 /T** —— 关键细节。辅助进程是「Electron → Host →
 *      powershell」这条链上的孙进程；`/T` 会连它一起杀掉，于是重启就再也没人做了。
 *      按映像名杀（`/IM`）只命中 DeepSeek Harness 自己的进程（主进程、渲染进程、
 *      Host 子进程都叫这个映像名），辅助进程本身是 powershell.exe，安全。
 *   3. 等旧实例真的退干净 —— 桌面端是单实例锁，旧的主进程还活着时，新实例只会把
 *      窗口唤到前台然后退出。
 *   4. 用原可执行文件重新拉起（不带额外参数：桌面端正常启动就是无参）。
 *
 * 每一步都往 $log 追加一行。这份日志是**唯一**的事后证据：杀掉自己宿主之后，本进程
 * 已经没有任何机会记录发生了什么，而「脚本没起来」和「脚本起来了但 taskkill 失败」
 * 是两种症状一样的完全不同故障。
 *
 * @param {{executable: string, imageName: string, logPath: string}} app - 应用可执行文件、映像名与日志路径。
 * @returns {string} 脚本正文（CRLF）。
 */
function installerScript({ executable, imageName, logPath }) {
  const processName = imageName.replace(/\.exe$/iu, '')
  const log = psLiteral(logPath)
  return [
    '$ErrorActionPreference = "SilentlyContinue"',
    // 自己的路径要在任何可能改变位置的操作之前取好：`$PSCommandPath` 在
    // `-File` 启动下可用，但脚本被重挂或环境异常时可能为空，所以留 $MyInvocation
    // 作为兜底，否则结尾的自我删除会静默失败、在临时目录里堆文件。
    '$selfPath = $PSCommandPath',
    'if (-not $selfPath) { $selfPath = $MyInvocation.MyCommand.Path }',
    `$log = ${log}`,
    '$note = { param($m) try { Add-Content -LiteralPath $log -Value ((Get-Date -Format "HH:mm:ss.fff") + " " + $m) } catch {} }',
    `$exe = ${psLiteral(executable)}`,
    `$processName = ${psLiteral(processName)}`,
    '& $note "helper started (pid $PID)"',
    'Get-Process -Name $processName | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }',
    '& $note "asked windows to close"',
    'Start-Sleep -Milliseconds 500',
    // 不带 /T：辅助进程自己就在这条进程树里，带 /T 会把自己杀掉。
    '& $note "taskkill by image"',
    'taskkill.exe /IM "$processName.exe" /F | Out-Null',
    'if ($LASTEXITCODE -ne 0) { & $note ("taskkill exit " + $LASTEXITCODE) }',
    'for ($i = 0; $i -lt 80; $i++) {',
    '  $alive = @(Get-Process -Name $processName -ErrorAction SilentlyContinue)',
    '  if ($alive.Count -eq 0) { & $note "all app processes gone"; break }',
    '  foreach ($p in $alive) { try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {} }',
    '  Start-Sleep -Milliseconds 200',
    '}',
    'Start-Sleep -Milliseconds 200',
    '& $note "starting replacement"',
    // 关键：拉起前必须清掉 ELECTRON_RUN_AS_NODE。
    //
    // 这个辅助进程的整条环境都继承自 Host，而 Host 正是桌面端用
    // `ELECTRON_RUN_AS_NODE=1`（Node 模式）拉起的子进程。带着它启动
    // `DeepSeek Harness.exe`，Electron 会把自己当成 Node 解释器：不建窗口、
    // 不初始化 app，解析完参数就退出（实测打印 node 版本号后 49ms 返回）。
    // 症状正是「应用关掉了，但没有重新启动」。
    //
    // PowerShell 的 Start-Process 用**当前进程环境**创建子进程，所以先从本进程
    // 的 Env: 盘符里删掉就够了 —— 这里还留了日志，方便事后确认清理是否发生在
    // 拉起之前。
    'if (Test-Path Env:ELECTRON_RUN_AS_NODE) { & $note ("clearing ELECTRON_RUN_AS_NODE=" + $env:ELECTRON_RUN_AS_NODE) }',
    'Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue',
    'Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue',
    'if (Test-Path Env:ELECTRON_RUN_AS_NODE) { & $note "WARNING: variable still present" } else { & $note "environment cleaned" }',
    'try { Start-Process -FilePath $exe -WorkingDirectory (Split-Path -Parent $exe) -ErrorAction Stop | Out-Null; & $note "replacement started" } catch { & $note ("start failed: " + $_.Exception.Message) }',
    'Start-Sleep -Milliseconds 2000',
    '& $note "helper exiting"',
    'if ($selfPath) { Remove-Item -LiteralPath $selfPath -Force -ErrorAction SilentlyContinue }',
  ].join('\r\n')
}

/**
 * 派一个辅助进程去完成重启。
 *
 * 这里刻意**同步**启动（`spawnSync`），而不是异步 spawn + unref：
 *
 *   - Host 进程马上就会被自己的辅助脚本用 `taskkill /IM` 杀掉。异步 spawn 的
 *     PowerShell 尚未完成初始化时父进程就没了，Windows 会连带把它收走 —— 实测症状
 *     正是「.ps1 留在临时目录里、一行日志都没有」，即脚本从未执行。
 *   - `cmd /c start /b` 反而更糟：它继承了父进程的 stdio 管道，`start` 返回后管道
 *     仍未关闭，spawnSync 会一路等到超时（实测 ETIMEDOUT）。
 *   - 同步等待 PowerShell「完成派发并自己脱离」这段时间（脚本里先 sleep 再杀应用，
 *     用 `$arg` 控制）是安全的：脚本第一步就把自己重挂到一个新的分离进程上。
 *
 * 因此脚本采用两段式：**第一段（同步跑完、立刻返回）**只负责生成并派发第二段
 * （真正干活的那段，`Start-Process -WindowStyle Hidden` 独立运行），然后打印
 * `dispatched`。这样本函数能在几百毫秒内返回，而第二段一定活到了应用被杀之后。
 *
 * @param {{executable: string, imageName: string}} app - 应用可执行文件与映像名。
 * @returns {{scriptPath: string, logPath: string, spawnError: string | null, dispatched: boolean}}
 */
function armRestart(app) {
  const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`
  const workerPath = join(tmpdir(), `dsh-desktop-restart-${stamp}-worker.ps1`)
  const launcherPath = join(tmpdir(), `dsh-desktop-restart-${stamp}.ps1`)
  const logPath = join(tmpdir(), `dsh-desktop-restart-${stamp}.log`)

  writeFileSync(workerPath, installerScript({ ...app, logPath }), 'utf8')
  writeFileSync(launcherPath, launcherScript({ workerPath, logPath }), 'utf8')

  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  let spawnError = null
  let dispatched = false
  try {
    const child = spawnSync(
      powershell,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', launcherPath],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: LAUNCHER_TIMEOUT_MS,
        // 关键：从这里开始就不再带 ELECTRON_RUN_AS_NODE。
        //
        // Host 自己是被桌面端以 Node 模式（ELECTRON_RUN_AS_NODE=1）拉起来的，这个
        // 变量会一路遗传给辅助进程，最后落到「重新拉起应用」那一步：Electron 见到它
        // 就把自己当 node 解释器，不建窗口、解析完参数直接退出 —— 症状就是「应用关掉
        // 了，但没有重新启动」。在派发源头剥掉它，整条链就都干净了。
        env: cleanLaunchEnvironment(),
      },
    )
    if (child.error !== undefined && child.error !== null) {
      spawnError = String(child.error.message ?? child.error)
    } else if ((child.stdout ?? '').includes('dispatched')) {
      dispatched = true
    } else {
      const detail = (child.stderr ?? '').trim() || (child.stdout ?? '').trim()
      spawnError = detail === '' ? `launcher exited with ${String(child.status)}` : detail
    }
  } catch (error) {
    spawnError = String(error?.message ?? error)
  }
  return { scriptPath: launcherPath, workerPath, logPath, spawnError, dispatched }
}

// ── 任务表 ───────────────────────────────────────────────────────────────────

function pruneTasks(now) {
  for (const [id, entry] of tasks) {
    if (now - entry.at > TASK_RETENTION_MS) tasks.delete(id)
  }
}

function recordTask(id, patch) {
  const previous = tasks.get(id)
  if (previous === undefined) return
  tasks.set(id, { ...previous, ...patch, at: Date.now() })
}

// ── 插件入口 ─────────────────────────────────────────────────────────────────

export function apply(ctx) {
  // 第一件事就登记注入行：桌面端在宿主启动时把注入表收集一次并交给渲染层，
  // 订阅晚于那次收集，按钮就永远进不了页面。
  ctx.effect(
    () => registerClientInjection(ctx),
    'desktop-restart: index injection',
  )

  // 路由跟着 webServer 走：服务被替换时注册也一起重来，而不是指向旧服务。
  ctx.inject(['webServer'], (sub) => {
    sub.effect(() => sub.webServer.register({
      kind: 'prefix',
      path: ROUTE_BASE,
      handler: async (request, response) => {
        const unauthorised = rejectUnauthenticated(ctx, request)
        if (unauthorised !== undefined) {
          sendJson(response, unauthorised, { ok: false, error: 'unauthenticated request' })
          return
        }

        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const method = url.pathname === ROUTE_BASE || url.pathname === `${ROUTE_BASE}/`
          ? ''
          : url.pathname.startsWith(`${ROUTE_BASE}/`) ? url.pathname.slice(ROUTE_BASE.length + 1) : null

        // GET /desktop-restart/client.js —— 浏览器端脚本本体。
        if (method === 'client.js' && (request.method === 'GET' || request.method === 'HEAD')) {
          let source
          try {
            source = readFileSync(CLIENT_FILE, 'utf8')
          } catch (error) {
            sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
            return
          }
          response.writeHead(200, {
            'content-type': 'text/javascript; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(source),
          })
          response.end(request.method === 'HEAD' ? undefined : source)
          return
        }

        // GET /desktop-restart/status?id=… —— 页面发出重启后轮询它。
        if (method === 'status' && request.method === 'GET') {
          const id = url.searchParams.get('id') ?? ''
          if (id === '') {
            const launcher = desktopLauncher()
            sendJson(response, 200, {
              ok: true,
              supported: launcher !== null,
              platform: process.platform,
              imageName: launcher?.imageName ?? null,
              evidence: launcher?.evidence ?? [],
            })
            return
          }
          const entry = tasks.get(id)
          sendJson(response, 200, entry === undefined
            ? { ok: true, state: 'unknown' }
            : { ok: true, state: entry.state, ...(entry.detail === undefined ? {} : { detail: entry.detail }) })
          return
        }

        // POST /desktop-restart/restart —— 真正的重启。
        if (method === 'restart' && request.method === 'POST') {
          const launcher = desktopLauncher()
          if (launcher === null) {
            sendJson(response, 503, {
              ok: false,
              error: 'restart is only available inside the DeepSeek Harness desktop app',
            })
            return
          }
          let body = {}
          try {
            const text = await readBody(request)
            if (text !== '') body = JSON.parse(text)
          } catch {
            sendJson(response, 400, { ok: false, error: 'bad json body' })
            return
          }
          const now = Date.now()
          pruneTasks(now)
          const id = randomUUID()
          tasks.set(id, { state: 'pending', at: now, force: body?.force === true })

          // 先派发，再回话。
          //
          // 早先的写法是「先回 202，再异步派发」：一旦派发失败，页面已经收到成功，
          // 只能靠后面的轮询发现 —— 而 Host 这时还活着，用户看到的就是无限
          // 「正在重启中」。派发本身只有几百毫秒（第一段脚本立刻返回），先做完再
          // 回话，失败就能当场用 500 + 原因讲清楚。
          const armed = (() => {
            try {
              return { ok: true, ...armRestart(launcher) }
            } catch (error) {
              return { ok: false, error: String(error?.message ?? error) }
            }
          })()

          if (armed.ok !== true) {
            recordTask(id, { state: 'failed', detail: armed.error })
            ctx.logger?.warn?.('desktop-restart: 无法派出重启辅助进程：%s', armed.error)
            sendJson(response, 500, { ok: false, taskId: id, error: armed.error })
            return
          }
          if (armed.spawnError !== null || armed.dispatched !== true) {
            const detail = armed.spawnError ?? 'the restart launcher did not report a dispatch'
            recordTask(id, { state: 'failed', detail })
            ctx.logger?.warn?.('desktop-restart: 辅助进程派发失败：%s', detail)
            sendJson(response, 500, { ok: false, taskId: id, error: detail })
            return
          }

          recordTask(id, { detail: { script: armed.scriptPath, log: armed.logPath } })
          ctx.logger?.warn?.('desktop-restart: 已派出重启辅助进程，日志 %s', armed.logPath)
          sendJson(response, 202, { ok: true, taskId: id })
          // 辅助进程每走一步都会往日志里写一行。若本进程还能活着读日志，说明它没能
          // 结束应用 —— 与其让页面无限等待，不如把真实进度回报给页面。
          const watchdog = setInterval(() => {
            const entry = tasks.get(id)
            if (entry === undefined || entry.state !== 'pending') {
              clearInterval(watchdog)
              return
            }
            let tail = ''
            try {
              tail = readFileSync(armed.logPath, 'utf8')
            } catch {
              tail = ''
            }
            if (tail === '') {
              // 脚本一行都没写：辅助进程根本没起来。
              if (Date.now() - now > HELPER_START_TIMEOUT_MS) {
                clearInterval(watchdog)
                recordTask(id, {
                  state: 'failed',
                  detail: 'the restart helper never started',
                })
              }
              return
            }
            if (/helper exiting/u.test(tail)) {
              clearInterval(watchdog)
              recordTask(id, { state: 'completed', detail: tail.trim() })
              return
            }
            // 有日志但迟迟不结束：把最后一行带上，让页面能说出卡在哪。
            if (Date.now() - now > HELPER_TOTAL_TIMEOUT_MS) {
              clearInterval(watchdog)
              const last = tail.trim().split(/\r?\n/u).pop() ?? ''
              recordTask(id, { state: 'failed', detail: `restart helper stalled: ${last}` })
            }
          }, 500)
          watchdog.unref?.()
          return
        }

        sendJson(response, 404, { ok: false, error: 'unknown desktop-restart method' })
      },
    }), 'desktop-restart: routes')
  })

  ctx.logger?.info?.('desktop-restart: routes mounted at %s', ROUTE_BASE)
}

export { name }
export const inject = []

// 供本地自测读取生成的脚本文本；不属于插件对外契约。
export const __testing = { installerScript, desktopLauncher }
