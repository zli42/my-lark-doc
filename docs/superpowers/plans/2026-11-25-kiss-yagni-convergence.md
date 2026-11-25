# KISS/YAGNI 收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变导出结果的前提下，修掉消息通道对灰度能力的依赖，并收敛 `content.js` 里的重复轮询、重复取消收尾与死代码。

**Architecture:** 后台消息监听改为 `sendResponse` + `return true`（兼容所有 Chrome 版本），`handleExtractSvg` 自行 catch 失败；`content.js` 新增一个 `waitFor(predicate, ms)` 统一三处 200ms 轮询，新增 `finishIfCancelled()` 统一三处取消收尾，其余为删除死参数/冗余判定/死 CSS。不拆分文件、不引入依赖。

**Tech Stack:** Chrome MV3、原生 JS（无构建、无第三方依赖、无测试框架）、Manifest JSON、Markdown。

**Spec:** `docs/superpowers/specs/2026-11-19-feishu-doc-html-export-design.md`（§2.3、§4.1、§4.2、§4.3、§13）

## Global Constraints

- `manifest.json` 的 `permissions` 只能保持 `["activeTab", "scripting"]`，`host_permissions` 只能保持 `["https://lf-fb.feishupkg.com/*"]`；不新增权限。
- Task 1 完成后 `minimum_chrome_version` 为 `"117"`（依据：`Map.groupBy`）；README 同步。
- `content.js` 继续保持单文件 IIFE，不拆模块。
- 不删除任何保真度路径：画板超采样/裁剪、iframe 截图补采、图片像素兜底、表格分次合并（spec §13「明确不做」）。
- 不引入构建链、依赖、测试框架（spec §10.7）；验证手段为 `node --check`、`python3 -m json.tool`、`grep` 断言，以及真实浏览器人工回归。
- 不执行 `git commit`；每个任务结束只用 `git diff` 核对，提交由用户决定。
- 一次只改一个任务；某个任务失败时停下来报告，不顺手改别的文件。

---

## 文件结构

| 文件 | 本计划中的职责 |
| --- | --- |
| `background.js` | 消息监听改为 `sendResponse` 模式；`handleExtractSvg` 自兜底 |
| `manifest.json` | 版本下限 148 → 117 |
| `README.md` | 版本说明同步 |
| `content.js` | `waitFor` / `finishIfCancelled` 抽取；删除死参数、冗余判定、死 CSS |
| `docs/superpowers/specs/2026-11-19-feishu-doc-html-export-design.md` | 已完成，不再修改 |

---

### Task 1: 后台消息通道与版本下限

**Files:**
- Modify: `background.js:1-61`
- Modify: `manifest.json:3`
- Modify: `README.md:7`

**Interfaces:**
- Consumes: 无。
- Produces: 消息协议不变——`{ type: 'extract-svg', src }` → `{ svg: string }`；`{ type: 'capture-tab' }` → `{ dataUrl: string } | { error: string }`。内容脚本无需改动。

- [ ] **Step 1: 记录基线**

Run: `node --check background.js && node --check content.js && python3 -m json.tool manifest.json > /dev/null`
Expected: 三条命令均无输出、退出码 0。

- [ ] **Step 2: 让 `handleExtractSvg` 自己兜底**

把 `background.js` 中这段（第 32-44 行）：

```js
// 失败时让 Promise 直接 reject，由内容脚本统一 warn 并回退截图
async function handleExtractSvg(message, sender) {
  if (!sender.tab) return { svg: '' };
  const base = String(message.src || '').split('?')[0];
  const frames = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, allFrames: true },
    func: pickLargestSvg,
  });
  const hit = frames.find(
    (frame) => frame.result?.svg && frame.result.href.split('?')[0] === base
  );
  return { svg: hit?.result?.svg || '' };
}
```

替换为：

```js
async function handleExtractSvg(message, sender) {
  if (!sender.tab) return { svg: '' };
  try {
    const base = String(message.src || '').split('?')[0];
    const frames = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id, allFrames: true },
      func: pickLargestSvg,
    });
    const hit = frames.find(
      (frame) => frame.result?.svg && frame.result.href.split('?')[0] === base
    );
    return { svg: hit?.result?.svg || '' };
  } catch (error) {
    console.warn('[feishu-doc-exporter] extract svg failed', error);
    return { svg: '' };
  }
}
```

