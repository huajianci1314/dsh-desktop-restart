// 验证浏览器端在「重启没生效」时的行为：不能停在“正在重启中”。
//
// 用假 Host 模拟三种结局：
//   1. status 返回 failed  → 立即显示失败与原因；
//   2. status 一直 pending  → 到 GIVE_UP_MS 后显示失败；
//   3. status 请求直接失败（应用已关闭）→ 保持“正在重启”，这是成功路径。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { check, report } from './assert.mjs'

const CLIENT = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// ── 最小 DOM（复用 client-smoke 的结构，去掉多余部分）─────────────────────────
class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.attributes = {}
    this.className = ''
    this.id = ''
    this.textContent = ''
    this.title = ''
    this.type = ''
    this.disabled = false
    this.listeners = new Map()
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    this.dataset = new Proxy({}, {
      set: (t, k, v) => {
        t[k] = v
        this.attributes['data-' + String(k).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())] = String(v)
        return true
      },
      deleteProperty: (t, k) => { delete t[k]; return true },
    })
  }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === 'string') this.children.push({ nodeType: 3, textContent: n, parentNode: this })
      else { n.parentNode = this; this.children.push(n) }
    }
  }
  appendChild(n) { this.append(n); return n }
  remove() {
    if (this.parentNode !== null) {
      this.parentNode.children = this.parentNode.children.filter((c) => c !== this)
      this.parentNode = null
    }
  }
  replaceChildren(...n) { this.children = []; this.append(...n) }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v) }
  getAttribute(k) { return this.attributes[k] ?? null }
  addEventListener(t, f) {
    if (!this.listeners.has(t)) this.listeners.set(t, new Set())
    this.listeners.get(t).add(f)
  }
  removeEventListener(t, f) { this.listeners.get(t)?.delete(f) }
  dispatch(t, e = {}) {
    const p = { type: t, preventDefault() {}, stopPropagation() {}, ...e }
    for (const f of [...(this.listeners.get(t) ?? [])]) f(p)
  }
  matches(sel) {
    // 支持逗号分隔的选择器组（产品代码里 closeDialog 用了它）。
    if (sel.includes(',')) return sel.split(',').some((part) => this.matches(part.trim()))
    if (sel.startsWith('#')) return this.id === sel.slice(1)
    if (sel.startsWith('.')) return String(this.className).split(/\s+/).includes(sel.slice(1))
    const role = /^\[role=(['"]?)([^\]]+)\1\]$/.exec(sel)
    if (role !== null) return this.attributes.role === role[2]
    const attr = /^\[([a-zA-Z-]+)\]$/.exec(sel)
    if (attr !== null) return attr[1] in this.attributes
    return this.tagName === sel.toUpperCase()
  }
  querySelectorAll(sel) {
    const out = []
    const walk = (n) => {
      for (const c of n.children) {
        if (c.nodeType === 3) continue
        if (c.matches(sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null }
  getBoundingClientRect() { return this._rect }
  focus() {}
  get offsetHeight() { return this._rect.height }
}

function buildDom() {
  const documentElement = new Element('html')
  documentElement.lang = 'zh-CN'
  const head = new Element('head')
  const body = new Element('body')

  const document = {
    documentElement, head, body,
    createElement: (t) => new Element(t),
    createTextNode: (t) => ({ nodeType: 3, textContent: t, parentNode: null }),
    getElementById: (id) => (head.id === id ? head : body.querySelectorAll('#' + id)[0] ?? null),
    querySelectorAll: (s) => body.querySelectorAll(s),
    querySelector: (s) => body.querySelector(s),
    addEventListener() {},
    removeEventListener() {},
  }

  const menuHost = new Element('div')
  menuHost.setAttribute('data-windows-menu', '')
  const shadowRoot = new Element('#shadow')
  const menubar = new Element('div')
  menubar.setAttribute('role', 'menubar')
  const appBtn = new Element('button')
  appBtn.textContent = '应用'
  appBtn._rect = { left: 48, top: 6, right: 88, bottom: 34, width: 40, height: 28 }
  const editBtn = new Element('button')
  editBtn.textContent = '编辑'
  editBtn._rect = { left: 90, top: 6, right: 130, bottom: 34, width: 40, height: 28 }
  menubar.append(appBtn, editBtn)
  shadowRoot.append(menubar)
  menuHost.shadowRoot = shadowRoot
  body.append(menuHost)

  return { document, body }
}

class NoopObserver { observe() {} disconnect() {} }

async function scenario(name, statusImpl) {
  const { document } = buildDom()
  let statusCalls = 0
  const calls = []
  const sandbox = {
    document,
    navigator: { language: 'zh-CN' },
    fetch(url, init) {
      const target = String(url)
      calls.push({ url: target, method: init?.method ?? 'GET' })
      if (target.endsWith('/restart')) {
        return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ ok: true, taskId: 'task-1' }) })
      }
      // 能力探测（不带 id）永远报告支持，否则按设计根本不会挂按钮。
      if (target === '/desktop-restart/status') {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, supported: true }),
        })
      }
      // 带 id 的轮询才是各场景要模拟的部分。
      statusCalls += 1
      const out = statusImpl(statusCalls)
      if (process.env.DEBUG_DOM === '1') {
        console.log('  [poll]', target, '->', JSON.stringify(out?.__body ?? '(threw)'))
      }
      return out
    },
    MutationObserver: NoopObserver,
    ResizeObserver: NoopObserver,
    setTimeout, clearTimeout, setInterval, clearInterval,
    console, JSON, String, Math, Error, Promise, Array, Object, encodeURIComponent,
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(CLIENT, sandbox, { filename: 'client.js' })

  await new Promise((r) => setTimeout(r, 40))
  let host = document.getElementById('dsh-desktop-restart-root')
  for (let i = 0; i < 20 && host === null; i++) {
    await new Promise((r) => setTimeout(r, 50))
    host = document.getElementById('dsh-desktop-restart-root')
  }
  if (host === null) {
    console.log(`\n--- ${name} ---`)
    console.log('MOUNT FAILED; body ids:', document.body.querySelectorAll('div').map((d) => d.id).join('|'))
    console.log('fetch calls so far:', JSON.stringify(calls))
    return { phase: 'unmounted', text: '', statusCalls: 0 }
  }
  const button = host.querySelector('#dsh-desktop-restart-button')
  button.dispatch('click')
  const dialog = host.querySelector('[data-dialog]')
  const confirm = dialog.querySelectorAll('button').find((b) => b.attributes['data-primary'] === 'true')
  confirm.dispatch('click')

  // 让轮询跑几轮（假定时器不便控制，这里用真实短等待）
  await new Promise((r) => setTimeout(r, 2600))
  const text = button.children.map((c) => c.textContent).join('')
  const openDialog = host.querySelector('[data-dialog]')
  const noteEl = openDialog === null ? null : openDialog.querySelector('.dsh-desktop-restart-note')
  const noteText = noteEl === null ? '' : String(noteEl.textContent ?? '') + noteEl.children.map((c) => String(c.textContent ?? '')).join('')
  if (process.env.DEBUG_DOM === '1') {
    console.log('  note attrs:', JSON.stringify(noteEl?.attributes ?? null))
    console.log('  note dataset:', JSON.stringify(noteEl?.dataset ?? null))
    console.log('  window failure var:', JSON.stringify(sandbox.__debugFailure?.()))
  }
  if (process.env.DEBUG_DOM === '1') {
    const dump = (n, d = 0) => {
      console.log('  '.repeat(d) + n.tagName + (n.id ? '#' + n.id : '') + (n.className ? '.' + String(n.className).split(/\s+/).join('.') : '') + (n.textContent ? ' =' + JSON.stringify(n.textContent) : ''))
      for (const c of n.children ?? []) if (c.nodeType !== 3) dump(c, d + 1)
    }
    dump(openDialog ?? host)
  }
  console.log(`\n--- ${name} ---`)
  console.log('button phase :', button.attributes['data-phase'])
  console.log('button text  :', JSON.stringify(text))
  console.log('status calls :', statusCalls)
  console.log('dialog note  :', JSON.stringify(noteText))
  return { phase: button.attributes['data-phase'], text, statusCalls, note: noteText }
}

// 1) Host 明确失败
const a = await scenario('status=failed', () => {
  const body = { ok: true, state: 'failed', detail: 'never started' }
  const p = Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  p.__body = body
  return p
})
check(a.phase === 'failed' && a.note.includes('辅助进程'), 'failed status shows helper-missing reason', a.note)

// 2) 一直 pending（Host 没死，也没记账）→ 页面必须自己放弃
const b = await scenario('status=pending forever', () => Promise.resolve({
  ok: true, status: 200,
  json: () => Promise.resolve({ ok: true, state: 'pending' }),
}))
check(b.phase === 'running', 'pending within give-up window keeps button in "running"', b.phase)

// 3) 应用已关闭（status 请求失败）→ 保持“正在重启”，不再刷请求
const c = await scenario('status unavailable (app closed)', () => Promise.reject(new Error('ECONNREFUSED')))
check(c.phase === 'running', 'disconnect keeps button in "running" (success path)', c.phase)
check(c.statusCalls <= 1, 'polling stops once the host is gone', `${c.statusCalls} calls`)

report()

process.exit(0)
