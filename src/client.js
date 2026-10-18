// 浏览器端：把「重启」按进桌面端左上角那条标题栏菜单里。
//
// 这是一个**经典脚本**（不是 ES module）：桌面端由注入行自己建 <script> 加载它，
// 所以没有 export，整体包在 IIFE 里。
//
// 目标不是 DSH 页面的东西，而是桌面端 preload 在 document.body 上挂的一个 shadow
// root（`<div data-windows-menu>`，里面 [role=menubar] 的两个按钮依次是「应用」与
// 「编辑」）。样式都封在 shadow root 里，页面碰不到；插件也没有任何正式入口能在
// 那里加第三个座位。
//
// 所以这里用的是最克制的一种做法：
//   - 只读地找到那个 shadow root，量出「编辑」按钮的位置；
//   - 在页面层（light DOM）把一枚同高的按钮绝对定位到它右边，视觉上连成一串；
//   - 用 MutationObserver + ResizeObserver + 低频轮询跟随窗口缩放、侧栏折叠、语言
//     切换与菜单重挂载；
//   - 桌面菜单不存在（浏览器里的 dsh web）就什么都不做。
//
// 颜色一律取当前主题的 `--dsw-alias-*` 变量，深浅色主题自动跟随；点下去先问一句
// （会打断正在跑的任务），确认后调 Host 的 /desktop-restart/restart。

