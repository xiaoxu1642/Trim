# 悬浮折叠侧边栏岛・TuneForge 改造方式

> 对应预览：
>
> `previews/floating-island-sidebar.html`
>
> （纯 CSS、零 JS，双击即开，可试折叠 / 悬停浮层 / 最大化贴边 / 深浅主题四态）。
> 目标形态：左侧导航不贴窗口边缘，四周留白，像一张独立悬浮的圆角导航卡；展开 232px（图标 + 文字），收起 56px（只留图标），主内容区随宽度同步伸展。



***

## 0. 结论先行：现有机制不用重写，改造 95% 在 CSS 层

仓库现状已经具备折叠的全部骨架，**不要新写折叠逻辑、不要加依赖、不要动 IPC**：



| 能力         | 现状                                                        | 位置                                    |
| ---------- | --------------------------------------------------------- | ------------------------------------- |
| 布局骨架       | `.layout > .sidebar + .main-content` flex 行               | `src/index.html:27-151`               |
| 折叠按钮       | `#sidebarToggle`，展开 / 收起双 SVG 图标                          | `src/index.html:31-43`                |
| 折叠协议       | 给 `#sidebar` 切 `.collapsed` 类；收起时隐藏文字 / 分组标题 / 子菜单 / 主题按钮 | `main.css:449-473`                    |
| 状态持久化      | localStorage 键 `winclean-sidebar-collapsed`，启动恢复          | `app.js:11-32`                        |
| 宽度动画       | `.sidebar { transition: width 220ms ease-emphasized }`    | `main.css:445`                        |
| 最大化态 class | `body.win-maximized`，主进程 `onResized` 推送                   | `app.js:669-679`、`main.css:2898-2911` |

缺的只是「岛化」三件事：**贴边 → 四周留白**、**直角右边框 → 整圈圆角卡**、**无投影 → 克制浮影**。

提供两档方案：



* **方案 A（推荐先上）**：零 HTML / 零 JS 改动，只改 CSS。折叠时宽度过渡、主内容自然伸展（与现状行为一致）。

* **方案 B（可选增强）**：HTML 加一层 `.sidebar-rail` 包裹，实现「收起后鼠标悬停，岛浮层展开覆盖主内容、主内容不位移」（VSCode 式 flyout，预览里的开关②）。仍是零 JS。



***

## 1. 方案 A：纯 CSS 岛化（按块粘贴）

> 全部改动建议标注批次注释 
>
> `/* 批次：悬浮岛侧边栏 */`
>
> ，回退时整批删除即可。圆角一律 
>
> `var(--radius-btn)`
>
>  \= 8px，
>
> **不得超过 8px 硬约束**
>
> （参考图的大圆角刻意收敛）。

### 块 1・新增岛阴影 token（2 处）

`main.css:82-85` 深色 `--shadow-*` 区块内加：



```
/\* 批次：悬浮岛侧边栏 —— 岛浮影（两级克制投影，区别于弹窗级 --shadow-flyout） \*/

\--shadow-island: 0 1px 2px rgba(0, 0, 0, 0.30), 0 6px 18px rgba(0, 0, 0, 0.26);
```

`main.css:184-186` 浅色 `--shadow-*` 区块内加：



```
\--shadow-island: 0 1px 2px rgba(20, 24, 40, 0.06), 0 6px 18px rgba(20, 24, 40, 0.10);
```

### 块 2・`.layout` 制造四周留白（改 `main.css:415-426`）



```
.layout {

&#x20; display: flex;

&#x20; flex: 1 1 auto;

&#x20; min-height: 0;

&#x20; min-width: 0;

&#x20; width: 100%;

&#x20; height: auto;

&#x20; overflow: hidden;

&#x20; position: relative;

&#x20; isolation: isolate;

&#x20; background: var(--bg-base);

&#x20; /\* 批次：悬浮岛侧边栏 —— 岛与标题栏/窗口边缘/主内容的留白 \*/

&#x20; gap: 12px;

&#x20; padding: 10px 12px 12px;

}
```

标题栏 `.titlebar` 通栏不动，岛从标题栏下方 10px 开始悬浮，层次正好。

### 块 3・`.sidebar` 从贴边栏改成岛卡（替换 `main.css:435-446`）



