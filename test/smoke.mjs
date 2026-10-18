// 本地自测：不启动 DSH，直接用一个假的 ctx 跑插件的路由与脚本生成。
import { EventEmitter } from 'node:events'
import { check, equal, report } from './assert.mjs'

const routes = []
const injections = []
const logs = []

function makeCtx() {
  const ctx = new EventEmitter()
  ctx.effect = (fn) => { const d = fn(); return () => { try { typeof d === 'function' && d() } catch {} } }
  ctx.inject = (deps, cb) => {
    const sub = {
      webServer: {
        register(spec) { routes.push(spec); return () => {} },
        protocol: 'http', port: 1,
      },
      effect: ctx.effect,
      on: ctx.on.bind(ctx),
    }
    cb(sub)
  }
  ctx.get = (name) => name === 'connection' ? { requestRejection: () => undefined } : undefined
  ctx.logger = { info: (...a) => logs.push(['info', ...a]), warn: (...a) => logs.push(['warn', ...a]) }
  return ctx
}

function fakeReq(method, url, body) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = {}
  setImmediate(() => {
    if (body !== undefined) req.emit('data', Buffer.from(body))
    req.emit('end')
  })
  return req
}

function fakeRes() {
  return {
    status: 0, headers: null, body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { if (chunk !== undefined) this.body += chunk },
  }
}

const mod = await import(new URL('../src/index.js', import.meta.url).href)
const ctx = makeCtx()
mod.apply(ctx)

console.log('name =', mod.name, '| inject =', JSON.stringify(mod.inject))
console.log('routes registered =', routes.length, '| kind =', routes[0]?.kind, '| path =', routes[0]?.path)

// 注入行：模拟宿主收集一次
const table = []
ctx.emit('webserver/index-inject', table)
ctx.emit('webserver/index-inject', table)
console.log('injection rows =', table.length, '| kind =', table[0]?.kind, '| placement =', table[0]?.placement)
console.log('injection text mentions client.js =', table[0]?.text.includes('/desktop-restart/client.js'))

const handler = routes[0].handler

async function call(method, url, body) {
  const res = fakeRes()
  await handler(fakeReq(method, url, body), res)
  return res
}

let res = await call('GET', '/desktop-restart/client.js')
console.log('client.js ->', res.status, res.headers?.['content-type'], 'bytes =', res.body.length)
console.log('client.js exposes install fn =', res.body.includes('installDesktopRestart'))
console.log('client.js references endpoint =', res.body.includes("'/desktop-restart'"))

res = await call('GET', '/desktop-restart/status')
const status = JSON.parse(res.body)
console.log('status(no id) ->', res.status, JSON.stringify(status))

res = await call('POST', '/desktop-restart/restart', JSON.stringify({ force: true }))
console.log('restart ->', res.status, res.body.slice(0, 120))

res = await call('GET', '/desktop-restart/other')
console.log('unknown method ->', res.status, res.body)

console.log('\nlogs:', logs.map((l) => l.join(' ')).join(' | '))

// ── 断言 ────────────────────────────────────────────────────────────────────
check(mod.name === 'desktop-restart', 'plugin name')
equal(routes.length, 1, 'exactly one route registered')
equal(routes[0]?.kind, 'prefix', 'route kind is prefix')
equal(routes[0]?.path, '/desktop-restart', 'route path')

// 注入行在两次收集里只应出现一次（去重）
equal(table.length, 1, 'injection row deduplicated across collections')
equal(table[0]?.kind, 'script', 'injection row is inline script')
equal(table[0]?.placement, 'body', 'injection row placed in body')
check(table[0]?.text.includes('/desktop-restart/client.js'), 'injection points at client.js')

const script = await call('GET', '/desktop-restart/client.js')
equal(script.status, 200, 'client.js served')
check(String(script.headers?.['content-type']).startsWith('text/javascript'), 'client.js content type')
check(script.body.includes('__dshDesktopRestartInstalled'), 'client.js is executable')
check(script.body.includes('dsh-desktop-restart-button'), 'client.js creates the button')
check(script.body.includes("'/desktop-restart'"), 'client.js knows the endpoint')
// 经典脚本：绝不能出现 ESM 语法，否则浏览器直接 SyntaxError
check(!/(^|\n)\s*export\s/.test(script.body), 'client.js has no export statements')
check(!/(^|\n)\s*import\s/.test(script.body), 'client.js has no import statements')

const probe = await call('GET', '/desktop-restart/status')
equal(probe.status, 200, 'status answers 200')
check(typeof JSON.parse(probe.body).supported === 'boolean', 'status reports a boolean capability')

const restart = await call('POST', '/desktop-restart/restart', JSON.stringify({ force: true }))
equal(restart.status, 503, 'restart refuses when not running inside the desktop app')

const unknown = await call('GET', '/desktop-restart/other')
equal(unknown.status, 404, 'unknown method answers 404')

report()
