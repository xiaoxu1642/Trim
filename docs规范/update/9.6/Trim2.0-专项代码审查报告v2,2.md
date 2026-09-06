# Trim 2.0 专项代码审查报告

> 审查基准：Trim 2.0（`C:\kaifa\TuneForge`）· Electron ^44.1.1 · Win11 27H2
> 审查方式：全量精读核心文件 + 脚本化机器扫描（IPC 通道覆盖、双源一致性、CSS 规范量化）
> 审查约束：**只审查，未修改任何项目代码**（临时审计脚本仅落在系统 temp 目录，未写入仓库）

---

## 一、审查概览

- **审查文件数**：全量精读 11 个核心文件（main.js 4944 行、preload.js 309 行、index.html 1263 行、security.js、package.json、cleanup-rules.json、app.js、theme.js、pathbinding.js、cleanup-scripts.js 关键段、cleanup.js 关键段）；机器扫描覆盖 59 个文件（53 个渲染层 JS / 5 个 HTML / main.css 7858 行）
- **问题总数**：42 个（🔴 严重 2 / 🟡 中等 17 / 🟢 建议 23）
- **最高风险领域**：**供应链与更新校验链**（规则库在线更新无签名，直接通往 PowerShell 删除执行）；其次是 **IPC 信任边界覆盖不全**（115 个通道仅 33 个校验 sender）
- **整体评价**：这是一份**安全基线明显高于同类个人项目**的代码——`safeStorage` DPAPI 加密密钥、临时脚本目录禁用符号链接、`validateSnapshotItems` 快照校验防构造删除目标、`rejectUntrustedRenderer` 信任边界模型、超时兜底与子进程 PID 白名单清理，都是专业级的防护设计；Win11 27H2 的 DWM 红线与各类回归陷阱也用注释完整固化了下来。主要短板在于**防护覆盖的不均衡**：安全机制建好了但只覆盖了 33/115 个通道，规则双源已实际漂移，CSS token 体系被 123 处覆盖层字面色侵蚀。

### 值得肯定的设计（非问题，供后续维护参考）

| 设计 | 位置 | 说明 |
|---|---|---|
| 密钥 DPAPI 加密，且加密不可用时**拒绝明文保存** | `src/security.js:32-39` | `encryptSecret` 抛错而非降级明文，fail-safe 取向正确 |
| 临时脚本目录拒绝符号链接 | `main.js:498-503` | 正确封堵了提权场景下的 TOCTOU 本地提权窗口 |
| 删除目标快照校验 | `main.js:122-134` | 只从最近一次扫描快照取参，禁止渲染层构造 `path/risk/source` |
| PowerShell 单引号转义 + `.replace(ph, () => v)` 函数式替换 | `cleanup-scripts.js:1084-1090` | 既封闭注入又避免 `$&` 替换模式陷阱，写法讲究 |
| 子进程 PID 白名单，退出时不按进程名误杀 | `main.js:138`、`4927-4939` | 注释明确"绝不按进程名无差别杀戮" |
| PowerShell 7 探测处理 WindowsApps 0 字节存根 | `main.js:351-360` | 真实踩坑经验，避免拉起 Microsoft Store |
| 27H2 最大化禁止材质操作 | `main.js:751-773` | 结论附实测依据（a/b/c 三条），红线遵守良好 |
| 日志缓冲 + 退出前 `flushLogSync` | `main.js:265-315`、`4923` | B9 优化点，尾部日志不丢 |

---

## 二、维度 1：安全漏洞审查

### [1-1] 清理规则库在线更新缺少签名/哈希校验 🔴 严重

- **位置**：`main.js:1133-1255`（`cleanup:update-rules` 的 `RULES_UPDATE_URLS` 与 `validate()`）
- **问题描述**：
  规则库校验链只有四环：尺寸 ≥ 4096 → JSON 可解析 → `groups[].items[].id/name` 字段存在 → `rulesVersion` 防降级。**没有任何签名、哈希或发布者身份验证**。
  而这些规则的内容**直接决定后续 PowerShell 脚本的删除目标**（`pathPs` / `fileKeys` / `regKeys` / `special:'dism'`）。也就是说，谁能控制规则内容，谁就能让用户点一次「开始清理」即执行任意路径删除。
  风险被两点放大：
  1. 源列表第 3 位是第三方明文代理 `https://gh-proxy.com/...`（`main.js:1136`）——该域名不由项目方控制，无鉴权、可缓存投毒；
  2. 未限制响应体上限（只有 `RULES_MIN_SIZE`，无 `RULES_MAX_SIZE`），超大响应会先整段进内存再做校验。
- **根因分析**：
  防降级（`version < currentVersion` 拒绝）解决的是"版本回退"，不解决"内容是真是假"。结构校验（有 `id`/`name`）只能证明"长得像规则"，而恶意规则完全可以长得一模一样——把某个条目的 `pathPs` 指向 `%USERPROFILE%\Documents` 是零成本的。
- **优化方案**：
  1. 内置公钥，对规则文件验签（ed25519 最小改动），或退一步锁定 `sha256` 白名单；
  2. 移除第三方代理源，或对其响应额外强制哈希比对；
  3. 补齐尺寸上限与流式读取上限。

```js
// Before（main.js:1189-1199）
const validate = (text) => {
  if (!text || text.length < RULES_MIN_SIZE) return { error: '内容过小，疑似异常响应' };
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return { error: 'JSON 解析失败' }; }
  if (!parsed || !Array.isArray(parsed.groups) || parsed.groups.length < 1) return { error: '缺少 groups 结构' };
  /* … 字段形状 + 防降级 … */
};

// After：增加签名与尺寸上限（示意，公钥以构建期常量注入）
const RULES_MAX_SIZE = 2 * 1024 * 1024;             // 新增：响应上限 2MB
const RULES_PUBKEY_PEM = require('./src/rules-pubkey');

const validate = (text) => {
  if (!text || text.length < RULES_MIN_SIZE) return { error: '内容过小，疑似异常响应' };
  if (text.length > RULES_MAX_SIZE) return { error: '内容过大，疑似异常响应' };  // 新增
  const sig = extractSigBlock(text);                 // 约定签名写在 JSON 的 _sig 字段
  if (!sig) return { error: '缺少签名，已拒绝' };                                // 新增
  if (!crypto.verify(null, Buffer.from(bodyWithoutSig), RULES_PUBKEY_PEM, Buffer.from(sig, 'base64')))
    return { error: '签名校验失败，已拒绝' };                                     // 新增
  let parsed;
  /* … 原有结构与防降级校验保持不变 … */
};
```

- **验证方式**：
  1. 本地起一个恶意 HTTP 服务返回「结构合法但 `pathPs` 指向测试目录」的规则，版本设为 `99999999`，走 `update-source.json` 覆盖源触发更新 → 修复后应返回「缺少签名/签名校验失败」；
  2. 用 Fiddler/mitmproxy 劫持 `gh-proxy.com` 响应，确认不再被接受；
  3. 返回 3MB 随机内容，确认被尺寸上限拦截而非 OOM。

---

### [1-2] 文件清理（QQ/微信）永久删除，未走回收站兜底 🔴 严重

- **位置**：`main.js:4783`（`fileclean:delete-file`）、`main.js:4812`（`fileclean:execute`）
- **问题描述**：
  两个通道都用 `fs.unlinkSync(filePath)` **直接永久删除**，没有回收站兜底。这与项目硬约束直接冲突——AGENTS.md §2.7：「删除类回收站兜底 + 确认弹窗统一 modal.js」。
  更值得注意的是**同项目内已存在正确实现**却未复用：`cleanup:execute` 支持 `toRecycle` 并走 `shell.trashItem`（`main.js:1039`），`finder:delete` 走 Rust 原生并支持 `recycled` 模式（`main.js:1467-1474`）。只有 fileclean 这一族漏了。
  该功能是批量操作（用户可一次选中数百个图片/文件），一旦误选即不可逆。
