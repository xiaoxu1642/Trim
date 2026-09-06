# Trim 架构与规范详表（智能体/维护者参考）

> 本文是 Trim（包名 `trim`，productName `Trim`，appId `com.xiaoxu.trim`）的项目架构、规范与回归陷阱全量参考，由 AGENTS.md 拆出（2026-09 目录梳理）。
> **文档分工**：`readme.md` = 用户使用说明（人话版，同时是应用内「使用说明」弹窗唯一数据源）；`AGENTS.md` = 智能体协作约束（精简）；本文 = 架构事实与陷阱库。
> 版本 2.0 · Windows 11 22H2+（27H2 Build 29648 验证）· 需要 PowerShell 7。

## 一、技术形态与仓库

- **零前端框架**：原生 HTML/CSS/JS 单窗口 SPA（`src/index.html` 每页一个 `.page` div）。禁止引入 React/Vue/组件库运行时；组件视觉参考 shadcn/ui，交互逻辑参考 antd。
- 仓库 `C:\kaifa\TuneForge`；Tauri 安装器工程在兄弟目录 `TuneForge goujian\trim-installer`。原生组件 `native-scanner/`（Rust）编译出 `finder.exe`（重复/大文件/空项查找器），由 electron-builder 作为 extraResources 进包。
- 运行时 npm 依赖仅 4 个（AI 简介联网拉取用），**默认不新增依赖**，确需新增先征得同意。electron ^44.1.1（`setBackgroundMaterial` 依赖 Electron 30+）。
- 目录总图（2026-09 梳理后）：
  - 根目录：`main.js` / `preload.js`（Electron 入口）、`package.json`、`test-features.js`、`readme.md`、`AGENTS.md`、`LICENSE.md`
  - `src/assets/ico/`：**唯一图标目录**（品牌源、打包、运行时都用它；生成器是 `scripts/fix_icons.py`）
  - `scripts/`：开发工具（gen-fallback / sign-rules / fix_icons）
  - `docs/`：架构文档（本文）与历史更新资料（`docs/update/...` 为历史快照，不改写）
  - `src/main/`：主进程共享 Node 模块（`diag.js` / `security.js` / `rules-signature.js`，被 main.js、test-features.js、sign-rules.js require）
  - `src/`：5 个窗口 HTML；`scripts/`（渲染层）、`scripts-powershell/`（主进程 PS 脚本模块）、`styles/`、`data/`、`assets/`（ico 图标、fonts 等）
  - `native-scanner/`：Rust 子工程，`target/` 是构建缓存（已 gitignore，不入库；本地保留，打包要用 release/finder.exe）
  - `design-system/`：设计系统参考（`README.md` 是 ds API 文档）

## 二、进程与窗口

| 部分 | 文件 | 要点 |
|---|---|---|
| 主进程 | `main.js`（约 4900 行，2026-09 实测；按域拆分待专项推进） | 窗口创建、全部 ipcMain.handle、appearance.json 持久化、原生窗口材质、安全模块 SECURITY（来自 `src/main/security.js`） |
| 预加载 | `preload.js` | contextIsolation + sandbox，白名单暴露 `window.api`；**新增 IPC 必须同步补这里** |
| 主窗口 | `src/index.html` | 每页一个 `.page` div；脚本见第三节 |
| 子窗口 | models-window / peripheral-window / process-manager-window | 共用 `src/scripts/window-material.js` 同步主题与材质；窗口图标引用 `./assets/ico/Trim.ico` |
| 预览窗 | preview-window.html | **刻意**不加载 window-material.js，保持纯黑底（看图对比场景），别"修复"它 |

## 三、渲染层脚本职责（src/scripts/）

| 脚本 | 职责 |
|---|---|
| `app.js` | 路由 switchPage、磁盘清理五合一视图（setCleanupView）、全局初始化、使用说明弹窗（轻量 Markdown 渲染器 renderMarkdown + showUsageGuide，数据源 readme.md）；`liquidMotionSelect` 绑定在此 |
| `theme.js` / `theme-boot.js` | 主题/背景模糊度/预设背景初装；theme-boot 是首帧前外置引导（勿内联回 index.html，CSP 会拦截） |
| `pathbinding.js` | 设置页外观（主题/材质/背景图片+雾化度+**背景模糊度**/强调色/系统信息折叠）与安装路径绑定 |
| `liquid-glass.js` | 液态玻璃引擎 2.0：`body.lg-mode-full/standard/frost/off` 四档（localStorage `winclean-liquid-motion`）；为 `.filter-tabs/.maint-tabs` 挂 `.lg-thumb` 弹簧滑块 |
| `spotlight.js` | 跟随聚光（仅作用于 `.btn/.filter-tab/.maint-tab/.material-card/.radio-row`） |
| `cleanup.js` / `finder.js` | 磁盘清理主视图 / 重复·大文件·空项·AppData 查找器（finder 按 `[data-finder-manifest]` 全局绑定清单按钮） |
| `memoryclean.js` | 内存清理页（`#memUseValue` 有 fitMemValue + ResizeObserver + line-clamp 三重护栏） |
| `ds.js` / `ds.css` | 设计系统运行时 `window.ds`，API 见 `design-system/README.md` |
| `modal.js` | 弹窗/确认框（ds.focusTrap；删除类红色 confirmDanger） |
| `xtable.js` | 表格组件（虚拟滚动、ResizeObserver，返回 relayout/dispose） |
| `icon-fallback.js` | 统一图标兜底，兜底图标走 `window.api.paths.fileIcon('src/assets/ico/Trim.ico')`（相对应用根目录解析） |
| 其余 | realtime / netspeed(-detector) / diskbench / startup / sysrestore / contextmenu / fontmanager / modelpicker / intro / logger 按名对域 |

