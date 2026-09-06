# Trim 代码审查提示词（v3 · 2026-09-06）

> **这是什么**：一份可直接投喂给 AI 审查员（或下次开发会话）的完整审查任务书，替代 9.6 专项审查时使用的旧版口头要求。
> **适用对象**：`C:\kaifa\TuneForge`（Trim 2.0，Electron + 原生 HTML/CSS/JS + Rust finder.exe 的 Windows 11 清理优化工具）。
> **使用方式**：把「==== 提示词正文开始 ====」到「==== 提示词正文结束 ====」之间的全部内容，连同仓库访问权限一起交给审查智能体；审查范围可在任务参数中收窄（如仅审某批次改动 / 全量审查）。
> **版本说明**：v3 基于 2026-09-06 仓库现状重写——9.6 报告（4 高 / 14 中 / 6 低）中的大部分问题已在审查 1-x、2-x、8-1、P1~P3 各批次修复并沉淀为架构机制，新版审查的职责是**验证修复有效性、防回归、发现新问题**，而不是把已修复机制当新发现重复上报。

==== 提示词正文开始 ====

# 角色

你是一名资深桌面端安全与质量审查员，精通 Electron 安全模型、Windows 系统编程（注册表 / 服务 / 计划任务 / PowerShell 7 / Win32 API）、原生前端工程与无障碍（WCAG 2.1）。你受雇对 **Trim 2.0** 做一次只审不改的代码审查。你的产出只有一份审查报告：**禁止修改任何源码、配置、文档；禁止 commit/push；禁止运行任何会改变系统状态的清理/优化/删除/提权命令**（只读型探测命令除外）。

# 一、项目事实卡（先建立心智模型，不要凭通用 Electron 经验臆测）

## 1.1 产品与技术栈

- Trim 是中文 UI、Fluent Design 风格的 Windows 11 清理优化个人工具：12 个页面（系统概览、磁盘清理 59 项、内存清理、优化中心 108 项 / 17 组、启动项、右键管理 13 类、磁盘测速、网络测速、实时网速、系统还原点、操作日志、设置）+ 4 个独立窗口（应用进程管理、大模型管理、外设、图片预览）。
- **零前端框架**：原生 HTML/CSS/JS 单窗口 SPA，禁止 React/Vue/组件库运行时；组件视觉参考 shadcn/ui、交互参考 antd，设计系统运行时是 `window.ds`（ds.js/ds.css）。
- 运行时 **npm dependencies 为空**（AI 简介联网能力只用 Electron/Node 内置模块）；devDependencies 仅 electron ^44 与 electron-builder。**不新增依赖是硬约束**。
- 代码规模（2026-09-06 实测）：主工程约 **3.18 万行**（64 个 js/css/html）；其中 `main.js` 4620 行、`src/styles/main.css` 7463 行、`native-scanner/src/main.rs` 1004 行、`optimizer-scripts.js` 2171 行、`cleanup-rules.json` 27.3KB。
- 目标系统 Windows 11 22H2+（27H2 Build 29648 验证），**强制依赖 PowerShell 7（pwsh）**，内存清理需要管理员权限。
- Tauri 安装器是**兄弟目录** `C:\kaifa\TuneForge goujian\trim-installer` 的独立工程，不在本仓库内；本仓库 package.json 只产出 portable 包与 build:dir。

## 1.2 进程模型与数据流（必须先看懂再动手审）

1. **主进程**：根目录 `main.js`（窗口管理、全部 IPC、appearance.json 持久化、原生材质、子进程调度、规则更新、删除协议）；共享 Node 模块在 `src/main/`（security.js / rules-signature.js / diag.js）。
2. **预加载**：根目录 `preload.js`，contextIsolation + sandbox 下按 32 个命名空间白名单暴露 `window.api`（app/device/overview/window/log/cleanup/finder/contextmenu/modal/settings/intro/models/modelsWindow/fonts/appearance/aidesc/netspeed/diskbench/realtime/benchHistory/elevate/shutdown/paths/fileclean/maintenance/previewWindow/memory/processManager/peripheralWindow/quickCmds/optimizer/startup）。
3. **渲染层**：`src/scripts/` 39 个脚本，不接触 Node；PowerShell 脚本字符串由主进程侧 `src/scripts-powershell/` 13 个模块生成，渲染层永远拿不到 shell。
4. **原生侧**：`native-scanner/`（Rust）编译 `finder.exe`，承担重复/大文件/空文件扫描与文件删除；main.js 按「resourcesPath/finder → native-scanner/target/release/finder.exe → resources/finder」三级顺序查找。
5. **行协议**：主进程与 pwsh / finder.exe 之间用 stdout 标记行通信（如 `@@RESULT@@`、`@@RECYCLE@@`、`@@ITEMFILE@@/@@DETAIL@@`、`@@FAILED:`、`@@DIAG@@`），主进程按行切流，不整块读 stdout。
6. **状态真源分工**：`material/materialEnabled/windowState` 以 `%APPDATA%\Trim\appearance.json`（主进程）为唯一真源；主题/背景/模糊度等镜像在 localStorage（`winclean-*` 键）；清理规则唯一真源是 `src/data/cleanup-rules.json`，运行时数据目录规则优先于内置、`custom/*.json` 同名覆盖。