- [ ] **Step 3: 监听器改用 `sendResponse`**

把 `background.js` 末尾（第 57-61 行）：

```js
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;
  if (message.type === 'extract-svg') return handleExtractSvg(message, sender);
  if (message.type === 'capture-tab') return handleCaptureTab(sender);
});
```

替换为：

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  // 监听器返回 Promise 是 Chrome 148 起逐步放量的能力，用 sendResponse 兼容所有版本
  if (message.type === 'extract-svg') {
    handleExtractSvg(message, sender).then(sendResponse);
    return true;
  }
  if (message.type === 'capture-tab') {
    handleCaptureTab(sender).then(sendResponse);
    return true;
  }
});
```

`handleCaptureTab` 已有 try/catch 且总是返回对象，`handleExtractSvg` 现在也总是 resolve，因此 `sendResponse` 一定会被调用。

- [ ] **Step 4: 下调版本下限**

`manifest.json` 第 3 行：

```json
  "minimum_chrome_version": "148",
```

改为：

```json
  "minimum_chrome_version": "117",
```

`README.md` 第 7 行：

```md
需要 Chrome 148 或更高版本（已在 Chrome 157 验证）。
```

改为：

```md
需要 Chrome 117 或更高版本（已在 Chrome 157 验证）。
```

- [ ] **Step 5: 验证**

Run:
```bash
node --check background.js
python3 -m json.tool manifest.json > /dev/null
grep -n "return true" background.js
grep -n "148" manifest.json README.md
```
Expected:
- `node --check` 与 `json.tool` 无输出；
- `grep "return true"` 输出 2 行（两个分支各一处）；
- `grep "148"` 无输出（退出码 1）。

- [ ] **Step 6: 核对 diff**

Run: `git diff -- background.js manifest.json README.md`
Expected: 只有上述四处改动，没有格式化噪声。不提交。

---

### Task 2: `content.js` 统一轮询

**Files:**
- Modify: `content.js:339-351`（`waitForReady`）
- Modify: `content.js:510-515`（等 iframe）
- Modify: `content.js:596-600`（等画板重绘）

**Interfaces:**
- Consumes: `cancelRequested: boolean`、`sleep(ms): Promise<void>`（文件顶部已有）。
- Produces: `waitFor(predicate: () => boolean, timeout: number): Promise<void>`。取消或超时后直接返回，不抛错，由调用方决定降级方式。

- [ ] **Step 1: 记录基线**

Run: `node --check content.js && grep -n "for (let i = 0; i < 15" content.js`
Expected: `node --check` 无输出；`grep` 输出 2 行（iframe、画板各一处）。

- [ ] **Step 2: 新增 `waitFor`**

在 `// 画板/嵌入块挂载后先显示加载骨架…` 这行注释之前插入：

```js
  // 轮询等待条件成立；取消或超时即返回，由调用方决定降级方式
  async function waitFor(predicate, timeout) {
    const deadline = Date.now() + timeout;
    while (!cancelRequested && !predicate() && Date.now() < deadline) await sleep(200);
  }

```

- [ ] **Step 3: 改写 `waitForReady`**

把整段：

```js
  // 画板/嵌入块挂载后先显示加载骨架，骨架期间快照会得到空白或半张图，需等骨架消失再捕获
  async function waitForReady(block) {
    const startedAt = Date.now();
    while (!cancelRequested && block.isConnected && Date.now() - startedAt < 5000) {
      const type = typeOf(block);
      // synced 容器里的画板也要等嵌套 canvas 挂载，否则同步块整体被拍成空白
      const needsCanvas =
        type === 'whiteboard' || type === 'board' || !!block.querySelector('.docx-whiteboard-block');
      if (!block.querySelector('.docx-block-loading-visible') && (!needsCanvas || block.querySelector('canvas'))) break;
      await sleep(200);
    }
    if (!cancelRequested && block.querySelector('canvas')) await sleep(200); // 等画布完成首帧绘制
  }
```

替换为：

