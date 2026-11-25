# 飞书文档导出为单文件 HTML 的 Chrome 扩展 — 设计文档

日期：2026-11-19
更新：2026-11-24（第七次收敛：删除死守卫、去重嵌入判定、Map.groupBy 图片分组、删除冗余 SVG 克隆；导出能力与保真度不变）
更新：2026-11-24（第八次收敛：移除 background 冗余 URL 守卫、表格合并改用 replaceChildren、删多余 await；功能与保真度不变）
更新：2026-11-24（第九次：画板快照改为 3 倍超采样，多 canvas 图层合成为单图）
更新：2026-11-24（第十次：画板快照裁剪到内容边界并铺满栏宽，替换为轻量容器）
更新：2026-11-25（第十一次收敛：消息监听改用 sendResponse 兼容灰度能力，版本下限修正为 117；抽出统一轮询与取消收尾，删除死参数、冗余嵌入判定与 Firefox 伪元素；导出能力与保真度不变）
更新：2026-11-25（第十二次收敛：删除占位块上无消费者的 `data-block-type`；导出结果不变）
状态：已实施（含嵌入图截图补采；Chrome 117+）

## 1. 背景与目标

企业管理员在飞书后台禁用「导出」后，网页端的导出按钮与 OpenAPI 导出任务都不可用，但用户仍能正常阅读文档。本扩展在浏览器内直接采集当前页面已渲染的内容，生成**单个内联 HTML 文件**，用于离线阅读。

目标：

- 一键导出当前飞书文档（新版 docx，含 `/wiki/` 渲染的 docx）。
- 覆盖标题、正文、列表、引用、标注块（callout）、代码块、表格、图片、画板/图表等。
- 输出单一 HTML：样式内联、图片转为 data URL，断网可读。
- 严格 KISS：无构建、无三方依赖、无常驻权限；后台仅保留注入与跨帧取 SVG/截图短任务。

非目标（明确不做）：

- 旧版 doc、电子表格、多维表格、幻灯片。
- 评论、目录侧栏、悬浮工具栏、顶部导航。
- 批量导出、选项页、快捷键、Markdown/PDF 导出。
- 绕过任何阅读权限：只导出当前账号已渲染、本来就能看的内容。

## 2. 前置研究结论

### 2.1 lark-cli（github.com/larksuite/cli）

- 其 `drive +export` 调用飞书 OpenAPI 的导出任务接口，与网页端导出受同一套权限控制；管理员禁用导出后会返回 `1069902`（无导出权限），无法绕过。
- 使用它需要创建自建应用、OAuth 授权、安装 CLI，做不到浏览器内一键。
- 有参考价值但不作为依赖：docx 块类型清单（画板为 `block_type 43`）、图片/画板缩略图下载方式、评论为独立图层。
- 结论：不采用 API 路线；仅借鉴其内容类型清单。

### 2.2 真实文档 DOM 实测（公开飞书 wiki 文档）

- 内容根节点：`.docx-page-block`；块节点：`.block[data-block-type][data-record-id]`。
- 滚动容器：从内容根向上找到 `overflow-y: auto|scroll` 且可滚动的祖先，实测为 `.bear-web-x-container`。
- **存在虚拟滚动**：整篇 85 个块，DOM 同时最多 25 个；按「滚动 → 收集 → 去重」可完整收集。
- 图片可在页面上下文用 `fetch(url, { credentials: 'include' })` 取回（实测 200，image/png，102KB）。
- 页面加载 169 个样式表，整体搬运不可行；逐元素内联计算样式更可控。
- 图片块内存在「附件不支持打印」等占位元素，需清理。

### 2.3 Chrome MV3 最佳实践（context7）

- 使用 `activeTab` + `scripting`，点击图标时通过 `chrome.scripting.executeScript` 注入，除小组件 CDN 的窄域 host permission 外不申请常驻域名权限。
- 页面内用 Blob + `<a download>` 触发下载，无需 `downloads` 权限。
- 无需 popup、storage、content script 常驻声明。
- 2026-11-25 复核：`runtime.onMessage` 监听器返回 Promise 是 Chrome 148 起、且逐步放量的能力，Chrome 官方文档建议用 `return true` + `sendResponse` 兼容未开启该能力的浏览器；代码实际最低运行时要求是 `Map.groupBy`（Chrome 117）。`scripting.executeScript` 会等待异步结果，`captureVisibleTab` 仍需 activeTab 权限。