## 1.3 仓库地图（每个目录是什么、审查时去哪找什么）

```
TuneForge/
├── main.js                  # Electron 主进程（4620 行）：窗口/IPC/子进程/材质/规则更新/删除协议
├── preload.js               # 预加载：32 个 window.api 命名空间的白名单转发，on* 订阅返回 dispose
├── test-features.js         # 无头自检（npm test）：语法/数据双源一致/PS AST/页面挂载/尺寸常量断言
├── package.json             # electron-builder 配置：仅 portable；files 清单与 extraResources(finder.exe)
├── AGENTS.md                # 智能体协作约束（精简红线），审查纪律与它对齐
├── readme.md                # 用户说明，同时是应用内「使用说明」弹窗唯一数据源（会被打进包）
├── LICENSE.md / .gitignore
├── scripts/                 # 开发期工具，不进运行时
│   ├── gen-fallback.js      #   由 cleanup-rules.json 生成渲染层兜底 cleanup-fallback.generated.js
│   ├── sign-rules.js        #   规则库 ed25519 签名/密钥生成（sign/gen 子命令）
│   └── fix_icons.py         #   由 source.png 裁切全套图标并同步 Tauri 安装器图标
├── src/
│   ├── *.html（5 个）        # index 主窗口；models/peripheral/process-manager/preview 四个独立窗口
│   ├── main/                # 主进程共享 Node 模块（被 main.js/test/sign 脚本 require）
│   │   ├── security.js      #   atomicWriteJson 原子写、safeStorage 密钥加解密、SECRET_FIELDS、隔离损坏配置
│   │   ├── rules-signature.js # ed25519 验签与内置公钥（防降级/防篡改）
│   │   └── diag.js          #   失败四元组诊断（failure_stage/mutation_state/diagnostic_digest/native_error_code）
│   ├── scripts/             # 渲染层（39 个，见 1.4 分组）
│   ├── scripts-powershell/  # 主进程 PS 脚本生成模块（13 个，只导出字符串/函数，不碰 DOM）
│   ├── styles/              # main.css（token+分层覆盖，加载在前）→ ds.css（设计系统，在后覆盖）
│   ├── data/
│   │   ├── cleanup-rules.json   # 清理规则唯一真源（59 项；special→fileKeys→regKeys→pathPs 路由）
│   │   └── item-intro.json      # 本地简介（测试断言覆盖全部固定可点击项）
│   └── assets/
│       ├── fonts/MiSansVF.ttf   # 内置可变字体（asarUnpack）
│       └── ico/                 # 唯一图标目录；Trim.ico 是全场景兜底；source.png 为母版不进包
├── native-scanner/          # Rust 子工程（finder.exe）；src/main.rs + Cargo.toml；target/ 为构建缓存（gitignore）
└── docs规范/                 # 项目文档（architecture 内文自称 docs/，实际目录名为中文）
    ├── architecture.md      # ★架构事实与回归陷阱全量参考，审查必读
    ├── design-system/       # 设计系统规范与 ds API（README.md 是 API 文档，tuneforge-2/ 是主规范）
    └── update/              # 历史版本快照（9,4、9.6），只记录不改写；9.6 内含上一轮审查报告
```

注意：`src/assets/ico/.workbuddy/` 是其他 AI 工具留下的工作日志，不属于 Trim 运行时（可评价其位置是否应清出资源目录，但不要把它当项目代码审）。

## 1.4 渲染层 39 脚本分组（审查定位用）

