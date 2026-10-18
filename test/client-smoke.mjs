// 端到端冒烟：用一个最小 DOM 桩把 client.js 真跑一遍。
//
// 目标不是完整浏览器，而是把最容易错的地方跑出来：
//   - 经典脚本能在没有 module 的上下文里执行（不能有 export/import）；
//   - 能从 shadow root 里认出「编辑」按钮并把自绘按钮定位到它右边；
//   - 点击 → 出现确认框；确认 → 发出 POST /desktop-restart/restart；
//   - 宿主「不是桌面端」时不挂按钮。
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { check, equal, report } from './assert.mjs'

const CLIENT = readFileSync(new URL('../src/client.js', import.meta.url), 'utf8')

// ── 最小 DOM ────────────────────────────────────────────────────────────────

class ClassList {
  constructor(node) { this.node = node }
  add(name) { const s = new Set(this.node.className.split(' ').filter(Boolean)); s.add(name); this.node.className = [...s].join(' ') }
}

class Element {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this.dataset = {}
    this.attributes = {}
    this.className = ''
    this.id = ''
    this.textContent = ''
    this.title = ''
    this.type = ''
    this.disabled = false
    this.listeners = new Map()
    this.classList = new ClassList(this)
    this._rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    // dataset 与 attributes 保持同步：浏览器里 dataset 就是 data-* 属性的视图。
    this.dataset = new Proxy({}, {
      set: (target, key, value) => {
        target[key] = value
        this.attributes['data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())] = String(value)
        return true
      },
      deleteProperty: (target, key) => {
        delete target[key]
        delete this.attributes['data-' + String(key).replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())]
        return true
      },
    })
  }
  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.children.push({ nodeType: 3, textContent: node, parentNode: this })
      } else {
        node.parentNode = this
        this.children.push(node)
      }
    }
  }
  appendChild(node) { this.append(node); return node }
  remove() {
    if (this.parentNode !== null) {
      this.parentNode.children = this.parentNode.children.filter((child) => child !== this)
      this.parentNode = null
    }
  }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes) }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value) }
  getAttribute(name) { return this.attributes[name] ?? null }
  removeAttribute(name) { delete this.attributes[name] }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn) }
  dispatch(type, event = {}) {
    const payload = { type, preventDefault() {}, stopPropagation() {}, ...event }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(payload)
  }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1)
    const roleMatch = /^\[role=(['"]?)([^\]]+)\1\]$/.exec(selector)
    if (roleMatch !== null) return this.attributes.role === roleMatch[2]
    const attrMatch = /^\[([a-zA-Z-]+)\]$/.exec(selector)
    if (attrMatch !== null) return attrMatch[1] in this.attributes
    return this.tagName === selector.toUpperCase()
  }
  querySelectorAll(selector) {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.nodeType === 3) continue
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
  getBoundingClientRect() { return this._rect }
  focus() {}
  get offsetHeight() { return this._rect.height }
}

const documentElement = new Element('html')
documentElement.lang = 'zh-CN'
const head = new Element('head')
const body = new Element('body')

const document = {
  documentElement,
  head,
  body,
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => ({ nodeType: 3, textContent: text, parentNode: null }),
  getElementById: (id) => (head.id === id ? head : body.querySelectorAll('#' + id)[0] ?? null),
  querySelectorAll: (selector) => body.querySelectorAll(selector),
  querySelector: (selector) => body.querySelector(selector),
  addEventListener() {},
  removeEventListener() {},
}

// 桌面端那条 shadow 菜单栏：宿主 → shadowRoot → [role=menubar] → two buttons
const menuHost = new Element('div')
menuHost.setAttribute('data-windows-menu', '')
menuHost.dataset.windowsMenu = ''
const shadowRoot = new Element('#shadow-root')
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

// ── 桩：fetch / 观察者 ──────────────────────────────────────────────────────

const calls = []
function fetchStub(url, init) {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body })
  if (String(url).endsWith('/status')) {
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, supported: true }) })
  }
  return Promise.resolve({ ok: true, status: 202, json: () => Promise.resolve({ ok: true }) })
}