- **根因分析**：
  三个删除链路是三个不同时期实现的（cleanup 最早、finder 走 Rust 原生、fileclean 最晚），缺少统一的"删除出口"抽象，导致兜底策略各写各的。
- **优化方案**：
  1. 抽一个统一删除出口，fileclean 接入；
  2. 保留"回收站失败才允许永久删除"的语义，并回写清单标记（现有 `saveDeleteManifest` 已支持 `recycled` 字段）。

```js
// 新增统一出口（main.js，靠近 saveDeleteManifest）
async function trashOrUnlink(target, { allowPermanent }) {
  try {
    await shell.trashItem(target);
    return { ok: true, recycled: true };
  } catch (e) {
    if (!allowPermanent) return { ok: false, recycled: false, message: e.message };
    try { fs.unlinkSync(target); return { ok: true, recycled: false }; }
    catch (e2) { return { ok: false, recycled: false, message: e2.message }; }
  }
}

// After（main.js:4808-4815，fileclean:execute 内）
if (fs.existsSync(file.path)) {
  const stat = fs.lstatSync(file.path);
  if (!stat.isFile()) throw new Error('目标不是普通文件');
  const size = stat.size;
  const r = await trashOrUnlink(file.path, { allowPermanent: true }); // 改：优先回收站
  if (!r.ok) throw new Error(r.message);
  freed += size; success++;
  details.push({ path: file.path, status: 'ok', freed: size, recycled: r.recycled });
}
```

- **验证方式**：在「文件清理」选中 1 个测试图片执行 → 检查系统回收站出现该文件，且 `%APPDATA%\Trim\fileclean-backup\deleted-*.json` 中该条 `recycled: true`；把回收站设为"不将文件移到回收站"后重试，确认降级为永久删除且清单标记为 `false`。

---

### [1-3] 115 个 IPC 通道中 82 个未做 sender 校验 🟡 中等

- **位置**：`main.js` 全文（实测统计：115 个 `ipcMain.handle/on`，仅 33 个含 `rejectUntrustedRenderer`/`isTrustedRenderer`）
- **问题描述**：
  AGENTS.md §2.7 硬约束：「新增 `ipcMain.handle` 一律 sender 校验 / `rejectUntrustedRenderer`」。实测覆盖率 **28.7%**。
  其中**有副作用且未校验**的高价值通道：

| 行号 | 通道 | 风险 |
|---|---|---|
| 3545 | `elevate:request` | UAC 提权重启（最高价值目标） |
| 2984 / 3079 | `models:save` / `models:test` | 携带 API Key 向任意 `apiUrl` 发请求（SSRF + 凭据外带） |
| 3189 | `aidesc:get` | 同上 |
| 2923 / 3115 | `settings:load` / `settings:save` | 读取/改写含解密密钥的配置 |
| 2470 / 2491 | `appearance:set-material` / `set-material-enabled` | 持久化写入 + 全窗口材质变更 |
| 1696 / 1719 | `contextmenu:icons` / `open-in-regedit` | 拉起 regedit / 注册表路径写入 |
| 1864 / 1963 | `optimizer:check-optimized` / `svc-mem-current` | 拉起 PowerShell |
| 3485 / 3495 / 3853 / 3861 | `bench-history:delete|clear` / `realtime:report-delete|clear` | 删除用户数据 |
| 4156 / 4107 | `paths:file-icon` / `app-icon` | 任意路径文件读取 |

- **根因分析**：
  校验是迭代中逐步补上的——`startup:add`（`main.js:2394`）留有注释「B12：与同族 startup:toggle/delete 对齐，补齐渲染进程来源校验」，说明团队是按"高风险族"逐个补，而非建立统一拦截层。这必然留下覆盖盲区。
- **优化方案**：
  不要逐个补（会继续漏），改成**统一包装器**，让"忘记校验"在结构上不可能发生。

```js
// 新增：main.js 顶部（与 isTrustedRenderer 同区域）
const SIDE_EFFECT_FREE = new Set([           // 只读通道，允许免校验
  'app:get-info', 'app:get-theme', 'app:read-usage', 'log:read',
  'intro:load', 'optimizer:list', 'maintenance:tasks', 'cleanup:rules'
]);
function handleSafe(channel, fn) {
  return ipcMain.handle(channel, async (event, ...args) => {
    if (!SIDE_EFFECT_FREE.has(channel)) {
      const denied = rejectUntrustedRenderer(event);
      if (denied) return denied;
    }
    return fn(event, ...args);
  });
}

// Before
ipcMain.handle('elevate:request', () => { /* … */ });

// After
handleSafe('elevate:request', () => { /* … */ });
```
  同时建议给 `models:save` / `models:test` 的 `apiUrl` 增加 SSRF 防护（拒绝 localhost / 127.0.0.0/8 / 10.0.0.0/8 / 169.254.0.0/16 等私有与链路本地网段）。
- **验证方式**：写脚本遍历 `main.js` 中所有 `ipcMain.handle(` 调用，断言其通道名要么在 `SIDE_EFFECT_FREE` 白名单、要么被 `handleSafe` 包裹；再用 CDP 从 devtools 侧 `require('electron').ipcRenderer.invoke('elevate:request')` 模拟非信任来源，确认返回「请求来源不受信任」。

---

### [1-4] `cleanup:execute` 回收站路径未过保护路径校验 🟡 中等

- **位置**：`main.js:1039`（`await shell.trashItem(entry.path)`）
- **问题描述**：
  项目已有 `isProtectedDeletePath()`（`main.js:1405-1415`，拒绝盘符根与 `C:\Windows`、`C:\Program Files` 等），`finder:delete` 正确调用了它（`main.js:1458`），但 **`cleanup:execute` 的回收站分支没有调用**。
  `entry.path` 来自 PowerShell stdout 解析出的 `@@RECYCLE@@` 行，属于"脚本输出"而非"快照字段"，信任级别低于 `validateSnapshotItems` 校验过的快照项。
- **缓解因素**（故定 🟡 而非 🔴）：条目本身来自最近一次扫描快照，且回收站可逆。
- **优化方案**：

```js
// After（main.js:1036-1050）
for (const entry of recycleEntries) {
  if (isProtectedDeletePath(entry.path)) {          // 新增：与 finder:delete 对齐
    writeLog('warn', `拒绝移入回收站（受保护路径）: ${entry.path}`);
    const st0 = perItem.get(entry.id) || { freed: 0, ok: 0, fail: 0 };
    st0.fail++;
    perItem.set(entry.id, st0);
    continue;
  }
  const st = perItem.get(entry.id) || { freed: 0, ok: 0, fail: 0 };
  /* … 原有 trashItem 逻辑 … */
}
```
- **验证方式**：在规则文件中临时加一条 `pathPs` 指向 `C:\Windows\Temp\..\` 的测试条目，扫描后勾选并执行（勾选回收站）→ 修复后日志应出现「拒绝移入回收站（受保护路径）」，且该项状态为 `error`。

---

### [1-5] `settings:load` 无校验并返回解密后的明文 API Key 🟡 中等

- **位置**：`main.js:2923-2981`（`settings:load`）、`2984` / `3079`（`models:save` / `models:test`）
- **问题描述**：
  密钥在磁盘上的保护是**做得好的**：`saveAiSettings`（`main.js:2834`）走 `SECURITY.encryptSettings`，底层是 Electron `safeStorage`（Windows 上即 DPAPI 用户态加密），且 `encryptSecret` 在加密不可用时**抛错拒绝明文保存**（`src/security.js:35-37`）——这是正确取向。
  问题在运行时：`settings:load` 把解密后的**明文密钥**作为响应返回，而该通道无 sender 校验；`models:save`/`models:test` 同样无校验且接受任意 `apiUrl`（仅校验 `^https?://` 前缀）。三者组合可被用于 SSRF 探测内网 + 将密钥外带。