```
/\* ---------- 侧边栏（批次：悬浮岛侧边栏 —— 独立悬浮圆角导航卡） ---------- \*/

.sidebar {

&#x20; width: 232px;

&#x20; /\* 岛浮在 bg-base 上，用实体表面 --bg-card 拉开一级明度；不再用 --bg-mica \*/

&#x20; background: var(--bg-card);

&#x20; backdrop-filter: none;

&#x20; -webkit-backdrop-filter: none;

&#x20; /\* 原 border-right 改整圈发丝边 \*/

&#x20; border: 1px solid var(--border-default);

&#x20; border-radius: var(--radius-btn); /\* 8px，硬约束上限 \*/

&#x20; box-shadow: var(--shadow-island);

&#x20; display: flex;

&#x20; flex-direction: column;

&#x20; flex-shrink: 0;

&#x20; overflow: hidden; /\* 负责把导航区裁进圆角 \*/

&#x20; transition: width var(--duration-base) var(--ease-emphasized),

&#x20;             box-shadow var(--duration-fast) var(--ease-standard);

}
```

`.sidebar.collapsed { width: 56px; }`（`main.css:449-451`）**原样保留**—— 收起态自动继承圆角、整圈边与阴影，即「窄岛」，无需另写规则。岛顶折叠按钮的 `border-bottom`（`main.css:487`）现在是岛内分隔线，保留。

### 块 4・主内容区内边距对齐岛顶（改 `main.css:747-756`，可选但建议）



```
.main-content {

&#x20; flex: 1 1 auto;

&#x20; min-width: 0;

&#x20; min-height: 0;

&#x20; width: auto;

&#x20; overflow-y: auto;

&#x20; overflow-x: hidden;

&#x20; /\* 批次：悬浮岛侧边栏 —— 顶部与岛顶齐平（原 24px 32px 32px） \*/

&#x20; padding: 12px 20px 20px;

&#x20; position: relative;

}
```

### 块 5・最大化态必须回退贴边（硬约束，加在 `main.css:2909` win-maximized 段旁）

Win11 最大化时客户区贴屏幕边，继续留缝会露出一圈不可拖动的死边；且 AGENTS 规定最大化路径必须完全不透明：



```
/\* 批次：悬浮岛侧边栏 —— 最大化时取消岛形，回归贴边导航（Win11 语义 + 不透明护栏） \*/

body.win-maximized .layout { padding: 0; gap: 0; }

body.win-maximized .sidebar {

&#x20; border-radius: 0;

&#x20; border-width: 0 1px 0 0;

&#x20; box-shadow: none;

}
```

`body.electron-mica.win-maximized .layout { background: var(--bg-base) }`（2909 行已有）继续生效；岛底色 `--bg-card` 本身是不透明色，天然满足「win-maximized /data-material=none 完全不透明」，**不要在最大化路径做任何原生材质操作**。

### 块 6・同步既有覆盖点（漏一处岛就会「浮不起来」或穿帮）

这些是 main.css 后段对 `.sidebar` 的既有覆盖，特异性都高于块 3，必须同步：

**6a. 主题段写死底色（**`main.css:7104-7107`**、**`7117`**）—— 改成岛色 + 整圈边色**



```
/\* 深色：原 #11141b 与 bg-base #0F1115 明度差太弱，岛会糊在底色上，改用 --bg-card #171A21 \*/

body.theme-dark .sidebar {

&#x20; background: var(--bg-card);

&#x20; border-color: rgba(255, 255, 255, 0.08);

}

body.theme-light .sidebar {

&#x20; background: #ffffff;

&#x20; border-color: rgba(20, 24, 40, 0.12);

}
```

**6b. Mica / 材质段（**`main.css:2876-2891`**、**`7546-7555`**）—— 岛改「半实体亚克力」，保留材质通透但要浮得起来**

`2876` 与 `7546` 现在把侧栏洗成 `rgba(128,128,128,.04)` / `rgba(255,255,255,.035)` 近乎全透明，贴边时正确、岛化后会直接消失。统一替换为：



