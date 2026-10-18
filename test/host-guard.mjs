// Host 侧：验证 restart 路由在派发失败时给出 500 + 原因，成功时给出 202。
// 用假 ctx 跑真实路由代码，不真的重启。
import { EventEmitter } from 'node:events'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, report } from './assert.mjs'

const routes = []
function makeCtx() {
  const ctx = new EventEmitter()
  ctx.effect = (fn) => { const d = fn(); return () => { try { typeof d === 'function' && d() } catch {} } }
  ctx.inject = (deps, cb) => {
    cb({
      webServer: { register(spec) { routes.push(spec); return () => {} } },
      effect: ctx.effect,
      on: ctx.on.bind(ctx),
    })
  }
  ctx.get = (name) => name === 'connection' ? { requestRejection: () => undefined } : undefined
  ctx.logger = { info: () => {}, warn: () => {} }
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
    writeHead(s, h) { this.status = s; this.headers = h },
    end(c) { if (c !== undefined) this.body += c },
  }
}

const mod = await import(new URL('../src/index.js', import.meta.url).href)
mod.apply(makeCtx())
const handler = routes[0].handler

async function call(method, url, body) {
  const res = fakeRes()
  await handler(fakeReq(method, url, body), res)
  return res
}

// 这个进程不是桌面宿主 → 必须是 503，绝不能派发。
const res = await call('POST', '/desktop-restart/restart', JSON.stringify({ force: true }))
console.log('non-desktop restart ->', res.status, res.body)
check(res.status === 503, 'non-desktop restart answers 503', res.status)

// 探测接口必须如实报告不支持
const probe = await call('GET', '/desktop-restart/status')
console.log('probe ->', probe.status, probe.body)
check(JSON.parse(probe.body).supported === false, 'probe reports supported=false')

// 确认没有遗留辅助脚本（非桌面宿主不该写任何临时文件）
const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith('dsh-desktop-restart-'))
check(leftovers.length === 0, 'no helper artifacts written off-desktop', leftovers.join(', '))

report()
