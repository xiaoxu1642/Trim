# AGENTS.md — TuneForge（品牌名：Trim）智能体协作指南

> 本文件供在此仓库工作的 AI 智能体阅读。全部结论来自真实开发会话与 CDP 真机验证（截至 2026-09「窗口界面升级3」）。
> 交互/视觉规范没有独立文档，写在 `readme.md`（如「窗口尺寸」段：最小 1294×870，主窗口 `useContentSize: true`）。

## 一、项目架构和模块关系

### 1.1 总览
- **是什么**：Electron 桌面 Windows 优化工具，中文 UI，品牌名 Trim（包名 `trim`，productName `Trim`，appId `com.xiaoxu.trim`）。目标系统 Windows 11 27H2（build 29648+），保留 Win10 降级路径。
- **技术形态**：零前端框架——原生 HTML/CSS/JS 单窗口 SPA（`src/index.html` 每页一个 `.page` div）。禁止引入 React/Vue/组件库运行时；组件视觉参考 shadcn/ui，交互逻辑参考 antd（选型结论见 `docs/组件优化-选型方案.html`）。
- **仓库**：主仓库 `C:\kaifa\TuneForge`；Tauri 安装器工程在兄弟目录 `TuneForge goujian\trim-installer`（负责打包发布）。
- **原生组件**：`native-scanner/`（Rust）编译出 `finder.exe`（重复文件/大文件/空项查找器核心），由 electron-builder 作为 extraResources 进包。

### 1.2 进程与窗口
| 部分 | 文件 | 要点 |
|---|---|---|
| 主进程 | `main.js`（约 2300+ 行） | 窗口创建、全部 ipcMain.handle、appearance.json 持久化、原生窗口材质、安全模块 SECURITY |
| 预加载 | `preload.js` | contextIsolation + sandbox，白名单暴露 `window.api`；**新增 IPC 必须同步补这里** |
| 主窗口 | `src/index.html`（约 1250 行） | 每页一个 `.page` div；脚本见 1.3 |
| 子窗口 | models-window / peripheral-window / process-manager-window | 共用 `src/scripts/window-material.js` 同步主题与材质 |
| 预览窗 | preview-window.html | **刻意**不加载 window-material.js，保持纯黑底（看图对比场景），别"修复"它 |

### 1.3 渲染层脚本职责（src/scripts/）
| 脚本 | 职责 |
|---|---|
| `app.js` | 路由 switchPage、磁盘清理五合一视图（setCleanupView）、全局初始化（各模块 init 在此调用） |
| `theme.js` / `theme-boot.js` | 主题/皮肤/材质初装；theme-boot 是首帧前外置引导（原内联脚本被 CSP 拦截的历史修复，别内联回去） |
| `pathbinding.js` | 设置页外观（强调色/背景图/窗口材质卡+总开关/系统信息折叠）与安装路径绑定 |
| `liquid-glass.js` | 液态玻璃引擎 2.0：`body.lg-mode-full/standard/frost/off` 四档（localStorage `winclean-liquid-motion`，旧值 refract 自动迁移 standard）；为 `.filter-tabs/.maint-tabs` 挂 `.lg-thumb` 弹簧滑块（SVG 折射/RGB 色散/焦散） |
| `spotlight.js` | 跟随聚光（document 级 pointermove 委托，仅作用于 `.btn/.filter-tab/.maint-tab/.material-card/.radio-row` 这些"选择块"） |
| `cleanup.js` / `finder.js` | 磁盘清理主视图 / 重复·大文件·空项·AppData 查找器（finder 按 `[data-finder-manifest]` 全局绑定清单按钮） |
| `memoryclean.js` | 内存清理页（指标卡 + fitMemValue 数值自适应 + 环形进度降级） |
| `overview.js` / `deviceinfo.js` | 系统概览实时指标与硬件信息渲染 |
| `optimizer.js` | 电脑优化中心（14 分类，`.filter-tab` + data-optcat） |
| `maintenance.js` | 系统维护修复组（分类 chips + 批量执行） |
| `quickcmds.js` + `quickcmds-data.js` | 快捷指令页（数据与执行分离；渲染层不接触命令原文） |
| `ds.js` / `ds.css` | 设计系统运行时 `window.ds`（见 §二硬性约束），API 文档 `design-system/README.md` |
| `modal.js` | 弹窗/确认框（ds.focusTrap 焦点陷阱；删除类红色 confirmDanger） |
| `xtable.js` | 表格组件（ResizeObserver 布局，返回 relayout/dispose） |
| `icon-fallback.js` | Trim.ico 单次缓存共享模块（进程/右键/启动项列表图标用） |
| 其余 | realtime / netspeed(-detector) / diskbench / startup / sysrestore / contextmenu / fontmanager / modelpicker / intro / logger 按名对域 |