```
/\* 非最大化：78% 实体卡 + 20px 磨砂 = 亚克力岛（深浅主题均适用） \*/

body.electron-mica:not(.win-maximized) .sidebar {

&#x20; background: color-mix(in srgb, var(--bg-card) 78%, transparent);

&#x20; border-color: var(--border-default);

&#x20; backdrop-filter: blur(20px) saturate(1.4);

&#x20; -webkit-backdrop-filter: blur(20px) saturate(1.4);

}

body.electron-mica.theme-light:not(.win-maximized) .sidebar {

&#x20; background: color-mix(in srgb, #ffffff 72%, transparent);

&#x20; border-color: rgba(20, 24, 40, 0.10);

}

/\* 最大化：不透明实体，遵守不透明护栏 \*/

body.electron-mica.win-maximized .sidebar {

&#x20; background: var(--bg-card);

&#x20; backdrop-filter: none;

&#x20; -webkit-backdrop-filter: none;

}
```

`2919 / 2923 / 2941` 四种材质（mica-alt /acrylic/thin-acrylic）对 `.sidebar` 的极轻着色规则在岛化后可保留但会被上面同特异性后置规则覆盖；若想让四种材质有区分度，只调上面 mix 的百分比（mica-alt 82%、acrylic 68%、thin-acrylic 58%），不要恢复纯透明。

**6c. 玻璃皮肤段（**`main.css:244-248`**）—— 右侧单边高光改整圈顶高光**



```
/\* 原 inset -1px 0 0 是贴边栏的右轮廓高光；岛是整圈卡，只留顶部内嵌高光 \*/

body\[data-skin="glass"] .sidebar {

&#x20; box-shadow:

&#x20;   inset 0 1px 0 var(--glass-highlight),

&#x20;   var(--shadow-island);

}
```

**6d. reduced-motion 护栏（**`main.css:7192-7195`**）—— 选择器列表补&#x20;**`.sidebar`



```
@media (prefers-reduced-motion: reduce) {

&#x20; .btn > .btn-ripple { display: none; }

&#x20; .btn, .summary-card, .nav-item, .sidebar { transition: none !important; }

}
```

### 方案 A 到此结束。HTML 一行不改、JS 一行不改，`app.js` 的折叠 / 持久化 / 父级菜单折叠时自动展开（`app.js:571`）全部继续生效。



***

## 2. 方案 B：收起态悬停浮层展开（可选，零 JS）

效果：收起为 56px 窄岛后，鼠标移入，岛加宽到 232px **浮在主内容之上**（主内容不位移、不重排），移出恢复。预览开关②即此形态。

### 2.1 HTML：给 nav 加一层轨道包裹（`src/index.html:29` 与 `:148`）



```
\<!-- 原：\<nav class="sidebar" id="sidebar"> … \</nav> -->

\<div class="sidebar-rail" id="sidebarRail">

&#x20; \<nav class="sidebar" id="sidebar">

&#x20;   ……原有全部内容不动……

&#x20; \</nav>

\</div>
```

`.collapsed` 类仍由 app.js 切在 `#sidebar` 上，现有所有 `.sidebar.collapsed …` 后代选择器**全部不用改**。

### 2.2 CSS 调整

宽度动画从岛本体挪到轨道，岛宽改为跟随轨道；块 3 的 `.sidebar` 宽度声明改为 `width: 100%`，然后追加：



```
/\* 批次：悬浮岛侧边栏 B 档 —— 轨道负责占位与宽度动画 \*/

.sidebar-rail {

&#x20; width: 232px;

&#x20; flex-shrink: 0;

&#x20; position: relative; /\* 岛浮出时的定位上下文 \*/

&#x20; transition: width var(--duration-base) var(--ease-emphasized);

}

.sidebar-rail:has(.sidebar.collapsed) { width: 56px; }

/\* 同时把 main.css:449 的 .sidebar.collapsed { width:56px } 删除，宽度归轨道管，避免双重宽度打架 \*/

/\* 收起 + 悬停：岛脱离文档流浮出加宽，轨道保持 56px，主内容纹丝不动 \*/

.sidebar-rail:has(.sidebar.collapsed):hover .sidebar {

&#x20; position: absolute;

&#x20; top: 0;

&#x20; bottom: 0;

&#x20; left: 0;

&#x20; width: 232px;

&#x20; z-index: 40;

&#x20; box-shadow: var(--shadow-island-flyout,

&#x20;   0 4px 10px rgba(0, 0, 0, 0.40), 0 14px 36px rgba(0, 0, 0, 0.42));

}

/\* 浮出时恢复被 .sidebar.collapsed 隐藏的文字（选择器与 452-473 对应） \*/

.sidebar-rail:has(.sidebar.collapsed):hover .sidebar .nav-item span,

.sidebar-rail:has(.sidebar.collapsed):hover .sidebar .nav-section-title,

.sidebar-rail:has(.sidebar.collapsed):hover .sidebar .sidebar-footer .sidebar-settings-btn span {

&#x20; display: block;

}

.sidebar-rail:has(.sidebar.collapsed):hover .sidebar .nav-item,

.sidebar-rail:has(.sidebar.collapsed):hover .sidebar .sidebar-footer .sidebar-settings-btn {

&#x20; justify-content: flex-start;

&#x20; padding: 8px 12px;

}

/\* 最大化态：轨道贴边，浮出岛左侧保持直角 \*/

body.win-maximized .sidebar-rail:has(.sidebar.collapsed):hover .sidebar {

&#x20; border-radius: 0 var(--radius-btn) var(--radius-btn) 0;

}
```

