# Trim 2.0 专项代码审查报告

- **审查日期**：2026-09-06
- **审查范围**：`C:\kaifa\TuneForge`（Electron 主程序源码，约 3.0 万行）+ `C:\kaifa\TuneForge goujian`（Electron/Tauri 构建工程）
- **审查基准**：Trim 2.0 项目规范第二部分（视觉 UI / 动效 / 交互功能 / 构建目录）
- **审查维度**：功能安全、规范符合性、性能稳定性、代码质量、无障碍
- **检索方式**：`vexor` 语义检索定位实现位置 + 精确匹配校验规范硬指标 + 关键代码段逐行精读 + WCAG 对比度脚本实测
- **结论**：**发现 4 项高危、14 项中危、6 项低危问题**。整体工程质量在同类桌面工具中属中上水平——安全基线（沙箱、导航限制、子进程白名单）扎得很牢，动效与 DOM 回收做得相当规范，AI 数据上传面也严格控制住了；但**高风险操作的"红色二次确认"实际未生效**、**文件清理缺失备份**、**启动期同步阻塞**三处需要在发布前处理。

---

## 一、结论速览

| 严重等级 | 数量 | 关键问题 |
|---|---|---|
| 🔴 高 | 4 | 临时脚本可被劫持、红色二次确认失效、文件清理无备份、启动同步阻塞 |
| 🟡 中 | 14 | 窗口最小尺寸超标、图标兜底不统一、还原点校验三处缺陷、runPowerShell 无超时、假日志、常驻轮询、弹窗无焦点陷阱等 |
| 💭 低 | 6 | 数据目录硬编码、close 事件双写、pwsh 存根候选、CSP、构建产物入源码树等 |

### 规范符合性总览