## 3. 已确认的决策

| 决策点 | 结论 |
| --- | --- |
| 保真度 | 保真优先：克隆已渲染 DOM + 内联计算样式 |
| 技术路线 | 内容脚本主导，后台仅做跨帧取 SVG/截图消息（无构建、无依赖） |
| 嵌入块 | 允许静态快照降级：块内图片 → canvas 快照 → iframe 视口截图 → 占位块 |
| 样式策略 | 逐元素内联计算样式白名单；不搬运 Feishu CSS |
| 触发方式 | 工具栏图标一键导出，无 popup |
| 主题 | 跟随导出时的页面外观（深色模式导出深色） |
| 验证 | 公开文档自动化实测 + 用户提供文档人工验收 |
| YAGNI 边界 | 逐块等待就绪、表格分次合并、iframe 截图补采、图片像素兜底均为真实文档触发的路径，保留；不以「可能用不到」为由删除 |

## 4. 架构与文件结构

```
my-lark-doc/
├── manifest.json      # MV3；permissions: ["activeTab", "scripting"]
├── background.js      # 图标点击注入 content.js；跨帧取 SVG / 截图消息
├── content.js         # 全部导出逻辑 + Shadow DOM 进度浮层
├── icons/             # icon16.png / icon48.png / icon128.png
└── README.md          # 加载方式、使用说明、已知限制
```

### 4.1 manifest.json

- `manifest_version: 3`
- `minimum_chrome_version: "117"`（代码用到的最新运行时能力是 `Map.groupBy`）
- `permissions: ["activeTab", "scripting"]`
- `host_permissions: ["https://lf-fb.feishupkg.com/*"]`（仅用于从小组件 iframe 提取矢量 SVG）
- `background.service_worker: "background.js"`
- `action.default_title: "导出飞书文档为 HTML"`
- 不声明 `content_scripts`、`downloads`、`storage`。

### 4.2 background.js

- 监听 `chrome.action.onClicked`。
- 仅校验 `tab.id`；不再读取 `tab.url`，受限页由 `executeScript` 抛错并记录。
- 对当前标签执行 `chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] })`。
- 注入失败（如权限或页面限制）时通过 `console.warn` 记录原因，不引入额外权限。
- 监听 `chrome.runtime.onMessage`，用 async handler 处理 `extract-svg` 与 `capture-tab`；监听器调用 `sendResponse` 并 `return true` 保持通道——监听器返回 Promise 是 Chrome 148 起逐步放量的能力，官方建议不要依赖。
- `extract-svg` 对所有帧执行 `pickLargestSvg`，按 iframe URL 匹配并返回 SVG；执行失败时 warn 并返回空 SVG，保证 `sendResponse` 一定被调用。
- `capture-tab` 仅在前台标签页调用 `chrome.tabs.captureVisibleTab`，失败返回原因。

### 4.3 content.js

- 单文件 IIFE，无模块。
- 使用 `window.__feishuDocExporterStart` 标记防止重复初始化与并发导出（保存 `start` 供重复注入复用）。
- 选择器集中在文件顶部常量，便于飞书改版时维护。
- 所有「轮询等待 DOM/画布就绪」共用 `waitFor(predicate, ms)`；取消与超时都由调用方降级。

## 5. 导出流程

1. 校验页面存在 `.docx-page-block`；否则浮层提示「请在飞书文档页面使用」并退出。
2. 读取标题：`h1.page-block-content` 的文本；为空则用 `document.title` 去掉「 - 飞书云文档」后缀；仍为空用「飞书文档」。
3. 在页面右下角挂载 Shadow DOM 浮层，显示阶段与进度，不参与导出内容。
4. 定位滚动容器；短文档无需滚动时直接收集一次。
5. 滚动收集（见第 6 节）。
6. 按 `src` 分组并发内联图片（最多 6 路）、生成占位块（canvas 已在捕获阶段替换，见第 7 节）。
7. 组装 HTML，创建 Blob 并触发下载。
8. `finally` 恢复原始滚动位置；浮层显示结果（块数、大小、完整性及未内联图片数）后自动消失。

