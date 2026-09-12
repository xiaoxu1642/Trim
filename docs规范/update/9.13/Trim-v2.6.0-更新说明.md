# Trim v2.6.0 更新说明（2026-09-13）

> 依据：`D:\KaiFa\文件分析\Pavise-Game-main\Pavise-全量功能解包分析与Trim改进路线图.md` 的改进路线图。
> 用户裁定范围：**P1-4 场景模式、P1-5 进程优先级/亲和性不做**（不同意该 AI 的做法）；**P3 长期方向全部不做**（GPU 厂商 API / ETW / 多语言 / 进程压制引擎）；P2-10 单实例健壮性路线图自证已完成，划掉。
> 本批实施：P0-1、P0-2、P0-3、P1-6、P2-7、P2-8、P2-9 + 版本 2.6.0 + 打包输出迁移 build-release。

---

## 一、P0 用户系统安全（本批核心）

### 1. P0-1 优化项「已应用清单」+ 崩溃自愈

- 新增 `src/main/optimization-state.js`，数据文件 `%APPDATA%\Trim\optimization-state.json`（损坏先隔离再降级，与 optimizer-backups 同策略）。
- 两条不变式（抄 Pavise SuppressionCore）：
  1. **先记账，记不进去就不改**：`optimizer:run` 执行前写 `pending` 记录（`recordPending`），写失败直接返回失败中止执行（fail-closed）；
  2. **还原失败不清账**：还原成功才 `remove`；失败保留记录等下次重试。
- **覆盖面**：`kinds: reg / service / cmd`——bcdedit、fsutil、powercfg、服务启停等 `optimizer-backups.json`（只记注册表原值）覆盖不到的步骤现在全部有记账痕迹。
- 执行失败/异常路径：记录转 `applied + lastVerify:'unknown'` 保留（前序步骤可能已生效），由启动扫描核对真实状态——**不在失败路径删记录**。
- 启动扫描：新 IPC `optimizer:state-overview`。stale 判定 = `pending`（执行中断遗留）∪「已应用但逐键检测不符」；动态项（svc_mem_gb）不参与（遗留 pending 直接清理，避免误报）。
- 渲染层（optimizer.js）：优化中心顶部「未完成还原」横幅（`#optimizerStaleBanner`）+ **一键还原**（逐项 `restoreReg`，无备份回退预置还原脚本——即 `restoreOption` 已提升到模块级共用）。

### 2. P0-2 执行后回读验证（三态）

- `check-optimized` 的逐键比对逻辑抽为 `checkOptimizedInternal()`（IPC 与回读共用单一实现）。
- `optimizer:run` 成功后立刻 `verifyOptionApplied()`：
  - reg/service 可检测项 → 复用 `checkOptimizedInternal` 逐键比对；
  - svc_mem_gb → 读当前阈值比对目标档位；
  - cmd 类（bcdedit 等）无比对手段 → 如实 `unknown`，**禁止伪造**。
- 返回 `verify: 'pass' | 'partial'`，结果同时写入记账（`markApplied`）。渲染层对 `partial` 弹黄色警示「已执行但读回校验不符，可能被组策略或安全软件覆盖」——不再静默假成功。
- `svcMemCurrent` 同步抽为 `svcMemCurrentInternal()`。

### 3. P0-3 退役优化项版本迁移

- 新增 `src/main/version-migrations.js` + `src/data/retired-optimizations.json`（当前 `items: []`，git 历史比对确认暂无退役 id；框架先行，后续退役项在此登记元数据）。
- whenReady 后台执行 `runRetiredMigrations`：扫 `optimizer-backups.json`，对**不在当前 OPTIONS 里**的 id 按记录原值还原注册表（`restoreBackupValues()` 与 `restore-reg` 共用同一实现，v2.6.0 抽出），成功后删除备份与记账记录；**失败保留原记录，下次启动自动重试**（多为缺管理员权限）。
- 迁移结果经 `optimizer:state-overview` 回报渲染层一次性 toast「已自动还原 N 项已退役优化的历史改动」。

## 二、P1-6 系统体检页（系统概览页升级）

- 导航/页头「系统概览」→「系统体检」（页面 key 仍为 `overview`，localStorage 兼容）；实时资源卡片与硬件信息保留。
- 新增只读体检：`overview-scripts.js checkup()` 生成 9 项诊断（本机实测通过）：
  CPU 拓扑（含 P/E 混合架构判定）/ 内存通道与频率 / 当前电源计划 / 开机自启数量 / 磁盘健康（SMART，Storage 模块缺失回退 WMI）/ 可精简服务 / 显示器刷新率 / Defender 实时防护 / 系统盘剩余空间。
