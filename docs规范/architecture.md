# Trim 架构与规范详表（智能体/维护者参考）

> 本文是 Trim（包名 `trim`，productName `Trim`，appId `com.xiaoxu.trim`）的项目架构、规范与回归陷阱全量参考，由 AGENTS.md 拆出（2026-09 目录梳理）。
> **文档分工**：`readme.md` = 用户使用说明（人话版，同时是应用内「使用说明」弹窗唯一数据源）；`AGENTS.md` = 智能体协作约束（精简）；本文 = 架构事实与陷阱库。
> 版本 2.6 · Windows 11 22H2+（27H2 Build 29648 验证）· 需要 PowerShell 7。
> **路径约定**：文内路径以仓库实际位置为准——仓库 `D:\KaiFa\Trim`，文档目录 `docs规范/`，构建产物输出 `build-release/`（v2.6.0 起 package.json `build.directories.output` 指向仓库根 `build-release`，相对路径；旧 `Trim goujian/` Tauri 工程已退役）。

## 一、技术形态与仓库

- **零前端框架**：原生 HTML/CSS/JS 单窗口 SPA（`src/index.html` 每页一个 `.page` div）。禁止引入 React/Vue/组件库运行时；组件视觉参考 shadcn/ui，交互逻辑参考 antd。
- 仓库 `D:\KaiFa\Trim`。原生组件 `native-scanner/`（Rust）编译出 `finder.exe`（重复/大文件/空项查找器），由 electron-builder 作为 extraResources 进包。安装器为 electron-builder NSIS（commit 5adbe47 起，Tauri 工程退役）。
- 运行时 npm 依赖 **1 个**（`electron-updater`；AI 简介联网拉取用内置 fetch），**默认不新增依赖**，确需新增先征得同意。electron ^44.1.1（`setBackgroundMaterial` 依赖 Electron 30+）。
- 目录总图（2026-09 梳理后）：
  - 根目录：`main.js` / `preload.js`（Electron 入口）、`package.json`、`test-features.js`、`readme.md`、`AGENTS.md`、`LICENSE.md`
  - `src/assets/ico/`：**唯一图标目录**（品牌源、打包、运行时都用它；生成器是 `scripts/fix_icons.py`）
  - `scripts/`：开发工具（gen-fallback / sign-rules / fix_icons / build-fastsize / gen-installer-assets）
  - `docs规范/`：架构文档（本文）、ds API 文档（`design-system/README.md`）与历史更新资料（`docs规范/update/...` 为历史快照，不改写）
  - `src/main/`：主进程共享 Node 模块（`diag.js` / `security.js` / `rules-signature.js` / `ps-rule-path-eval.js`（规则路径受限求值器 PS 片段单一来源）/ `ps-protect-path.js`（受保护路径清单 JS+PS 双实现单一来源）/ `optimization-state.js`（v2.6.0 优化项已应用状态记账）/ `version-migrations.js`（v2.6.0 退役优化项迁移）/ `updater.js`（v2.6.0 多线路自动更新）），被 main.js、脚本生成模块、test-features.js、sign-rules.js require
  - `src/`：5 个窗口 HTML；`scripts/`（渲染层）、`scripts-powershell/`（主进程 PS 脚本模块）、`styles/`、`data/`（cleanup-rules.json、item-intro.json、retired-optimizations.json）、`assets/`（ico 图标、fonts 等）
  - `native-scanner/`：Rust 子工程，`target/` 是构建缓存（已 gitignore，不入库；本地保留，打包要用 release/finder.exe）
  - `build-release/`：electron-builder 构建产物输出（gitignore，不入库；GitHub Releases 发布用）

## 二、进程与窗口