进度分段：收集 0–70%，媒体处理 70–95%，生成与下载 95–100%。

## 6. 内容采集算法

### 6.1 滚动

- 起始位置记录为 `originScrollTop`，先滚到 0；本来就在顶部时跳过等待。
- 步长 `max(clientHeight * 0.8, 400)`。
- 每次滚动后不固定等待，而是监听 `pageEl` 子树的 DOM 变更：静默 120ms 视为渲染完成；总时长以 350ms 为硬上限，期间无任何变更时等同原固定等待。
- 循环条件动态读取 `scrollHeight`；上限 300 步或 180 秒，触达上限时标记「可能不完整」。
- 每步结束后收集当前 DOM 中可见的块。

### 6.2 块收集与去重

- 查询 `.docx-page-block .block[data-record-id]`，排除 `[data-block-type="page"]`。
- 对每个块读取最近的块祖先：祖先为其他内容块时跳过；没有块祖先或祖先为 page 块时收集。这样 callout/表格内的子块会归并到其容器块，避免重复收集。
- 去重键仅使用 `data-record-id`；`BLOCK_SELECTOR` 已保证该属性存在。
- 记录 `top = scroller.scrollTop + rect.top - scrollerRect.top` 作为排序依据。
- 同一屏内尚未收集的块并行执行 `waitForReady`（等加载骨架消失、画布挂载并完成首帧），等待结束后按原顺序逐个捕获。
- 捕获时立即执行 `cloneNode(true)`，并在活节点仍存在时依次完成：同步遍历内联样式并替换 canvas 为快照、清洗、属性归一化；除 WeakMap 中保留的活 `<img>` 引用（供抓取失败时读取已解码像素）外，不保留其它活节点引用。
- 表格块每次重新进入视口都重新捕获，按 `td[data-record-id]` 逐格保留占位符更少、内容更多的快照，补齐飞书单元格级虚拟滚动造成的空占位。
- 收集结果按 `top` 升序排列并返回 `Element[]`；相同 position 保持首次出现顺序。

### 6.3 收尾

- `finally` 中把滚动容器恢复到 `originScrollTop`。
- 收集到的块数为 0 时报错「未找到文档内容」。

## 7. 清洗、样式与媒体

### 7.1 清洗（作用于克隆节点）

删除：

- `script, style, link, iframe, video, audio`（删除 iframe 前先记录其 `src`，供占位块附注链接；视频只保留块内说明文字与链接）
- `button, input, textarea, select`
- 评论按钮：`.comment-btn, [class*="comment-btn"]`（`.block-comment` 是表格/图片的正文容器，不能整块删除）
- 折叠相关：`.fold-wrapper, .fold-handler`
- 零宽占位：`[data-zero-space], .docx-block-zero-space`
- 打印/导出占位：`[data-type="print-forbidden-placeholder"]`
- 缩放/拖拽控件：`[class*="resize-handle"], [class*="drag-handle"]`

属性处理：

- 非 SVG 元素只保留白名单属性：`class, style, href, src, alt, title, colspan, rowspan, start, reversed, type, lang, dir`；表格单元格额外保留 `data-record-id` 供分次捕获合并；`target`/`rel` 由链接归一化在清洗后写入。SVG 元素保留除 `on*` 外的原有属性。
- HTML 与 SVG 链接的 `href`/`xlink:href` 补全为绝对 URL，仅允许 `http`、`https`、`mailto`、`tel` 协议，并设置 `target="_blank" rel="noopener noreferrer"`。
- 移除图片/画布的 `width/height` 属性，改由 CSS 控制。

### 7.2 样式内联

