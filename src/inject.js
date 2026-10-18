/**
 * 把浏览器端脚本挂进页面。
 *
 * 桌面端页面（`dsh-app://app/`）的 index.html 直接来自安装包里的静态 dist，宿主侧
 * 的 `tapIndex`（对 HTML 做函数式改写）永远走不到它。唯一的通道是
 * `webserver/index-inject` 推的结构化行：桌面壳在宿主启动时收集一次，经 IPC 交给
 * 渲染层逐行应用。
 *
 * 两种行的行为并不对称（桌面端 web-boot 的解释器）：
 *   - `kind: 'script'`        → createElement + textContent + append，不会失败；
 *   - `kind: 'script-src'`    → await loadScript(src)，失败即 reject，而那个 reject
 *                               会把 `__DSH_BOOT_READY__` 一起打掉，应用起不来。
 *
 * 所以这里推一行**内联**脚本，由它自己去建 `<script src>` 并吞掉 onerror：
 * 路由在就正常加载，路由不在就静默失败，宿主永远不会因为我们起不来。
 *
 * 同一张表在宿主启动时被收集一次并缓存，插件在运行期被关掉时表里仍留着这一行，
 * 而 /desktop-restart 路由已经注销 —— onerror 吞掉正是为这一种情况准备的。
 */

const CLIENT_SCRIPT_URL = '/desktop-restart/client.js'

const INJECTION_TEXT = `(function(){try{
  var d=document.body||document.head||document.documentElement;
  if(!d)return;
  if(document.querySelector('script[data-dsh-desktop-restart]'))return;
  var s=document.createElement('script');
  s.src=${JSON.stringify(CLIENT_SCRIPT_URL)};
  s.async=true;
  s.dataset.dshDesktopRestart='';
  s.onerror=function(){};
  d.appendChild(s);
}catch(e){}})()`

/**
 * 注入行是否已经存在（同一次收集或上一次收集留下的）。
 * @param {unknown} row - 表格中的一行。
 * @returns {boolean} 是则 true。
 */
function isOurs(row) {
  if (row === null || typeof row !== 'object') return false
  if (row.kind === 'script-src' && row.src === CLIENT_SCRIPT_URL) return true
  return row.kind === 'script' && typeof row.text === 'string' && row.text.includes(CLIENT_SCRIPT_URL)
}

/**
 * 订阅注入表事件，装上浏览器端脚本。
 * @param {import('node:events').EventEmitter | object} ctx - 宿主插件上下文。
 * @returns {() => void} 清理函数。
 */
export function registerClientInjection(ctx) {
  return ctx.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      if (table.some(isOurs)) return
      table.push({ kind: 'script', placement: 'body', text: INJECTION_TEXT })
    } catch {
      /* 一行注入失败绝不能连累整张表 */
    }
  })
}

export { CLIENT_SCRIPT_URL, INJECTION_TEXT }