class NoopObserver {
  observe() {}
  disconnect() {}
}

const sandbox = {
  window: {},
  document,
  navigator: { language: 'zh-CN' },
  fetch: fetchStub,
  MutationObserver: NoopObserver,
  ResizeObserver: NoopObserver,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  console,
  JSON,
  String,
  Math,
  Error,
  Promise,
  Array,
  Object,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

vm.createContext(sandbox)
vm.runInContext(CLIENT, sandbox, { filename: 'client.js' })

// 让 probe() 的 promise 链走完
await new Promise((resolve) => setTimeout(resolve, 60))

var host = document.getElementById('dsh-desktop-restart-root')
if (host === null) {
  const roots = body.querySelectorAll('#dsh-desktop-restart-root')
  console.log('debug body children:', body.children.map((c) => c.tagName + '#' + c.id).join(','))
  console.log('debug all ids:', body.querySelectorAll('div').map((c) => c.id).join('|'))
  host = roots[0] ?? null
}
console.log('menuHost attrs           :', JSON.stringify(menuHost.attributes))
console.log('shadow bar role          :', menubar.attributes.role, '| buttons:', menubar.children.length)
console.log('button host mounted      :', host !== null)
console.log('host ready               :', host?.dataset.ready)
console.log('host left (edit.right+2) :', host?.style.left, '(expect 132px)')
console.log('host top                 :', host?.style.top)
console.log('probe called /status     :', calls.some((c) => c.url === '/desktop-restart/status'))

const button = host.querySelector('#dsh-desktop-restart-button')
// 点击会把按钮切成「正在重启…」，所以初始文案要在点之前记下来。
const labelBeforeClick = button.children.map((c) => c.textContent).join('')
console.log('button text              :', JSON.stringify(labelBeforeClick))
console.log('button title             :', JSON.stringify(button.title))

// 点一下 → 确认框
button.dispatch('click')
const dialog = host.querySelector('[data-dialog]')
console.log('dialog opened            :', dialog !== null)
console.log('dialog heading           :', JSON.stringify(dialog.querySelector('h2').textContent))

// 点确认 → POST
const confirm = dialog.querySelectorAll('button').find((b) => b.dataset.primary === 'true')
confirm.dispatch('click')
await new Promise((resolve) => setTimeout(resolve, 60))
const post = calls.find((c) => c.method === 'POST')
console.log('POST restart             :', post?.url, post?.body)
console.log('button phase after POST  :', button.dataset.phase)
console.log('button text after POST   :', JSON.stringify(button.children.map((c) => c.textContent).join('')))

// ── 断言 ────────────────────────────────────────────────────────────────────
check(host !== null, 'button host mounted into the page')
equal(host?.dataset.ready, 'true', 'host is positioned and visible')
// 「编辑」右边缘是 130，加 2px 间距
equal(host?.style.left, '132px', 'button sits right of the Edit menu')
equal(host?.style.top, '6px', 'button is vertically centred on the menu')
check(calls.some((c) => c.url === '/desktop-restart/status'), 'capability probe ran')
equal(labelBeforeClick, '重启', 'button label is localised')
check(dialog !== null, 'click opens the confirm dialog')
equal(dialog?.querySelector('h2')?.textContent, '重启 DeepSeek Harness？', 'dialog heading')
equal(post?.url, '/desktop-restart/restart', 'confirm posts to the restart route')
equal(JSON.parse(post?.body ?? '{}').force, true, 'request carries force')
equal(button.dataset.phase, 'running', 'button switches to running')
equal(button.children.map((c) => c.textContent).join(''), '正在重启…', 'button shows progress copy')

report()
process.exit(process.exitCode ?? 0)