- **优化方案**：
  1. 三个通道补 `rejectUntrustedRenderer`（或直接纳入 1-3 的 `handleSafe`）；
  2. `apiUrl` 增加私有网段拒绝；
  3. 密钥回显改用掩码，仅在用户聚焦输入框时按一次"显示"按钮才返回真值。

```js
// After：settings:load 返回掩码，避免明文常驻渲染层
resp.data.aiApiKey = s.aiApiKey ? '••••••••' : '';
resp.data.models[key].apiKey = models[key].apiKey ? '••••••••' : '';
resp.data._keyPresent = { ai: !!s.aiApiKey, baidu: !!s.baiduApiKey, metaso: !!s.metasoApiKey, zhihu: !!s.zhihuApiKey };
```
- **验证方式**：CDP 执行 `window.api.settings.load()` 查看返回，确认 `aiApiKey` 为掩码；对 `models:test` 传 `apiUrl: 'http://127.0.0.1:8080'` 确认被拒绝。

---

### [1-6] 临时脚本清理用 `statSync`（跟随符号链接）🟢 建议

- **位置**：`main.js:517-539`（`cleanupTempScripts`）
- **问题描述**：`sweep()` 用 `fs.statSync(fp)` 判断 mtime。若临时目录内存在符号链接，`stat` 会解析到目标，可能读到意外路径的元数据。同文件的 `writeTempScript` 已正确使用 `lstatSync` 检查目录（`main.js:500`），此处不一致。
- **优化方案**：`statSync` → `lstatSync`，并对非常规文件直接跳过：`if (!stat.isFile()) continue;`
- **验证方式**：在 tmp 目录放一个指向外部文件的符号链接，运行清理，确认不报错且不删除目标文件。

### [1-7] `forceRoundCorners` 用字符串拼接 `exec` 且每次调用都编译 C# 🟢 建议

- **位置**：`main.js:194-211`（调用点 `722`、`771`）
- **问题描述**：`exec('powershell -NoProfile … -Command "' + ps + '"')` 为字符串拼接。当前内容仅含 base64 与数字 hwnd，无注入风险；但存在两个实际问题：① 用的是 Windows PowerShell 5.1 而非已解析出的 pwsh7，行为不一致；② 每次 `maximize`/`unmaximize` 都 `Add-Type` 重新编译一次 C#（数百毫秒）。
- **优化方案**：改用 `runPowerShell`（已封装 pwsh7 + 超时），并用 `-EncodedCommand` 传参彻底规避引号问题；加模块级 `cornersDeclared` 标志避免重复编译。
- **验证方式**：连续最大化/还原窗口 10 次，用任务管理器确认不再有 10 次 powershell 进程创建。

---

## 三、维度 2：架构与可维护性

### [2-1] `main.js` 4944 行，上帝对象 🟡 中等

- **位置**：`main.js`（实际行数为 AGENTS.md 记录「2300+ 行」的 **2.15 倍**）
- **问题描述**：单文件聚合了窗口创建、单实例锁、日志、PowerShell 运行时、清理引擎、右键管理、优化器、AI 简介、网速/磁盘测速、内存清理、路径绑定、字体、外观材质、提权、优雅关闭共 15 个域。任何一处改动都要在 5000 行内定位，回归风险高。
- **优化方案**：按域拆分，保持 IPC 通道名与载荷完全不变（渲染层零改动）：
```
main.js                  → 仅生命周期 + 窗口 + 模块装配
src/main/security.js     → isTrustedRenderer / isPathUnderRoot（已存在，扩展）
src/main/pwsh.js         → resolvePowerShell7Path / runPwshChild / writeTempScript
src/main/ipc-cleanup.js  → cleanup:* 四通道
src/main/ipc-ai.js       → settings/models/aidesc/intro
src/main/ipc-system.js   → device/overview/netspeed/diskbench/realtime/memory
src/main/ipc-appearance.js → appearance:* / paths / fonts
```
  建议先做「pwsh + security」两个最稳定的域，验证零回归后再推进其余。
- **验证方式**：拆分后逐条跑 `npm test`，并 CDP 冒烟：扫描→清理→材质切换→提权状态查询，比对拆分前后日志输出一致。

### [2-2] 清理规则双源已实际漂移（FALLBACK 缺全部执行字段 + risk 值不一致）🟡 中等

- **位置**：`src/scripts/cleanup.js:10`（`CATEGORIES_FALLBACK`）vs `src/data/cleanup-rules.json`（`rulesVersion: 20260906`）
- **问题描述**：脚本化比对结果——

| 指标 | 结果 |
|---|---|
| 条目 id 集合 | **59 / 59 完全一致** ✓ |
| 仅存在于 JSON 的字段 | `pathPs`(37)、`evidence`(59)、`recommended`(59)、`requiredStoppedProcesses`(19)、`fileKeys`(17)、`detect`(15)、`regKeys`(3)、`candidatesPs`(3)、`special`(1)、`globCandidatesPs`(1) |
| 值不一致 | `dismComponentCleanup.risk`：JSON = **high** / FALLBACK = **medium** |

  即 FALLBACK 只剩 `id/name/risk` 三字段骨架，且其中一条的风险等级还错了。
  AGENTS.md §2.6 明确要求「改规则 JSON 后必须同步 cleanup.js 的 FALLBACK 副本」，实际只同步了 id/name。
- **影响判定**：
  正常 Electron 路径下 `CATEGORIES` 被 IPC 覆盖为 JSON（`cleanup.js:1317-1332`），**执行与风险判定不受影响**；问题只在降级路径（浏览器预览 / IPC 不可用）暴露：`dismComponentCleanup`（WinSxS 组件清理，不可逆）会显示为「中风险」而非「高风险」。
- **优化方案**（推荐 ①）：
  1. **构建期生成**：加 `scripts/gen-fallback.js`，打包前从 `cleanup-rules.json` 生成 `src/scripts/cleanup-fallback.generated.js`，彻底消除手工同步；
  2. 或删除 FALLBACK，IPC 失败时明确提示"规则加载失败"而非静默展示残缺列表。
- **验证方式**：改 `cleanup-rules.json` 中任一条目的 `risk`，跑生成脚本，断言 FALLBACK 同步变化；CI 加一条"双源一致性"断言。

### [2-3] `lastCleanupSnapshot` 全局单例，扫描/执行存在竞态窗口 🟡 中等

- **位置**：`main.js:56`（声明）、`943`（scan 开头清空）、`980`（scan 结束填充）、`994`（execute 校验）
- **问题描述**：
  `cleanup:scan` 在**开头**执行 `lastCleanupSnapshot = new Map()`，在**结束**才填充。由此产生两个窗口：
  1. 两次扫描并发（用户快速切换分类触发）→ 后发起者的清空会抹掉先发起者已建立的快照；
  2. 扫描进行中触发执行 → 快照为空 → `validateSnapshotItems` 返回 null → 用户看到"清理项不是最近一次扫描结果，已拒绝执行"。
  这是 fail-safe（拒绝而非误执行），但属于真实的可用性缺陷。