### 1.4 样式分层（src/styles/main.css 约 7600+ 行，覆盖顺序=文件顺序）
加载顺序 `main.css → ds.css`。main.css 从上到下分层，**后写的覆盖先写的**；改样式先用**可搜索的注释锚点**定位（行号会漂移，不要在文档/注释里引行号）：
1. `:root` / `.theme-light` 设计 token（`--bg-card`、`--accent`、`--border-*` 等）
2. `data-skin="glass"` 玻璃皮肤块
3. 基础组件区
4. 「Trim 2.0 final visual layer」——按主题钉死的表面 + 按钮 ripple 体系
5. 鼠标拖尾 / 预设背景 / 自定义背景图（`body.bg-image-on .layout::after`）/ 磁盘清理查找器 `.finder-*`
6. 「窗口材质 2.0」——`body.electron-mica` 分级面纱 + token 玻璃化 + 卡片 blur
7. 「液态玻璃 2.0」——lg 按钮 tint、`.lg-thumb` 滑块、`.lg-elastic`、焦散画布
8. 「窗口界面升级3」——工具栏齐平、聚光、材质总开关等最新覆盖层

**教训（升级3 根因）**：覆盖层里的字面色（如 `#ffffff`）会让上面的 token 体系失效。改任何表面颜色必须查两处：token 定义本身 + 文件尾各覆盖层有没有字面值盖住它。