主进程侧的 PowerShell 脚本生成模块在 `src/scripts-powershell/`（13 个，main.js 按域 require，导出字符串脚本/函数，不接触 DOM）。

## 四、样式分层（src/styles/main.css 约 7600+ 行）

加载顺序 `main.css → ds.css`，后写覆盖先写。分层：`:root`/`.theme-light` token → `data-skin="glass"`（**背景模糊度**驱动，`--glass-blur` 0-26px）→ 基础组件 → 「Trim 2.0 final visual layer」→ 拖尾/预设背景/自定义背景图（`body.bg-image-on .layout::after`）→ 「窗口材质 2.0」（`body.electron-mica`）→ 「液态玻璃 2.0」→ 「窗口界面升级3」→ 「设置页整合4」（卡片子分区 `.appearance-sub` 等）。

**教训**：覆盖层里的字面色（如 `#ffffff`）会让 token 体系失效。改表面颜色必须查两处：token 定义本身 + 文件尾各覆盖层的字面值。

## 五、状态与数据存储

| 位置 | 键 / 字段 | 说明 |
|---|---|---|
| `%APPDATA%\Trim\appearance.json` | material / materialEnabled / windowState | 主进程持久化（`SECURITY.atomicWriteJson`） |
| localStorage `winclean-appearance` | accent / bgPath / bgOpacity / **bgBlur** / presetBg | 渲染层镜像，与 appearance.json 的分工：`material`/`materialEnabled`/`windowState` 归 **appearance.json 单一真源**（主进程持久化），localStorage 不再写 material；bgOpacity 与 bgBlur 均存百分数（0-100）。UI 标签「透明度」已更名「雾化度」（存储键 bgOpacity 不变，「设置页整合4」后续调整） |
| localStorage 其他 | `winclean-active-page` / `winclean-cleanup-view` / `winclean-liquid-motion` / `winclean-systeminfo-open` / `winclean-theme` | 页面记忆 / 五合一视图 / 液态玻璃档位 / 折叠态 / 主题 |
| `%APPDATA%\Trim\backgrounds\bg_*.png` / `tmp\` / `icons\` | — | 背景图 / 临时脚本（安全要求）/ 内置图标释放目录 |

**背景模糊度（设置页整合4）**：原「皮肤：经典/液态玻璃」二选一下拉已并入「背景图片」卡的 0-100% 无级滑块。0% = 经典不透明面板；>0% 挂 `body[data-skin="glass"]`，模糊半径 `--glass-blur` = 百分比 × 26px（`GLASS_MAX_BLUR_PX`，pathbinding.js 与 theme.js 两处共用约定，改动需同步）；旧 `skin` 键自动迁移（glass=100%）。

**材质值域**：`mica / mica-alt / acrylic / thin-acrylic / none`；「无材质」卡片已移除，`none` 仅作为总开关关闭时的「生效材质」广播值与存储等价态。链路：渲染层 → IPC `appearance:set-material` / `appearance:set-material-enabled` → 主进程对全部存活窗口 `setBackgroundMaterial` + 持久化 + 广播 `appearance:material-changed`（载荷是**生效材质**字符串，总开关关闭时为 `'none'`，勿改成对象）。

**Win11 27H2 红线**：最大化/还原路径禁止任何原生材质操作；`body.win-maximized` 与 `data-material="none"` 必须 100% 不透明。

## 六、构建与发布

| 命令 | 作用 |
|---|---|
| `npm start` | 开发运行 |
| `npm test` / `npm run test:features` | `node test-features.js` 特性自检 |
| `npm run build` / `build:dir` / `build:portable` | electron-builder --win --x64（输出 `build-release/`）；prebuild 钩子先跑 gen-fallback |
| `node --check <file.js>` | JS 语法检查（项目无 linter，改完 JS 必跑） |
| `cargo check`（native-scanner/） | Rust 侧检查 |
| `python scripts/fix_icons.py` | 由 `src/assets/ico/source.png` 重新裁切生成全套 png/ico，并同步 Tauri 安装器图标（ROOT 取脚本上级目录；勿就地覆盖 source.png） |
| `.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9333` | 带 CDP 启动（见 AGENTS 验收流程） |

发布链路：`npm run build` → `trim-installer` 执行 `npm run sync:resources`（robocopy `/MIR` 同步 win-unpacked → `src-tauri/resources/app`，退出码 <8 视为成功）→ Tauri 构建。打包 files 清单见 package.json `build.files`（含 `readme.md`、`src/assets/ico/*.ico`；应用内使用说明弹窗读的就是这个 readme.md）。版本号以 package.json 为准；窗口/交互规范变更同步本文档相关章节。**工作树常态保留大量未提交改动：不主动 commit / push，也不得为实施新改动回滚既有未提交工作。**

## 七、代码组织约定

- 页面容器 id `page-*`；导航 `data-page`；磁盘清理五合一 `data-cleanup-view` / `data-cleanup-panel`；分类 chips `data-qcat` / `data-cat` / `data-optcat`。
- CSS 前缀按域：`ov-` `qc-` `maint-` `ctx-` `mw-` `peri-` `pw-` `lg-` `ds-` `mt-`，新代码沿用就近前缀。
- UI 文案、注释、汇报一律中文；注释解释「为什么/约束/根因」，重要改造标注批次（如「设置页整合4」）。
- **index.html 禁止内联 `<script>`**（CSP 静默拦截）；`ds.js` 在一切 `window.ds` 使用方之前，`spotlight.js` 在 `liquid-glass.js` 之后。
- 主进程共享模块统一放 `src/main/`，用相对路径 require（main.js 中为 `./src/main/xxx`）；不要把 Node 模块放回 src 根与 HTML 混放。
- 设计系统硬性约束（全文见 `design-system/README.md`）：只用 main.css 既有 token；圆角 ≤ 8px（胶囊/徽章除外），禁大圆角与彩色渐变；`prefers-reduced-motion` 下无动画；文本 API 一律转义禁拼 HTML；悬停提示用 `data-tip` 不用原生 title；新交互先查 ds 是否已有（badge/progress/slider/switch/focusTrap/tooltip/menu/skeletonRows/accordion）。

## 八、交互与视觉规范

- 主窗口默认并最小 **1294×870（客户区，`useContentSize: true`）**，不允许缩小，可最大化（test-features 有常量断言 MAIN_WINDOW_MIN_WIDTH/HEIGHT）。
- 独立窗口（应用进程管理 / 大模型管理 / 图片预览）`show:false` + `ready-to-show` 首帧后才显示 + 主窗口 `backgroundThrottling:false` + `window.api.window.notifyFirstPaint()` 握手——都是黑闪修复的一部分，**不要当冗余代码"优化"掉**。
- 磁盘清理分类默认折叠；删除类确认走 modal.js 红色 `confirmDanger`。

## 九、安全模块与边界（架构事实）

- IPC 一律经 `handleSafe`/`onSafe` 包装器注册（审查 1-3 全量：除 `SIDE_EFFECT_FREE` 只读白名单外全部通道校验来源，「忘记校验」结构上不可能；新增通道默认经包装器）。
- 模型 `apiUrl` 经 `isPrivateApiUrl` 拒绝环回/私有/链路本地网段（审查 1-5，支持本地模型端点须显式加白名单而非删校验）。
- `settings:load` 返回的密钥是掩码 `API_KEY_MASK`（'••••••••'），save/test 侧识别掩码视为未修改保留旧值，明文密钥不经 IPC 回渲染层；密钥加解密走 `src/main/security.js` 的 encryptSecret/decryptSecret。
- 删除类操作统一走 `trashOrUnlink`（回收站优先、失败才降级永久删除，审查 1-2）并经 `saveDeleteManifest` 落清单，回收站失败项经渲染层红色确认后走 `cleanup:retry-failed-delete`（主进程白名单）。
- preload 只做白名单转发（`on*` 订阅统一返回 dispose）；写 JSON 走 `SECURITY.atomicWriteJson`；配置文件损坏先 `quarantineFile` 隔离再降级；临时脚本只放 `%APPDATA%\Trim\tmp\`；提权走 `elevate:request` 握手（禁静默提权）；快捷指令渲染层只发 id，主进程按白名单 spawn；日志缓冲落盘、危险操作前 `flushLogSync()`、不打印敏感信息。

## 十、回归陷阱速查（动这些地方前先看）

- `liquid-glass.js` 的 `schedulePlace` 会 cancel 前一个 rAF——谁后调 `refreshAll(animate)` 滑块动画以谁为准（`app.js` setCleanupView 里必须是 `true`，改 false 会复发"切换无动效"）。
- quickcmds / maintenance 分类栏 innerHTML 整体重渲染 → 滑块走 MutationObserver 路径，别改手动 `placeThumb(false)`。
- 磁盘清理工具栏按钮可搬位置，但 finder.js 按 `[data-finder-manifest]` 全局绑定、其余按钮靠 id 通信——**别改 id / data 属性**。
- 内存卡 `#memUseValue` 三重护栏，动 summary-value 结构前先看 memoryclean.js。
- 悬停提示一律 `data-tip`；弹窗一律 modal.js（focusTrap）。
- 液态玻璃性能护栏是刻意的：折射元素上限 28、>420px 大元素只磨砂、位移贴图缓存 48、rAF 节流——不要放开。
- ds.js 未加载时相关功能必须优雅降级（参考 memoryclean 环形进度的无线环回退）。
- 清理规则唯一数据源是 `src/data/cleanup-rules.json`（P1-9）。条目目标模型按优先级路由：`special:'dism'` → `fileKeys[]`（%ENV% + 通配路径、pattern、removeSelf、excludeKeys 排除）→ `regKeys[]`（value 语义：无=删树 / `'*'`=清键值 / 具名=删值）→ `pathPs`（目录型）；通用字段 `detect[]`（未命中不参与扫描，渲染层扫描后隐藏）、`requiredStoppedProcesses`（已接线：扫描出 blockedBy 标签，执行命中即整项跳过）。**改规则 JSON 后运行 `node scripts/gen-fallback.js` 重新生成 FALLBACK**（审查 2-2：generated 文件入库，npm prebuild 钩子自动生成，test-features 含双源一致性断言；发布前还需 `scripts/sign-rules.js sign` 签名，见下条）。引擎细节陷阱：PS 里属性缺失时 `@($null).Count` 是 1（判空要先 `-not $x`）；哈希表 `$m.count` 命中内建 Count 属性（返回键数），要用 pscustomobject。
- 规则库在线更新（P2）：数据目录 `%APPDATA%\Trim\cleanup\rules.json` 优先于内置生效（`cleanup-scripts.js loadRules()`，mtime 签名缓存），`custom\*.json` 同名 id 覆盖；更新走 `cleanup:update-rules` IPC（发布源常量 RULES_UPDATE_URLS 在 main.js，GitHub → jsDelivr → gh-proxy 回退，**ed25519 验签**（审查 1-1：公钥内置 `src/main/rules-signature.js`，私钥在发布机 `~/.trim-signing/`，签名对象为去掉 `_sig` 后的紧凑 JSON；`_sig` 置于根对象）+ 尺寸上下限（4KB/2MB，流式限量读取）/结构/防降级校验，.downloading 原子替换），渲染层入口是磁盘清理工具栏「更新规则库」按钮（id `btnUpdateRules`）。**改规则 JSON 发布前必须 `node scripts/sign-rules.js sign` 重新签名**（gen 子命令生成/更换密钥对，更换公钥须同步发新版应用），未签名内容应用端一律拒绝。私有仓库的匿名 HTTP 源会 404：可在数据目录 `update-source.json` 配 `{urls,headers}` 覆盖；另有 git 回退（应用在 git 仓库内时 `git fetch origin main` + `git show FETCH_HEAD:` 取远程文件，只 fetch 不动工作树）。`pathscan-scripts.js scan()` 接收注入的规则 JSON，缓存目录候选从 rules 的 candidatesPs/globCandidatesPs 求值（更新后路径扫描同步）。
- P3 执行/明细：`cleanup:execute` 收到 `{items,force,toRecycle,autoRebuild}`；toRecycle 时 PS 只枚举输出 `@@RECYCLE@@`（path/size/isDir）行，主进程 `shell.trashItem` 实际移入回收站（注册表/DISM 无回收站语义仍 PS 直删）；删除后每项带 `residual` 残留计数。`cleanup:item-detail` 用 DETAIL_SCRIPT 只读枚举文件清单（上限 600 行，`@@ITEMFILE@@`/`@@DETAIL@@` 行协议，主进程按行切流不整块读 stdout）。渲染层：工具栏新增「删除进回收站」勾选框，全项目「明细」按钮弹窗；注意 ForceDelete/AutoRebuild 勾选框此前从未被读取，现已真实接线。
- finder.exe 查找顺序（main.js）：打包后 `process.resourcesPath/finder/finder.exe` → 开发态 `native-scanner/target/release/finder.exe` → `resources/finder/finder.exe`；改 Rust 后必须 `cargo build --release` 刷新，electron-builder 从 target/release 取件进包。
