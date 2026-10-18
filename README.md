# DSH Desktop Restart

在 **DeepSeek Harness 桌面端**左上角「编辑」菜单旁边加一个「重启」按钮：点一下确认，
整个应用关闭并重新启动。

English: adds a **Restart** button next to the *Edit* menu in the DSH desktop title bar.
One click (plus a confirm) closes the whole app and starts it again.

---

## 为什么需要它

DSH 桌面端的「应用」菜单里其实有「重启应用与 Host」，但那一条只在开发构建里出现，
正式版里没有。改过 profile 配置、装完插件、插件提示「请重启 DSH 生效」之后，用户只能
手动退出再从开始菜单重新打开。

这个插件补上那个按钮。

## 效果

```
┌─────────────────────────────────────────────┐
│  应用   编辑   重启          [窗口按钮]      │
└─────────────────────────────────────────────┘
```

- 按钮与桌面菜单同高同字号，视觉上连成一条
- 深浅色主题、窗口缩放、侧栏折叠、语言切换都会自动跟随
- 点击先弹确认（会打断正在运行的任务），确认后整机重启
- 浏览器里的 `dsh web` 不会显示按钮

## 安装

### 方式一：从本地目录安装

```powershell
dsh plugin --profile desktop add link:<本仓库绝对路径>
```

### 方式二：手工放置

把仓库目录拷进 profile 的 `node_modules`：

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-desktop-restart\
```

然后在同级的 `package.json` 里把 `dsh-desktop-restart` 追加进
`dsh.profile.bundles` 数组：

```json
"dsh": {
  "profile": {
    "bundles": [
      "...",
      "dsh-desktop-restart"
    ]
  }
}
```

bundle 自带的 `cordis.patch.yml` 会插入插件行，无需手工改 patch。

装完重启一次 DSH，按钮出现在「编辑」右边。**插件改动需要重启 DSH 才生效**——
这正好可以用这个按钮自己完成。

## 它怎么工作

- 按钮由一段**页面内联脚本**画出来。桌面端标题栏的「应用 / 编辑」不是 DSH 页面，
  而是 preload 挂在 `document.body` 上的 shadow root（`[data-windows-menu]`），插件
  没有插槽可加第三个座位。脚本只读地量出「编辑」按钮的位置，把一枚同高按钮绝对定位
  到它右边。
- 点击后 POST 到插件的 `/desktop-restart/restart`，Host 用**两段式**派发辅助进程：
  - **第一段**（Host 同步等待，约 0.2 秒）只做 `Start-Process`，把第二段重挂成一个
    独立隐藏进程，打印 `dispatched` 后立即返回；
  - **第二段**独立执行：关窗口 → 按映像名 `taskkill`（**不带 `/T`**）→ 等进程退干净
    → **清掉 `ELECTRON_RUN_AS_NODE`** → 按原可执行文件重新拉起。
- 路由带完整校验：只有「由 Electron 以 Node 模式拉起的 DSH 桌面宿主」才允许重启，
  调用方必须通过 webServer 的 Host/Origin 栅栏与登录 Cookie。

## 三个踩过的坑

这三个都是「看起来对、实际不工作」，写在这里省得别人再踩一遍。

### 1. 异步 spawn 会被父进程的死亡带收走

Host 马上会被自己的辅助脚本 `taskkill`，而异步 `spawn` + `unref()` 拉起的 PowerShell
还没初始化完父进程就没了，Windows 会把它一起收走。`unref()` 只解除 Node 侧的引用计数，
**并不会**让 OS 进程脱离父进程。

症状：`.ps1` 留在临时目录、一行日志都没有——脚本从未执行。

### 2. `cmd /c start /b` 更糟

它继承了父进程的 stdio 管道，`start` 返回后管道仍未关闭，同步等待会一路拖到
`ETIMEDOUT`。

最终方案是两段式：第一段在父进程还活着时完成重挂，第二段从此不依赖它。

### 3. `ELECTRON_RUN_AS_NODE` 会让应用「关掉了但没重启」

Host 本身是桌面端用 `ELECTRON_RUN_AS_NODE=1`（Node 模式）拉起的子进程，这个变量
会一路遗传到辅助脚本。带着它启动 `DeepSeek Harness.exe`，Electron 会把自己当成
node 解释器：

| 环境 | 行为 | 耗时 |
|---|---|---|
| 带 `ELECTRON_RUN_AS_NODE=1` | 当成 node 解释器，打印 `v24.21.0` 后退出 | 52ms |
| 清掉之后 | 正常以 Electron 应用启动 | 286ms |

症状正是「应用关掉了，但没有重新启动」，而且没有任何错误输出。

脚本在拉起前执行 `Remove-Item Env:ELECTRON_RUN_AS_NODE`，并在日志里留下
`clearing ELECTRON_RUN_AS_NODE=…` / `environment cleaned`，方便事后确认这一步真的发生了。

## 排障

辅助脚本每走一步都往 `%TEMP%\dsh-desktop-restart-<stamp>.log` 写一行。杀掉自己宿主后，
这份日志是唯一的事后证据：

```
22:36:53.427 all app processes gone
22:36:53.629 starting replacement
22:36:53.634 clearing ELECTRON_RUN_AS_NODE=1
22:36:53.637 environment cleaned
22:36:53.729 replacement started
22:36:55.734 helper exiting
```

正常重启后脚本会自我删除，日志保留。此外：

| 层 | 机制 |
|---|---|
| 派发 | 第一段只在亲眼看到 `dispatched` 时才回 202；否则当场回 500 + 原因 |
| Host | watchdog 盯日志：12 秒没动静判「辅助进程没起来」，30 秒没结束判「卡住」 |
| 页面 | Host 报 failed 立即显示原因；另设 25 秒兜底，到点还连着就说明重启没发生 |

判断「成功」的方式是**连接断开**——应用真的关掉时轮询自然失败，不需要 Host 回报。

## 限制

- **仅 Windows**：辅助脚本是 PowerShell，进程判定依赖 `.exe` 映像名。
- **会中断任务**：重启即关闭应用，正在跑的轮次会中断（确认框已写明）。
- **只在桌面端生效**：`dsh web` 下不显示按钮，路由返回 503。

## 自测

不需要真的重启应用：

```powershell
node test/smoke.mjs          # Host 路由与注入行
node test/host-guard.mjs     # 非桌面环境下必须拒绝
node test/script-smoke.mjs   # 生成的 PowerShell 脚本能跑通（无害目标）
node test/client-smoke.mjs   # 页面：挂载、定位、点击、确认
node test/client-failure.mjs # 页面：失败/断连/超时三种结局
```

`script-smoke` 与 `client-*` 用最小 DOM / 无害进程名，不会碰到真实应用。

## 结构

```text
cordis.patch.yml   bundle 层：插入插件行
src/index.js       Host 半边：路由、两段式派发、环境清理、watchdog
src/inject.js      index 注入行（桌面端唯一能带脚本进页面的通道）
src/client.js      浏览器端：标题栏按钮、确认框、进度与失败回读
test/              最小桩下的自测
```

## License

MIT