| 部分 | 文件 | 要点 |
|---|---|---|
| 主进程 | `main.js`（约 5200 行，2026-09 实测；按域拆分待专项推进） | 窗口创建、全部 ipcMain.handle、appearance.json 持久化、原生窗口材质、安全模块 SECURITY（来自 `src/main/security.js`） |
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
| `%APPDATA%\Trim\optimizer-backups.json` | optionId → { at, values[] } | 优化项执行前注册表原值备份（fail-closed：备份写失败则中止执行） |
| `%APPDATA%\Trim\optimization-state.json` | items[optionId] = { title, appliedAt, kinds(reg/cmd/service), status(pending/applied), lastVerify(pass/partial/unknown) } | **v2.6.0（P0-1）已应用状态记账**：执行前先写 pending（写不进去就不改，fail-closed 不变式①）；执行成功转 applied + 回读验证；还原成功才销账（不变式②：还原失败保留等下次）。损坏先隔离再降级 |
| `%APPDATA%\Trim\update-mirror.json` | { mirror } | **v2.6.0（P2-8）更新镜像偏好**（auto/github/gh-proxy/ghfast），设置页下拉写入 |
| `%APPDATA%\Trim\system-info.json` | { timestamp, data } | 硬件信息扫描缓存（overview:hardware） |
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
| `npm run build` / `build:dir` / `build:portable` | electron-builder --win --x64（输出 `build-release/`）；prebuild 先跑 gen-fallback，**postbuild（仅 build）自动把非当前版本的旧安装包移入回收站**（clean-old-packages.js，当前版本受保护） |
| `node --check <file.js>` | JS 语法检查（项目无 linter，改完 JS 必跑） |
| `cargo check`（native-scanner/） | Rust 侧检查 |
| `python scripts/fix_icons.py` | 由 `src/assets/ico/source.png` 重新裁切生成全套 png/ico，并同步 Tauri 安装器图标（ROOT 取脚本上级目录；勿就地覆盖 source.png） |
| `.\node_modules\electron\dist\electron.exe . --remote-debugging-port=9333` | 带 CDP 启动（见 AGENTS 验收流程） |

发布链路（v2.6.0 起，NSIS + electron-updater）：`npm run build`（NSIS 安装包 + Portable，prebuild 钩子先跑 gen-fallback）→ 产物在 `build-release/`（`Trim-Setup-<ver>.exe` / `Trim-Portable-<ver>.exe` + `latest.yml` + `*.blockmap`）→ 发布到 GitHub Releases（repo `xiaoxu1642/Trim`，electron-updater 按 latest.yml + sha512 校验增量更新）。**发布到 Releases 的文件 = Setup/Portable exe + latest.yml + blockmap，缺一不可**（blockmap 是差分更新的依据）。`build.directories.output` 是相对路径 `build-release`（v2.6.0 从绝对路径 `Trim goujian\build-release` 迁移，目录名带空格的坑一并消除）。打包 files 清单见 package.json `build.files`（含 `readme.md`、`src/assets/ico/*.ico`；应用内使用说明弹窗读的就是这个 readme.md）。版本号以 package.json 为准；窗口/交互规范变更同步本文档相关章节。**工作树常态保留大量未提交改动：不主动 commit / push，也不得为实施新改动回滚既有未提交工作。**

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
- **受保护路径清单（v2.2 第 2 批 / D18）唯一来源 `src/main/ps-protect-path.js`**：同时导出 JS 判定 `isPathProtected()`（主进程）与 PS 片段 `PROTECT_PATH_PS`（`Resolve-TFPathKey` + `Test-PathProtected`，注入 EXECUTE）。清单三语义——`subtree`（等于根或在根之下即拒：`%APPDATA%\Trim`、`%WINDIR%\System32\config`）、`exact`（等于根或根在目标之下即拒：WINDIR/ProgramFiles/ProgramFiles(x86)/PROGRAMDATA/USERPROFILE/Desktop/Documents/Downloads/Roaming 根/Local 根）、`anyDrive`（任意盘符同名整棵拒：`system volume information`）。主进程 `ensureProtectedConfigured()` 补 Electron known folder 与 `APP_DATA_DIR`（known folder 会被组策略/OneDrive 重定向，不能被 env 推导替代），`cleanup:execute` 生成脚本前调用，故 JS 与 PS 走同一份清单（`require` 缓存单例）。**六个闸口**：EXECUTE 的 `Remove-PathSafely` 入口、fileKeys 分支（任一命中整条拒绝）、目录型回收站分支（`@@RECYCLE@@` 之前）、`Prune-EmptyDirs`、`Remove-PathSafely` contents 分支逐子项（v2.2 第 3 批 / D2，纵深防御），加主进程 `trashOrUnlink` 入口（命中返回 `{ok:false,protected:true}`）。清单解析为 `$null` 时脚本 `[Console]::Error.WriteLine` + `exit 2`（缺清单等于没闸，禁止静默放行）。注册表条目走独立 `excludeKeys` 保护，不在此清单内。**已知未覆盖**：`finder:delete` 的 Rust 原生删除（`delete.rs` 回收站失败回退永久删）不经 `trashOrUnlink`，仅靠调用点 `isProtectedDeletePath` 整批前置拒绝缓解，彻底收口需把保护清单（或其等价判定）传进 Rust——D2/D18 两批均未动 Rust 删除面，独立专项。
- **规则路径表达式受限求值（v2.2 第 2 批 / D1）**：`pathPs`/`candidatesPs`/`globCandidatesPs` 原经 `Invoke-Expression` 求值（全仓 6 处：cleanup SCAN 3 + DETAIL 1 + pathscan 2），因自定义规则目录 `%APPDATA%\Trim\cleanup\custom\*.json` 不验签且在线更新文件可被写入，等价「能写 json = 执行任意代码」。现统一走单一来源 `src/main/ps-rule-path-eval.js` 导出的 `RULE_PATH_EVAL_PS`（递归下降，文法仅 `表达式 := '(' 表达式 ')' | 项 ('+' 项)*`、`项 := '$env:' 标识符 | 单引号字面量`），返回 `[pscustomobject]{ok,path}`，**调用方必须 fail-closed**（旧「求值失败回落表达式原文当路径」兜底已废除）。内置 49 条表达式与旧 IEX 结果对拍零偏差。新增动态求值禁止回到 `Invoke-Expression`（test-features 有全仓零调用断言）。