> 注意：
>
> `:has()`
>
>  在项目目标 Electron（Chromium 内核 ≥105）可用；若要兼容更老内核，把 hover 规则改成 JS 切 
>
> `.rail-hover`
>
>  类（在 app.js 给 rail 绑 pointerenter/leave，唯一需要动 JS 的地方）。

### 2.3 与 ds tooltip 的关系

收起态每个 `.nav-item` 都有 `data-tip`，ds.js 会弹原生风格 tooltip。B 档悬停时岛整体已展开，**tooltip 与浮层不要同时出现**：在浮层规则里加 `.sidebar-rail:has(.sidebar.collapsed):hover .nav-item[data-tip] { }` 无法关 ds 气泡（ds 监听挂在 document），需要在 ds tooltip 的 show 路径判断 `#sidebarRail:hover` 时跳过；嫌麻烦就保持现状 —— 移出图标的瞬间气泡才出现，实际不冲突。



***

## 3. 红线与回归陷阱（动前对照 AGENTS.md/architecture.md 第十节）



1. **圆角 ≤ 8px**：岛用 `var(--radius-btn)`；不要用参考图那种 12-16px 大圆角，也不要给 `.nav-item` 加大圆角（保持 6px）。

2. **最大化路径**：只靠 `body.win-maximized` 的 CSS 回退，**禁止**在最大化 / 还原时操作原生材质（AGENTS 第五节）。块 5 不可省。

3. **不透明护栏**：`data-material="none"` 与最大化时岛必须不透明 ——`--bg-card` 是实色，6b 已显式兜底；不要再叠 `opacity`。

4. **液态玻璃联动**：已核实 `liquid-glass.js` 不登记 `.sidebar`（无选择器命中），岛宽度动画不重挂载导航、不触发分类栏 MutationObserver，`refreshAll` 链路不受影响；但 `body[data-skin="glass"] .sidebar` 是玻璃皮肤选择器（6c 必改），漏改会出现「右边缘一条竖高光」穿帮。

5. **滚轮联动**：`app.js:606-634` 的 `.nav-scroll` 滚轮转发依赖侧栏 `scrollHeight/clientHeight`，岛化只改外边距不改内部滚动结构，无影响；B 档浮出时滚动照常。

6. **最小窗口 1294×870**：收起后多出 232-56=176px 给主内容，展开时主内容最小宽 = 1294-232-12×3-… 仍满足现有布局；验收时在最小尺寸下展开 / 收起各看一次，确认 `.filter-tabs--scroll` 分段栏不溢出。

7. **标题栏**：`.titlebar` 保持通栏，不要给它也做悬浮（拖拽区域必须贯通窗口顶边，否则出现无法拖动的死区）。

8. **零新增依赖、index.html 禁内联 script**：本改造全程不涉及；方案 B 的 HTML 只加一个静态包裹 div。

9. **文本转义 /data-tip**：导航项仍走既有渲染，不拼 HTML；收起态提示继续用 `data-tip`，不用 `title`。



***

## 4. 验收清单（按 AGENTS.md 第 4 节执行）

### 4.1 静态检查



```
\# 本改造不改 JS，可跳过 node --check；若走了方案 B 的 JS 兜底则必须检查

npm test   # test-features.js 双源一致性 / 尺寸常量断言，确认无回归
```

### 4.2 CDP 真机矩阵（渲染层改动必须真机验证）