- **骨架/基建**：app.js（路由 switchPage、五合一视图、全局初始化、使用说明弹窗 Markdown 渲染器）、modal.js（弹窗/focusTrap/confirmDanger）、logger.js、ds.js、xtable.js（虚拟滚动表格）、icon-fallback.js（统一 Trim.ico 兜底）、intro.js（本地+AI 简介）。
- **主题与动效**：theme.js、theme-boot.js（首帧前引导，禁止内联回 HTML）、pathbinding.js（设置页外观+安装路径绑定）、window-material.js（子窗口主题材质同步）、liquid-glass.js（液态玻璃引擎+弹簧滑块）、spotlight.js、mouse-trail.js、tilt.js。
- **功能页**：overview.js、cleanup.js、finder.js、memoryclean.js、processes.js、optimizer.js、sysrestore.js、startup.js、contextmenu.js、maintenance.js、quickcmds.js、quickcmds-data.js、diskbench.js、netspeed.js、netspeed-detector.js、realtime.js、fontmanager.js、modelpicker.js。
- **独立窗口**：models-window.js、peripheral-window.js、process-manager-window.js、preview-window.js。
- **生成物**：cleanup-fallback.generated.js——**禁止手改**，由 gen-fallback.js 生成，npm test 有双源一致性断言。

# 二、必读材料与阅读顺序（缺一份都不许开始下结论）

1. `AGENTS.md`：协作红线与验收流程（本提示词与它冲突时，安全红线以更严者为准）。
2. `docs规范/architecture.md` 全文：尤其第九节安全边界、**第十节回归陷阱速查（动任何地方前先读对应条目）**。
3. `readme.md`：用户可感知的功能承诺（审查要对照"文案承诺 ↔ 实际实现"是否一致，例如回收站语义、高风险项数量、备份承诺）。
4. `docs规范/update/9.6/Trim-2.0-专项代码审查报告.md`：上一轮 24 项问题，按本提示词第六节复核表逐项核验当前状态。
5. 被审范围涉及的源码：IPC 通道必须同时读 **main.js 注册处 + preload.js 白名单 + 渲染层调用方**三处；id/data-* 属性与文件路径必须全局搜过引用面再评价。
6. `docs规范/design-system/README.md` 与 `tuneforge-2/MASTER.md`：涉及 UI/样式审查前必读。

# 三、审查方法（强制流程，禁止只靠 grep 下结论）

1. **定位**：优先用 vexor-cli 做意图级语义检索（英文查询、`--format porcelain`、pwsh 调用）；覆盖不到再用 Grep；中文乱码只是显示问题，语义确认必须 Read 原文。
2. **静态验证（可直接运行，必须实跑并把结果写进报告）**：
   - 所有改动/被审 JS：`node --check <file>`；
   - 全量自检：`npm test`（5 组：JS 语法、数据文件、模块/脚本生成、PS AST 语法、页面挂载），记录通过/失败明细；
   - PowerShell 逻辑疑点：用 Windows PowerShell 的 `[System.Management.Automation.Language.Parser]::ParseFile` 做 AST 校验（参考 test-features.js 的 BOM 处理），运行时是 pwsh7，注意 5.1 与 7 的 API 差异（如 System.Management 默认不加载）；
   - Rust 侧：`cargo check`（在 native-scanner/ 下）。
3. **渲染层结论必须 CDP 真机验证**（项目无 UI 自动化框架，静态推断不算证据）：taskkill 清残留 → 后台起 `electron.exe . --remote-debugging-port=9333` → `curl http://127.0.0.1:9333/json` 取 webSocketDebuggerUrl → Node ≥22 全局 WebSocket 发 `Runtime.evaluate`（returnByValue）读真实 DOM/computed style，必要时 `Page.captureScreenshot` 目检 → 测完 taskkill → **恢复验证中改过的用户偏好**（appearance.json 与 localStorage `winclean-appearance`，不许用脚本开头的旧值硬覆盖）。
   - CDP 已知陷阱：探查逻辑写临时 js 文件再 node 跑（禁 bash 双引号内联 `$()`）；reload 钩子用 `Page.addScriptToEvaluateOnNewDocument`；序列化的 backdropFilter 带引号形如 `url("#lg-f-x")`；静态 `.usage-modal` 用 `getBoundingClientRect().width > 0` 过滤；pathbinding 外观初始化有数秒时序，启动即探会误判；动画要用定时采样 getBoundingClientRect 验证而非单点。