;(function () {
  'use strict'

  if (window.__dshDesktopRestartInstalled === true) return
  window.__dshDesktopRestartInstalled = true

  var ROOT_ID = 'dsh-desktop-restart-root'
  var BUTTON_ID = 'dsh-desktop-restart-button'
  var STYLE_ID = 'dsh-desktop-restart-style'
  var ENDPOINT = '/desktop-restart'

  /** 与桌面菜单栏按钮同高（preload 里固定 28px）。 */
  var BUTTON_HEIGHT = 28

  /**
   * 页面的兜底时限：到点还连着 Host，就说明这次重启没发生。
   *
   * 应用真的关掉时页面会先断开，所以这个值只要盖过一次正常重启（关窗口 + 杀进程 +
   * 重启）就可以；宁可让用户多等十几秒看到明确结论，也不要无限「正在重启中」。
   */
  var GIVE_UP_MS = 25000

  var bodyObserver = null
  var resizeObserver = null
  var themeObserver = null
  var mountedHost = null
  var supported = null
  var phase = 'idle' // idle | running | failed
  var failure = ''
  var pollTimer = null
  var giveUpTimer = null
  var retryTimer = null
  var followTimer = null
  var escapeListener = null

  function isZh() {
    var lang = String(document.documentElement.lang || navigator.language || 'en').toLowerCase()
    return lang.indexOf('zh') === 0
  }

  /** 当前语言下的文案；只认中文与英文，其它回落到英文。 */
  function copy() {
    return isZh()
      ? {
          label: '重启',
          title: '重启 DeepSeek Harness（整个应用会关闭并重新启动）',
          confirmTitle: '重启 DeepSeek Harness？',
          confirmBody: '整个应用会被关闭并重新启动。正在运行的任务会中断，定时任务在关闭期间不会运行。',
          confirmOk: '重启',
          confirmCancel: '取消',
          running: '正在重启…',
          runningHint: '应用即将关闭，本页面会自动断开；重新打开后会用新的一轮启动。',
          failed: '重启失败',
          failedHint: '重启没有生效，应用仍在运行。',
          failedHelperMissing: '重启辅助进程没能启动，应用仍在运行。可以在终端手动重启。',
          failedStalled: '重启卡住了，应用仍在运行：',
        }
      : {
          label: 'Restart',
          title: 'Restart DeepSeek Harness (the whole app closes and starts again)',
          confirmTitle: 'Restart DeepSeek Harness?',
          confirmBody: 'The whole app will close and start again. Running tasks are interrupted, and scheduled tasks do not run while it is closed.',
          confirmOk: 'Restart',
          confirmCancel: 'Cancel',
          running: 'Restarting…',
          runningHint: 'The app is closing; this page will disconnect and reopen on a fresh start.',
          failed: 'Restart failed',
          failedHint: 'The restart did not take effect; the app is still running.',
          failedHelperMissing: 'The restart helper never started, so the app is still running. Restart it manually.',
          failedStalled: 'The restart stalled; the app is still running:',
        }
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID) !== null) return
    var style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = [
      '#' + ROOT_ID + ' { position: fixed; z-index: 1101; display: none; }',
      '#' + ROOT_ID + '[data-ready="true"] { display: block; }',
      '#' + BUTTON_ID + ' {',
      '  height: ' + BUTTON_HEIGHT + 'px; padding: 0 10px; border: 0; border-radius: 6px;',
      '  background: transparent; color: var(--dsw-alias-label-secondary);',
      '  font-family: var(--dsw-font-family, inherit); font-size: 14px; font-weight: normal;',
      '  line-height: ' + BUTTON_HEIGHT + 'px; cursor: default; -webkit-app-region: no-drag;',
      '  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; user-select: none;',
      '}',
      '#' + BUTTON_ID + ':hover, #' + ROOT_ID + '[data-open="true"] #' + BUTTON_ID + ' {',
      '  background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);',
      '}',
      '#' + BUTTON_ID + ':focus-visible {',
      '  outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: -2px;',
      '}',
      '#' + BUTTON_ID + '[data-phase="running"] { color: var(--dsw-alias-state-business-primary); }',
      '#' + BUTTON_ID + '[data-phase="failed"] { color: var(--dsw-alias-label-error, #d93025); }',
      '#' + BUTTON_ID + '[aria-disabled="true"] { opacity: .65; }',
      '.dsh-desktop-restart-dot {',
      '  width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none;',
      '  animation: dshDesktopRestartPulse 1s ease-in-out infinite;',
      '}',
      '@keyframes dshDesktopRestartPulse { 50% { opacity: .25 } }',
      '#' + ROOT_ID + ' .dsh-desktop-restart-backdrop { position: fixed; inset: 0; background: rgba(0, 0, 0, .32); }',
      '#' + ROOT_ID + ' .dsh-desktop-restart-dialog {',
      '  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);',
      '  width: min(420px, calc(100vw - 48px)); box-sizing: border-box;',
      '  border-radius: 14px; padding: 20px 22px 18px;',
      '  background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #111);',
      '  border: 1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, .1));',
      '  box-shadow: 0 24px 64px rgba(0, 0, 0, .28);',
      '  font-family: var(--dsw-font-family, inherit); font-size: 14px; line-height: 22px;',
      '}',
      '#' + ROOT_ID + ' .dsh-desktop-restart-dialog h2 { margin: 0 0 10px; font-size: 16px; line-height: 24px; }',
      '#' + ROOT_ID + ' .dsh-desktop-restart-dialog p { margin: 0; color: var(--dsw-alias-label-secondary, #555); }',
      '#' + ROOT_ID + ' .dsh-desktop-restart-actions {',
      '  display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px;',
      '}',
      '#' + ROOT_ID + ' .dsh-desktop-restart-actions button {',
      '  height: 32px; padding: 0 16px; border-radius: 8px; font: inherit; cursor: default;',
      '  border: 1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, .14));',
      '  background: transparent; color: inherit;',
      '}',
      '#' + ROOT_ID + ' .dsh-desktop-restart-actions button:hover { background: var(--dsw-alias-interactive-bg-hover); }',
      '#' + ROOT_ID + ' .dsh-desktop-restart-actions button[data-primary="true"] {',
      '  border-color: transparent; background: var(--dsw-alias-button-primary-fill, #4d6bfe);',
      '  color: var(--dsw-alias-label-primary-foreground, #fff);',
      '}',
      '#' + ROOT_ID + ' .dsh-desktop-restart-actions button:disabled { opacity: .55; }',
      '#' + ROOT_ID + ' .dsh-desktop-restart-note {',
      '  margin-top: 10px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #555);',
      '}',
      '#' + ROOT_ID + ' .dsh-desktop-restart-note[data-error="true"] { color: var(--dsw-alias-label-error, #d93025); }',
      '@media (prefers-reduced-motion: no-preference) {',
      '  #' + ROOT_ID + ' .dsh-desktop-restart-dialog { animation: dshDesktopRestartIn 140ms ease-out; }',
      '  @keyframes dshDesktopRestartIn { from { opacity: 0; transform: translate(-50%, -46%); } }',
      '}',
    ].join('\n')
    document.head.append(style)
  }

  /** 桌面端那条 shadow 菜单栏，没有就返回 null。 */
  function desktopMenubar() {
    var hosts = document.querySelectorAll('[data-windows-menu]')
    for (var i = 0; i < hosts.length; i += 1) {
      var shadow = hosts[i].shadowRoot
      if (shadow === null) continue
      var bar = shadow.querySelector('[role=menubar]')
      if (bar === null) continue
      var buttons = Array.prototype.slice.call(bar.querySelectorAll('button'))
      if (buttons.length < 2) continue
      // 第二个按钮是「编辑」；顺序若变了，按本机语言里的那个词再认一次。
      var expected = isZh() ? '编辑' : 'Edit'
      var named = null
      for (var j = 0; j < buttons.length; j += 1) {
        if (String(buttons[j].textContent || '').trim() === expected) { named = buttons[j]; break }
      }
      return { bar: bar, edit: named !== null ? named : buttons[1] }
    }
    return null
  }

  function teardown() {
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null }
    if (giveUpTimer !== null) { clearTimeout(giveUpTimer); giveUpTimer = null }
    if (retryTimer !== null) { clearInterval(retryTimer); retryTimer = null }
    if (followTimer !== null) { clearInterval(followTimer); followTimer = null }
    if (resizeObserver !== null) { resizeObserver.disconnect(); resizeObserver = null }
    if (themeObserver !== null) { themeObserver.disconnect(); themeObserver = null }
    if (bodyObserver !== null) { bodyObserver.disconnect(); bodyObserver = null }
    if (escapeListener !== null) {
      document.removeEventListener('keydown', escapeListener, true)
      escapeListener = null
    }
    if (mountedHost !== null) { mountedHost.remove(); mountedHost = null }
  }

  function closeDialog() {
    if (mountedHost === null) return
    var old = mountedHost.querySelectorAll('[data-dialog], .dsh-desktop-restart-backdrop')
    for (var i = 0; i < old.length; i += 1) old[i].remove()
    mountedHost.dataset.open = 'false'
    if (escapeListener !== null) {
      document.removeEventListener('keydown', escapeListener, true)
      escapeListener = null
    }
  }

  function renderDialog() {
    if (mountedHost === null) return
    closeDialog()
    var text = copy()
    mountedHost.dataset.open = 'true'

    var backdrop = document.createElement('div')
    backdrop.className = 'dsh-desktop-restart-backdrop'
    backdrop.addEventListener('mousedown', function (event) {
      event.preventDefault()
      if (phase !== 'running') closeDialog()
    })

    var dialog = document.createElement('div')
    dialog.className = 'dsh-desktop-restart-dialog'
    dialog.dataset.dialog = ''
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')

    var heading = document.createElement('h2')
    heading.textContent = phase === 'failed' ? text.failed : text.confirmTitle

    var body = document.createElement('p')
    body.textContent = text.confirmBody

    var note = document.createElement('div')
    note.className = 'dsh-desktop-restart-note'
    if (phase === 'running') note.textContent = text.runningHint
    else if (phase === 'failed') {
      note.dataset.error = 'true'
      note.textContent = failure
    }

    var actions = document.createElement('div')
    actions.className = 'dsh-desktop-restart-actions'

    var cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.textContent = text.confirmCancel
    cancel.addEventListener('click', function (event) {
      event.preventDefault()
      closeDialog()
    })

    var confirm = document.createElement('button')
    confirm.type = 'button'
    confirm.dataset.primary = 'true'
    confirm.textContent = phase === 'running' ? text.running : text.confirmOk
    confirm.addEventListener('click', function (event) {
      event.preventDefault()
      restart()
    })

    if (phase === 'running') {
      cancel.disabled = true
      confirm.disabled = true
    }

    actions.append(cancel, confirm)
    dialog.append(heading, body, note, actions)
    mountedHost.append(backdrop, dialog)
    if (phase !== 'running') confirm.focus({ preventScroll: true })

    if (phase !== 'running') {
      escapeListener = function (event) {
        if (event.key === 'Escape') {
          event.preventDefault()
          closeDialog()
        }
      }
      document.addEventListener('keydown', escapeListener, true)
    }
  }

  function paintButton() {
    if (mountedHost === null) return
    var button = mountedHost.querySelector('#' + BUTTON_ID)
    if (button === null) return
    var text = copy()
    button.dataset.phase = phase
    button.setAttribute('aria-disabled', phase === 'running' ? 'true' : 'false')
    button.title = phase === 'running' ? text.runningHint : text.title
    button.replaceChildren()
    if (phase === 'running') {
      var dot = document.createElement('span')
      dot.className = 'dsh-desktop-restart-dot'
      button.append(dot, document.createTextNode(text.running))
    } else {
      button.append(document.createTextNode(phase === 'failed' ? text.failed : text.label))
    }
  }

  /** 位置：「编辑」右边缘往右 2px，垂直居中。 */
  function position() {
    if (mountedHost === null) return
    var menu = desktopMenubar()
    if (menu === null) {
      mountedHost.dataset.ready = 'false'
      return
    }
    var rect = menu.edit.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) {
      mountedHost.dataset.ready = 'false'
      return
    }
    mountedHost.dataset.ready = 'true'
    mountedHost.style.left = Math.round(rect.right + 2) + 'px'
    mountedHost.style.top = Math.round(rect.top + (rect.height - BUTTON_HEIGHT) / 2) + 'px'
  }

  function restart() {
    if (phase === 'running') return
    phase = 'running'
    failure = ''
    paintButton()
    renderDialog()
    fetch(ENDPOINT + '/restart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }).then(function (response) {
      return response.json().catch(function () { return null }).then(function (payload) {
        // 派发失败时 Host 已经用非 2xx 把原因说清楚了，直接把它转成文案，
        // 不要再让用户等到超时才看到「重启失败」。
        if (!response.ok) {
          var detail = payload !== null && typeof payload.error === 'string' ? payload.error : ''
          throw new Error(detail === '' ? 'HTTP ' + response.status : detail)
        }
        return payload
      })
    }).then(function (payload) {
      var taskId = payload !== null && typeof payload.taskId === 'string' ? payload.taskId : ''
      // Host 收到之后才会动手。这里要盯的是「应用还在不在」和「任务有没有明确失败」：
      // 应用正常关掉时轮询自然失败，那是成功；Host 还活着并报失败，就必须如实告诉用户。
      armGiveUp()
      pollTimer = setTimeout(function () { pollUntilGone(taskId) }, 1200)
    }, function (error) {
      fail(String((error && error.message) || error))
    })
  }

  function fail(message) {
    phase = 'failed'
    failure = message
    if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null }
    if (giveUpTimer !== null) { clearTimeout(giveUpTimer); giveUpTimer = null }
    paintButton()
    renderDialog()
  }

  function pollUntilGone(taskId) {
    pollTimer = null
    if (phase !== 'running') return
    var url = ENDPOINT + '/status' + (taskId === '' ? '' : '?id=' + encodeURIComponent(taskId))
    fetch(url, { method: 'GET', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (body) {
        if (phase !== 'running') return
        // Host 明确报失败：重启没有生效，别再转圈了。
        if (body !== null && body.state === 'failed') {
          fail(describeFailure(body))
          return
        }
        pollTimer = setTimeout(function () { pollUntilGone(taskId) }, 800)
      }, function () {
        /* Host 已经不在了：应用正在关闭，这就是成功路径 */
      })
  }

  /**
   * 前端自己的兜底。
   *
   * Host 侧已经有一个 watchdog，但「Host 活着、辅助进程也没跑成、watchdog 又没能
   * 记账」这种组合下页面会永远停在「正在重启中」。应用真的关掉时页面会先断开，
   * 所以只要到点还连着，就说明这次重启没有发生 —— 直接把结论给用户。
   */
  function armGiveUp() {
    if (giveUpTimer !== null) clearTimeout(giveUpTimer)
    giveUpTimer = setTimeout(function () {
      giveUpTimer = null
      if (phase === 'running') fail(copy().failedHint)
    }, GIVE_UP_MS)
  }

  /** 把 Host 的失败详情整理成一句人话。 */
  function describeFailure(body) {
    var detail = typeof body.detail === 'string' ? body.detail : ''
    if (detail === '') return copy().failedHint
    if (/never started/iu.test(detail)) return copy().failedHelperMissing
    if (/stalled/iu.test(detail)) return copy().failedStalled + detail
    return detail
  }

  /** 挂上按钮（或复用已挂的），并开始跟随菜单栏的位置。 */
  function mount() {
    if (desktopMenubar() === null) {
      if (mountedHost !== null) mountedHost.dataset.ready = 'false'
      return
    }
    ensureStyle()
    if (mountedHost === null) {
      var host = document.createElement('div')
      host.id = ROOT_ID
      host.dataset.ready = 'false'

      var button = document.createElement('button')
      button.id = BUTTON_ID
      button.type = 'button'
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        if (phase === 'running') return
        phase = 'idle'
        failure = ''
        paintButton()
        if (host.dataset.open === 'true') closeDialog()
        else renderDialog()
      })

      host.append(button)
      document.body.append(host)
      mountedHost = host
      paintButton()

      if (typeof ResizeObserver === 'function') {
        resizeObserver = new ResizeObserver(function () { position() })
        resizeObserver.observe(document.documentElement)
      }
      // 主题与语言变化都会改写根元素属性，重画文案并重新定位。
      themeObserver = new MutationObserver(function () {
        paintButton()
        position()
      })
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['lang', 'class', 'data-theme', 'data-color-scheme', 'style'],
      })
      // 侧栏折叠、标题栏菜单左移这类变化既不改窗口尺寸也不改根元素属性，
      // 低频轮询是这里最省事也最稳的跟随方式。
      followTimer = setInterval(function () {
        if (mountedHost === null) return
        if (desktopMenubar() === null) { mountedHost.dataset.ready = 'false'; return }
        position()
      }, 400)
    }
    position()
  }

  /** 能力探测：宿主认「桌面端」才显示按钮，普通浏览器里保持安静。 */
  function probe() {
    fetch(ENDPOINT + '/status', { method: 'GET', cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (body) {
        supported = body !== null && body.supported === true
        if (supported) mount()
        else scheduleRetry()
      }, function () {
        supported = false
        scheduleRetry()
      })
  }

  /** 桌面菜单栏可能比这段脚本晚挂上，短时间内补几次。 */
  function scheduleRetry() {
    if (retryTimer !== null) return
    var attempts = 0
    retryTimer = setInterval(function () {
      attempts += 1
      if (desktopMenubar() !== null) {
        clearInterval(retryTimer)
        retryTimer = null
        if (supported === true) mount()
        else probe()
        return
      }
      if (attempts >= 20) { clearInterval(retryTimer); retryTimer = null }
    }, 500)
  }

  function start() {
    if (document.body === null) {
      document.addEventListener('DOMContentLoaded', start, { once: true })
      return
    }
    bodyObserver = new MutationObserver(function () {
      if (supported === true) mount()
    })
    bodyObserver.observe(document.body, { childList: true })
    probe()
    scheduleRetry()
  }

  start()
})()
