# Trim v2.7.0 更新说明（2026-09-13）

> 用户五项需求驱动的小版本：体检页行动化、优化记录常态化持久化、启动页、关闭即隐、版本 2.7.0。
> 附带：同步用户会话间隙的标题栏覆盖层颜色修复（#F3F3F3 → #f7f8fb，含 theme.js meta 主题色）。

---

## 一、系统体检：去处理 / 忽略（任务1）

- 异常（bad）/ 注意（warn）条目行尾新增两个胶囊按钮：
  - **去处理**：跳转对应功能页。映射 `CHECKUP_JUMP`：可精简服务→电脑优化中心、开机自启→启动项管理、系统盘空间→磁盘清理、电源计划→快捷指令（内有 powercfg.cpl 入口）；无应用内处理手段的项（CPU 拓扑/内存通道/磁盘健康/刷新率/实时防护）只提供「忽略」。
  - **忽略**：条目立即消失，id 写入 localStorage `winclean-checkup-ignored`（JSON 数组，持久生效）；标题行旁出现「已忽略 N 项，点击恢复」链接，一键全部恢复。
- 已忽略项不再参与排序露出；全部被忽略时列表显示空态文案。
- test-features 断言：忽略键存在 + 跳转目标必须是导航里真实存在的 data-page 键。

## 二、优化记录常态化持久化（任务2）

**v2.6.0 已实现的**：执行前记账（pending→applied，fail-closed）+ 执行后回读验证（pass/partial/unknown）——这两条已在 `optimization-state.json` 落盘。

**v2.7.0 新增的**：`detected` 段——「哪些条目已做过优化」的检测结果持久化：

- **首次启动即扫描**：whenReady + 3s 后台跑 `refreshOptimizerDetectCache()`（checkOptimizedInternal 全量可检测项 + svc_mem_gb 动态项），结果写入 `optimization-state.json` 的 `detected[id] = { optimized, at }`。
- **及时回写**：执行成功（pass/partial）与还原成功立即 `setDetectedEntry` 单条更新，不等下次启动。
- **API 语义**：`replaceDetected` = 全量替换（启动扫描用）；`setDetectedEntry` = 单条及时写。
- **渲染层收益**：优化中心打开时先用持久化缓存即时灰化（首启 3s 扫描未完成也有反馈），随后实时检测作为**权威源**增删灰态（此前实时检测只加不减）。
- **存放位置**（用户确认）：安装版 `%APPDATA%\Trim\optimization-state.json`；便携版程序目录 `data\optimization-state.json`（沿用 v2.6.0 便携数据目录机制，**不写入 docs规范**——那是文档目录，运行时数据与文档混放会破坏整洁且打包便携版不含该目录）。

## 三、启动页（任务3）

- 参考 `hero-preview/index.html` 移植：WebGL 流线背景（烟→淡紫偏白，流星→黄白；shader 作者 Matthias Hurrle，Trim 改色版）+「Provided By Xiaoxu」徽章 + 简介 + 进度条。
- **双模式**：首次启动完整体验（进度走完出现「点击进入」，点击后落位）；之后每次启动紧凑模式（仅 Trim+进度，自动落位）。`trim_splash_seen` 记录是否首访。
- **落位动画**：背景层与辅助元素淡出，"Trim" 大字以 FLIP transform（`0.9s cubic-bezier(.16,1,.3,1)`，PowerPoint「平滑」手感）平移缩放到标题栏 `.titlebar-title` 处落位；落位前同步目标 computed color/letterSpacing，落位瞬间与真实品牌无缝衔接（`body:has(.splash-overlay:not(.finished))` 期间隐藏真实标题）。
- **移植时修掉参考页的两个动画 bug**（hero-preview 原文件仍带此 bug，未改动——非本任务范围）：
  1. 入场动画 `splashTrimIn` 的 fill both 状态持续占用 transform，优先级高于 transition，FLIP 会被动画终帧钉死 → 落位前 `animation='none'`；
  2. transition 与 transform 同帧写入 → before-change style 无 transition 定义，过渡不触发直接跳变 → 写 transform 前强制一次样式重流（`void offsetWidth`）。
- 兜底链：reduced-motion 直接进主界面（无动画）；目标元素缺失直接淡出；transitionend 丢失有 1.3s 定时兜底；整体 15s 硬兜底强制 finish；WebGL 初始化失败退回静态渐变。进入后停止 rAF 渲染释放 GPU。
- 结构约束：无内联脚本（CSP）；`splash.js` 必须是 body 末尾脚本中**第一个**加载（独立无依赖）。

## 四、关闭即隐（任务4）

- 旧流程（已移除）：close → 渲染层「感谢使用」Toast 四步动画 → shutdown:complete → 退出。
- 新流程：**点击 X → 窗口立即隐藏（用户视角=已关闭）→ 主进程后台静默收尾 → 自动退出**：
  1. close 钩子 `preventDefault + hide`，标记关闭态，调 `requestSilentQuit()`；
  2. 静默等待删除类任务落定（`activeCleanupRuns` 计数 cleanup:execute；`maintenanceRunning` 维护任务）——清理结果不可回滚，半途强退丢统计；窗口已隐藏，用户无感；
  3. `app.quit()` → before-quit：`flushLogSync` 刷盘日志 + `saveWindowState` + taskkill 全部登记子进程（pwsh/finder，即所有网络连接与 IO 的载体）+ `cleanupTempScripts` 清理临时脚本；
  4. 兜底：quit 被意外阻塞 5s 后 `app.exit(0)` 强制退出。
- 渲染层 app.js 不再监听 `app:shutdown`、不再弹任何关闭提示；`shutdown:begin/complete` 通道保留作扩展点（preload 白名单未动）。
- 更新安装路径（`updater:install`）提前置关闭态，防止 close 钩子 preventDefault 卡住 `quitAndInstall` 的窗口替换。

## 五、其它

- 同步用户修复：`TITLEBAR_OVERLAY.color` #F3F3F3 → **#f7f8fb**（与 `body.theme-light .titlebar` 实际渲染色一致，消除右上角原生按钮的独立浅灰条）+ `theme.js` meta theme-color 同步；test-features 断言已跟进锁定新值。
- 版本 2.6.0 → **2.7.0**；readme 版本行 2.7 + 体检页表格行 + 已应用清单「首启扫描持久化」描述 + 启动/关闭小知识。
- test-features 第 7 段 4 项新断言（detected 持久化含重读、体检映射、启动页结构、关闭即隐），全量 **96 项通过**。
- CDP 真机验证：探针 9/9（FLIP 五帧采样捕获动画中间态、忽略/恢复/跳转、detected 落盘 82 项）+ 关闭即隐 3/3（窗口立即隐藏 + 10s 内进程自动退出）+ 落位中途截图目检。

## 六、已知边界

- 体检「去处理」对无应用内修复手段的项不提供按钮（诚实原则，不伪造可处理性）。
- 启动页「点击进入」仅首次出现；如需改成全自动，改 splash.js 中 `isFirstVisit` 分支即可。
- 关闭即隐下，若清理任务执行中点 X，窗口立即消失但进程会静默活到清理完成（最长 10 分钟）才退出——这是设计行为，防止丢删除统计。
- hero-preview/index.html（参考页）仍带两个动画 bug（见第三节），如需修复改两行即可。