### 1.5 状态与数据存储
| 位置 | 键 / 字段 | 说明 |
|---|---|---|
| `%APPDATA%\Trim\appearance.json` | material / materialEnabled / windowState | 主进程持久化（`SECURITY.atomicWriteJson`） |
| localStorage `winclean-appearance` | skin / accent / bgPath / bgOpacity / material / materialEnabled | 渲染层镜像，**与 appearance.json 是两套存储**，别混淆；bgOpacity 存百分数（如 42），使用时 /100 |
| localStorage `winclean-active-page` / `winclean-cleanup-view` / `winclean-liquid-motion` / `winclean-systeminfo-open` | — | 页面记忆 / 五合一视图 / 液态玻璃档位 / 折叠态 |
| `%APPDATA%\Trim\backgrounds\bg_*.png` | — | 导入的背景图 |
| `%APPDATA%\Trim\tmp\` | — | 临时脚本目录（安全要求，见 §七） |

### 1.6 窗口材质与外观链路（改材质必读）
- 材质值域：`mica` / `mica-alt` / `acrylic` / `thin-acrylic` / `none`；原生映射 mica→`mica`、mica-alt→`tabbed`、acrylic 与 thin-acrylic→`acrylic`（"更透亮"由渲染层 data-material 分级着色实现）。
- 应用链路：渲染层（设置页 pathbinding / 子窗 window-material）→ IPC `appearance:set-material` / `appearance:set-material-enabled` → 主进程对全部存活窗口 `setBackgroundMaterial` + 持久化 + 广播 `appearance:material-changed`。
- **广播载荷是「生效材质」字符串**：总开关 materialEnabled=false 时广播 `'none'`，但用户所选材质保留在 appearance.json（重开开关即恢复）；消费方按字符串处理，勿改成对象（子窗兼容）。
- 渲染层半透明三级：`body.electron-mica` 面纱（按 data-material 分档）→ layout/main-content 全透明 → 卡片/输入/浮层走 `--bg-card/--bg-input/--bg-elevated` rgba token。
- **Win11 27H2 红线**：最大化/还原会扰动 DWM 材质层，且该状态下运行中 `setBackgroundMaterial` 无法重建 backdrop（可能把黑屏拖成永久）——**最大化/还原路径禁止任何原生材质操作**；`body.win-maximized` 与 `data-material="none"` 必须保持 100% 不透明护栏。

## 二、代码组织结构和命名约定
- 页面容器 id `page-*`；导航 `data-page`；磁盘清理五合一 `data-cleanup-view` / `data-cleanup-panel`；分类 chips `data-qcat`（快捷指令）/ `data-cat`（维护）/ `data-optcat`（优化中心）。
- CSS 类前缀按域缩写：`ov-`（概览）、`qc-`（快捷指令）、`maint-`（维护）、`ctx-`（右键）、`mw-`（模型子窗）、`peri-`（外设）、`pw-`（进程窗）、`lg-`（液态玻璃）、`ds-`（设计系统）、`mt-`（材质开关）。新代码沿用就近前缀。
- UI 文案、代码注释、任务汇报一律中文。注释解释「为什么 / 约束 / 根因」，重要改造在注释里标注批次（如「窗口界面升级3」）——既有惯例，续写保持。
- **index.html 禁止内联 `<script>`**（CSP `script-src 'self'` 会静默拦截，theme-boot.js 就是这么修的）；启动期脚本外置到 src/scripts/ 并在 index.html 尾部按依赖顺序引入：`ds.js` 在一切 `window.ds` 使用方之前，`spotlight.js` 在 `liquid-glass.js` 之后。
- 设计系统硬性约束（运行时 `window.ds`，全文见 `design-system/README.md`）：
  1. 只用 main.css 既有 token；新 token 先进 main.css 再用；
  2. 圆角 ≤ 8px（胶囊 999px / 徽章等小圆角除外），禁大圆角卡片与彩色渐变；
  3. `prefers-reduced-motion: reduce` 时组件不产生任何过渡/动画；
  4. 文本类 API 一律转义，禁止调用方拼 HTML；
  5. 悬停提示用 `data-tip`（ds 委托式 Tooltip），不要用原生 title（会出双气泡）。
- 新交互优先复用 window.ds（badge / progress / slider / switch / focusTrap / tooltip / menu / skeletonRows / accordion），先查 design-system/README.md 再造轮子。

## 三、可用的构建脚本和命令
| 命令 | 作用 |
|---|---|
| `npm start` | `electron .` 开发运行 |
| `npm test` / `npm run test:features` | `node test-features.js` 特性自检脚本 |
| `npm run build` | electron-builder --win --x64（便携版，输出 `build-release/`） |
| `npm run build:dir` / `build:portable` | 仅产出目录 / 便携版 |
| `node --check <file.js>` | JS 语法检查（项目无 linter，改完 JS 必跑） |
| `cargo check`（native-scanner/） | Rust 侧检查 |
| `.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9333` | 带 CDP 启动（见 §五） |

## 四、依赖管理和版本约束
- 运行时 npm 依赖仅 4 个（agent-base / debug / http-proxy-agent / https-proxy-agent，AI 简介联网拉取用）。**默认不新增 npm 依赖**（设计系统选型已明确"零框架、零新增依赖"），确需新增先向用户说明理由征得同意。
- electron ^44.1.1（`setBackgroundMaterial` 等原生材质 API 依赖 Electron 30+）；electron-builder ^26。
- Rust 侧 native-scanner 独立构建，产物路径在 package.json `build.extraResources` 中约定，改动打包配置时核对。

## 五、测试策略和运行方式（渲染层改动的标准验收）
- 无自动化测试框架。验收 = `node --check`（语法）+ **CDP 真机验证**（行为与视觉）。用户已授权直接启动应用做验证。
- **CDP 标准流程**（Git Bash 环境）：
  1. 清残留实例：`pwsh -NoProfile -Command 'taskkill /F /IM electron.exe'`（Git Bash 直调则斜杠翻倍 `//F //IM`；旧实例会占住调试端口）；
  2. 启动：`electron.exe . --remote-debugging-port=9333`（后台）；
  3. `curl http://127.0.0.1:9333/json` 拿页面 `webSocketDebuggerUrl`；
  4. Node ≥22 全局 `WebSocket` 连 CDP：`Runtime.evaluate`（`returnByValue:true, awaitPromise:true`）读真实 DOM/computed style；`Page.captureScreenshot` 存 PNG 后用 Read 工具目检；
  5. 测完 taskkill，并**恢复被测改动过的用户偏好**（`%APPDATA%\Trim\appearance.json` 与 `localStorage['winclean-appearance']`）。
- **CDP 陷阱（全部真实踩过）**：
  - 探查逻辑写成临时 js 文件再 `node` 运行；**禁止在 bash 双引号里内联 `$()` / `$var`**（会被外层 Git Bash 先行展开成空串）；`/tmp/...` 路径只作 argv 传（node -e 字符串里的 /tmp 会解析成 `C:\tmp`）。
  - 要捕获 reload 期间的报错或预置钩子，必须用 `Page.addScriptToEvaluateOnNewDocument`——`Runtime.evaluate` 装的钩子在 Page.reload 后随旧上下文一起销毁（等于白装）。
  - `el.style.backdropFilter` 序列化带引号：`url("#lg-f-x")`——用 `includes('url(#lg-f-')` 判断永远 false，要匹配 `url("#lg-f-` 或读 computed style。
  - index.html 静态存在一个 `display:none` 的使用说明 `.usage-modal`，`querySelector('.usage-modal')` 会命中它；按 `getBoundingClientRect().width > 0` 过滤。
  - **启动后立刻探测会误判"数据丢了"**：pathbinding 的 initAppearance()（应用背景图/强调色）随 app.js 初始化链路可能延迟数秒执行，导入背景图（`body.bg-image-on .layout::after`，变量 `--app-bg-image` / `--app-bg-opacity`）晚几秒才出现——既有时序，不是 bug；等待或切一次页再验。
  - 用户可能正在实时操作被测窗口（历史上把材质当场切过档）：验证偏好类功能前确认用户没中途改设置，恢复偏好别用脚本开头记录的旧值硬覆盖。