| 规范项 | 结论 | 说明 |
|---|---|---|
| 深色 carbon ladder 色阶 | ✅ 符合 | `#0F1115 → #171A21 → #1D212B → #242936` 四级阶梯清晰，侧边栏选中态为薰衣草紫 14% 叠加，无高对比黑块/绿块 |
| 浅色标题 `#1c1e24` / 正文 `#4b505b` | ✅ 符合 | 实测 15.41:1 / 7.48:1，均达 AAA |
| 卡片描边回归原底色 | ✅ 符合 | `rgba(255,255,255,0.07)`（深）/ `rgba(20,24,40,0.09)`（浅），低对比描边 |
| 图标统一 `src/assets/ico/` + Trim.ico 兜底 | ⚠️ 部分符合 | 窗口/页面图标 ✅；进程管理 ✅；**右键管理与启动项 ❌** |
| Mica/Acrylic 材质 + 失败回滚 | ✅ 符合 | `appearance:set-material` → `setBackgroundMaterial`，CSS 88% 兜底 + 最大化 100% 自绘 |
| 主窗口最小 1080×720 | ❌ 不符合 | 实际锁定 1294×870，且注释与常量自相矛盾 |
| ripple-click 480ms 波纹 | ✅ 符合 | 绝对定位脱离文档流，animationend + 兜底定时器双重回收 |
| 移除 jello 果冻动效 | ✅ 符合 | 仅余注释说明，无残留实现 |
| 拖尾默认关闭 + localStorage | ✅ 符合 | 默认 off，`pointer-events:none`，仅窗口内，reduced-motion 下不建节点 |
| 减弱动效不创建 DOM 节点 | ⚠️ 部分符合 | 波纹 ✅ 实时判断；**拖尾/倾斜 ❌ 仅模块加载时求值一次** |
| 高风险操作红色二次确认 | ❌ 不符合 | 确认按钮恒为主色；且红色警示文案被转义成字面文本 |
| 优化前还原点 5 天校验 | ⚠️ 部分符合 | 流程存在，但 PS7 下时间转换大概率失效→恒误报；文案语义错乱 |
| 删除类操作执行前备份 | ⚠️ 部分符合 | 右键项 ✅、启动项 ✅、**文件清理 ❌ 硬删除** |
| 独立窗口 `show:false` + `ready-to-show` | ✅ 符合 | 5 个窗口全部覆盖 |
| 操作日志写入 `%APPDATA%\Trim\logs\` | ⚠️ 部分符合 | 路径 ✅；但存在一条与实际行为不符的「模拟」日志 |
| 管理员提权流程 | ⚠️ 部分符合 | 流程完整，但提权后无条件退出、内嵌脚本路径无超时 |
| AI 简介仅上传名称与厂商 | ✅ 符合 | 仅传 `name/company/scope`，注册表路径与命令仅本地展示 |
| 图标随源码打包 | ✅ 符合 | `files: ["src/**/*", "ico/*.ico"]` |
| 构建顺序（Electron→镜像→安装器） | ✅ 符合 | 但镜像产物落在源码树内，存在不同步风险 |
| 配置缓存统一 `%APPDATA%\Trim\` | ✅ 符合 | 含 CleanTool→Trim 一次性迁移 |

---

## 二、🔴 高危问题

### A1. 临时 ps1 脚本可被劫持，存在本地提权与 TOCTOU 窗口

- **问题分类**：功能安全
- **位置**：`main.js:423-437` `writeTempScript()`；`main.js:438-460` `cleanupTempScripts()`；全项目 39 处调用
- **问题描述**：
  1. 脚本统一写入 `%TEMP%\Trim\`（`os.tmpdir()`）——系统级全局可写目录，同机任何用户均可写入。
  2. `fs.mkdirSync(tempDir, { recursive: true })` 与 `fs.writeFileSync(filePath, ...)` 均未设置 ACL 或文件权限（`mode`）。目录若被低权限用户预先创建、或替换为目录联接/符号链接，脚本内容即可被控制。
  3. 应用经 UAC 提权为管理员后，这些脚本将以**管理员权限**执行——写入与 pwsh 执行之间存在 TOCTOU 时间窗，构成典型的本地提权路径。
  4. 加剧因素：`cleanupTempScripts()` 只在启动与退出时调用，且**只清理 1 小时前的文件**；未命中的脚本会长期滞留临时目录，内容包含注册表路径与系统命令，可被其他进程读取。
- **违反规范**：二.3「系统级操作的权限校验、异常处理、边界条件」
- **修改建议**：
  - 改用 `%APPDATA%\Trim\tmp\`（继承当前用户 ACL，天然隔离其他用户）。
  - 创建目录前校验：目录已存在时检查所有权；拒绝符号链接/联接点（可用 `fs.lstatSync().isSymbolicLink()`）。
  - `fs.writeFileSync(fp, buf, { mode: 0o600 })` 限制文件权限。
  - 脚本执行完毕在 `finally` 中**立即**删除（现有 38/39 处已做，补齐剩余一处并确保 catch 路径同样删除）。
  - 更彻底的做法：短脚本（<8KB）改用 `pwsh -EncodedCommand <base64>` 内联传参，完全避免落盘，顺带解决编码与截断问题。

---

### A2. 高危二次确认不是红色，且红色警示文案被转义为字面文本

- **问题分类**：规范不符 + 功能安全
- **位置**：`src/scripts/app.js:153-192`（`confirm` 恒 `btn-primary`、无 danger 参数）、`src/scripts/app.js:174`（`escapeHtml`）、`src/scripts/modal.js:157`（另一套支持 `danger` 的 confirm）、`src/scripts/optimizer.js:200-211`
- **问题描述**：项目里存在**两套 confirm 实现**，而高风险操作全部用的是不支持红色那一套：
  1. `window.modal.confirm`（modal.js:157）支持 `danger: true`，会渲染 `btn-danger` 红色按钮——但在整条高风险链路上**从未被调用**。
  2. `window.app.confirm`（app.js:153）签名只有 `(title, message, confirmText, cancelText)`，确认按钮**硬编码 `btn-primary`**（app.js:168）。所有高危调用都走它：
     - `optimizer.js:202` 高危优化项
     - `optimizer.js:704` 还原点警示
     - `optimizer.js:796 / 868` 批量执行
     - `memoryclean.js:260` 内存深度清理
     - `cleanup.js:968` 高风险清理项
     - `startup.js:250 / 296` 启动项删除与启停
     - `sysrestore.js:130` 系统还原
  3. 更严重的是，`optimizer.js:204-206` 为高危确认精心构造的红色警示 HTML（`<span style="color:var(--danger);font-weight:700">…</span>`），在 `app.js:174` 被 `escapeHtml(message).replace(/\n/g,'<br>')` **完整转义**，用户实际看到的是一串 `<span style="color:var(--danger)…">` 字面文本，红色强调完全失效，可读性很差。
- **违反规范**：二.3「高风险操作（高风险清理项、内存深度清理、高危优化项、删除类操作）**必须有红色二次确认弹窗**」
- **修改建议**：
  - 收敛为单一实现：`app.confirm` 直接代理 `window.modal.confirm`，并透传第 5 个 `options` 参数（含 `danger`）。
  - 提供语义化入口 `confirmDanger(title, message, okText)`，让调用方无法遗漏。
  - 高危提示改为**结构化字段**（如 `{ title, message, dangerHint }`）由弹窗模板渲染，不再由调用方拼接 HTML 字符串——既避免转义陷阱，也杜绝后续 XSS 隐患。
  - 顺带修复 A2 之外的收益：统一后 `modal.js` 的 `role="dialog"` 与 ESC/背景点击处理也能覆盖到全部确认场景。

---

### A3. 文件清理无备份且为硬删除

- **问题分类**：功能安全
- **位置**：`main.js:1000-1034` `finder:delete`；`native-scanner/src/main.rs:441-460` `cmd_delete`
- **问题描述**：删除类操作的三条链路里，两条已实现备份、一条没有：
  - ✅ 右键项：`contextmenu:backup`（main.js:1071）先备份再删除
  - ✅ 启动项：备份到 `%APPDATA%\Trim\startup-backup\deleted`（main.js:1807）
  - ❌ **文件清理**：校验通过（白名单快照 + 受保护路径拦截 + 500 项上限）后，直接由 Rust 侧 `fs::remove_file` / `fs::remove_dir_all` **永久删除**，不进回收站、不留任何清单。用户误删大文件后无法追溯。
- **违反规范**：二.3「删除类操作（右键项、启动项、**文件清理**）执行前自动备份」
- **修改建议**：
  - 大文件不适合内容复制，改为**落删除清单**：路径、大小、类型、删除时间、所属扫描批次 ID → `%APPDATA%\Trim\fileclean-backup\`，并在 UI 提供「查看已删除清单」入口。
  - 更稳妥：默认走**回收站**（Shell `IFileOperation` 或 `SHFileOperationW`），把最终删除权交还用户，同时在设置里保留「直接删除」选项给高级用户。
  - 清单与回收站二者可同时做，成本都不高。

---

### A4. 启动期同步阻塞：`isAdmin()` 使用 `execSync('net session')`

- **问题分类**：性能问题
- **位置**：`main.js:210-217` `isAdmin()`；调用点 `main.js:606`（**位于 `ready-to-show` 回调内**）、`683`（`app:get-info`）、`2918`（`elevate:status`）
- **问题描述**：`execSync` 是**同步阻塞**调用，会冻结 Electron 主进程事件循环（连带所有渲染进程）。`net session` 在离线环境、域环境或网络异常时可能耗时数秒。而 `main.js:606` 正处在窗口首帧显示的关键路径上——`ready-to-show` 回调里同步等一个网络相关命令，直接表现为**启动白屏/卡顿**。
- **违反规范**：三.3「性能稳定性」
- **修改建议**：
  - 改为异步 `exec`，并**缓存结果**（同一进程生命周期内权限不会变化，检测一次即可）。
  - `ready-to-show` 路径移除该调用，改为异步回填后通过 IPC 通知渲染层刷新管理员状态横幅（`optimizer.js:937-947` 已有 `checkAdmin` 轮询机制，可直接复用）。
  - 若追求零子进程开销，可考虑 `node:process` 结合 Windows `IsUserAnAdmin`（通过原生模块或 `net session` 之外的轻量 API）。

---

## 三、🟡 中危问题

### B1. 主窗口最小尺寸与规范不符（1294×870 vs 1080×720）

- **问题分类**：规范不符
- **位置**：`main.js:46-47`；`main.js:523-535`
- **问题描述**：常量为 `MAIN_WINDOW_MIN_WIDTH = 1294` / `MIN_HEIGHT = 870`，配合 `useContentSize: true`，客户区被锁定在 1294×870，，而 `main.js:533-534` 的注释仍写着「1080×720 即内容区/客户区尺寸，使 innerWidth/Height 恒等于 1080×720」——注释与常量值自相矛盾，是需求变更后常量与注释未同步留下的痕迹。
- **违反规范**：二.1「主窗口最小尺寸 1080×720，禁止缩小到该尺寸以下」
- **修改建议**： 1294×870 是有意调整的新基线，请同步更新规范文档与该处注释
---

### B2. 图标兜底不统一，Trim.ico 未覆盖全场景

- **问题分类**：规范不符
- **位置**：`processes.js:177`（✅）、`contextmenu.js:151-161`（❌）、`startup.js:198`（❌）
- **问题描述**：三个需要展示第三方/系统图标的模块，只有一处真正实现了规范要求的兜底：
  - 进程管理：提取失败回退 `window.api.paths.fileIcon('src/assets/ico/Trim.ico')` ✅
  - 右键管理：图标缺失时回退一个**通用问号圆圈 SVG 占位符**（`placeholderIconHtml`）❌
  - 启动项：仅渲染 `<div class="startup-item-icon ${meta.cls}">` CSS 色块，**既无真实图标也无兜底** ❌
- **违反规范**：二.1「所有图标统一从 `src/assets/ico/` 目录加载，`Trim.ico` 作为全场景统一兜底图标」
- **修改建议**：封装统一的 `resolveItemIcon(item, size)`，内部统一走 `window.api.paths.fileIcon('src/assets/ico/Trim.ico')` 兜底，三个模块共用，避免各写各的。

---

### B3. 还原点校验存在三处缺陷

- **问题分类**：功能安全 + 规范不符
- **位置**：`main.js:1669-1689`；`src/scripts/optimizer.js:685-720`
- **问题描述**：
  1. **PS7 下时间转换大概率失效**：`main.js:1673` 使用 `[System.Management.ManagementDateTimeConverter]::ToDateTime($rp.CreationTime)`。该类型属于 `System.Management` 程序集，**PowerShell 7（.NET Core）默认不加载**，实际执行极可能抛异常。而脚本首行 `$ErrorActionPreference = "SilentlyContinue"` 会把异常吞掉，结果恒为 `RPNONE` → **每次优化都误判为「无还原点」并弹窗骚扰用户**。
  2. **文案语义错乱**：`optimizer.js:699` — 5 天内**已有**还原点时弹出 `还原点很重要喔。`。此场景并不需要创建还原点，这句提示既无动作指引也无意义，属于无效打扰。
  3. **恒放行**：`optimizer.js:719` `return true` 无条件放行，用户在警示弹窗中点「否」后仍继续执行优化。
- **违反规范**：二.3「优化操作执行前必须检查系统还原点：5天内未创建则弹出警示建议创建」
- **修改建议**：
  - 避免依赖 `System.Management`：改用还原点对象自带方法，或直接输出 `CreationTime` 原始 DMTF 串交由 Node 侧解析。同时把 `SilentlyContinue` 改为显式 try/catch，**区分「查询失败」与「确无还原点」**——查询失败应放行并记日志，不应伪装成「无还原点」。
  - 已有有效还原点时不弹任何提示。
  - 点「否」后建议追加一次简短风险确认，或至少在日志中记录用户已拒绝创建。

---

### B4. `runPowerShell` 缺少超时保护（与 `runPowerShellFile` 不一致）

- **问题分类**：功能安全 + 性能问题
- **位置**：`main.js:320-364`（`runPowerShell`，**无 timeout**）；对照 `main.js:366-420`（`runPowerShellFile`，413-418 行有 `timeout` + `child.kill()`）
- **问题描述**：`runPowerShell` 只监听 `error` 与 `close`，完全不处理 `options.timeout`。调用它的 `elevate:request`（`main.js:2930`）在 pwsh 卡死时 Promise **永不 settle**，IPC handler 永久挂起——用户点击「提升权限」后按钮一直停留在等待态，且不会有任何错误提示。
- **违反规范**：二.3「无权限时必须触发提权流程，**失败友好提示**」
- **修改建议**：把 `runPowerShellFile` 的 timeout/kill/clearTimeout 逻辑抽成公共实现，两个函数共用；`elevate:request` 显式传一个 15s 超时。

---

### B5. 提权成功后无条件 1.5s 退出当前实例

- **问题分类**：功能安全
- **位置**：`main.js:2930-2943`
- **问题描述**：`Start-Process -Verb RunAs` 返回 0 只代表「UAC 拉起请求成功」，**不代表新实例真的启动成功**（新实例可能因单实例锁、配置损坏等原因立即退出）。当前实现在 resolve 成功后 1.5s 无条件 `app.quit()`，若新实例启动失败，用户会遇到「点了提权，应用直接消失」的困惑场景。
- **违反规范**：二.3「失败友好提示」
- **修改建议**：监听 `app.requestSingleInstanceLock` 的 `second-instance` 事件确认新实例已就绪后再退出，并设超时兜底——超时则保持当前实例存活并提示「未检测到新实例启动，已保持当前运行状态」。

---

### B6. 操作日志写入与实际行为不符的「模拟」记录

- **问题分类**：功能安全 + 代码质量
- **位置**：`src/scripts/cleanup.js:1065`
- **问题描述**：清理完成后固定写入：
  ```js
  window.app?.log('info', '[模拟] 已执行：ipconfig /flushdns, lodctr /r (参考 cmd/bat 脚本)');
  ```
  这条日志记录与实际是否执行完全无关，是占位式的假日志。在需要审计「用户对系统做过什么」的场景（日志本就是为此存在的），这种记录会**主动误导**排查方向。
- **违反规范**：二.3「所有操作必须写入操作日志」
- **修改建议**：要么真正执行这两个命令并记录真实退出码与输出，要么直接删除该行。当前这种「写一条看起来像操作记录的占位文本」是最坏选择——它让日志库的可信度整体下降。

---

### B7. 看板布局 300ms 常驻轮询强制回流，且无销毁接口

- **问题分类**：性能问题
- **位置**：`src/scripts/xtable.js:338-344`
- **问题描述**：`attach()` 内部的 `setInterval(() => check(false), 300)` 与 `window resize` 监听一旦建立便**永不释放**。`check()` 每次都读 `container.clientWidth`，即每 300ms 触发一次**强制同步布局（reflow）**；即使用户已切换到其它页面，也要先执行一次 `getContainer()` 与 `clientWidth` 读取才返回。调用方 `optimizer.js:321` 与 `contextmenu.js:229` 都有 `if (!kanbanMasonry)` 守卫，所以**不会累积**（属于常驻开销，非泄漏），但 `attach()` 也未返回任何 dispose 接口。
- **违反规范**：三.3「是否存在定时器未清理、动效是否造成性能损耗」
- **修改建议**：
  - `attach()` 返回 `dispose()`，页面切换/销毁时调用。
  - `check()` 开头先判断 `container && container.isConnected`，未挂载直接跳过。
  - 最优解：用 **`ResizeObserver`** 替代 300ms 轮询——容器尺寸变化才触发，彻底消除定时轮询。

---

### B8. 减弱动效偏好只在模块加载时求值一次

- **问题分类**：无障碍
- **位置**：`src/scripts/mouse-trail.js:9-10`；`src/scripts/tilt.js:50`（对照 `app.js:39` ✅ 每次点击实时求值）
- **问题描述**：两处都写成 `const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches`，在 IIFE 执行时求值一次后固化。若用户在应用**运行期间**开启系统「减弱动效」，拖尾与倾斜动效不会停止，必须重启应用才生效。波纹实现（app.js:39）反而是正确的实时判断，三处写法不一致。
- **违反规范**：二.2「系统开启「减弱动效」时，波纹与拖尾完全不创建 DOM 节点」
- **修改建议**：保存 `MediaQueryList` 对象并监听 `change` 事件动态响应，或每次生成节点前实时求值（与 app.js:39 保持一致）。

---

### B9. 日志同步写入阻塞主进程

- **问题分类**：性能问题
- **位置**：`main.js:231-242` `writeLog()` 使用 `fs.appendFileSync`
- **问题描述**：主进程所有日志（含每次 pwsh 非零退出、`@@DIAG@@` 诊断行解析结果）都用**同步 I/O**。在高频扫描或批量清理场景下，短时间内会产生大量同步写盘，直接叠加到主进程事件循环上。
- **违反规范**：三.3「性能稳定性」
- **修改建议**：改为内存缓冲 + 批量异步 flush（`fs.promises.appendFile` + 队列，或 `setImmediate` 合并落盘），应用退出前强制 flush 一次。日志对实时性要求不高，非常适合缓冲。

---

### B10. 确认弹窗无焦点管理，键盘用户缺少焦点陷阱

- **问题分类**：无障碍
- **位置**：`src/scripts/app.js:153-192`；`src/scripts/modal.js:99-174`
- **问题描述**：两套弹窗实现都设置了 `role="dialog" aria-modal="true" aria-labelledby`（这部分做得不错 👍），但**打开后均不移动焦点，也没有 focus trap**：
  - 键盘用户按 Tab 会遍历到弹窗背后的背景元素，与 `aria-modal="true"` 的语义承诺相矛盾。
  - 高危弹窗打开后直接按 Enter，可能误触背景控件。
- **违反规范**：三.5「键盘导航是否可用」
- **修改建议**：打开时把焦点移到**「取消」按钮**（高危操作更安全默认），Tab 在弹窗内循环，关闭后把焦点还给触发元素。

---

### B11. 浮动 Promise：`runOptionActive` 未 await

- **问题分类**：代码质量 + 功能安全
- **位置**：`src/scripts/optimizer.js:1066`、`1068`
- **问题描述**：
  ```js
  runOptionActive({ gb: gbVal }, opt);   // 无 await、无 .catch
  runOptionActive({}, opt);
  ```
  函数内部抛出的异常会变成 unhandled rejection，用户侧表现为「点击后毫无反应」，且不会有任何错误提示。同一文件的 `runBatch`（895 行）反而是正确的 `await` + try/catch 写法，同一模块内两种标准并存。
- **违反规范**：三.4 代码质量（模块内一致性）
- **修改建议**：统一加 `await` 与 try/catch，或至少 `.catch(e => toast('error', ...))`。

---

### B12. `startup:add` 未做渲染进程来源校验

- **问题分类**：功能安全
- **位置**：`main.js:1843`
- **问题描述**：全项目 101 个 `ipcMain.handle` 中 29 个调用了 `rejectUntrustedRenderer`。逐项核对后的实际覆盖情况：

  | Handler | 行号 | 来源校验 |
  |---|---|---|
  | `cleanup:execute` | 851 | ✅ |
  | `finder:delete` | 1000 | ✅ |
  | `contextmenu:remove` / `toggle` | 1102 / 1129 | ✅ |
  | `optimizer:run` | 1270 | ✅ |
  | `optimizer:backup-reg` / `restore-reg` / `create-restore` | 1538 / 1614 / 1692 | ✅ |
  | `startup:toggle` / `delete` | 1785 / 1808 | ✅ |
  | **`startup:add`** | **1843** | **❌ 遗漏** |
  | `optimizer:check-restore` | 1669 | ❌（只读，影响小）|
  | `log:write` | 734 | ❌（影响小）|

  写操作覆盖面总体不错，但 `startup:add`（可持久化新增开机自启项，属于典型高风险持久化操作）与同族的 `startup:delete` 不一致，明显是逐条手写时的遗漏。
- **违反规范**：二.3「系统级操作的权限校验」
- **修改建议**：补齐 `startup:add` 校验；更根本的做法是把 `ipcMain.handle` 包一层统一注册函数（如 `defineIpc(name, handler, { trusted: true })`），**默认全部校验、只读类显式豁免**，用机制而非记忆来防止遗漏。

---

### B13. 浅色主题三级文字对比度未达 WCAG AA

- **问题分类**：无障碍
- **位置**：`src/styles/main.css:122` `--fg-tertiary: #737987`
- **问题描述**：规范强制要求的两组色值（标题 `#1c1e24`、正文 `#4b505b`）实测均达 AAA ✅。但三级文字 `--fg-tertiary: #737987` 在页面底色 `#F5F6F8` 上实测仅 **4.03:1**，低于 WCAG AA 对正文的 4.5:1 要求。该变量常用于说明性小字（字号更小，实际更需要对比度）。
- **违反规范**：三.5「颜色对比度是否达标」（规范 1 的强制色值已达标，此项为审查重点范围内的额外发现）
- **修改建议**：调整至 **`#6A7080`（4.58:1）** 或 **`#666C7C`（4.85:1）**，改动极小且视觉几乎无感。