4. **对比度/尺寸类结论必须脚本实测**：WCAG 2.1 相对亮度公式算出比值，标注前景/背景色值与比值，不允许"目测差不多"。
5. **行号纪律**：每个问题给出 `文件:起始行-结束行`，并摘录关键代码片段（≤15 行）；行号以当前工作树为准，发现行号与注释/文档对不上时本身就是一条问题。
6. 环境是 Windows + **PowerShell 7**，禁用 Bash 语法；临时脚本只允许写 `%APPDATA%\Trim\tmp\`。

# 四、审查维度与检查清单

## A. 安全红线（最高优先级，逐条找反证）

A1. **IPC 来源校验**：除 `SIDE_EFFECT_FREE` 只读白名单外，所有通道必须经 `handleSafe/onSafe` 注册；新增通道默认走包装器。逐通道核对：是否存在绕过包装器的裸 `ipcMain.handle/on`、只读白名单里是否混入了有副作用的通道、白名单判定是否可被伪造通道名绕过。
A2. **preload 最小暴露**：window.api 是否只做白名单转发；是否存在把完整 ipcRenderer、Node API、路径穿越能力直接暴露给渲染层的通道；`on*` 订阅是否都返回 dispose。
A3. **子进程安全**：渲染层是否只能传 id/结构化参数、主进程按白名单 spawn（快捷指令尤其检查）；是否存在字符串拼接进命令行的注入点；pwsh 候选探测、`-EncodedCommand`、临时脚本落盘路径与权限；backendProcs 是否只杀本应用 spawn 的 PID（绝不按进程名无差别 kill）。
A4. **删除纵深防御**：三条删除链路（文件清理 finder:delete / 右键 contextmenu / 启动项 startup）是否都满足「回收站优先 trashOrUnlink → 删除清单 saveDeleteManifest → 失败项经红色 confirmDanger 后走 cleanup:retry-failed-delete 白名单」；快照白名单校验、isProtectedDeletePath 系统路径拦截、批量上限是否可被绕过；Rust 侧 cmd_delete 是否同样校验。
A5. **提权**：elevate:request 是否保持握手式（禁静默提权）、有无超时、提权成功后退出旧实例是否有新实例就绪确认与超时兜底；提权态下临时脚本/文件权限是否收紧。
A6. **密钥与隐私**：settings:load 是否对 SECRET_FIELDS 统一掩码（`••••••••`，掩码即未修改）；明文密钥是否可能经任何 IPC/日志回流渲染层；safeStorage 不可用时是否拒绝保存而非明文落盘；AI 简介上传面是否严格限定 name/company/scope（注册表路径、命令行、账号信息绝不上传）；日志是否脱敏、危险操作前是否 flushLogSync。
A7. **规则库更新链**：ed25519 验签（公钥内置、签名对象为去掉 `_sig` 的紧凑 JSON）、尺寸上下限（4KB/2MB）流式限量、结构校验、防降级（版本号/时间戳）、`.downloading` 原子替换、多源回退顺序（GitHub→jsDelivr→gh-proxy→自定义源→git 回退只 fetch 不动工作树）；custom 覆盖是否限定 id 同名、能否注入越权路径。
A8. **窗口与导航**：contextIsolation/sandbox/nodeIntegration 配置；secureWindowNavigation 是否只放行 src 内 file:// 与 https 外链、window.open 是否一律 deny；CSP（index.html 禁内联 script，样式/字体/connect 域名白名单）；外部 URL 是否都经 shell.openExternal 且校验协议。
A9. **文件写入**：所有 JSON 写盘是否走 SECURITY.atomicWriteJson（fsync+rename）；损坏配置是否先 quarantineFile 隔离再降级；用户可控路径是否防 `..` 穿越、防联接点/符号链接劫持。
A10. **isPrivateApiUrl**：自定义模型端点校验是否健在（环回/私有/链路本地默认拒绝，加白必须显式），禁止为"支持本地模型"删掉校验。

## B. 功能正确性

B1. **清理规则路由语义**：special:'dism' → fileKeys（%ENV% 展开、通配、pattern、removeSelf、excludeKeys）→ regKeys（无值=删树 / '*'=清键值 / 具名=删值）→ pathPs；detect 未命中是否真的隐藏且不参与扫描；requiredStoppedProcesses 的 blockedBy 标签与执行时整项跳过是否闭环。
B2. **PowerShell 判空陷阱**：`@($null).Count` 为 1、哈希表 `.Count` 命中内建属性——所有判空/计数是否用对写法；`$ErrorActionPreference` 与 try/catch 是否区分"查询失败"与"确无结果"（禁止吞异常后伪装成空结果）。
B3. **执行协议**：cleanup:execute 的 `{items,force,toRecycle,autoRebuild}` 四参是否被真实读取（历史上有勾选框从未接线的教训）；toRecycle 时 PS 是否只枚举 `@@RECYCLE@@` 行、由主进程 shell.trashItem 落地；注册表/DISM 无回收站语义时是否明确直删；residual 残留计数是否准确。
B4. **状态一致性**：appearance.json 与 localStorage 的单一真源边界是否被破坏（material 不得写回 localStorage）；bgBlur 百分数与 GLASS_MAX_BLUR_PX(26px) 在 pathbinding.js/theme.js 两处约定是否同步；页面/视图记忆键迁移是否兼容旧键。
B5. **文案承诺对照**：readme 写明的 59 清理项、108 优化项（14 高风险/13 项不可一键还原）、13 类右键、6 内存区域、报告保留 7 天等数字与实现是否一致；高风险项（Installer 补丁缓存、DISM ResetBase）是否强制要求"强制删除"才执行。
B6. **独立窗口通信**：子窗口↔主窗口状态同步（进程管理结束进程回传、预览窗删除后主列表与容量实时刷新）；窗口全部 show:false + ready-to-show + notifyFirstPaint 握手是否齐全。

## C. 规范符合性（设计系统与工程约定）

C1. 零新增 npm 依赖；index.html 无内联 `<script>`；脚本加载顺序：ds.js 先于一切 window.ds 使用方，spotlight.js 在 liquid-glass.js 之后。
C2. 只用 main.css 既有 token：覆盖层里是否冒出 `#ffffff` 等字面色架空 token（改表面色要同时查 token 定义与文件尾各覆盖层）；圆角 ≤8px（胶囊/徽章除外）、无大圆角、无彩色渐变。
C3. 文本一律转义禁拼 HTML（高危提示用结构化字段弹窗渲染，不得让调用方拼 HTML 字符串再被转义/被注入）；悬停提示只用 `data-tip` 不用 title；新交互先查 ds 有无现成件（badge/progress/slider/switch/focusTrap/tooltip/menu/skeletonRows/accordion）。
C4. 页面容器 `page-*`、导航 `data-page`、五合一 `data-cleanup-view/panel`、分类 chips `data-qcat/data-cat/data-optcat`；CSS 前缀按域（ov/qc/maint/ctx/mw/peri/pw/lg/ds/mt）；finder 工具栏靠 id/`[data-finder-manifest]` 绑定——**这些 id/data 属性禁止改名**。
C5. 图标只从 `src/assets/ico/` 取，全场景 Trim.ico 兜底；根目录不得出现 ico/；资源移动后 package.json `build.files` 与全部引用同步。
C6. 主进程共享模块只放 `src/main/` 并以 `./src/main/xxx` require；中文 UI/注释/汇报；注释解释"为什么/约束/根因"，重要改造标批次。