- **优化方案**：按发送方分桶，消除全局共享状态：

```js
// After：main.js
const cleanupSnapshots = new Map();               // webContentsId -> Map
const snapshotFor = (event) => cleanupSnapshots.get(event.sender.id) || new Map();

ipcMain.handle('cleanup:scan', async (event, { categories }) => {
  /* … */
  const pending = new Map();
  cleanupSnapshots.set(event.sender.id, pending);   // 每个窗口独立
  /* … 填充 pending … */
  cleanupSnapshots.set(event.sender.id, snapshotById(data));
});
ipcMain.handle('cleanup:execute', async (event, { items /* … */ }) => {
  const safeItems = validateSnapshotItems(items, snapshotFor(event));  // 取本窗口快照
  /* … */
});
```
  窗口销毁时清理：`event.sender.once('destroyed', () => cleanupSnapshots.delete(id))`。
- **验证方式**：并发发两次不同分类的 `cleanup:scan`，再分别 `execute`，确认两批都能执行而非互相拒绝。

### [2-4] `appearance.json` 与 localStorage 双写 material，且 localStorage 侧只写不读 🟡 中等

- **位置**：`main.js:2427-2436`（`loadAppearance`/`saveAppearance`）vs `src/scripts/pathbinding.js:331`（`APPEARANCE_KEY = 'winclean-appearance'`）、`558`（写 `ap2.material`）
- **问题描述**：
  材质切换时写两套：IPC → `appearance.json`（主进程持久化），同时 `saveAppearance()` → localStorage。但 localStorage 里的 `material` 字段**没有任何读取方**（`theme.js` 只读 `bgBlur`/`presetBg`/`skin`；材质一律从 `appearance:get-material` IPC 取），是僵尸字段。
  `pathbinding.js:526` 的注释「初始高亮以主进程持久化值为准…避免与 localStorage 不一致」说明团队已意识到该风险并做了规避——但根本解法是消除双写。
- **优化方案**：
  明确单一真源分工并写进注释——`material`/`materialEnabled`/`windowState` 归 `appearance.json`；`accent`/`bgPath`/`bgOpacity`/`bgBlur`/`presetBg` 归 localStorage。删除 `pathbinding.js:557` 与 `509` 的 material 写入。
- **验证方式**：切材质后分别 dump 两处存储，确认 material 只存在于 `appearance.json`；重启应用高亮状态仍正确。

### [2-5] preload 的 `on*` 订阅大多不返回取消函数 🟡 中等

- **位置**：`preload.js` 全文（20+ 处 `ipcRenderer.on`，仅 `diskbench.onProgress` 第 167-171 行返回 dispose）
- **问题描述**：渲染层无法解绑监听器。当前各模块只在 `init()` 里注册一次，尚未表现出问题；但任何"页面模块被重复初始化"或"未来新增动态注册"都会造成监听器累积与回调泄漏。
- **优化方案**：统一返回 dispose（对现有调用方是纯增量兼容，忽略返回值即可）：

```js
// Before（preload.js:68）
onScanProgress: (callback) => ipcRenderer.on('cleanup:scan-progress', (_, data) => callback(data)),

// After
onScanProgress: (callback) => {
  const handler = (_, data) => callback(data);
  ipcRenderer.on('cleanup:scan-progress', handler);
  return () => ipcRenderer.removeListener('cleanup:scan-progress', handler);
},
```
  建议加 `removeAllListeners(channel)` 白名单通道支持，便于页面模块销毁时批量清理。
- **验证方式**：渲染层连续注册/注销 100 次，用 `process.getProcessMemoryInfo()` 对比句柄与内存增长。

### [2-6] 脚本加载顺序违反「ds.js 在一切 `window.ds` 使用方之前」🟢 建议

- **位置**：`src/index.html:1231-1239`
- **问题描述**：`theme.js`(1232)、`modal.js`(1234)、`xtable.js`(1235) 都排在 `ds.js`(1237) **之前**。实测 `modal.js:132` 是在函数体内访问 `window.ds` 且写了 `window.ds && typeof window.ds.focusTrap === 'function'` 降级，因此**当前不报错**；但这违反 AGENTS.md §七硬约束，且任何在顶层立即调用 modal 的新代码都会静默失去 focusTrap。
  子窗口（models / peripheral / process-manager）加载 `liquid-glass.js` 但不加载 `ds.js`——当前 `liquid-glass.js` 不依赖 ds，无实际影响。
- **优化方案**：把 `ds.js` 提到 `1231` 之前（紧随 `theme-boot.js`）；或在 index.html 脚本区顶部加一行注释固化该约束。
- **验证方式**：`node --check` 无变化；CDP 在各脚本第一行打点，确认 `window.ds` 在 `modal.js` 执行时已存在。

### [2-7] `escapeHtml` 重复实现 19 份 🟢 建议

- **位置**：`app.js:403`、`cleanup.js:316`、`contextmenu.js:151`、`diskbench.js:255`、`ds.js:14`、`fontmanager.js:21`、`intro.js:19`、`logger.js:8`、`maintenance.js:17`、`memoryclean.js:39`、`modal.js:11`、`modelpicker.js:20`、`models-window.js:70`、`netspeed.js:338`、`optimizer.js:213`、`overview.js:25`、`pathbinding.js:333`、`preview-window.js:16`、`process-manager-window.js:9`
- **问题描述**：同一段 3~5 行逻辑复制 19 次。`ds.js` 已提供，但各模块未统一取用，违反 AGENTS.md「新交互先查 ds 是否已有」。风险在于：任一处漏改（如未来需要转义 `/`）就会不一致。
- **优化方案**：保留各文件内的局部函数以控制改动面，但**新代码一律用 `window.ds?.escapeHtml`**；长期用 codemod 批量替换。
- **验证方式**：`grep -c "function escapeHtml"` 应逐版本下降。

---

## 四、维度 3：性能优化

### [3-1] 54 处 `backdrop-filter`，且无 `prefers-reduced-transparency` 降级 🟡 中等

- **位置**：`src/styles/main.css`（`backdrop-filter` 声明 54 处；`prefers-reduced-transparency` 媒体查询 **0 处**）
- **问题描述**：主窗口固定 1294×870 且不可缩小，液态玻璃满档时同屏可能存在大量 backdrop-filter 合成层。项目已对动效做了降级（`prefers-reduced-motion` 6 处 ✓），但对**透明度**没有对应策略。Windows 11 提供「透明度效果」系统开关，未响应会导致：低配机器卡顿 + 部分视觉障碍用户可读性下降。
- **优化方案**：

```css
/* 建议追加到 main.css 末尾覆盖层 */
@media (prefers-reduced-transparency: reduce) {
  body[data-skin="glass"] { --glass-blur: 0px; }
  .glass-panel, .card, .modal { backdrop-filter: none !important; background: var(--surface-solid); }
}
```
  另建议：滚动中给 `body` 挂 `.is-scrolling`，临时停用非关键元素的 backdrop-filter（rAF 节流恢复）。
- **验证方式**：Windows 设置 → 辅助功能 → 视觉效果 → 关闭「透明度效果」，重启应用确认面板变为实色；性能分析器对比滚动帧率。

### [3-2] `runRustScanner` 无超时保护，卡死时 IPC 永久挂起 🟡 中等