- 动画/过渡类改动用「采样插值」验证：定时连续读 `getBoundingClientRect()`，看坐标是否平滑插值——比单点读 class 名可信。

## 六、CI/CD 流程和部署规范
- 无 CI。发布链路：`npm run build`（electron-builder → `build-release/win-unpacked` 与便携版）→ 兄弟工程 `TuneForge goujian\trim-installer` 执行 `npm run sync:resources`（robocopy `/MIR` 同步 win-unpacked → `src-tauri/resources/app`，`/XD logs`，robocopy 退出码 <8 视为成功）→ Tauri 构建（bundle.active 已固化为 true）。
- 版本号以 package.json 为准；窗口/交互规范变更要同步 `readme.md` 的 Trim 2.0 规范段。
- 工作树常态保留大量未提交改动：**不主动 commit / push**；也不得为实现新改动回滚既有未提交工作。

## 七、敏感操作的安全边界
- 新增 `ipcMain.handle` 一律做 sender 校验 / `rejectUntrustedRenderer`（既有惯例）；preload 只做白名单转发，不向渲染层传可执行字符串。
- 写 JSON 配置必须走 `SECURITY.atomicWriteJson`；临时脚本只放 `%APPDATA%\Trim\tmp\`（目录权限收紧 + 拒符号链接）。
- 删除类操作：回收站兜底（Rust SHFileOperationW）+ 已删除清单可追溯；确认弹窗统一走 modal.js（删除类用红色 `confirmDanger` + dangerHint），禁止裸 `confirm`。
- 提权：走 `elevate:request` 握手（新实例 `--elevated-relaunch` 轮询拿锁、15s 超时、`elevate:notice` toast），不允许静默提权。
- 快捷指令执行：渲染层只发 id，主进程按白名单 spawn（`quickcmds:run`），命令原文不出主进程。
- 日志：writeLog 缓冲 + setImmediate 批量落盘，危险操作前 `flushLogSync()`；不打印密钥、完整用户路径等敏感信息。
- 首帧握手（`window.api.window.notifyFirstPaint()` → show 窗口）与主窗口 `backgroundThrottling:false` 是黑闪修复的一部分，是刻意的，不要当冗余代码"优化"掉。

## 八、协作偏好与回归陷阱速查（用户明确要求过的工作方式）
- **流程**：接到修复/改造任务，先 TodoWrite 列出清单供审核，经 AskUserQuestion 确认范围与方案分歧点后再动手；用户消息本身已是明确批准的清单时，按单直接执行并逐项汇报。
- **定位代码**：优先用 vexor-cli 技能做意图级搜索（查询用英文、`--format porcelain`，stderr 噪音忽略；经 pwsh 调用：`pwsh -NoProfile -Command 'vexor search "..." --path "C:\kaifa\TuneForge" --mode code ...'`）。vexor 覆盖不到（需大范围遍历/带行号结构图）时再派 Explore 子代理，要求产出精确到行号的报告。
- **Shell**：Windows 一律 pwsh 7。在 Git Bash 工具里调 pwsh 时，外层命令用**单引号**包裹（双引号会让 bash 先吞掉 `$变量`），内层 pwsh 字符串用双引号；rg 经 pwsh 控制台输出的中文乱码只是显示问题，语义确认用 Read 读文件。
- **回归陷阱速查（动这些地方前先看）**：
  - `liquid-glass.js` 的 `schedulePlace` 会 cancel 前一个 rAF——谁后调 `refreshAll(animate)`，滑块动画就以谁为准（`app.js` setCleanupView 里现在必须是 `true`，改成 false 会复发"切换无动效"）。
  - quickcmds / maintenance 的分类栏是 innerHTML 整体重渲染 → 滑块走 MutationObserver「从 lastX 带动画滑回」路径；别改成手动 `placeThumb(false)`。
  - 磁盘清理工具栏按钮可搬位置，但 finder.js 按 `[data-finder-manifest]` 全局绑定、其余按钮靠 id 通信——别改 id / data 属性。
  - 内存卡 `#memUseValue` 有 fitMemValue + ResizeObserver + CSS line-clamp 三重护栏，动 summary-value 结构前先看 memoryclean.js。
  - 悬停提示一律 `data-tip`；弹窗一律走 modal.js（focusTrap）。
  - 液态玻璃性能护栏是刻意的：折射元素上限 28、>420px 大元素只磨砂、位移贴图缓存 48、rAF 节流——不要放开。
  - ds.js 未加载时相关功能必须优雅降级（参考 memoryclean 环形进度的无线环回退）。