- 对「活节点 → 克隆节点」逐层同步遍历，把 `getComputedStyle` 结果写入克隆节点的 `style`。
- 属性白名单覆盖：布局（display/position/尺寸/内外边距/overflow/flex/grid/gap）、排版（font-*/line-height/letter-spacing/text-align/white-space/word-break/vertical-align）、视觉（color/background-color/边框/圆角/opacity）、表格（table-layout/border-collapse/border-spacing）、列表（list-style-*）。
- `background-image` 仅保留渐变，丢弃 `url(...)`。
- 归一化：
  - 文本流元素（`position` 为 `static`/`relative` 且有文字）：不内联 `height/min-height/max-height`，由内容撑开；字体回退或宽度变化后换行增多时不会压住后续块。画板、图表、多维表格等嵌入块除外：其高度是画布/视口尺寸，必须保留。
  - `img`：`max-width:100%; height:auto`（canvas 已在捕获阶段替换为 img）。
  - 媒体包装层：`max-width:100%`。
  - 表格：只保留 `<table>` 本体，包进 `.table-scroll`（`max-width:100%; overflow-x:auto`）；清除固定宽高与粘性定位，宽表横向滚动。
  - `pre, code`：保留 `white-space:pre`，`pre` 允许 `overflow-x:auto`。
- 输出外壳基础 CSS：`body` 系统字体（PingFang SC、Microsoft YaHei、Segoe UI）；背景色与正文色取自导出时文档容器的计算样式，跟随当前主题；`.export-root` 宽 860px、居中、上下留白；`.placeholder` 使用虚线边框与类型说明样式。普通链接保留内联计算样式，占位链接由基础 CSS 设置颜色与换行。
- 不还原伪元素、CSS 背景图、字体文件；不尝试切换主题。

### 7.3 媒体与嵌入块

对每个克隆块：

- `<img>`：收集 `src`（优先 `currentSrc`），按 `src` 分组后由最多 6 个任务并发 `fetch(credentials:'include')` → blob → dataURL；同组只请求一次。
  - `data:` / `blob:` 与其他地址一样统一经过上述 `fetch`，不增加单独分支。
  - 失败：保留绝对 URL，计入失败数。
- `<canvas>`：在捕获阶段（活节点仍在）把块内所有 canvas 按 DOM 顺序合成为一张位图，在克隆中替换为单个 `<img>`；抛异常（被污染）时降级为占位块。
  - 收集结束后对画板块（含 `.docx-whiteboard-block`）补采：滚到块位置，临时把 `.whiteboard_layer` 宽高放大 3 倍，轮询等 canvas 位图变大（引擎按新尺寸重绘）后合成取图；`finally` 复原容器尺寸。引擎未重绘（3 秒超时）、取图失败或取消时保留原倍快照。
  - 合成后按 alpha>8 求内容边界（留 8px 内边距）裁剪，再用轻量 `div + img` 替换克隆里的画板块：图片按导出栏宽（100%）铺满，块高随图片比例伸缩，画板自身的外边距沿用；内容为空或合成失败时保留原快照与原块结构。
- iframe 在清洗时删除；采集结束后对含 iframe 的顶层嵌入块优先提取帧内矢量 SVG（`chrome.scripting` 注入跨域帧，HTML 解析器还原，保留 viewBox 与图内样式，宽度铺满导出内容），提取失败再补采截图（后台 `captureVisibleTab` + 按 iframe 矩形拼接），成功则替换占位块；都失败时保留占位块，删除前记录的 `src` 作为附注链接。
- 占位块按 `data-block-type` 生成中文标签：
  - `board`/`whiteboard` → 画板
  - `chart`/`diagram` → 图表
  - `mindnote` → 思维导图
  - `sheet` → 电子表格
  - `bitable` → 多维表格
  - `isv` → 小组件
  - `file` → 附件
  - `video` → 视频
  - 其它未知类型：保留原 DOM；含 iframe 且既无可见文字也无图片/画布时，降级为 `嵌入内容（<type>）`
  - 占位块保留块内可见文字。
- 视频/附件不内嵌二进制，保留文件名与链接文本。

## 8. 输出

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>文档标题</title>
  <meta name="source" content="原文 URL">
  <style>/* 基础 CSS + 注意：样式已内联到元素 */</style>
</head>
<body>
  <main class="export-root">
    <h1>文档标题</h1>
    <div class="export-content"><!-- 块 HTML --></div>
  </main>
</body>
</html>
```

- 不包含任何脚本；标题写入 `<title>` 与 `<h1>` 前做 HTML 转义。
- 文件名：`<标题>.html`；过滤 `/\:*?"<>|` 与控制字符，空标题用「飞书文档」。
- 下载方式：`Blob([html], { type: 'text/html;charset=utf-8' })` + 临时 `<a download>`；60 秒后 `revokeObjectURL`。