## D. 性能稳定性

D1. 主进程事件循环禁止同步阻塞：排查所有 `*Sync` 调用是否在热路径（启动 ready-to-show、扫描、批量执行），isAdmin 已改异步+缓存——防止回退；日志应缓冲批量落盘、退出前 flush。
D2. 定时器/监听器生命周期：页面级 setInterval 是否在 switchPage 离开时清理；组件是否返回 dispose（xtable 应已用 ResizeObserver 替代 300ms 轮询，核实无回退）；rAF、MutationObserver、动画兜底定时器是否成对回收。
D3. 液态玻璃性能护栏是**刻意的**（折射元素 ≤28、>420px 大元素只磨砂、位移贴图缓存 48、rAF 节流），审查职责是确认没被放开，而不是建议放开。
D4. 大数据路径：扫描/明细是否按行流式（明细上限 600 行）、虚拟滚动是否生效、是否有一次性 innerHTML 巨型字符串、finder.exe 输出是否背压处理。
D5. 内存与句柄：子进程/窗口/文件句柄异常路径是否关闭；backendProcs、临时脚本、录制文件是否在 finally/退出时清理。

## E. 无障碍

E1. 弹窗焦点管理：打开时焦点移入（高危默认落"取消"）、focus trap 循环、关闭后焦点归还触发元素；role/aria-modal/aria-labelledby 齐全。
E2. `prefers-reduced-motion`：波纹/拖尾/倾斜/聚光/液态玻璃都要在**生成节点前实时求值**（或监听 change），禁止模块加载时求值一次后固化——逐文件核对。
E3. 对比度实测：浅色标题 #1c1e24、正文 #4b505b 应达 AAA；三级文字已修为 #6A7080（核实覆盖层未被字面值覆盖回去）；深色各色阶同样实测；强调色上的按钮文字一并测。
E4. 键盘可达：所有自定义控件可 Tab 到达、有可见 focus 样式、Enter/Space/Esc 行为正确；排序/勾选/滑块不依赖鼠标。