## 十、回归陷阱速查（动这些地方前先看）

- `liquid-glass.js` 的 `schedulePlace` 会 cancel 前一个 rAF——谁后调 `refreshAll(animate)` 滑块动画以谁为准（`app.js` setCleanupView 里必须是 `true`，改 false 会复发"切换无动效"）。
- quickcmds / maintenance 分类栏 innerHTML 整体重渲染 → 滑块走 MutationObserver 路径，别改手动 `placeThumb(false)`。
- 磁盘清理工具栏按钮可搬位置，但 finder.js 按 `[data-finder-manifest]` 全局绑定、其余按钮靠 id 通信——**别改 id / data 属性**。
- 内存卡 `#memUseValue` 三重护栏，动 summary-value 结构前先看 memoryclean.js。
- 悬停提示一律 `data-tip`；弹窗一律 modal.js（focusTrap）。
- 液态玻璃性能护栏是刻意的：折射元素上限 28、>420px 大元素只磨砂、位移贴图缓存 48、rAF 节流——不要放开。
- ds.js 未加载时相关功能必须优雅降级（参考 memoryclean 环形进度的无线环回退）。
- 清理规则唯一数据源是 `src/data/cleanup-rules.json`（P1-9）。条目目标模型按优先级路由：`special:'dism'` → `fileKeys[]`（%ENV% + 通配路径、pattern、removeSelf、excludeKeys 排除）→ `regKeys[]`（value 语义：无=删树 / `'*'`=清键值 / 具名=删值）→ `pathPs`（目录型）；通用字段 `detect[]`（未命中不参与扫描，渲染层扫描后隐藏）、`requiredStoppedProcesses`（已接线：扫描出 blockedBy 标签，执行命中即整项跳过）、**`deleteMode:"contents"`**（v2.2 第 3 批 / D2：只删目录内容、目录壳保留；仅 pathPs 条目有意义，37 条里 34 条标 contents、3 条老版本备份类刻意不标——删除前 regKeys 另有 `reg.exe export` fail-closed 备份，见下条）。**改规则 JSON 后运行 `node scripts/gen-fallback.js` 重新生成 FALLBACK**（审查 2-2：generated 文件入库，npm prebuild 钩子自动生成，test-features 含双源一致性断言；发布前还需 `scripts/sign-rules.js sign` 签名，见下条）。引擎细节陷阱：PS 里属性缺失时 `@($null).Count` 是 1（判空要先 `-not $x`）；哈希表 `$m.count` 命中内建 Count 属性（返回键数），要用 pscustomobject。
- 规则库在线更新（P2）：数据目录 `%APPDATA%\Trim\cleanup\rules.json` 优先于内置生效（`cleanup-scripts.js loadRules()`，mtime 签名缓存），`custom\*.json` 同名 id 覆盖；更新走 `cleanup:update-rules` IPC（发布源常量 RULES_UPDATE_URLS 在 main.js，GitHub → jsDelivr → gh-proxy 回退，**ed25519 验签**（审查 1-1：公钥内置 `src/main/rules-signature.js`，私钥在发布机 `~/.trim-signing/`，签名对象为去掉 `_sig` 后的紧凑 JSON；`_sig` 置于根对象）+ 尺寸上下限（4KB/2MB，流式限量读取）/结构/防降级校验，.downloading 原子替换），渲染层入口是磁盘清理工具栏「更新规则库」按钮（id `btnUpdateRules`）。**改规则 JSON 发布前必须 `node scripts/sign-rules.js sign` 重新签名**（gen 子命令生成/更换密钥对，更换公钥须同步发新版应用），未签名内容应用端一律拒绝。私有仓库的匿名 HTTP 源会 404：可在数据目录 `update-source.json` 配 `{urls,headers}` 覆盖；另有 git 回退（应用在 git 仓库内时 `git fetch origin main` + `git show FETCH_HEAD:` 取远程文件，只 fetch 不动工作树）。`pathscan-scripts.js scan()` 接收注入的规则 JSON，缓存目录候选从 rules 的 candidatesPs/globCandidatesPs 求值（更新后路径扫描同步）。
- P3 执行/明细：`cleanup:execute` 收到 `{items,force,toRecycle,autoRebuild}`；toRecycle 时 PS 只枚举输出 `@@RECYCLE@@`（path/size/isDir）行，主进程 `shell.trashItem` 实际移入回收站（注册表/DISM 无回收站语义仍 PS 直删）；删除后每项带 `residual` 残留计数。`cleanup:item-detail` 用 DETAIL_SCRIPT 只读枚举文件清单（上限 600 行，`@@ITEMFILE@@`/`@@DETAIL@@` 行协议，主进程按行切流不整块读 stdout）。渲染层：工具栏新增「删除进回收站」勾选框，全项目「明细」按钮弹窗；注意 ForceDelete/AutoRebuild 勾选框此前从未被读取，现已真实接线。
- **清理两阶段 Analyze→Clean + 可删性探测（v2.2 第 3 批·架构 / D13+D7）**：清理从「扫描/明细/执行三次独立枚举」改为「扫描是一次即产出**可删文件清单**（`@@PLANFILE@@` 行流式回传，fileKeys 的 `Get-FileKeyDeletable` + pathPs 的 `Get-PathDeletableStats` 都过独立打开预检），主进程聚合进 `cleanupSnapshots` 快照 `item.files`；`cleanup:item-detail` 对 fileKeys **直接读快照清单**（cap=600，计划即明细，DETAIL_SCRIPT 降级为无快照兜底）；EXECUTE fileKeys 分支**只消费 `item.files` 计划清单**，不再现场 glob——扫描后新增文件不在清单则不会被误删（TOCTOU 根治）；回收站 `@@RECYCLE@@` 同样只发计划内仍存在的文件」。**可删性探测**：`FileShare.None` 独占打开预检，任一进程持该文件句柄即剔除——**保守语义**，把「正被读取但允许删除」的文件也剔除（宁可少报，不可虚报可释放量），根治「显示 8GB 清理 300MB」虚报。`TrimFastSize.cs` 新增 `ListDeletable`（`FileSystemEnumerable` 单遍枚举+探测，返回 Files/TotalCount，`locked=TotalCount-Files.Length`）。**防呆上限** `PLAN_CAP_PER_ITEM` 10 万/条目、`PLAN_CAP_TOTAL` 100 万/全扫，超限标 `filesTruncated`。**渲染层零改动**（`locked`/`filesTruncated` 只进协议不进 UI，占用提示留给 D11/D16）。
- **清理正确性口径（v2.2 第 1 批立规，动 `cleanup-scripts.js` 前必读）**：① `freed` 只能是删除前后**实测快照差值**（`Resolve-RemoveOutcome` 里 `$before.size - $after.size`），`after.size>0 -or after.nfiles>0` 判 `partial`，**严禁**直接取删除前全量 size 冒领；② `residual` 复用删除后快照的 `nfiles`，不得另起 `-Depth 6` 复查（旧实现恒 0）；③ size 是**三态**：`Get-PathStats` 返回 `{ok,missing,size,nfiles}`，统计失败上报 `$null` → 渲染层渲染 `—`，与「真的是 0 字节」区分，新增消费点一律按 `?.size || 0` 汇总、显式判 null 展示；④ 全局 `SilentlyContinue` 下 `Write-Error` **不写 stderr**，致命错误必须 `[Console]::Error.WriteLine` + `exit 2`（主进程 `code!==0` 时把 stderr 当 message 透出），SCAN/EXECUTE 头部各有 `$null -eq` 致命守卫——注意 `'[]' | ConvertFrom-Json` 落变量即为 `$null`（`'{}'` 不是），空清单与解析失败无从区分，守卫只能合并，`@($items).Count -eq 0` 属不可达死代码（test-features 有反向断言拦截）；⑤ `EnumerateFileSystemEntries` 无 `MoveNext`、ACL 异常惰性发生在首次 `MoveNext()`，探针必须 `.GetEnumerator()`；`Test-Path` 对「存在但无列举权限」返回 True，**存在 ≠ 可统计**；⑥ 函数体内禁止 `Write-Output` 类诊断（`Write-TFDiag` 会污染返回值破行协议），诊断一律在调用处输出；⑦ 主进程入口已强校验（`cleanup:scan` 要求 `categories.length>=1`、`validateSnapshotItems` 对空清单 `return null`），**勿在 main.js 补空清单早退死代码**。已知遗留：`special='dism'` 分支硬编码 `size = 0`（应为 `—`），牵动汇总口径未随本批改。
- **路径表达式与保护清单口径（v2.2 第 2 批立规，动 `ps-rule-path-eval.js` / `ps-protect-path.js` / EXECUTE 删除分支前必读）**：① **.NET `Path.GetFullPath` 会展开磁盘上存在的 8.3 短名，Node `path.resolve` 不会** → 短名与裸盘符两类 fail-closed 判定必须放在**解析之前**、JS/PS 同位置（`resolve` 还会拼 CWD、折叠 `..`，只查解析结果会漏判 `C:\a~1\..\Windows`）；② 清单只能从环境变量取根，**禁止** `SystemDrive + 硬编码目录名`（多语言/自定义安装静默失效）；`USERPROFILE`/`APPDATA`/`LOCALAPPDATA` **永不进 subtree**；③ PS 片段写在 JS 模板里时**注释不得含反斜杠、严禁反引号**，分隔符用 `$bs=[string][char]92`，路径匹配一律 `Substring`/`StartsWith` 字面量比较（正则要穿三层转义必错）；④ **PS 子作用域 `+=` 不回传父作用域**，fileKeys 保护过滤改用「计数 + 任一命中整条拒绝」（同 id 拆两行 details 会破坏渲染层行协议）；⑤ 归一化清单元素存**已归一化小写绝对路径**，PS 侧只比字符串，故语义不可能漂；⑥ `C:\$Recycle.Bin` **刻意不在清单**（内置 `recycleBin` 规则目标即它），test-features 有反向 tripwire 断言，改判须连规则一起改；⑦ EXECUTE 侧现有 **5** 处 `Test-PathProtected`（函数入口 / fileKeys / 回收站分支 / Prune-EmptyDirs / contents 逐子项；断言下限仍是 4），新增删除面先问「这条路径有没有经过 `Remove-PathSafely`」，没有就单独挂闸并同步断言下限；⑧ **JS 模板字符串吞反斜杠同样作用于代码里的路径字面量**——`'Trim\cleanup-reg-backup'` 的 `\b` 会被吞成退格符，路径一律嵌套 `Join-Path` 无斜杠写法（v2.2 第 3 批 D4 实战）；⑨ **regKeys 删除前备份「先全备份、后统一删除」fail-closed**（备份目录 `%APPDATA%\Trim\cleanup-reg-backup\`，`Convert-RegPathForExport` 剥 `Registry::` 前缀 + 全名缩写，与 `Convert-RegPath` 互为反向，改一处须同步另一处；备份不看 `recycle`——注册表两种模式都是直接删）；⑩ **`deleteMode:"contents"` 的 37/34/3 分布被断言锁死**，备份类误标 contents 会留空壳、非备份类漏标会退回「整目录删 + 路径猜测重建」，改规则 JSON 后必跑 `gen-fallback.js`。
- finder.exe 查找顺序（main.js）：打包后 `process.resourcesPath/finder/finder.exe` → 开发态 `native-scanner/target/release/finder.exe` → `resources/finder/finder.exe`；改 Rust 后必须 `cargo build --release` 刷新，electron-builder 从 target/release 取件进包。
- **优化中心记账三不变式（v2.6.0，动 `optimizer:run` / `restore-reg` / `optimization-state.js` 前必读）**：① **执行前先记账**（`OPT_STATE.recordPending` pending），记账写失败必须中止执行返回失败（fail-closed，不能降级放行）；② **还原成功才销账**（`restore-reg` 成功路径 / `optimizer:run` restore 模式成功路径调 `OPT_STATE.remove`），失败一律保留记录；③ 执行失败/异常路径转 `applied + lastVerify:'unknown'` 保留记录（前序步骤可能已生效），由启动扫描核对——不要在失败路径上删记录。`checkOptimizedInternal` 是 `optimizer:check-optimized` IPC 与执行后回读共用的单一实现，改检测逻辑两处同时生效；`verifyOptionApplied` 对无逐键比对手段的 cmd 类步骤只能返回 `'unknown'`，**禁止伪造 pass/partial**。退役迁移（`version-migrations.js`，whenReady 后台跑）：备份文件里「不在当前 OPTIONS」的 id 按原值还原，还原失败保留原记录下次重试；退役清单 `src/data/retired-optimizations.json` 只提供元数据（title/note），缺省也能还原。渲染层 stale 横幅（optimizer.js `loadStateOverview`）：stale = pending 记录 + 已应用但逐键检测不符；动态项（svc_mem_gb）不参与 stale 判定（遗留 pending 记录在 state-overview 里直接清理）。
- **优化项 effect 字段（v2.6.0 P2-7）**：`EFFECT_MAP` 在 optimizer-scripts.js 末尾统一注入（不改 125 个对象字面量），未登记的 id 一律默认 `'未验证'`（诚实兜底）；渲染层 EFFECT_BADGE/弹窗说明与档位字符串强耦合，增删档位需同步 test-features 的 effect 断言与 readme 描述。
- **系统体检脚本（v2.6.0 P1-6，`overview-scripts.js checkup()`）**：写在此 JS 模板字符串里的 PS 代码**禁反引号、禁 `${`**（模板插值冲突，test-features 有断言）；`Add-Check` 用 `$script:checks +=`（脚本经 `-File` 执行，script 作用域成立，改成 `-Command` 会静默丢数据）；全部只读 + 证据等级（本机实测/机制明确/未验证），检测不出标 `'unknown'` 不伪造结论；主进程 5 分钟缓存 + 在途去重（`overview:checkup`），`refresh=true` 才强制重跑。
- **updater 多线路（v2.6.0 P2-8）**：electron-updater 单实例无法并发竞速，容灾是 `orderedFeeds()` 顺序回退（用户指定镜像优先 → GitHub 兜底）；每次尝试都 `setFeedURL` 显式重设（github provider 与 generic provider 混用），新增镜像只改 `MIRRORS` 常量 + 渲染层 `getMirror` 返回的 options（下拉按主进程清单动态渲染，HTML 不硬编码）。**信任锚是 latest.yml 内 sha512**（electron-updater 下载后强校验），镜像域名不需要也不应再加白名单——这与规则库更新「源只是通道、内容自证可信」同一模型。镜像偏好持久化在数据目录 `update-mirror.json`（tmp+rename 原子替换）。
- **便携模式（v2.6.0 P2-9）**：`IS_PORTABLE`（程序目录 `Trim.portable` 标记，仅打包后生效）在模块顶层、`app ready` 之前 `setPath('userData', exeDir\data)`；`APP_DATA_DIR` IIFE 必须先判 `PORTABLE_DATA_DIR`——userData 基名此时是 `data` 不是 `trim`，走 C1 分支会静默回落 `%APPDATA%\Trim` 便携失效。开发环境恒为标准模式（`!app.isPackaged` 短路）。
- **启动页（v2.7.0，`src/scripts/splash.js`）**：必须是 body 末尾脚本中**第一个**加载（独立无依赖，先盖住整窗）；标题栏品牌靠 CSS `body:has(.splash-overlay:not(.finished)) .titlebar-title { visibility:hidden }` 隐藏（Electron 44 支持 `:has`），splash 移除节点即放行——**别改成 JS 手动切 visibility**（finish 有多条兜底路径，CSS 联动才不会漏）。FLIP 落位两个必踩坑：① 入场动画 fill both 会钉死 transform（动画优先级 > transition），落位前必须 `style.animation='none'`；② transition 与 transform 同帧写入不触发过渡，必须先强制重流（`void offsetWidth`）再写 transform。参考页 hero-preview/index.html 仍带这两个 bug，勿当「正确实现」回抄。`trim_splash_seen` 决定首访/紧凑模式，清掉即复现完整首访流程。**v2.7.1 编排**：进度条 92% 封顶等 `trim:boot-ready`（app.js init 末尾派发，4s 硬兜底），紧凑模式就绪即进（MIN_DISPLAY 450ms 防闪烁）；右上角原生 titleBarOverlay 盖不住（非客户区原生绘制，DOM 层级永远低于它）只能同色融合——splash:overlay IPC 把覆盖层临时染 #efedfb、结束恢复；`.splash-overlay` 底色必须保持透明，否则「落位期间主页内容渐显」失效。
- **关闭即隐（v2.7.0）**：close 钩子 = `preventDefault + hide + requestSilentQuit()`；`activeCleanupRuns` 计数器包住 `cleanup:execute` 全程（++/--），`requestSilentQuit` 轮询等它归零 + `maintenanceRunning` 为空才 `app.quit()`（删除统计不可回滚），5s 后 `app.exit(0)` 兜底。**updater:install 必须先置 `isShuttingDown = true`** 再 `quitAndInstall`，否则 close 钩子 preventDefault 卡死安装替换。渲染层不再监听 `app:shutdown`、不弹关闭 Toast——`shutdown:begin/complete` 通道保留作扩展点，勿删。
- **体检行动化与检测结果持久化（v2.7.0）**：忽略清单在渲染层 localStorage `winclean-checkup-ignored`（id 数组）；`CHECKUP_JUMP` 的跳转目标必须是 index.html 导航真实存在的 `data-page` 键（test-features 有断言）。`optimization-state.json` 新增 `detected` 段：`replaceDetected`=全量替换（启动扫描，whenReady+3s 后台）、`setDetectedEntry`=单条及时写（执行/还原后立即回写）；渲染层先用 detected 即时灰化，实时检测（checkOptimized）为**权威源**（增删灰态都生效——此前只加不减是刻意修改）。