```js
  // 画板/嵌入块挂载后先显示加载骨架，骨架期间快照会得到空白或半张图，需等骨架消失再捕获
  async function waitForReady(block) {
    await waitFor(() => {
      // synced 容器里的画板也要等嵌套 canvas 挂载，否则同步块整体被拍成空白
      const needsCanvas =
        typeOf(block) === 'whiteboard' || typeOf(block) === 'board' || !!block.querySelector('.docx-whiteboard-block');
      return (
        !block.isConnected ||
        (!block.querySelector('.docx-block-loading-visible') && (!needsCanvas || block.querySelector('canvas')))
      );
    }, 5000);
    if (!cancelRequested && block.querySelector('canvas')) await sleep(200); // 等画布完成首帧绘制
  }
```

`needsCanvas` 必须在谓词内部计算：synced 容器可能在等待期间才挂载出画板。

- [ ] **Step 4: 改写等 iframe**

把 `captureEmbedScreenshots` 里的：

```js
      let iframe = live.querySelector('iframe');
      for (let i = 0; i < 15 && !iframe; i += 1) {
        await sleep(200);
        iframe = live.querySelector('iframe');
      }
      if (!iframe) continue;
```

替换为：

```js
      await waitFor(() => live.querySelector('iframe'), 3000);
      const iframe = live.querySelector('iframe');
      if (!iframe) continue;
```

- [ ] **Step 5: 改写等画板重绘**

把 `upgradeBoardSnapshots` 里的：

```js
        // 引擎在容器尺寸变化后异步重绘，canvas 位图变大才算完成
        const grown = () => (layer.querySelector('canvas')?.width || 0) > baseWidth;
        for (let i = 0; i < 15 && !grown(); i += 1) {
          await sleep(200);
        }
        const canvases = [...layer.querySelectorAll('canvas')];
        if (!canvases.length) continue;
        if (canvases[0].width <= baseWidth) warn('board upscale timeout, using current canvas');
```

替换为：

```js
        // 引擎在容器尺寸变化后异步重绘，canvas 位图变大才算完成
        const grown = () => (layer.querySelector('canvas')?.width || 0) > baseWidth;
        await waitFor(grown, 3000);
        const canvases = [...layer.querySelectorAll('canvas')];
        if (!canvases.length) continue;
        if (!grown()) warn('board upscale timeout, using current canvas');
```

- [ ] **Step 6: 验证**

Run:
```bash
node --check content.js
grep -n "for (let i = 0; i < 15" content.js
grep -n "await waitFor(" content.js
```
Expected:
- `node --check` 无输出；
- `grep "for (let i = 0; i < 15"` 无输出（退出码 1）；
- `grep "await waitFor("` 输出 3 行：`waitForReady`、等 iframe、等画板。

- [ ] **Step 7: 核对 diff**

Run: `git diff -- content.js`
Expected: 只有三处轮询改写 + `waitFor` 定义。不提交。

---

### Task 3: `content.js` 统一取消收尾

**Files:**
- Modify: `content.js:949-1005`（`start`）

**Interfaces:**
- Consumes: `overlay.finish(text, kind)`、`cancelRequested`。
- Produces: `finishIfCancelled(): boolean`——已取消返回 `true`（并已收尾浮层），否则 `false`。

- [ ] **Step 1: 记录基线**

Run: `node --check content.js && grep -c "已取消导出" content.js`
Expected: `node --check` 无输出；计数为 `3`。

- [ ] **Step 2: 新增 `finishIfCancelled`**

把：

```js
    const overlay = createOverlay(() => {
      cancelRequested = true;
    });
    try {
```

改为：

```js
    const overlay = createOverlay(() => {
      cancelRequested = true;
    });
    const finishIfCancelled = () => {
      if (!cancelRequested) return false;
      overlay.finish('已取消导出', 'info');
      return true;
    };
    try {
```

- [ ] **Step 3: 替换三处取消判断**

三处都是同一形状，逐处替换。

第一处：

```js
      const { blocks, limited } = await collectBlocks(pageEl, overlay);
      if (cancelRequested) {
        overlay.finish('已取消导出', 'info');
        return;
      }
```

改为：

```js
      const { blocks, limited } = await collectBlocks(pageEl, overlay);
      if (finishIfCancelled()) return;
```

第二处：

