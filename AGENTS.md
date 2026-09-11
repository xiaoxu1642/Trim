# AGENTS.md — Trim 智能体协作约束

> 面向在本仓库工作的 AI 智能体。**只写规则与红线，不写架构教材**：
> 架构/规范/陷阱全量事实见 **`docs规范/architecture.md`**；用户使用说明（也是应用内弹窗数据源）见 **`readme.md`**。
> Trim = Windows 11 清理优化工具（Electron + 原生 HTML/CSS/JS，零前端框架，中文 UI，Fluent Design），仓库 `D:\KaiFa\Trim`。

## 1. 工作流程

1. 接到修复/改造任务，先 **TodoWrite** 列清单供审核，存在分歧点先问清再动手；用户消息本身已是明确批准清单时，按单直接执行、逐项汇报。
2. 只改任务点名范围，不主动扩展、不回滚用户既有未提交改动、**不主动 commit/push**。
3. UI 文案、注释、汇报一律中文；注释写「为什么/约束/根因」，重要改造标批次。
4. 完成后按第 4 节验收，交付说明写清验证方式、覆盖范围与遗留缺口。

## 2. 定位代码

- 优先 **vexor-cli** 意图级搜索（英文查询、`--format porcelain`、pwsh 调用）；覆盖不到再用 Grep（中文乱码只是显示问题，语义确认用 Read）。
- 改前先确认引用面：IPC 通道必查 main.js + preload.js + 渲染调用方；id/data 属性、文件路径全局搜过再动。

## 3. Shell 与环境

- Windows 一律 **PowerShell 7（pwsh）**，默认 UTF-8，禁止 Bash 语法；多行 Python 用 here-string 管道，禁止 heredoc。
- Git Bash 工具内调 pwsh：外层单引号、内层双引号（防 bash 吞 `$变量`）。
- 能用专用工具（Read/Edit/Glob/Grep）就不用 shell；文件操作避开 `find/grep/cat/sed/awk`。

## 4. 验收（改完必做）

1. 改动的 JS 一律 `node --check`；涉及规则/模块/页面挂载跑 **`npm test`**（test-features.js 含语法、双源一致性、尺寸常量等断言）。
2. 改了 `src/data/cleanup-rules.json`：跑 `node scripts/gen-fallback.js`；要发布再跑 `node scripts/sign-rules.js sign`。
3. **渲染层改动必须 CDP 真机验证**（项目无自动化 UI 框架）：taskkill 清残留 → 后台起 `electron.exe . --remote-debugging-port=9333` → `curl http://127.0.0.1:9333/json` 拿 webSocketDebuggerUrl → Node ≥22 全局 WebSocket 发 `Runtime.evaluate`（returnByValue）读真实 DOM/computed style，必要时 `Page.captureScreenshot` 目检 → 测完 taskkill → **恢复验证中改过的用户偏好**（appearance.json 与 localStorage winclean-appearance，不许用脚本开头旧值硬覆盖）。
4. CDP 陷阱：探查逻辑写临时 js 文件再 node 跑（禁 bash 双引号内联 `$()`）；reload 钩子用 `Page.addScriptToEvaluateOnNewDocument`；序列化的 backdropFilter 带引号 `url("#lg-f-x")`；静态 `.usage-modal` 用 `getBoundingClientRect().width > 0` 过滤；pathbinding 外观初始化有数秒时序，启动即探会误判；动画用定时采样 getBoundingClientRect 验证。
5. Rust 侧改动跑 `cargo check`，并 `cargo build --release` 刷新 finder.exe（打包从 native-scanner/target/release 取件）。

## 5. 硬性约定（违反即回退）

- 零前端框架，**不新增 npm 依赖**（确需先征得同意）；index.html **禁内联 script**（CSP 静默拦截）；脚本加载顺序：ds.js 先于一切 `window.ds` 使用方，spotlight.js 在 liquid-glass.js 之后。
- 主进程共享 Node 模块放 `src/main/`；新增 IPC 必须同步 preload.js 白名单与 `window.api`。
- 设计系统：只用 main.css 既有 token；圆角 ≤8px（胶囊/徽章除外），禁大圆角与彩色渐变；`prefers-reduced-motion` 无动画；文本一律转义禁拼 HTML；提示用 `data-tip` 不用 title；新交互先查 ds 有无现成件。
- 主窗口 1294×870 最小尺寸、独立窗口黑闪握手、预览窗纯黑底——均为刻意设计，禁止「优化」删除（详见 architecture 第二、八节）。
- 最大化/还原路径禁止原生材质操作；`body.win-maximized`、`data-material="none"` 必须完全不透明。
- 图标统一放 `src/assets/ico/`（生成器 `scripts/fix_icons.py`），根目录不再留 `ico/`；文件路径类资源移动后，package.json files 清单与全部引用同步改。

## 6. 安全红线

- 所有 IPC 经 `handleSafe/onSafe` 注册（只读白名单外全校验来源），新增通道默认走包装器；preload 只做白名单转发。
- 删除统一 `trashOrUnlink`（回收站优先）+ 删除清单 + 渲染层红色 confirmDanger；失败重试走 `cleanup:retry-failed-delete` 白名单。
- 写 JSON 走 `SECURITY.atomicWriteJson`；配置损坏先 `quarantineFile`；临时脚本只写 `%APPDATA%\Trim\tmp\`；提权走 `elevate:request` 握手，禁静默提权。
- 密钥不明文回渲染层（掩码 `••••••••`，掩码即未修改）；`isPrivateApiUrl` 校验不删，支持本地端点只能显式加白。
- 日志不落敏感信息，危险操作前 `flushLogSync()`；快捷指令渲染层只发 id、主进程白名单 spawn。

## 7. 回归陷阱索引（动前先读 architecture 第十节全文）

液态玻璃滑块以最后一次 refreshAll 为准且分类栏重渲染走 MutationObserver · 工具栏靠 id/`[data-finder-manifest]` 绑定别改名 · `#memUseValue` 三重护栏 · 液态玻璃性能护栏（28/420px/48/rAF）刻意不放开 · ds 未加载须优雅降级 · 清理规则路由 special→fileKeys→regKeys→pathPs 与 detect/requiredStoppedProcesses 语义 · 规则库更新 ed25519 验签/防降级/自定义源/git 回退 · execute 的 toRecycle/force/autoRebuild 协议与 item-detail 行协议 · PS 判空陷阱（`@($null).Count=1`、哈希表 Count 冲突）· finder.exe 三级查找顺序。