按 AGENTS 流程：taskkill 清残留 → 后台起 `electron.exe . --remote-debugging-port=9333` → `curl http://127.0.0.1:9333/json` 取 webSocketDebuggerUrl → Node ≥22 全局 WebSocket 发 `Runtime.evaluate`（returnByValue）。

**几何断言（普通窗口、展开态）**—— 岛必须离边、有圆角与阴影：



```
(() => {

&#x20; const s = document.getElementById('sidebar').getBoundingClientRect();

&#x20; const cs = getComputedStyle(document.getElementById('sidebar'));

&#x20; return {

&#x20;   left: s.left, top: s.top, width: s.width,

&#x20;   radius: cs.borderTopLeftRadius,

&#x20;   shadow: cs.boxShadow.slice(0, 40),

&#x20;   layoutPad: getComputedStyle(document.querySelector('.layout')).padding

&#x20; };

})()

// 期望：left≈12、top≈46(标题36+留白10)、width≈232、radius=8px、shadow 非 none、padding 含 10px/12px
```

**折叠断言**—— 点 `#sidebarToggle` 后 width=56，主内容比展开时宽 176px，文字节点隐藏：



```
(() => {

&#x20; document.getElementById('sidebarToggle').click();

&#x20; const s = document.getElementById('sidebar').getBoundingClientRect();

&#x20; const m = document.getElementById('mainContent').getBoundingClientRect();

&#x20; const hidden = getComputedStyle(document.querySelector('.nav-item span')).display;

&#x20; return { sidebarW: s.width, mainLeft: m.left, textDisplay: hidden,

&#x20;          persisted: localStorage.getItem('winclean-sidebar-collapsed') };

})()

// 期望：sidebarW≈56、textDisplay=none、persisted="true"；再点一次恢复 232
```

**最大化断言**—— 主进程 maximize 后 body 出现 win-maximized，岛回退贴边：



```
// 期望：body.classList 含 win-maximized；sidebar.left=0、radius=0px、box-shadow=none、layout padding=0
```

**四材质 × 双主题矩阵**（设置 → 窗口材质逐个切，深 / 浅各一遍）：



| 组合                                       | 期望                                      |
| ---------------------------------------- | --------------------------------------- |
| 无材质 + 深 / 浅                              | 岛为不透明 --bg-card / #fff，与 bg-base 有明确明度差 |
| mica / mica-alt / acrylic / thin-acrylic | 岛为半实体磨砂，能浮起、不透到读不清文字                    |
| data-material="none"                     | 岛完全不透明                                  |
| win-maximized（任意材质）                      | 贴边、直角、无阴影、100% 不透明                      |
| data-skin="glass" 玻璃皮肤                   | 岛整圈顶部高光，无右侧竖线穿帮                         |

**动效断言**：DevTools Rendering 勾 `prefers-reduced-motion: reduce`（或 CDP `Emulation.setEmulatedMedia`），`getComputedStyle(sidebar).transitionDuration` 必须为 `0s`。

**B 档追加断言**：收起后 `#sidebarRail` 宽 56 不变；hover（`Input.dispatchMouseEvent` mouseMoved 到岛中心）后内部 `.sidebar` 宽 232 且 `getBoundingClientRect` 覆盖在主内容之上，主内容 `left` 不变。

### 4.3 收尾



* 测完 taskkill；**恢复验证中改过的用户偏好**（appearance.json 与 localStorage `winclean-appearance`，不许用脚本开头旧值硬覆盖）。

* 本改造不碰 cleanup-rules.json/ Rust，无需 gen-fallback /cargo check。

* 不主动 commit；交付说明写清本批改动文件清单与回退方式（删除「批次：悬浮岛侧边栏」注释块即恢复贴边栏）。



***

## 5. 改动文件清单（方案 A）



| 文件                    | 改动                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/styles/main.css` | 块 1-6：token ×2 处、`.layout`、`.sidebar`、`.main-content`、win-maximized 回退、主题段 / 材质段 / 玻璃段 /reduced-motion 同步 |
| `src/index.html`      | 不改                                                                                                        |
| `src/scripts/*.js`    | 不改                                                                                                        |

方案 B 额外：`src/index.html` 加 `.sidebar-rail` 包裹层（2 行）、main.css 追加 2.2 一节。