---

### B14. 构建产物被镜像进源码树，存在版本不同步风险

- **问题分类**：代码质量 + 规范不符
- **位置**：`TuneForge goujian\trim-installer\src-tauri\resources\app\`（Electron `win-unpacked` 全量副本）
- **问题描述**：构建顺序本身**符合规范**（Electron 产物 → 镜像到 Tauri resources → 构建安装器）✅。但该镜像副本直接落在源码目录内，带来两个问题：
  1. 仓库/磁盘膨胀（最终 Setup 产物 412MB）。
  2. **重新构建 Electron 后若忘记同步镜像，安装器会打包旧版本**——这类错误非常隐蔽，安装器外观与版本号都正常，但内部是旧代码。
- **违反规范**：二.4（构建顺序符合，产物管理存在风险）
- **修改建议**：加一个 `sync:resources` 脚本（`robocopy build-release\win-unpacked → resources\app`，`/MIR` + 排除日志），串进 `beforeBuildCommand`；并把 `resources/app` 加入 `.gitignore`。

---

## 四、💭 低危问题

### C1. 应用数据目录硬编码拼接
- **问题分类**：代码质量
- **位置**：`main.js:124-127` `path.join(os.homedir(), 'AppData', 'Roaming', 'Trim')`
- **问题描述**：未使用 `app.getPath('userData')`。绝大多数情况下二者一致，但在 USERPROFILE 被重定向、或以 portable 形态运行时可能不符预期（本项目恰好有 portable 构建目标）。
- **建议**：优先 `app.getPath('userData')`，硬编码路径仅保留给 CleanTool→Trim 的旧数据迁移兜底。

### C2. close 事件双写
- **问题分类**：代码质量
- **位置**：`main.js:654` `mainWindow.on('close', saveWindowState)` 与 `main.js:2953` `registerShutdownHook()` 内的 close 拦截
- **问题描述**：两个 close 监听并存，`saveWindowState` 先执行。若关闭流程最终被取消（或走超时兜底），窗口状态仍已被写入。
- **建议**：合并为单一 close 处理函数，在确认真正退出时才保存状态。

### C3. pwsh 候选路径包含 WindowsApps 存根
- **问题分类**：代码质量
- **位置**：`main.js:263-267`
- **问题描述**：候选列表含 `%LOCALAPPDATA%\Microsoft\WindowsApps\pwsh.exe`。这是应用执行别名存根，未安装 PowerShell 7 时执行会尝试拉起 Microsoft Store。虽有 `isPowerShell7Executable` 前置校验（`spawnSync` + 5s 超时），但探测阶段本身可能产生 Store 弹窗或额外耗时。
- **建议**：把该候选降到 `where.exe` 之后，或探测前先判断存根文件大小（真实 pwsh 存根为 0 字节）。

### C4. Tauri 安装器 CSP 允许 unsafe-inline 样式
- **问题分类**：功能安全（低）
- **位置**：`trim-installer\src-tauri\tauri.conf.json` → `app.security.csp`
- **问题描述**：`style-src 'self' 'unsafe-inline'`。React 内联样式通常需要此项，风险有限，但与 Electron 主程序的安全基线存在落差。
- **建议**：若构建后无实际内联样式依赖可收紧；至少补充 `object-src 'none'` 与 `base-uri 'none'`。

### C5. `tauri.conf.json` 与实际产物状态不一致
- **问题分类**：代码质量
- **位置**：`trim-installer\src-tauri\tauri.conf.json` → `"bundle": { "active": false }`；目录中存在 `Trim-Setup-2.0.0.exe`（412MB）
- **问题描述**：配置声明不打包，实际却产出了安装包，说明构建时临时改过配置或走了其它路径。配置与产物状态不一致，下次构建可能产出不符预期的结果。
- **建议**：确认最终构建流程，把生效配置固化（或用 `--config` 覆盖文件），避免依赖手工临时改动。

### C6. 拖尾图层禁用时不移除
- **问题分类**：性能问题（低）
- **位置**：`src/scripts/mouse-trail.js:35-38`
- **问题描述**：`setEnabled(false)` 只执行 `layer.textContent = ''` 清空光点，`layer` 元素本身保留在 DOM 中（CSS `body:not(.mouse-trail-on) .mouse-trail-layer { display: none }` 已隐藏）。影响极小，仅一个空 div。
- **建议**：无需强制修改；若追求极致，可在禁用时 `layer.remove()` 并把 `layer` 置 null。

---

## 五、实测附录：WCAG 对比度

脚本按 WCAG 2.1 相对亮度公式实测（深色对比基底/卡片，浅色对比页面底/卡片）：

| 组合 | 对比度 | 结论 |
|---|---|---|
| 浅色 标题 `#1C1E24` on `#F5F6F8` | **15.41 : 1** | AAA ✅（规范强制值，达标）|
| 浅色 正文 `#4B505B` on `#F5F6F8` | **7.48 : 1** | AAA ✅（规范强制值，达标）|
| 浅色 正文 `#4B505B` on 卡片 `#FFFFFF` | 8.08 : 1 | AAA ✅ |
| **浅色 三级 `#737987` on `#F5F6F8`** | **4.03 : 1** | **未达 AA（4.5:1）❌** |
| 深色 主文 `#F4F6FA` on 基底 `#0F1115` | 17.47 : 1 | AAA ✅ |
| 深色 次文 `#C3C9D4` on 卡片 `#171A21` | 10.47 : 1 | AAA ✅ |
| 深色 三级 `#8B93A5` on 卡片 `#171A21` | 5.65 : 1 | AA ✅ |
| 深色 主按钮字 `#171832` on 强调 `#8B8EE0` | 5.81 : 1 | AA ✅ |
| 深色 强调 `#8B8EE0` on 卡片 `#171A21` | 5.84 : 1 | AA ✅ |