```js
      const failedImages = await inlineImages(blocks, overlay);
      if (cancelRequested) {
        overlay.finish('已取消导出', 'info');
        return;
      }
```

改为：

```js
      const failedImages = await inlineImages(blocks, overlay);
      if (finishIfCancelled()) return;
```

第三处（catch 内）：

```js
    } catch (error) {
      if (cancelRequested) {
        overlay.finish('已取消导出', 'info');
        return;
      }
      console.error('[feishu-doc-exporter]', error);
```

改为：

```js
    } catch (error) {
      if (finishIfCancelled()) return;
      console.error('[feishu-doc-exporter]', error);
```

- [ ] **Step 4: 验证**

Run:
```bash
node --check content.js
grep -c "已取消导出" content.js
grep -n "finishIfCancelled" content.js
```
Expected:
- `node --check` 无输出；
- 计数为 `1`（只剩 helper 内的提示文案）；
- `grep "finishIfCancelled"` 输出 4 行：1 处定义 + 3 处调用。

- [ ] **Step 5: 核对 diff**

Run: `git diff -- content.js`
Expected: 只涉及 `start()`，无其他改动。不提交。

---

### Task 4: `content.js` 删除死参数、冗余判定与死 CSS

**Files:**
- Modify: `content.js:169-191`（`replaceCanvases` 注释）
- Modify: `content.js:270-286`（`inEmbed`、`canvasLost`）
- Modify: `content.js:296`（占位条件）
- Modify: `content.js:353-372`（`waitForDomSettled`）
- Modify: `content.js:885`（`::-moz-progress-bar`）

**Interfaces:**
- Consumes: 无。
- Produces: `replaceCanvases(liveEl, cloneEl): boolean`——语义不变（`true` = canvas 不可读），仅变量改名与注释补充；`waitForDomSettled(pageEl): Promise<void>`——去掉未使用的第二参数。

- [ ] **Step 1: 记录基线**

Run: `node --check content.js && grep -n "maxMs\|ownerType\|canvasFailed\|moz-progress" content.js`
Expected: 输出 7 行（`maxMs` 2 处、`ownerType` 2 处、`canvasFailed` 2 处、`moz-progress` 1 处）。

- [ ] **Step 2: 删除 `waitForDomSettled` 的死参数**

把：

```js
  function waitForDomSettled(pageEl, maxMs = WAIT_MS) {
```

改为：

```js
  function waitForDomSettled(pageEl) {
```

把：

```js
      hardTimer = setTimeout(finish, maxMs);
```

改为：

```js
      hardTimer = setTimeout(finish, WAIT_MS);
```

- [ ] **Step 3: 化简嵌入判定**

把 `captureBlock` 里的：

```js
    const isKnownEmbed = Object.hasOwn(EMBED_TYPES, blockType);
    // 块本身没有类型时，沿用最近带类型祖先的嵌入判定
    const ownerType = block.closest('[data-block-type]')?.getAttribute('data-block-type');
    const inEmbed = isKnownEmbed || Object.hasOwn(EMBED_TYPES, ownerType);
```

改为：

```js
    const isKnownEmbed = Object.hasOwn(EMBED_TYPES, blockType);
    // 块本身没有类型时，沿用最近带类型祖先的嵌入判定
    const embedOwner = block.closest('[data-block-type]')?.getAttribute('data-block-type');
    const inEmbed = Object.hasOwn(EMBED_TYPES, embedOwner);
```

`closest` 包含元素自身，因此原来的 `isKnownEmbed ||` 是冗余的。

- [ ] **Step 4: 明确 canvas 失败语义**

把 `replaceCanvases` 的注释：

```js
  // 画板等嵌入块用多个 canvas 图层叠加绘制，逐层导出会得到多张图片；合成一张
```

改为：

```js
  // 画板等嵌入块用多个 canvas 图层叠加绘制，逐层导出会得到多张图片；合成一张。
  // 返回 true 表示 canvas 无法读取（已从克隆中删除），由调用方降级为占位块。
```

把：

```js
    const canvasFailed = replaceCanvases(block, clone);
```

改为：

```js
    const canvasLost = replaceCanvases(block, clone);
```

把：

```js
    if (!hasMedia && (isKnownEmbed || canvasFailed || (iframeSrc && !hasText))) {
```