- **位置**：`main.js:1300-1332`
- **问题描述**：同文件的 `runPwshChild`（`main.js:405-463`）有完整的 `timeout → child.kill() → finish()` 兜底，注释还特别写了「B4：pwsh 卡死时调用方不会再出现 Promise 永不 settle、IPC 永久挂起」——但 `runRustScanner` 没有照做。`spawn(exe, ...)` 后只监听 `error` 与 `close`，若 `finder.exe` 遇到无响应网络盘、权限拒绝的递归目录或自身死锁，Promise 永不 settle，UI 永久停留在"扫描中"。
- **优化方案**：对齐 `runPwshChild` 的超时模式：

```js
// After（main.js:1300-1332 关键改动）
function runRustScanner(scanType, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const exe = resolveFinderExe();
    if (!exe) return reject(new Error('未找到原生扫描器 finder.exe'));
    const child = spawn(exe, [scanType, ...args], { windowsHide: true });
    registerBackendChild(child, exe, [scanType, ...args]);
    let settled = false, timer = null;
    const finish = (fn, v) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); fn(v); };
    /* … stdout/stderr 解析保持不变 … */
    child.on('error', err => finish(reject, err));
    child.on('close', code => {
      if (code !== 0) return finish(reject, new Error(stderr || `原生扫描器退出码 ${code}`));
      finish(resolve, items);
    });
    const ms = Number(opts.timeoutMs) || 300000;                 // 新增：默认 5 分钟
    timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      writeLog('warn', `原生扫描器超时已终止: ${scanType}`);        // 新增
      finish(reject, new Error(`扫描超时（超过 ${Math.round(ms/1000)} 秒），请缩小扫描范围后重试`));
    }, ms);
  });
}
```
- **验证方式**：用一个死循环的假 `finder.exe` 替换（或用超大目录 + 断网盘），确认 5 分钟后 UI 弹出超时提示而非永久转圈。

### [3-3] 背景模糊度滑块每次 `input` 都同步写 localStorage（无防抖）🟢 建议

- **位置**：`src/scripts/pathbinding.js:700-707`
- **问题描述**：`blurSlider.addEventListener('input', …)` 中每次移动都 `loadAppearance() → saveAppearance()`（含 `JSON.stringify` + 同步 `localStorage.setItem`）。0→100% 一次拖动可产生上百次同步写。
- **优化方案**：150ms 防抖（视觉即时、存储延迟）：

```js
let blurSaveTimer = null;
blurSlider.addEventListener('input', () => {
  const v = parseInt(blurSlider.value, 10) || 0;
  if (blurVal) blurVal.textContent = v + '%';
  applyBgBlur(v);                                  // 视觉立即生效
  clearTimeout(blurSaveTimer);
  blurSaveTimer = setTimeout(() => {               // 存储防抖
    const ap2 = migrateSkinToBlur(loadAppearance());
    ap2.bgBlur = v;
    saveAppearance(ap2);
  }, 150);
});
```
- **验证方式**：DevTools Performance 录制一次完整拖动，确认 `localStorage.setItem` 调用次数从 ~100 降到 1~2。

### [3-4] `forceRoundCorners` 重复 spawn + 重复编译 🟢 建议

- 同 [1-7]，性能影响并入该项。

---

## 五、维度 4：健壮性与边界处理

### [4-1] 配置/备份文件损坏时静默返回空对象，且下次保存直接覆盖原文件 🟡 中等

- **位置**：`main.js:2428-2433`（`loadAppearance`）、`main.js:1994-1999`（`loadOptBackups`）
- **问题描述**：两处均为 `try { JSON.parse(...) } catch { return {} }`。若文件因断电/磁盘错误损坏，用户会看到"材质设置回到默认""优化项备份消失"，且**下一次保存会用新数据覆盖掉损坏文件**——损坏现场被销毁，无法事后分析。
- **优化方案**：损坏时先隔离再降级：

```js
function loadAppearance() {
  try {
    const v = JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch (e) {
    quarantineFile(APPEARANCE_FILE, e);            // 新增：重命名保留现场
    return {};
  }
}
function quarantineFile(file, err) {
  try {
    if (!fs.existsSync(file)) return;
    const bak = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, bak);
    writeLog('error', `配置文件损坏已隔离: ${path.basename(file)} -> ${path.basename(bak)} (${err.message})`);
  } catch (_) {}
}
```
  `loadOptBackups` 同理。同时建议 `loadOptBackups` 捕获后返回 `{ __corrupt: true }`，让 UI 提示"备份文件已损坏，还原功能不可用"。
- **验证方式**：手动把 `appearance.json` 改成 `{ broken`，启动应用，确认生成 `.corrupt-<ts>` 文件、日志有记录、应用正常启动。

### [4-2] 清理执行中途关闭窗口，结果与状态可能不一致 🟢 建议

- **位置**：`main.js:3581-3608`（`registerShutdownHook`/`performFinalClose`）+ `cleanup:execute`（timeout 600s）
- **问题描述**：`cleanup:execute` 最长可跑 10 分钟。期间用户关闭窗口 → 主进程拦截 close → 渲染层走 5 秒优雅关闭动画 → `shutdown:complete` → `app.quit()`。PowerShell 子进程靠 `before-quit` 的 `taskkill /T /F` 兜底（有兜底 ✓），但**已删除的文件无法回滚，UI 侧结果统计丢失**。
- **优化方案**：优雅关闭前检查是否有清理任务在跑，若有则延长等待并提示：

```js
// app.js startGracefulShutdown 开头追加
if (window.cleanup?.isCleaning?.()) {
  toast('warning', '清理任务正在执行，请等待完成（最长 10 分钟）', 6000);
  const waitCleanup = setInterval(() => {
    if (!window.cleanup?.isCleaning?.()) { clearInterval(waitCleanup); proceedShutdown(); }
  }, 1000);
  return;
}
```
- **验证方式**：执行一个大清理任务时点关闭，确认提示出现且不会在清理未完成时强杀。

### [4-3] `rules.json.downloading` 孤儿文件无清理 🟢 建议

- **位置**：`main.js:1200-1209`（`writeValidated`）
- **问题描述**：先写 `rules.json.downloading` 再 `renameSync`。若进程在两步之间崩溃，残留孤儿文件。`cleanupTempScripts()` 只扫 `tmp` 与 `%TEMP%\Trim`，不扫 `cleanup` 目录。
- **优化方案**：`app.whenReady()` 的启动序列（`main.js:4893-4902`）追加一次清理：