- 每条结论 = `正常/注意/异常/无法判定` 状态徽章 + **证据等级**（本机实测/机制明确/未验证）——检测不出如实标「未验证」，不伪造结论（Pavise SystemAudit 哲学）。异常>注意 排序优先露出。
- 新 IPC `overview:checkup`（只读白名单），主进程 5 分钟缓存 + 在途去重；进页面自动体检，「重新体检」按钮强制刷新。
- 脚本约束：JS 模板里禁反引号/`${`；`$script:checks` 依赖 `-File` 执行的 script 作用域。

## 三、P2 工程化与体验

### 4. P2-7 优化项「预期效果」+ readme「不做的事」

- `EFFECT_MAP`（optimizer-scripts.js 末尾统一注入，125/125 全覆盖）：明显 7 / 一般 76 / 微小 36 / 未验证 6；未登记的新项默认「未验证」（诚实兜底）。
- 详情弹窗 meta 行加「效果·X」徽章 + 分级依据说明行（明确标注「经验分级，非本机实测数据」）。
- readme 新增「十一、不做的事（已知无效或有代价的常见优化）」8 条：清空待机列表、MMCSS、FSO/MPO、BCD 玄学参数、高频自动内存整理、盲目禁服务、MSI 模式、AMD 注册表调优。

### 5. P2-8 更新多线路容灾

- `src/main/updater.js`：`orderedFeeds()` 顺序回退（electron-updater 单实例无法并发竞速，顺序回退是等价容灾，与规则库更新同模式）：用户指定镜像优先 → GitHub 直连兜底 → 其余镜像。
- 镜像：gh-proxy / ghfast（generic provider，指向 `releases/latest/download/`）；**信任锚是 latest.yml 内 sha512**（electron-updater 下载强校验），镜像只是传输通道，不加域名白名单——与规则库「内容自证可信」同一模型。
- 新 IPC `updater:set-mirror` / `updater:get-mirror`（后者入只读白名单）；偏好持久化 `%APPDATA%\Trim\update-mirror.json`（tmp+rename 原子替换）。
- 设置页「关于」新增「更新镜像」下拉（选项由主进程 `getMirror` 动态渲染，HTML 不硬编码镜像清单）。

### 6. P2-9 便携模式

- 程序目录存在 `Trim.portable` 空文件（仅打包后生效）→ 模块顶层、`app.ready` 前 `setPath('userData', <exeDir>\data)`；`APP_DATA_DIR` 显式返回 `PORTABLE_DATA_DIR`（userData 基名此时是 `data`，不走 C1 分支）。
- `app:get-info` 新增 `portable/dataDir` 字段；设置页「系统信息」加「数据目录」行。

## 四、版本与发布

- package.json `version: 2.6.0`；`build.directories.output` 绝对路径 `D:\KaiFa\Trim\Trim goujian\build-release` → **相对路径 `build-release`**（仓库根，消除目录名带空格的坑）；`.gitignore` 已有 `build-release/`。
- readme 版本行 2.5 → 2.6；功能表/优化中心/设置页章节同步。
- 测试：test-features.js 新增第 6 段 8 项断言（记账 fail-closed 语义、迁移成功销账/失败保留、retired 清单结构、effect 全覆盖、体检脚本 PS 语法+模板冲突禁用字符、多线路形状、IPC 双侧对齐、便携关键代码），全量 91 项通过。
- 架构文档：architecture.md（版本/模块/存储/发布链路/第 6 段 v2.6.0 陷阱）、目录结构.md 重写。

## 五、已知边界与遗留

- 体检「CPU 拓扑」的混合架构判定依赖内核公开的 `EfficiencyClass` 注册表值，部分平台不公开——此时如实返回同构结论（证据等级「本机实测」），不会误判。
- 更新镜像的可用性依赖社区镜像服务存活；GitHub 直连始终是第一优先级（用户未固定线路时），镜像失败会逐条回退并记日志。
- 退役迁移还原 HKLM 值需要管理员权限；非管理员启动时失败并保留记录，下次以管理员启动自动重试。
- P1-4 / P1-5 / P3 按用户裁定未实施（见文首）。