改为：

```js
    if (!hasMedia && (isKnownEmbed || canvasLost || (iframeSrc && !hasText))) {
```

- [ ] **Step 5: 删除 Firefox 伪元素**

删除这一整行（Chrome 扩展中永不生效）：

```css
        progress::-moz-progress-bar{background:#3370ff;border-radius:2px;transition:var(--progress-value-transition)}
```

- [ ] **Step 6: 验证**

Run:
```bash
node --check content.js
grep -n "maxMs\|ownerType\|canvasFailed\|moz-progress" content.js
```
Expected:
- `node --check` 无输出；
- `grep` 无输出（退出码 1）。

补充断言：

Run: `grep -n "canvasLost\|embedOwner" content.js`
Expected: 各 2 行（定义 + 使用）。

- [ ] **Step 7: 核对 diff**

Run: `git diff -- content.js`
Expected: 只涉及上述五处，无行为分支变化。不提交。

---

### Task 5: 全项目静态验证与人工回归

**Files:**
- 无代码改动；验证 `background.js`、`content.js`、`manifest.json`。

**Interfaces:**
- Consumes: Task 1-4 的全部产物。
- Produces: 一份可复核的验证结论。

- [ ] **Step 1: 语法与清单校验**

Run:
```bash
node --check background.js
node --check content.js
python3 -m json.tool manifest.json > /dev/null
```
Expected: 全部无输出、退出码 0。

- [ ] **Step 2: 关键约束断言**

Run:
```bash
grep -n '"minimum_chrome_version"' manifest.json
grep -n '"permissions"' manifest.json
grep -n "sendResponse" background.js
grep -n "for (let i = 0; i < 15" content.js || true
```
Expected:
- `minimum_chrome_version` 为 `"117"`；
- `permissions` 仍为 `["activeTab", "scripting"]`，`host_permissions` 未变；
- `sendResponse` 出现 3 次（参数 + 两个 `.then`）；
- 最后一条无输出。

- [ ] **Step 3: 加载扩展（若 DevTools MCP 可用）**

若 `chrome-devtools-mcp` 可用：
1. `list_extensions` 确认是否已安装本扩展；
2. 未安装则 `install_extension` 指向 `/home/zli/Projects/my-lark-doc`；
3. 已安装则 `reload_extension`；
4. `list_console_messages` 检查 service worker 是否有报错。

Expected: 扩展加载成功，无 manifest 解析错误、无 service worker 异常。
若 MCP 不可用，跳过并在结论中注明「未做浏览器加载验证」。

- [ ] **Step 4: 真实文档人工回归（需要用户提供可读的飞书 docx 链接）**

逐项确认：
1. 点击扩展图标，浮层出现，进度从「准备中」推进到「收集内容」；
2. 导出完成后提示「已导出 N 个块，X MB」；
3. 导出前后页面滚动位置一致；
4. 导出过程中点「取消」，浮层变为「已取消导出」，页面滚动位置恢复；
5. 输出 HTML 断网打开：标题、列表、引用、代码块、表格、图片正常；
6. 含图表/小组件/画板的文档：嵌入块要么是矢量 SVG、要么是快照图片；若出现「未能自动截图」，说明 Task 1 的消息通道未生效，需回查；
7. 图片区没有大面积「图片未能内联」提示。

- [ ] **Step 5: 输出验证结论**

在最终回复中列出：
- 已通过的静态检查（命令 + 结果）；
- 是否完成浏览器加载验证；
- 是否完成真实文档回归；未完成时明确写「未验证」，不得表述为「已验证」。

---

## 风险与回退

| 风险 | 处理 |
| --- | --- |
| `sendResponse` 在端口已关闭时调用 | Chrome 忽略该调用；内容脚本侧的 catch 仍保留 |
| `waitFor` 改变了轮询起点 | 三处都在第一次判断前不 sleep，与原逻辑一致；`waitForReady` 的 `needsCanvas` 仍在谓词内计算 |
| 版本下限 117 未在 117 上实测 | 依据文档化 API 支持（`Map.groupBy` = Chrome 117）；README 注明已在 157 验证 |
| 无真实文档可回归 | 只报告静态验证结果，并明确标注未做功能验证 |