```js
// 清理上次更新中断残留的 .downloading
try {
  const d = CLEANUP_SCRIPT.dataRulesDir();
  const tmp = path.join(d, 'rules.json.downloading');
  if (fs.existsSync(tmp)) { fs.unlinkSync(tmp); writeLog('info', '已清理上次更新残留的 .downloading'); }
} catch (e) {}
```
- **验证方式**：手动在 `%APPDATA%\Trim\cleanup\` 放一个 `rules.json.downloading`，重启应用确认被删除。

### [4-4] 回收站不可用时无降级引导 🟢 建议

- **位置**：`main.js:1046-1049`
- **问题描述**：`shell.trashItem` 失败只写 warn 日志并把该项标记为 `partial`/`error`。UI 会显示"移入回收站失败（可能被占用）"，但用户没有下一步——事实上回收站被禁用/已满时，用户通常愿意改为永久删除。
- **优化方案**：失败项汇总后给一次选择（走 modal.js 红色确认）：
  "有 N 项无法移入回收站（回收站已满或已禁用）。是否改为永久删除？"→ 确认后对失败项重试 `fs.rmSync(..., { recursive: true })`。

---

## 六、维度 5：规范符合性

### [5-1] 圆角 > 8px 共 38 处声明（排除胶囊/徽章后约 15 处实际违反）🟡 中等

- **位置**：`src/styles/main.css`
- **问题描述**：AGENTS.md §七「圆角 ≤ 8px（胶囊/徽章除外）」。实测超出项：

| 值 | 行号 | 判定 |
|---|---|---|
| 10px | 1520、1762、1891、2496、2601、5680、6097、6110 | 违反 |
| 12px | 2285、2555 | 违反 |
| 16px | 2446、4596、5075、5724 | 违反 |
| 9px | 5130 | 违反 |
| 999px / 99px | 2263、2690、2697、4546、4559、4971、5328、5389、5592、6005 | 胶囊/徽章，规范允许 ✓ |

- **优化方案**：全部收敛为 8px；若确有需要更大圆角的卡片，提取语义 token 而非写死数字：
```css
/* :root 内新增 */
--radius-card: 8px;
--radius-card-lg: 8px;   /* 与 --radius-card 同值，保留语义位以便将来统一调整 */
```
- **验证方式**：脚本扫描 `border-radius` 声明，断言非胶囊类最大值 ≤ 8px（加入 `npm test` 的规范自检）。

### [5-2] 组件级彩色渐变（违反「禁彩色渐变」）🟡 中等

- **位置**：`main.css:4948-4950`
```css
.startup-item-icon.reg    { background: linear-gradient(135deg, #3B82F6, #1D4ED8); }
.startup-item-icon.folder { background: linear-gradient(135deg, #16A34A, #15803D); }
.startup-item-icon.task   { background: linear-gradient(135deg, #D97706, #B45309); }
```
- **问题描述**：AGENTS.md §七「禁大圆角与彩色渐变」。全文件渐变共 44 处，需分类处理：
  - **需整改**：上述组件级彩色渐变（3 处），以及 `theme.js:64-67` 注入的 SVG `linearGradient #8B8EE0 → #A6A9F2`（环形进度用）；
  - **可保留**：`250-263` 行预设背景墙纸（aurora/sunset/graphite）的 `radial-gradient` —— 这是刻意的墙纸视觉设计，不属于"组件表面"；`1000` 行 `linear-gradient(90deg, var(--accent), var(--accent-hover))` 已 token 化 ✓。
- **优化方案**：组件图标改为实色 + 透明度层次：
```css
/* After */
.startup-item-icon.reg    { background: color-mix(in srgb, var(--info) 16%, transparent);    color: var(--info); }
.startup-item-icon.folder { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
.startup-item-icon.task   { background: color-mix(in srgb, var(--warning) 16%, transparent); color: var(--warning); }
```
- **验证方式**：目视对比 + 脚本断言"非 `body[data-preset-bg]` 上下文中的彩色渐变数量为 0"。

### [5-3] 覆盖层字面色 123 处，token 体系被侵蚀 🟡 中等

- **位置**：`src/styles/main.css` 文件后 40%（覆盖层区域）123 处，全文件非 token 行字面色 156 处
- **问题描述**：典型值 `#3B82F6`（蓝）、`#16A34A`（绿）、`#D97706`（橙）、`#DC2626`（红）、`#8B5CF6`（紫）、`#fff`。典型位置如：
```css
/* main.css:4973-4974 */
.startup-badge.on  { background: color-mix(in srgb, #16A34A 14%, transparent); color: #16A34A; }
.startup-badge.off { background: color-mix(in srgb, #D97706 14%, transparent); color: #D97706; }
```
  这正是 AGENTS.md §四记录的教训：「覆盖层里的字面色（如 `#ffffff`）会让 token 体系失效」。后果是深色模式/强调色切换时这些元素不跟随，视觉割裂。
- **优化方案**：为风险等级建立语义 token，再批量替换：

```css
/* :root / .theme-light / .theme-dark 三处各定义一组 */
--risk-low: #16A34A;  --risk-medium: #D97706;  --risk-high: #DC2626;  --risk-protected: #8B5CF6;
--risk-low-soft: color-mix(in srgb, var(--risk-low) 14%, transparent);
/* … */
/* After */
.startup-badge.on  { background: var(--risk-low-soft); color: var(--risk-low); }
.startup-badge.off { background: var(--risk-medium-soft); color: var(--risk-medium); }
```
- **验证方式**：切换深色/浅色与强调色，确认所有风险徽章跟随变化；脚本统计覆盖层字面色数量应逐版下降。

### [5-4] 原生 `title=` 提示 51 处 vs `data-tip` 仅 7 处 🟡 中等

- **位置**：`src/index.html`（`title=` 51 处 / `data-tip` 7 处）；脚本内亦有大量 `title="${escapeHtml(...)}"`（`cleanup.js:378/405/415/806/1281`、`contextmenu.js:70/261/273` 等）
- **问题描述**：AGENTS.md §七「悬停提示用 `data-tip` 不用原生 title」。当前以原生 title 为主。转义处理是**正确的** ✓（如 `cleanup.js:405` `title="${escapeHtml(item.name)}"`），无安全问题；但两类提示混用导致视觉与延迟不一致。
- **优化方案**：
  1. 新代码一律 `data-tip`；
  2. 存量用 codemod 批量迁移（`title="X"` → `data-tip="X"`），注意同时保留 `aria-label` 保证可访问性；
  3. 在 `xtable.js` 的单元格渲染中优先处理（那里最密集）。
- **验证方式**：`grep -c ' title="'` 逐版下降；悬停确认出现的是应用内气泡而非系统 tooltip。

### [5-5] `GLASS_MAX_BLUR_PX` 常量只在 pathbinding 提取，theme.js 仍硬编码 🟢 建议

- **位置**：`pathbinding.js:657`（`const GLASS_MAX_BLUR_PX = 26`）、`theme.js:124`（`(blur / 100 * 26)` 硬编码）
- **问题描述**：AGENTS.md §五已注明「两处共用约定，改动需同步」，但目前只有一处是常量。当前值一致（26/26），尚未产生 bug。
- **优化方案**：提取到 `ds.js` 暴露为 `window.ds.GLASS_MAX_BLUR_PX`，两处共同读取；或建 `src/scripts/constants.js`。
- **验证方式**：改常量为 30，确认两处同时生效。

### [5-6] 4 个 runtime 依赖完全未被引用 🟢 建议

- **位置**：`package.json:60-65`（`agent-base`、`debug`、`http-proxy-agent`、`https-proxy-agent`）
- **问题描述**：全项目（main.js / preload.js / src/**）**无任何 `require`** 使用这 4 个包。后果有二：① 打包时被塞进 asar，纯增体积；② 更实际的——它们本应是给联网请求做代理支持的，实际代码改用全局 `fetch`（`main.js:1221/2766/2797`）后**没有接代理**，意味着**企业代理/科学上网环境下，AI 简介与规则库更新会直接失败**。
- **优化方案**：二选一——
  1. 移除这 4 个依赖（AGENTS.md「默认不新增依赖」，删除更符合）；
  2. 真正接上：`fetch(url, { dispatcher: new ProxyAgent(proxyUrl) })`（`undici` 已随 Electron 内置）。
- **验证方式**：`npx depcheck`；在设置代理的环境实测规则库更新是否成功。

### [5-7] AGENTS.md 记录的 `main.js` 行数与实际严重不符 🟢 建议

- **位置**：`AGENTS.md` §二 进程架构表（`main.js`（约 2300+ 行）），实际 **4944 行**
- **问题描述**：文档失真 2.15 倍，会误导后续维护者的改动评估（"5000 行文件加个函数"和"2300 行文件加个函数"是两种风险）。
- **优化方案**：更新为「约 4900 行（2026-09 实测）」，或改为不写具体行数、只写"主进程全量"。

---

## 七、维度 6：Windows 原生适配

### [6-1] 未响应系统「透明度效果」开关 🟡 中等

- 同 [3-1]（`prefers-reduced-transparency` 0 处），此处从系统适配角度再列一次：Windows 11 设置 → 辅助功能 → 视觉效果 →「透明度效果」是该媒体查询对应的系统开关，当前未响应。

### 适配良好项（非问题，确认无回归）

| 项 | 位置 | 结论 |
|---|---|---|
| PowerShell 7 探测 | `main.js:333-372` | ✓ 覆盖 `PWSH7_PATH` 环境变量、`ProgramFiles`、`where.exe` 枚举、WindowsApps 0 字节存根排除，探测失败抛 `PWSH7_NOT_FOUND` |
| 27H2 最大化红线 | `main.js:751-773` | ✓ 明确不做原生材质操作，注释附 a/b/c 三条实测结论 |
| 客户区不扩展校正 | `main.js:213-235`、`760-766` | ✓ `ensureMaximizedClientBounds` 双档延迟校验 |
| 提权级别 | `package.json:56` | ✓ `requestedExecutionLevel: asInvoker`，无静默提权 |
| 材质 API 失败回退 | `main.js:2455-2458` | ✓ `applyNativeMaterialAll` 单窗失败不影响其余，且有 CSS 回退 |
| 窗口状态持久化可见性校验 | `main.js:607-620` | ✓ `sanitizeWindowState` 防止显示器拓扑变化后窗口跑到屏幕外 |
| 高 DPI | 全局 | ✓ 未发现硬编码像素依赖，Electron 默认支持 |

---

## 八、维度 7：代码质量

### [7-1] 风险等级获取存在 fail-open：`getItemById(id)?.risk || 'low'` 🟡 中等

- **位置**：`src/scripts/cleanup.js:920`
- **问题描述**：查不到条目时风险等级**默认为 `low`**。而 `risk === 'high'` 是红色二次确认的唯一触发条件（`cleanup.js:1006-1018`）。也就是说：一旦某个高危条目在 `CATEGORIES` 中查不到（JSON 新增条目而分类表未同步、id 拼写差异等），它会**静默降级为低危，绕过危险确认**。
  正常路径下 risk 来自主进程扫描结果，当前不受影响；但这是典型的 fail-open 取向，与项目整体的 fail-safe 风格（如 `encryptSecret` 拒绝明文、`validateSnapshotItems` 拒绝未知项）不一致。
- **优化方案**：改为 fail-safe——查不到就按高风险管理，并补一条 warn 日志：
```js
// Before（cleanup.js:920）
risk: getItemById(id)?.risk || 'low',

// After
risk: (() => {
  const r = getItemById(id)?.risk;
  if (!r) { console.warn('[cleanup] 条目风险等级未知，按高危处理:', id); return 'high'; }
  return r;
})(),
```
- **验证方式**：临时在 `cleanup-rules.json` 加一条 `risk: 'high'` 但不在 `CATEGORIES` 中注册的条目，扫描勾选后执行，确认弹出红色危险确认。

### [7-2] `theme.js` 中 `updateRingGradient()` 名不副实 🟢 建议

- **位置**：`src/scripts/theme.js:57-71`（调用点 `49`）
- **问题描述**：函数名是 "update"，实际只在首次调用时创建 `<defs>`，之后每次 `applyTheme` 都进来判断一下就返回。名不副实，且每次主题切换都执行一次 DOM 查询（`getElementById`）。
- **优化方案**：重命名为 `ensureRingGradientDef()`，或把创建逻辑移出 `applyTheme` 到初始化一次完成。

### [7-3] `theme.js` `getSystemTheme()` 存在空 if 块（死代码）🟢 建议

- **位置**：`src/scripts/theme.js:25-28`
```js
if (IS_ELECTRON && window.api?.app?.getTheme) {
  // 同步调用不可用，使用 matchMedia 作为渲染进程的近似
  // 主进程会通过 app:theme-changed 主动推送准确值
}
```
- **问题描述**：条件体内只有注释，无语句。保留它唯一的价值是这段说明——但说明应放在函数上方而非空块里。
- **优化方案**：删除空块，把两行注释上移到函数文档位置。

### [7-4] `app.js` 初始恢复页面时用了未归一化的变量 🟢 建议

- **位置**：`src/scripts/app.js:736-738`
```js
const targetPage = lastPage && CLEANUP_VIEWS.indexOf(lastPage) > -1 ? 'cleanup' : lastPage;
if (targetPage && targetPage !== 'overview' && document.getElementById('page-' + targetPage)) {
  switchPage(lastPage);        // ← 用的是 lastPage，不是 targetPage
}
```
- **问题描述**：判断用 `targetPage`、调用用 `lastPage`。当前结果正确（`switchPage` 内部第 157-160 行会再次归一化），但读者需要跳两段代码才能确认"这不是 bug"。
- **优化方案**：统一为 `switchPage(targetPage)`，并在 `switchPage` 上补一行注释说明它自身具备归一化能力。

### [7-5] `shutdown:begin` 空实现（死代码）🟢 建议

- **位置**：`main.js:3610-3612`
```js
ipcMain.on('shutdown:begin', () => {
  // 渲染进程主动开始关闭流程（预留）
});
```
- **问题描述**：注册了通道但什么都不做。preload 侧有对应 API（`preload.js:204`）。保留会让人误以为存在"渲染层主动发起关闭"的能力。
- **优化方案**：要么实现它（渲染层在关键操作完成后主动上报），要么删除通道并在 preload 同步移除；若需保留作扩展点，注释应写明"预留：尚未接线"。

### [7-6] 硬编码个人目录 `C:\yule` 🟢 建议

- **位置**：`main.js:1271`（`FINDER_DEFAULT_DUP_DIRS`）
- **问题描述**：开发者本机的个人娱乐盘目录被写进默认扫描路径列表并随包分发。属于个人信息外泄，且对其他用户是无意义路径（会被 `resolveExistingDirs` 静默跳过）。
- **优化方案**：移除该默认项，只保留 `Downloads/Desktop/Documents/Pictures`；或改为读取设置项里的"自定义扫描目录"。

### [7-7] `logger.js` 中 `e.message` 未转义进 innerHTML 🟢 建议

- **位置**：`src/scripts/logger.js:45`
```js
viewer.innerHTML = `<div class="empty-state"><p>读取日志失败: ${e.message}</p></div>`;
```
- **问题描述**：唯一一处未转义即插入 innerHTML 的动态内容。实际来源是本应用 IPC 返回的 Error message，不可被外部控制，**当前无利用路径**；但与项目"文本 API 一律转义"的硬约束不一致，且会成为后续复制粘贴的坏范例。
- **优化方案**：`${escapeHtml(e.message)}`。

---

## 九、维度 8：构建与发布

### [8-1] `win.target` 只有 portable，且 artifactName 对所有 target 生效 🟡 中等

- **位置**：`package.json:12-13`、`46-58`
- **问题描述**：`build.win.target` 只配了 `portable`，`artifactName` 硬编码为 `${productName}-Portable-${version}.${ext}`。这意味着：
  - `npm run build` 产出的其实是 portable 包；
  - `npm run build:dir`（`--dir`）也套用 Portable 命名，语义不符；
  - 若后来者想产出 NSIS 安装器，当前配置不产出，且从 package.json 看不出"安装器由 Tauri 工程承担"这一设计意图（AGENTS.md §六提到 `trim-installer` 兄弟目录）。
- **优化方案**：
  1. 在 `package.json` 中就近注释说明（JSON 不支持注释时可写在 `build.description` 字段或 AGENTS.md）；
  2. 或按脚本分流：给 `build:dir` 单独指定 `artifactName`，避免 Portable 语义污染。
- **验证方式**：分别跑 `build` 与 `build:dir`，确认产物命名与预期一致。

### 构建配置良好项（非问题）

| 项 | 结论 |
|---|---|
| `finder.exe` 路径解析 | ✓ `main.js:1288-1298` 三候选（`process.resourcesPath/finder/`、`native-scanner/target/release/`、`resources/finder/`）与 `package.json:40-45` 的 `extraResources → finder/finder.exe` 正确对应 |
| 版本号一致性 | ✓ `package.json` 2.0.0 = AGENTS.md「版本 2.0」；`main.js:803` 走 `app.getVersion()` 动态取（`app.js:417` 预览模式硬编码 `'2.0.0'`，建议改为注入） |
| source map 泄露 | ✓ 项目无 `.map` 文件 |
| asarUnpack 范围 | ✓ 仅 `src/assets/fonts/**`，合理（字体需真实文件路径） |
| `files` 清单 | ✓ `src/**/*` 覆盖了 `src/scripts-powershell/`、`src/diag.js`、`src/security.js`；含《使用说明.md》。建议后续加 `"!src/**/*.map"` 兜底 |

---

## 十、整改路线图

### P0 — 立即修复（安全 / 数据丢失风险）

| 编号 | 问题 | 等级 | 工作量 | 依赖 |
|---|---|---|---|---|
| 1-1 | 规则库在线更新补签名/哈希校验 + 尺寸上限 + 移除第三方代理源 | 🔴 | 0.5~1 天 | 需生成并内置密钥对 |
| 1-2 | fileclean 删除接入回收站兜底（抽统一删除出口） | 🔴 | 0.5 天 | 无 |
| 1-3 | 82 个未校验 IPC 通道：先补 `elevate:request` / `models:*` / `aidesc:get` / `settings:*` / `appearance:set-*` 九条 | 🟡 | 0.5 天 | 无 |
| 7-1 | `risk` 默认值 fail-open 改 fail-safe | 🟡 | 10 分钟 | 无 |

> 说明：1-3 全量覆盖（改 `handleSafe` 包装器）列在 P1，因为它需要通读全部 115 个通道并回归验证。P0 阶段先用最小改动堵住最高价值的 9 条。

### P1 — 本迭代修复（功能 / 性能 / 健壮性）

| 编号 | 问题 | 等级 | 工作量 | 依赖 |
|---|---|---|---|---|
| 1-3（全量） | 统一 `handleSafe` 包装器 + SSRF 防护 | 🟡 | 1~1.5 天 | P0 的 9 条已完成 |
| 3-2 / 4-1 | `runRustScanner` 加超时 + kill | 🟡 | 2 小时 | 无 |
| 4-1 | 配置文件损坏隔离（quarantine） | 🟡 | 2 小时 | 无 |
| 2-3 | `lastCleanupSnapshot` 按窗口分桶 | 🟡 | 3 小时 | 无 |
| 2-2 | FALLBACK 改为构建期生成 | 🟡 | 0.5 天 | 需加构建脚本 |
| 2-4 | 消除 material 双写，明确单一真源 | 🟡 | 2 小时 | 需同步更新 AGENTS.md |
| 3-1 / 6-1 | 补 `prefers-reduced-transparency` 降级 | 🟡 | 3 小时 | 需提供 `--surface-solid` token |
| 5-1 | 圆角收敛到 8px（约 15 处） | 🟡 | 0.5 天 | 需目视回归 |
| 5-2 | 组件级彩色渐变去化 + SVG 渐变处理 | 🟡 | 0.5 天 | 需设计确认替代色 |
| 5-3 | 风险色 token 化，替换覆盖层字面色 | 🟡 | 1 天 | 需三套主题各定义一组 |
| 5-4 | `title=` → `data-tip` 迁移 | 🟡 | 1 天 | 需 codemod + 目视 |
| 1-4 | `cleanup:execute` 回收站路径补保护校验 | 🟡 | 30 分钟 | 无 |
| 1-5 | `settings:load` 密钥掩码 + 三通道补校验 | 🟡 | 3 小时 | 与 1-3 合并做 |

### P2 — 后续规划（架构 / 可维护性 / 清理）

| 编号 | 问题 | 等级 | 工作量 | 依赖 |
|---|---|---|---|---|
| 2-1 | `main.js` 按域拆分（建议先拆 pwsh + security） | 🟡 | 2~3 天 | 需建立回归冒烟清单 |
| 2-5 | preload `on*` 统一返回 dispose | 🟡 | 0.5 天 | 无 |
| 2-6 | `ds.js` 提升加载顺序 + 子窗口 ds 依赖声明 | 🟢 | 1 小时 | 无 |
| 2-7 | `escapeHtml` 收敛到 `ds.escapeHtml`（19 处） | 🟢 | 0.5 天 | 无 |
| 5-5 | `GLASS_MAX_BLUR_PX` 提取共享常量 | 🟢 | 30 分钟 | 无 |
| 5-6 | 移除 4 个未用依赖 / 或接上代理 | 🟢 | 2 小时 | 需决策：删 or 接 |
| 5-7 | 更新 AGENTS.md 的 main.js 行数 | 🟢 | 5 分钟 | 无 |
| 8-1 | 构建 target 语义澄清 | 🟢 | 1 小时 | 无 |
| 3-3 | 背景模糊度滑块存储防抖 | 🟢 | 30 分钟 | 无 |
| 4-2 | 清理执行中关闭窗口的等待/提示 | 🟢 | 3 小时 | 需 `cleanup.isCleaning` 暴露 |
| 4-3 | 启动时清理 `.downloading` 孤儿文件 | 🟢 | 20 分钟 | 无 |
| 4-4 | 回收站失败的永久删除降级引导 | 🟢 | 3 小时 | 需 modal 交互设计 |
| 1-6 | `cleanupTempScripts` 用 `lstatSync` | 🟢 | 10 分钟 | 无 |
| 1-7 / 3-4 | `forceRoundCorners` 改 pwsh7 + 避免重复编译 | 🟢 | 1 小时 | 无 |
| 7-2 ~ 7-7 | 六项代码质量小修（命名/死代码/空块/未转义/硬编码路径） | 🟢 | 1.5 小时 | 无 |

---

## 附录：审查方法与产物

- **审查方式**：只审查，未改动任何项目文件。
- **脚本化核对**（避免主观判断）：
  1. IPC sender 校验覆盖率：解析 `main.js` 全部 `ipcMain.handle/on` 调用块 → 115 个通道 / 33 个已校验；
  2. 规则双源一致性：`vm` 求值 `CATEGORIES_FALLBACK` 字面量，与 `cleanup-rules.json` 做 id 集合与逐字段 diff；
  3. CSS 规范量化：正则扫描 7858 行，统计 `border-radius > 8px`、渐变、非 token 行字面色、`backdrop-filter`、`prefers-*` 降级；
  4. 依赖使用核对：全项目 `require` 扫描确认 4 个 runtime 依赖零引用。
- **临时审计脚本位置**（可删）：`%TEMP%\trim_audit_rules.js`、`trim_audit_rules2.js`、`trim_audit_css.js`
- **未覆盖**：`native-scanner/`（Rust，205 文件）、`src/scripts-powershell/` 全量脚本正文、`main.css` 逐条人工目视、`optimizer/startup/contextmenu` 等模块内部业务逻辑——如需深入可另开一轮专项。