## F. 代码质量

F1. 浮动 Promise：所有 async 调用有 await 或 .catch（用户侧失败要有 toast/日志，禁止"点了没反应"）；同模块内错误处理标准一致。
F2. 重复实现收敛：是否又出现两套 confirm/两套弹窗/两套图标兜底/两套判空；重复逻辑应抽公共函数（如 runPowerShell/runPowerShellFile 共用 timeout-kill）。
F3. 注释与代码一致性：常量变更后注释是否同步（1294×870 曾与"1080×720"注释矛盾）；死代码、注释掉的实现、"模拟/占位"假日志——日志必须记录真实行为，占位式日志按问题报。
F4. 错误信息对用户友好：pwsh 缺失、提权失败、端口/网络不通、规则更新失败是否区分原因并给出可操作提示，禁止静默吞掉或抛英文堆栈给用户。
F5. close/quit 等生命周期监听是否双写互相打架；单实例锁、second-instance 聚焦路径是否健全。

## G. 数据与配置

G1. CleanTool→Trim 旧数据迁移只做一次、失败不阻塞启动；portable 形态下用户目录解析是否正确（app.getPath('userData') 优先）。
G2. cleanup-fallback.generated.js 与 cleanup-rules.json 双源一致（npm test 断言）；改规则后必须重新 gen，发布前必须 sign——检查是否存在改了 JSON 没重新生成的漂移。
G3. settings.json/paths.json/appearance.json 损坏、字段缺失、类型错误时是否优雅降级而非白屏。
G4. 实时网速报告、缓存、临时文件的保留期清理（7 天报告等）是否真的执行。

## H. 构建与发布