**唯一未达标项**：浅色主题 `--fg-tertiary: #737987`（4.03:1）。候选修正值实测：`#6A7080` → 4.58:1，`#666C7C` → 4.85:1，`#626878` → 5.15:1。

---

## 六、值得肯定的实践

审查中发现的亮点，建议在后续重构中保留：

1. **安全基线扎实**（`main.js:550-554`）：`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true` 三件套齐全；`secureWindowNavigation`（81-95）把导航限制在 `src` 目录内的 `file://`，`window open` 一律 deny、`https` 才放行到外部浏览器。
2. **子进程管理克制且有底线**（`main.js:120-121`、`293-303`）：`backendProcs` PID 白名单登记，退出时**只杀本应用 spawn 的进程，绝不按进程名无差别 kill**——这条注释体现的工程自律，在同类工具里很少见。
3. **删除操作的纵深防御**（`main.js:1000-1013`）：`lastFinderSnapshot` 白名单校验 + `isProtectedDeletePath` 系统路径拦截 + 500 项批量上限，三重防护。
4. **AI 数据上传面严格控制**（`intro.js:231` → `main.js:2600`）：仅上传 `name` / `company` / `scope`，注册表路径与命令行**仅用于本地展示、不上传**，密钥存本地 `settings.json`、不写日志——完全符合规范。
5. **动效 DOM 回收规范**（`app.js:39-53`、`mouse-trail.js:55-58`）：`animationend` / `transitionend` + 兜底 `setTimeout` 双重保障；`prefers-reduced-motion` 时**直接 return 不创建节点**；拖尾层 `pointer-events: none` + `contain: strict` + `z-index` 隔离。
6. **窗口黑闪治理彻底**：5 个窗口（主窗口 + 进程管理 + 大模型管理 + 图片预览 + 外设）全部 `show: false` + `ready-to-show`（`main.js:537/591`、`3733/3743`、`3786/3796`、`3831/3841`、`3913/3923`）。
7. **页面级定时器生命周期管理到位**：`realtime.js:448-461`、`overview.js:205-212`、`netspeed.js:89-111` 均有 `clearInterval` 配对；`switchPage`（`app.js:142-149`）在离开页面时统一停止轮询，避免后台空耗 CPU。
8. **材质降级策略成熟**（`main.js:620-628` 注释 + `main.css:2685+`）：Mica 失效时 CSS 88% 不透明兜底、最大化期间 100% 自绘客户区，把 DWM 材质定位为「可损失的视觉增强」——这个取舍判断很专业。
9. **临时脚本清理覆盖率良好**：39 处 `writeTempScript` 中 38 处在 `finally` 中删除，异常路径也不会遗漏。
10. **旧版本数据迁移**（`main.js:130+`）：CleanTool → Trim 目录一次性迁移，避免用户配置/日志/备份丢失，且失败不阻塞启动。

---

## 七、建议修复顺序

1. **发布前必须处理**：A2（红色二次确认，属于规范硬性要求且用户可见）、A4（启动卡顿）、A3（文件删除无兜底）
2. **发布前建议处理**：A1（临时脚本权限）、B3（还原点误报，影响每次优化体验）、B1（窗口尺寸需与规范对齐或更新规范）
3. **下个迭代规划**：B2、B4、B5、B6、B7、B9、B12、B13
4. **技术债清理**：B10、B11、B14、C 组全部

---

*本报告仅做静态审查与实测校验，未对源码做任何修改。*
