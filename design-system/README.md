# Trim 2.0 Design-System · 组件层（五件套 + 行为层，已落地）

> 行为规格参考 shadcn/ui（Radix）源码；视觉走 `src/styles/main.css` 的 Fluent token
> （碳墨×薰衣草，8px 圆角系统工具感）。零框架、零新增 npm 依赖。
> 关联选型结论：`docs/组件优化-选型方案.html`。

## 运行时文件

| 文件 | 职责 |
|---|---|
| `src/styles/ds.css` | 组件视觉：Badge（规范 + sm 变体 + 旧类别名）、Slider（ds-slider）、Progress 环形（ds-ring）、Tooltip（ds-tooltip）、DropdownMenu（ds-menu）、Skeleton（ds-skeleton）、Switch token 修正；减弱动效一律无过渡 |
| `src/scripts/ds.js` | 组件行为：`window.ds` API（见下）；自动接管「裸 range」滑块 |
| `src/scripts/modal.js` | Dialog 行为层（B10）：调用 `ds.focusTrap` 实现焦点陷阱 + 初始焦点 + 关闭归还 |
| `src/scripts/theme-boot.js` | 首帧前同步主题（原内联脚本被 CSP 拦截，外置修复） |

引入顺序：`main.css → ds.css`；`ds.js`（需在 modal.js 及一切 `window.ds` 使用方之前）。

## window.ds API 一览

### 阶段一（高频五件套）

| API | 说明 |
|---|---|
| `ds.badge(type, text, opts)` / `ds.badgeHtml(...)` | 徽章；type: ok/warn/bad/neutral/accent；opts: `{ dotless, title, small }`（small=紧凑变体，看板行用） |
| `ds.progress.setFill(fillEl, pct)` | 线形进度：钳值 + aria-valuenow |
| `ds.progress.circle({ size, stroke, label })` | 环形进度：`{ el, set(pct, text?, color?), value }` |
| `ds.slider.sync(el)` / `ds.slider.initAll(root)` | 滑块轨道填充同步；initAll 只接管无 class 的裸 range |
| `ds.switch({ checked, label, title, id, onChange })` | 开关工厂（.toggle-switch 结构） |

### 阶段二（行为层补齐）

| API | 说明 |
|---|---|
| `ds.focusTrap(container, { initialFocus })` | 焦点陷阱：`{ release() }` 时归还焦点。modal.js 与各自定义弹窗（右键详情）共用 |
| `ds.tooltip` / `data-tip` 属性 | 悬停提示：给任意元素加 `data-tip="文本"` 即生效（pointer 延迟 300ms、focus 即时、边界翻转、Esc/滚动/外点即隐）；**替代原生 title，避免双气泡** |
| `ds.menu({ trigger, items, onSelect, align })` | 下拉菜单：键盘 ↑↓/Home/End/Enter/Esc、外点关闭、aria-haspopup/expanded；items: `{ label, value, danger?, disabled? }`；返回 `{ open, close, destroy }` |
| `ds.skeletonRows(n)` | 列表骨架屏 HTML（扫描/加载期占位；减弱动效时为静态灰块） |
| `ds.accordion.enhance(toggle, panel)` | 为既有折叠（collapsed class 或 display:none）补 aria-expanded/aria-hidden，不改视觉逻辑 |

## 已接线清单（阶段三）

- **设置**：透明度滑块（ds-slider）、拖尾开关（Switch token 修正）、系统信息折叠 + 已导入图片列表（accordion aria）
- **内存清理**：指标卡环形进度（阈值变色）、工具条按钮 data-tip、风险徽章 token 化
- **启动项管理**：启用/已禁用 → ds-badge sm、扫描骨架屏、行内操作按钮 data-tip
- **右键管理**：类型/状态徽章 → ds-badge sm、详情弹窗接入 ds.focusTrap（Esc 沿用原有）
- **优化中心**：风险徽章 → ds-badge sm（低=ok 中=warn 高=bad）
- **全部弹窗**（modal.create/confirm）：焦点陷阱 + 初始焦点（高危→取消）+ 焦点归还

## 约束（硬性）

1. 只用 main.css 既有 token；新 token 先进 main.css 再用。
2. 圆角 ≤ 8px（badge/开关轨道/菜单项 999/6px 等胶囊与小圆角除外），禁大圆角卡片与彩色渐变。
3. `prefers-reduced-motion: reduce` 时组件不产生任何过渡/动画节点。
4. 所有文本 API（badgeHtml/skeletonRows/menu 等）一律转义，禁止调用方拼 HTML。
5. 徽章在密集看板行用 `small: true`，标准位置用默认尺寸。