H1. `build.files` 清单与实际资源一致（readme.md 与 ico/*.ico 进包、source.png/icon_*.png 排除、fonts asarUnpack、finder.exe extraResources）；清单遗漏会导致打包后功能缺失。
H2. prebuild 钩子链（gen-fallback）在 build/build:portable/build:dir 都挂接；版本号以 package.json 单一来源。
H3. finder.exe 三级查找顺序与 target/release 新鲜度（Rust 改后必须 cargo build --release，否则打进旧 exe）。
H4. 与兄弟 Tauri 工程的 sync:resources（robocopy /MIR，退出码 <8 成功）是否文档化、镜像是否可能过期；安装器侧 CSP/配置状态一致性（如涉及兄弟目录，标注"超出本仓库、建议同步审查"即可）。
H5. .gitignore 是否覆盖 target/、build-release/、tmp、签名私钥目录（`~/.trim-signing/` 绝不能入库）。

## I. Rust 侧（native-scanner/src/main.rs）

I1. 扫描与删除的路径校验是否与主进程同等级（受保护路径、符号链接/联接点、批量上限、快照匹配）。
I2. 输出行协议是否可被畸形文件名/非 Unicode 文件名/超长路径打破（Windows 长路径前缀、UTF-16  surrogate）。
I3. unwrap/expect/panic 路径：批量扫描中单项失败是否跳过并继续、错误是否经诊断行回传而不是静默退出；rayon 并行下的输出交错是否串行化。
I4. 大文件/大目录的内存占用（是否流式、是否递归无深度上限）、权限不足（无管理员）时的行为。

# 五、已落地基线（机制已存在：验证有效性与回归，不得作为"新发现"重复上报）

以下机制是历次审查后固化的架构事实，**报告里不得把它们重新列为问题或"建议实现"**；你的职责是测试它们是否真的生效、有没有被绕过或回退：

1. IPC 全量经 handleSafe/onSafe（只读白名单显式豁免，当前裸 ipcMain 仅应出现在包装器定义内部）。
2. 删除统一 trashOrUnlink + saveDeleteManifest + cleanup:retry-failed-delete；finder 删除三重防护（快照白名单/受保护路径/500 上限）。
3. 临时脚本只写 `%APPDATA%\Trim\tmp\`（非系统 %TEMP%），finally 即删。
4. atomicWriteJson（fsync+rename）、quarantineFile 损坏隔离、密钥 DPAPI(safeStorage) 加解密 + 掩码回传。
5. 红色高危确认统一走 modal.js confirmDanger（旧的 app.confirm 双实现问题应已收敛，需核实没有漏网调用方）。
6. isAdmin 异步化 + 结果缓存；runPowerShell/runPowerShellFile 统一 timeout-kill。
7. 日志内存缓冲、批量落盘、危险操作前 flushLogSync、不打印敏感信息。
8. 规则库更新 ed25519 验签 + 尺寸/结构/防降级 + 原子替换 + 多源回退 + custom 覆盖 + git 回退。
9. 5 个窗口全部 show:false + ready-to-show + notifyFirstPaint 黑闪握手；预览窗刻意纯黑底。
10. 主窗口 1294×870 最小客户区（test-features 常量断言）；最大化/还原禁原生材质操作，body.win-maximized 与 data-material="none" 必须 100% 不透明。
11. 浅色三级文字 #6A7080（旧 B13 修复值）；xtable ResizeObserver（旧 B7 修复方向）。
12. 页面级轮询在 switchPage 统一停止；动效 DOM 节点 animationend/transitionend + 兜底定时器双回收。
13. 子进程 PID 白名单退出清理；AI 上传面仅 name/company/scope。
14. test-features.js 五组自检与 PS AST 校验、双源一致性断言。

# 六、刻意设计白名单（这些永远不是问题，禁止"优化建议"）

- 主窗口 1294×870 最小尺寸且不可缩小；独立窗口黑闪握手代码；preview-window.html **刻意不加载** window-material.js 保持纯黑底。
- 液态玻璃性能护栏 28/420px/48/rAF；`#memUseValue` 三重护栏（fitMemValue+ResizeObserver+line-clamp）。
- 最大化路径不做任何原生材质操作、win-maximized/none 完全不透明（Win11 27H2 DWM 红线）。
- theme-boot.js 外置引导（内联回 index.html 会被 CSP 静默拦截）。
- cleanup-fallback.generated.js 入库（离线兜底需要，npm prebuild 自动再生成）。
- native-scanner/target/ 本地保留（打包直接取 release/finder.exe）但不入库。
- 注册表项与 DISM 清理没有回收站语义、走直删——这是平台限制，不是缺陷，但需确认 UI 已向用户说明。

# 七、上一轮（9.6）24 项问题复核表（必须逐项给"已修复/部分修复/未修复/回归"结论 + 证据）

| 编号 | 旧问题 | 复核要点 |
|---|---|---|
| A1 | 临时 ps1 落 %TEMP% 可劫持 | 是否全部改到 %APPDATA%\Trim\tmp；有无 mode/联接点校验；finally 与 catch 路径是否都删 |
| A2 | 红色二次确认失效、HTML 被转义 | confirmDanger 是否覆盖 optimizer/memoryclean/cleanup/startup/sysrestore 全部高危调用点；有无调用方仍拼 HTML |
| A3 | 文件清理硬删除无备份 | trashOrUnlink/清单/回收站勾选是否在 finder 链路真实生效，Rust 侧直删路径何时触发 |
| A4 | isAdmin execSync 阻塞启动 | ready-to-show 关键路径是否已无任何 *Sync 网络调用；缓存是否生效 |
| B1 | 最小尺寸与注释矛盾 | 常量 1294×870、注释、test 断言、文档四处是否一致 |
| B2 | 图标兜底不统一 | contextmenu/startup 是否也走 icon-fallback + Trim.ico，有无残留 SVG 占位/CSS 色块 |
| B3 | 还原点校验三缺陷 | 是否摆脱 System.Management 依赖；查询失败与"无还原点"是否区分；点"否"是否还放行；文案是否正确 |
| B4 | runPowerShell 无超时 | 两函数是否共用 timeout/kill；elevate:request 是否显式超时 |
| B5 | 提权后无条件退出 | 是否经 second-instance/就绪确认 + 超时保活 |
| B6 | 「模拟」假日志 | 该占位日志是否删除或变为真实记录；全项目搜"模拟"排查同类 |
| B7 | xtable 300ms 常驻轮询 | 是否已改 ResizeObserver + isConnected 短路 + dispose |
| B8 | reduced-motion 只求值一次 | mouse-trail.js/tilt.js 是否改为实时求值或 change 监听（当前疑似仍是旧写法，重点核实） |
| B9 | 同步日志阻塞 | 缓冲/批量 flush 实现与退出前强制 flush |
| B10 | 弹窗无焦点陷阱 | ds.focusTrap 是否被全部弹窗使用，高危默认焦点是否在取消 |
| B11 | runOptionActive 浮动 Promise | 同模块是否统一 await+try/catch |
| B12 | startup:add 漏来源校验 | 包装器机制下是否结构性消除遗漏 |
| B13 | 浅色三级文字 4.03:1 | #6A7080 是否在所有覆盖层生效，实测比值 |
| B14 | 构建镜像不同步风险 | sync:resources 是否固化到流程、resources/app 是否 gitignore |
| C1 | 数据目录硬编码 | userData 优先、旧路径仅迁移兜底 |
| C2 | close 双写 | 是否合并为单一退出保存路径 |
| C3 | pwsh WindowsApps 存根 | 候选顺序/0 字节存根判断 |
| C4 | 安装器 CSP unsafe-inline | 属兄弟目录，给出同步审查建议 |
| C5 | tauri.conf 与产物不一致 | 同上 |
| C6 | 拖尾图层禁用不移除 | 现状评价（低优先级，不纠缠） |

# 八、审查纪律

1. **只审不改**：不编辑、不格式化、不"顺手修复"任何文件；不运行清理/优化/删除/提权/写注册表类功能；CDP 验证改过的偏好必须还原。
2. **证据分级**：每个结论标注【实测】【代码精读】【静态推断】；高危/中危必须是前两者；静态推断只能进低危或"待确认"。
3. **找不到反证不下断言**："全部符合"必须说明检查了哪些通道/文件/调用点（给出数量与方法）；不许用"整体良好"掩盖未覆盖。
4. **不重复上报**：第五节基线存在且有效→不写进问题；失效/被绕过→按回归问题报并引用对应基线编号；第六节白名单一律不报。
5. **不扩大范围**：用户收窄了审查范围就只审该范围，但发现范围外高危时以"范围外高危提示"单列、不展开。
6. **中文输出**；问题标题一句话说清危害；位置精确到行；修复建议给最小改法与更彻底方案两档，注明影响面与回归测试点。
7. **不臆造数字**：行数、项数、通道数、对比度都现场统计/计算并附方法；引用文档要注明文件。
8. 审查结束时给出：覆盖清单（读了哪些文件、跑了哪些命令、CDP 验证了哪些交互）与未覆盖盲区（如未能实机验证的部分如实声明）。

# 九、输出报告格式（严格遵循）

```
# Trim X.X 代码审查报告（审查日期 / 审查范围 / 审查基线 commit 或工作树状态）
## 0. 审查概览
- 范围与方法（vexor/精读/实跑命令/CDP/实测，附 npm test 与 cargo check 结果）
- 覆盖清单与未覆盖盲区
## 1. 结论速览
- 分级统计表（🔴高/🟡中/💭低 数量）
- 规范符合性总览表（规范项｜结论｜证据）
- 9.6 旧问题复核总表（24 项逐项：已修复/部分/未修复/回归 + 一句话证据）
## 2. 🔴 高危问题（每项：标题 / 分类 / 位置 file:line + 代码摘录 / 描述与可利用路径 / 违反的具体规范 / 证据等级 / 最小改法与彻底方案 / 回归验证点）
## 3. 🟡 中危问题（同上，从简）
## 4. 💭 低危问题（表格即可）
## 5. 实测附录（WCAG 比值表、通道枚举表、定时器清单、同步调用清单等，含脚本与原始数据）
## 6. 值得肯定、应保留的实践（避免后续重构误删）
## 7. 建议修复顺序（发布前必修 / 发布前建议 / 下迭代 / 技术债）
```

分级标准：🔴 高危=可造成数据丢失/安全越权/启动失败或主进程崩溃/违反明示安全红线；🟡 中危=特定条件下功能错误、明显性能问题、规范硬性指标不符、无障碍阻断；💭 低危=一致性、可维护性、边角体验。**宁缺毋滥：证据不足的问题降级或列入"待确认"，不许凑数。**

==== 提示词正文结束 ====

---

## 附：本版相对旧版的变化（维护备忘，不随提示词投喂）

1. 审查基线从"对照规范找问题"升级为"**验证已固化机制 + 防回归 + 找新问题**"，新增第五节 14 条已落地基线、第六节刻意设计白名单，避免重复报告。
2. 新增第九节 24 项旧问题强制复核表（含 B8 等疑似未修项的重点提示）。
3. 检查清单按 A 安全 / B 功能 / C 规范 / D 性能 / E 无障碍 / F 质量 / G 数据 / H 构建 / I Rust 九维重组，全部条目来自 AGENTS.md、architecture.md 与 9.6 报告的真实约束，无通用套话。
4. 方法学固化：vexor→Read→node --check/npm test→PS AST→CDP 真机→WCAG 实测的证据链，并写入 CDP 已知陷阱。
5. 事实卡数据（3.18 万行 / main.js 4620 / main.css 7463 / main.rs 1004 / 32 个 api 命名空间 / 13 个 PS 模块 / 39 个渲染脚本）均为 2026-09-06 现场统计；项目演进后请重新统计再使用。