## 9. 错误处理与上限

| 场景 | 行为 |
| --- | --- |
| 非 docx 页面 / 无内容根 | 浮层提示，立即退出 |
| 导出进行中重复点击 | 忽略并提示「正在导出」 |
| 收集到 0 个块 | 报错退出 |
| 触达 300 步 / 180 秒 | 继续导出，提示「可能不完整」 |
| 滚动位置恢复 | `finally` 保证 |
| 单张图片失败 | 保留 URL，完成时提示失败数量 |
| iframe 截图失败（切换标签页、最小化） | 保留占位块，导出继续 |
| Blob/下载失败 | 浮层显示错误 |
| 导出中页面被修改 | 按点击瞬间快照处理，不做一致性校验 |

## 10. 验证计划

1. 公开飞书文档（浏览器自动化）：
   - 完整收集全部块（以 85 块文档为基准），无重复。
   - 标题、标题层级、列表、callout、图片正确。
   - 导出后滚动位置恢复。
2. 用户提供的真实文档（含代码块、画板/图表、表格、长文档）人工验收：
   - 代码块换行、缩进、高亮颜色保留。
   - 画板/图表有缩略图则显示快照，否则占位块可辨识。
3. 离线校验：断网打开导出文件，Network 面板除 `data:` 外无请求，排版与图片正常。
4. 画板清晰度与留白：导出文件中画板块只有一张快照图，像素宽度约为块 CSS 宽度的 3 倍（含 DPR）；图片裁到内容边界后铺满栏宽，块高与图片一致；导出结束后页面画板尺寸恢复原值。
5. 失败路径：非文档页点击图标、导出中重复点击。
6. 提速回归：同一文档改动前后导出的块数、未内联图片数、文件大小一致；对比 `collectBlocks` 与 `inlineImages` 阶段耗时。
7. 不引入测试框架与构建链；以真实页面验收。

## 11. 已知风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 飞书改版导致选择器失效 | 选择器集中定义；找不到内容根时明确报错；用用户文档回归 |
| 虚拟滚动遗漏块 | 0.8 视口步长 + DOM 静默等待（上限 350ms）+ 动态 scrollHeight；上限时提示不完整 |
| 内联样式导致文件偏大 | 接受该代价（保真优先）；仅白名单属性，不做全量样式 |
| 画板/图表为 iframe 或无缩略图 | 按约定降级为占位块 |
| 图片 CORS/签名 URL 失效 | 失败保留原 URL 并提示；离线时该图缺失 |
| 深色模式导出深色 | 已知行为，设计如此 |
| 超长文档耗时 | 300 步 / 180 秒上限；提示可能不完整，可重试 |

## 12. 验收标准

- 点击图标一次即可下载单文件 HTML，无需任何配置。
- 断网后打开文件，标题、正文、列表、表格、代码块、callout 正常显示；内联成功的图片正常显示。
- 画板/图表按「快照或占位」规则可辨识。
- 页面无评论、工具栏、拖拽把手等残留。
- 导出前后滚动位置一致。
- 扩展仅申请 `activeTab`、`scripting`，以及小组件 CDN 的窄域 host permission。

## 13. 第十一次收敛清单（2026-11-25）

只做代码收敛，导出结果不变：

- `background.js`：监听器改用 `sendResponse` + `return true`；`handleExtractSvg` 自行捕获失败并返回空 SVG，保证响应一定送达。
- `manifest.json`：`minimum_chrome_version` 由 148 改为 117。
- `content.js`：新增 `waitFor(predicate, ms)` 替换三处 200ms 轮询；新增 `finishIfCancelled()` 替换 `start()` 中三处取消收尾；删除 `waitForDomSettled` 的死参数 `maxMs`；`inEmbed` 去掉冗余的 `isKnownEmbed ||`；`replaceCanvases` 的失败语义写入注释并将变量改名 `canvasLost`；删除 overlay 的 `::-moz-progress-bar`。
- `README.md`：Chrome 要求改为 117。
- 明确不做：删除任何保真度路径（画板超采样/裁剪、iframe 截图补采、图片像素兜底、表格分次合并）、拆分 `content.js`、引入构建或测试框架。
