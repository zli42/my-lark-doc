(() => {
  if (window.__feishuDocExporterStart) {
    window.__feishuDocExporterStart();
    return;
  }

  const PAGE_SELECTOR = '.docx-page-block';
  const BLOCK_SELECTOR = '.block[data-record-id]';
  const TITLE_SELECTOR = 'h1.page-block-content';
  const WHITEBOARD_LAYER_SELECTOR = '.whiteboard_layer';
  const MAX_STEPS = 300;
  const MAX_MS = 180000;
  const STEP_RATIO = 0.8;
  const WAIT_MS = 350;
  const IMAGE_CONCURRENCY = 10;
  const IMAGE_TIMEOUT_MS = 15000;
  const BOARD_SCALE = 3;
  const BOARD_CROP_PADDING = 8;

  const REMOVE_SELECTOR = [
    'script', 'style', 'link', 'iframe', 'video', 'audio',
    'button', 'input', 'textarea', 'select',
    '.comment-btn', '[class*="comment-btn"]',
    '.fold-wrapper', '.fold-handler',
    '[data-zero-space]', '.docx-block-zero-space',
    '[data-type="print-forbidden-placeholder"]',
    // 同步块的外框遮罩是覆盖全块的白色蒙层，静态页面会把画板快照整个盖住
    '.synced-block-overflow-border-mask', '.synced-block-overflow-comment-border-mask',
    '[class*="resize-handle"]', '[class*="drag-handle"]',
  ].join(',');

  const KEEP_ATTRS = new Set([
    'class', 'style', 'href', 'src', 'alt', 'title',
    'colspan', 'rowspan', 'start', 'reversed', 'type', 'lang', 'dir',
  ]);

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const STYLE_PROPS = [
    'display', 'visibility', 'position', 'top', 'right', 'bottom', 'left',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
    'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
    'border-radius', 'box-sizing', 'overflow-x', 'overflow-y', 'float', 'clear',
    'background-color', 'background-image', 'box-shadow', 'color',
    'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
    'text-align', 'text-decoration-line', 'text-decoration-color', 'text-indent',
    'white-space', 'word-break', 'overflow-wrap', 'vertical-align',
    'object-fit', 'object-position',
    'list-style-type', 'list-style-position', 'table-layout', 'border-collapse', 'border-spacing',
    'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
    'flex-grow', 'flex-shrink', 'flex-basis', 'gap', 'grid-template-columns', 'grid-column', 'grid-row',
    'opacity',
  ];

  const SKIP_VALUES = new Set(['none', 'normal', 'auto', 'static', 'visible', 'rgba(0, 0, 0, 0)']);

  // 这些属性的默认值决定可见性，不能按默认值丢弃
  const ALWAYS_KEEP = new Set(['display', 'visibility', 'color']);

  // 无法静态还原的嵌入块；frame 为 true 的内容在跨域 iframe 里，只能靠导出时截图
  const EMBED_TYPES = {
    board: { label: '画板' },
    whiteboard: { label: '画板' },
    chart: { label: '图表', frame: true },
    diagram: { label: '图表', frame: true },
    mindnote: { label: '思维导图', frame: true },
    sheet: { label: '电子表格', frame: true },
    bitable: { label: '多维表格', frame: true },
    isv: { label: '小组件', frame: true },
    file: { label: '附件' },
    video: { label: '视频' },
  };

  const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",sans-serif}
.export-root{max-width:860px;margin:0 auto;padding:40px 24px 80px}
.export-root>h1{font-size:34px;line-height:1.4;margin:0 0 24px}
.export-content{overflow-x:auto}
.export-content *{max-width:100%}
.export-content img{height:auto}
.export-content .docx-table-block{width:auto!important;max-width:100%!important;height:auto!important}
.export-content .table-scroll{max-width:100%;overflow-x:auto}
.export-content .table-scroll table{max-width:none!important;height:auto!important;overflow:visible!important;padding-top:0!important;position:static!important;top:auto!important}
.export-content .table-scroll tr,.export-content .table-scroll td{height:auto!important}
.export-content pre{overflow-x:auto}
.placeholder{margin:12px 0;padding:12px 14px;border:1px dashed rgba(127,127,127,.45);border-radius:8px;opacity:.85;font-size:13px}
.placeholder-title{font-weight:600;margin-bottom:4px}
.placeholder a{display:inline-block;margin-top:6px;color:#3370ff;word-break:break-all}
`;

  // 克隆图 → 页面里的活节点，抓取失败时用后者已解码的像素兜底
  const liveImages = new WeakMap();
  let running = false;
  let cancelRequested = false;
  let imageInliner = null;

  const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 连续两帧让浏览器提交渲染；后台标签 rAF 暂停时用 100ms 超时兜底
  const waitForPaint = () => new Promise((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    }));
  });

  const warn = (...args) => console.warn('[feishu-doc-exporter]', ...args);

  const typeOf = (el) => el.getAttribute('data-block-type') || '';

  const isEmbedType = (type) => Object.hasOwn(EMBED_TYPES, type);

  // 去掉空白与零宽空格，用于判断是否有可见文字
  const textOf = (el) => (el.textContent || '').replace(/[\s\u200b]/g, '');

  function getTitle(pageEl) {
    const el = document.querySelector(TITLE_SELECTOR) || pageEl.querySelector('h1');
    let title = (el?.textContent || '').replace(/\u200b/g, '').trim();
    if (!title) title = (document.title || '').replace(/\s*[-–]\s*飞书云文档.*$/, '').trim();
    return title || '飞书文档';
  }

  function findScroller(pageEl) {
    let el = pageEl;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if (/auto|scroll/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }

  const getViewTop = (scroller) =>
    scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;

  function getTheme(pageEl) {
    const color = getComputedStyle(pageEl).color;
    for (let el = pageEl; el; el = el.parentElement) {
      const background = getComputedStyle(el).backgroundColor;
      if (background && background !== 'rgba(0, 0, 0, 0)') {
        return { background, color };
      }
    }
    return { background: '#ffffff', color };
  }

  // 逐元素 textContent 会把 inlineStyles 拖成 O(n²)；先后序遍历一次，标出子树含可见文字的元素
  function markTextElements(el, textSet) {
    let hasText = false;
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        if ((child.nodeValue || '').replace(/[\s\u200b]/g, '')) hasText = true;
      } else if (child.nodeType === Node.ELEMENT_NODE && markTextElements(child, textSet)) {
        hasText = true;
      }
    }
    if (hasText) textSet.add(el);
    return hasText;
  }

  function inlineStyles(liveEl, cloneEl, inEmbed, textSet) {
    cloneEl.removeAttribute('style');
    const computed = getComputedStyle(liveEl);
    // 导出后字体回退/容器宽度变化会让文本重新换行，固定高度会把后续块压上来；
    // 画板/图表等嵌入块的高度是画布视口尺寸，评论文案等文本不能触发高度省略。
    const flowingText =
      !inEmbed &&
      (computed.position === 'static' || computed.position === 'relative') &&
      textSet.has(liveEl);
    for (const prop of STYLE_PROPS) {
      if (flowingText && (prop === 'height' || prop === 'min-height' || prop === 'max-height')) continue;
      const value = computed.getPropertyValue(prop);
      if (!value) continue;
      if (prop === 'opacity' && value === '1') continue;
      if (!ALWAYS_KEEP.has(prop) && SKIP_VALUES.has(value)) continue;
      if (prop === 'background-image' && value.includes('url(')) continue; // 外链背景离线不可用
      cloneEl.style.setProperty(prop, value);
    }

    for (let i = 0; i < liveEl.children.length && i < cloneEl.children.length; i += 1) {
      const child = liveEl.children[i];
      const type = child.getAttribute('data-block-type');
      const childInEmbed = type === null ? inEmbed : isEmbedType(type);
      inlineStyles(child, cloneEl.children[i], childInEmbed, textSet);
    }
  }

  // 画板等嵌入块用多个 canvas 图层叠加绘制，逐层导出会得到多张图片；合成一张。
  // 返回 true 表示 canvas 无法读取（已从克隆中删除），由调用方降级为占位块。
  function replaceCanvases(liveEl, cloneEl) {
    const liveCanvases = [...liveEl.querySelectorAll('canvas')];
    const cloneCanvases = [...cloneEl.querySelectorAll('canvas')];
    if (!liveCanvases.length || !cloneCanvases.length) return false;
    try {
      const canvas = document.createElement('canvas');
      canvas.width = liveCanvases[0].width;
      canvas.height = liveCanvases[0].height;
      const context = canvas.getContext('2d');
      liveCanvases.forEach((item) => context.drawImage(item, 0, 0));
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.alt = '画布快照';
      const style = cloneCanvases[0].getAttribute('style');
      if (style) img.setAttribute('style', style);
      cloneCanvases[0].replaceWith(img);
      cloneCanvases.slice(1).forEach((clone) => clone.remove());
      return false;
    } catch {
      cloneCanvases.forEach((clone) => clone.remove());
      return true;
    }
  }

  function makeLinkAbsolute(el) {
    if (el.localName !== 'a') return;
    ['href', 'xlink:href'].forEach((name) => {
      const href = el.getAttribute(name);
      if (!href) return;
      let abs;
      try {
        abs = new URL(href, location.href);
      } catch {
        el.removeAttribute(name);
        return;
      }
      if (!/^(https?|mailto|tel):$/.test(abs.protocol)) {
        el.removeAttribute(name);
        return;
      }
      el.setAttribute(name, abs.href);
    });
    if (el.hasAttribute('href') || el.hasAttribute('xlink:href')) {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
  }

  function cleanClone(clone) {
    // 标题编号是渲染出来的数据而非按钮控件；转成普通元素，避免被 button 规则删掉
    clone.querySelectorAll('.heading-order').forEach((el) => {
      const span = document.createElement('span');
      span.setAttribute('style', el.getAttribute('style') || '');
      span.textContent = el.textContent;
      el.replaceWith(span);
    });

    clone.querySelectorAll(REMOVE_SELECTOR).forEach((el) => el.remove());

    [clone, ...clone.querySelectorAll('*')].forEach((el) => {
      if (el.namespaceURI === SVG_NS) {
        Array.from(el.attributes).forEach((attr) => {
          if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        });
      } else {
        // 行内 height 会压过 BASE_CSS 的 height:auto，宽图会变形
        if (el.tagName === 'IMG') el.style.removeProperty('height');
        Array.from(el.attributes).forEach((attr) => {
          if (KEEP_ATTRS.has(attr.name)) return;
          // 表格单元格的分次捕获按 record-id 合并，需在克隆中保留
          if (el.tagName === 'TD' && attr.name === 'data-record-id') return;
          el.removeAttribute(attr.name);
        });
      }
      makeLinkAbsolute(el);
    });
  }

  function makePlaceholder(type, text, iframeSrc) {
    const label = EMBED_TYPES[type]?.label || `嵌入内容（${type}）`;
    const box = document.createElement('div');
    box.className = 'placeholder';

    const title = document.createElement('div');
    title.className = 'placeholder-title';
    title.textContent = `[${label}] 未导出为可读内容`;
    box.appendChild(title);

    const visible = (text || '').replace(/\u200b/g, ' ').trim().slice(0, 200);
    if (visible) {
      const line = document.createElement('div');
      line.textContent = visible;
      box.appendChild(line);
    }
    if (iframeSrc) {
      const link = document.createElement('a');
      link.href = iframeSrc;
      link.textContent = '打开嵌入内容';
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.appendChild(link);
    }
    return box;
  }

  // 代码块的行只挂载页面视口附近的一段，首次可见时克隆会缺行；
  // 块内可滚动时扫块内，块比视口高时扫页面，按行号补采全部行。
  async function collectCodeLineSets(block, scroller, inEmbed, overlay) {
    const contents = [...block.querySelectorAll('.code-block-content')];
    if (!contents.length) return null;
    const viewTop = getViewTop(scroller);
    const viewHeight = scroller.clientHeight;
    const originPageTop = scroller.scrollTop;
    const originTops = contents.map((content) => content.scrollTop);
    const originStyles = contents.map((content) => content.getAttribute('style'));
    const step = Math.max(300, Math.round(viewHeight * 0.8));
    const results = [];
    try {
      for (const content of contents) {
        const scrollable = content.scrollHeight > content.clientHeight + 40;
        const rect = content.getBoundingClientRect();
        const fullyVisible = rect.top >= viewTop && rect.bottom <= viewTop + viewHeight;
        if (cancelRequested || (!scrollable && fullyVisible)) {
          results.push(null);
          continue;
        }
        const lines = new Map();
        const harvest = () => {
          for (const line of content.querySelectorAll('.code-line-wrapper')) {
            const num = line.getAttribute('data-line-num');
            if (num === null || lines.has(num)) continue;
            // 每行包在独立的 .ace-line 里，克隆外层才能保留行布局
            const unit = line.parentElement;
            const clone = unit.cloneNode(true);
            const textSet = new WeakSet();
            markTextElements(unit, textSet);
            inlineStyles(unit, clone, inEmbed, textSet);
            cleanClone(clone);
            lines.set(num, clone);
          }
          overlay.update(`补采代码块… ${lines.size} 行`);
        };
        if (scrollable) {
          // 窗口超过一屏会漏掉末尾几行，先压到一屏高再对齐视口顶
          content.style.height = `${viewHeight}px`;
          content.style.minHeight = `${viewHeight}px`;
          content.style.maxHeight = `${viewHeight}px`;
          scroller.scrollTop = Math.max(0, scroller.scrollTop + content.getBoundingClientRect().top - viewTop);
          await sleep(WAIT_MS);
          for (let top = 0; top <= content.scrollHeight && !cancelRequested; top += step) {
            content.scrollTop = top;
            await waitForPaint();
            harvest();
          }
        } else {
          // 行随页面视口挂载：把页面从内容顶滚到内容底，覆盖整块
          const start = Math.max(0, scroller.scrollTop + rect.top - viewTop);
          for (let top = start; top <= start + content.clientHeight && !cancelRequested; top += step) {
            scroller.scrollTop = top;
            await waitForPaint();
            harvest();
          }
        }
        results.push(
          lines.size
            ? [...lines.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([, el]) => el)
            : null
        );
      }
    } finally {
      contents.forEach((content, i) => {
        if (originStyles[i] === null) content.removeAttribute('style');
        else content.setAttribute('style', originStyles[i]);
        content.scrollTop = originTops[i];
      });
      scroller.scrollTop = originPageTop;
    }
    return results.some(Boolean) ? results : null;
  }

  function captureBlock(block, codeLineSets) {
    const clone = block.cloneNode(true);
    const blockType = typeOf(block) || 'unknown';
    // 块本身没有类型时，沿用最近带类型祖先的嵌入判定
    const embedOwner = block.closest('[data-block-type]')?.getAttribute('data-block-type');
    const inEmbed = isEmbedType(embedOwner);
    // 顺序有依赖：样式与 canvas 只能从活节点读取，cleanClone 会删除克隆节点
    const textSet = new WeakSet();
    markTextElements(block, textSet);
    inlineStyles(block, clone, inEmbed, textSet);

    const liveImgs = block.querySelectorAll('img');
    const cloneImgs = clone.querySelectorAll('img');
    for (let i = 0; i < cloneImgs.length && i < liveImgs.length; i += 1) {
      const src = liveImgs[i].currentSrc || liveImgs[i].src;
      if (src) cloneImgs[i].setAttribute('src', new URL(src, location.href).href);
      liveImages.set(cloneImgs[i], liveImgs[i]);
    }

    const canvasLost = replaceCanvases(block, clone);

    // cleanClone 会删掉 iframe，先记下 src 供占位块使用
    const iframeSrc = block.querySelector('iframe')?.src || '';

    cleanClone(clone);

    const hasMedia = !!clone.querySelector('img');
    const hasText = textOf(clone).length > 0;

    if (!hasMedia && (isEmbedType(blockType) || canvasLost || (iframeSrc && !hasText))) {
      return makePlaceholder(blockType, clone.textContent, iframeSrc);
    }
    // 飞书表格的滚动/虚拟化包装层依赖页面脚本，静态 HTML 中会把宽表裁掉；
    // 只保留表格本体，交给 .table-scroll 横向滚动。
    if (blockType === 'table' && clone.querySelector('table')) {
      const box = document.createElement('div');
      box.className = 'table-scroll';
      box.append(...clone.querySelectorAll('table'));
      clone.replaceChildren(box);
    }
    // 合并结果按 .code-block-content 的出现顺序替换；行元素已内联样式并清理
    if (codeLineSets) {
      clone.querySelectorAll('.code-block-content').forEach((content, i) => {
        // 补采后行可能还没重新挂载，行容器用类名兜底
        const zone = content.querySelector('.code-line-wrapper')?.parentElement?.parentElement || content.querySelector('.zone-container');
        if (zone && codeLineSets[i]) zone.replaceChildren(...codeLineSets[i]);
      });
    }
    // 代码块可能嵌在列表/标注块里随父块整体克隆，按类名清理而不是只认块类型。
    // 行号由 .code-line-wrapper 的伪元素渲染，伪元素消失后负边距会把代码左移遮住前几列；
    // 标题编辑区的 scroll 是编辑态常显滚动条，静态页面改为按需显示。
    clone.querySelectorAll('.code-block-line').forEach((el) => el.remove());
    clone.querySelectorAll('.code-line-wrapper').forEach((el) => {
      el.style.removeProperty('margin-left');
      el.style.removeProperty('width');
    });
    clone.querySelectorAll('.code-block-caption-editor').forEach((el) => {
      if (el.style.overflowX === 'scroll') el.style.overflowX = 'auto';
    });
    // 行号列删除后代码会贴着块边框，补回与代码块标题对齐的左侧缩进；
    // overflow 的 auto 会被样式白名单当作默认值丢弃，长行代码会撑破导出页面，需要显式写回
    clone.querySelectorAll('.code-block-content').forEach((el) => {
      el.style.paddingLeft = '28px';
      el.style.overflowX = 'auto';
    });
    return clone;
  }

  function cellCompletion(cell) {
    return {
      placeholders: cell.querySelectorAll('.bear-virtual-renderUnit-placeholder').length,
      weight:
        cell.querySelectorAll('.block').length +
        cell.querySelectorAll('img, canvas').length +
        textOf(cell).length,
    };
  }

  // 飞书表格只挂载视口附近的单元格内容，其余格子会退化成占位符；
  // 每次滚到表格都重新捕获，逐格保留渲染更完整的那份。
  function mergeTableCells(target, source) {
    const incomingCells = new Map();
    source.querySelectorAll('td[data-record-id]').forEach((cell) => {
      incomingCells.set(cell.getAttribute('data-record-id'), cell);
    });
    target.querySelectorAll('td[data-record-id]').forEach((cell) => {
      const incoming = incomingCells.get(cell.getAttribute('data-record-id'));
      if (!incoming) return;
      const before = cellCompletion(cell);
      const after = cellCompletion(incoming);
      const better =
        after.placeholders < before.placeholders ||
        (after.placeholders === before.placeholders && after.weight > before.weight);
      if (better) cell.replaceChildren(...incoming.childNodes);
    });
  }

  // 轮询等待条件成立；取消或超时即返回，由调用方决定降级方式
  async function waitFor(predicate, timeout) {
    const deadline = Date.now() + timeout;
    while (!cancelRequested && !predicate() && Date.now() < deadline) await sleep(50);
  }

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

  // 虚拟滚动换块时 DOM 会连续变更；先确认滚动后确实有过渲染提交（DOM 变更或签名变化），
  // 再等 3 帧无新变更视为完成（约 50ms）。无任何变更时保留 WAIT_MS 硬上限，
  // 避免抢在虚拟列表挂载前采集导致漏块。
  function waitForDomSettled(pageEl) {
    return new Promise((resolve) => {
      const readSignature = () => {
        const ids = [...pageEl.querySelectorAll(BLOCK_SELECTOR)].map((el) => el.getAttribute('data-record-id'));
        return `${ids.join(',')}|${pageEl.scrollHeight}|${pageEl.querySelectorAll('.docx-block-loading-visible').length}`;
      };
      let signature = readSignature();
      let changed = false;
      let stableFrames = 0;
      let done = false;
      const deadline = performance.now() + WAIT_MS;
      let hardTimer;
      const observer = new MutationObserver(() => {
        changed = true;
        stableFrames = 0;
      });
      observer.observe(pageEl, { childList: true, subtree: true, attributes: true });
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(hardTimer);
        resolve();
      };
      const check = () => {
        if (done) return;
        const next = readSignature();
        if (next !== signature) {
          changed = true;
          signature = next;
          stableFrames = 0;
        } else {
          stableFrames += 1;
        }
        if (changed && stableFrames >= 2) finish();
        else if (performance.now() >= deadline) finish();
        else requestAnimationFrame(check);
      };
      hardTimer = setTimeout(finish, WAIT_MS);
      requestAnimationFrame(check);
    });
  }

  // 小组件 iframe 里是矢量图表，直接取 SVG 比截图清晰，且放大不失真
  async function extractFrameSvg(src) {
    if (!src) return '';
    try {
      const response = await chrome.runtime.sendMessage({ type: 'extract-svg', src });
      return response?.svg || '';
    } catch (error) {
      warn('extract svg failed', error);
      return '';
    }
  }

  // SVG 内的 foreignObject 含 HTML（裸 <br>），XML 解析会整段失败，必须走 HTML 解析
  function parseSvg(text) {
    if (!text) return null;
    const template = document.createElement('template');
    template.innerHTML = text;
    const svg = template.content.querySelector('svg');
    if (!svg) return null;
    if (!svg.getAttribute('viewBox')) {
      // 无 viewBox 时浏览器按像素尺寸渲染，放大后比例会走样
      const width = parseFloat(svg.getAttribute('width'));
      const height = parseFloat(svg.getAttribute('height'));
      if (!(width > 0 && height > 0)) return null;
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    }
    [svg, ...svg.querySelectorAll('*')].forEach((el) => {
      if (el.localName === 'script') {
        el.remove();
        return;
      }
      Array.from(el.attributes).forEach((attr) => {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        if (/href$/i.test(attr.name) && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name);
      });
    });
    // 原样式里的 max-width 是 iframe 内的尺寸上限，留着会把图缩在一侧；白底等其余样式要保留
    svg.style.removeProperty('max-width');
    svg.style.removeProperty('height');
    svg.style.setProperty('display', 'block');
    svg.style.setProperty('width', '100%');
    svg.style.setProperty('margin', '12px 0');
    svg.setAttribute('width', '100%');
    svg.removeAttribute('height');
    return svg;
  }

  // iframe 内容跨域且依赖父页面上下文，静态 HTML 无法还原；导出时截当前视口并按 iframe 矩形裁剪
  async function captureViewport() {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: 'capture-tab' });
    } catch (error) {
      warn('capture message failed', error);
      return { reason: `后台未响应，请重新加载扩展后重试（${error.message || error}）` };
    }
    if (!response?.dataUrl) {
      const detail = response?.error ? `（${response.error}）` : '';
      return { reason: response?.error === 'tab-inactive' ? '标签页不在前台' : `后台截图失败${detail}` };
    }
    const image = new Image();
    image.src = response.dataUrl;
    await image.decode();
    return { image };
  }

  // 嵌入图可能比可视区高，顶部对齐后按视口高度逐段截图再拼回整图
  async function snapshotIframe(iframe, scroller, overlay) {
    const rect = iframe.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return { reason: '嵌入框架尺寸异常' };
    const viewTop = getViewTop(scroller);
    const viewHeight = scroller.clientHeight;
    const viewBottom = viewTop + viewHeight;
    overlay.hide();
    try {
      await sleep(50); // 等浮层隐藏后的帧提交，避免被截进图里
      scroller.scrollTop += iframe.getBoundingClientRect().top - viewTop;
      await sleep(WAIT_MS);
      let canvas;
      let scale;
      for (let guard = 0; guard < 20; guard += 1) {
        if (cancelRequested) return { reason: '已取消' };
        const current = iframe.getBoundingClientRect();
        const sliceTop = Math.max(current.top, viewTop);
        const sliceBottom = Math.min(current.bottom, viewBottom);
        const sliceHeight = sliceBottom - sliceTop;
        if (sliceHeight < 4) {
          if (current.top <= viewTop) break;
          scroller.scrollTop += current.top - viewTop;
          await sleep(WAIT_MS);
          continue;
        }
        const { image, reason } = await captureViewport();
        if (reason) return { reason };
        if (!canvas) {
          scale = image.naturalWidth / innerWidth;
          canvas = document.createElement('canvas');
          canvas.width = Math.round(current.width * scale);
          canvas.height = Math.round(current.height * scale);
        }
        canvas.getContext('2d').drawImage(
          image,
          current.left * scale, sliceTop * scale, current.width * scale, sliceHeight * scale,
          0, (sliceTop - current.top) * scale, canvas.width, sliceHeight * scale
        );
        if (sliceBottom >= current.bottom - 1) break;
        scroller.scrollTop += sliceHeight;
        await sleep(Math.max(WAIT_MS, 500)); // 截图接口限制每秒 2 次
      }
      if (!canvas) return { reason: '嵌入框架未完整显示' };
      const img = document.createElement('img');
      img.src = canvas.toDataURL('image/png');
      img.alt = '嵌入内容快照';
      img.style.cssText = `display:block;max-width:100%;width:${Math.round(rect.width)}px;height:${Math.round(rect.height)}px;`;
      return { img };
    } catch (error) {
      warn('iframe snapshot failed', error);
      return { reason: '截图处理失败' };
    } finally {
      overlay.show();
    }
  }

  // 小组件在 iframe 内渐进渲染：等 400ms 后每 300ms 取一次 SVG，序列化长度连续两次一致即采用。
  // 连续 3 次取不到矢量图（约 1.2s）就回退截图，避免非 SVG 组件被拖到 3s 上限
  async function extractStableSvg(src) {
    await sleep(400);
    const deadline = Date.now() + 3000;
    let lastLength = 0;
    let emptyTries = 0;
    while (!cancelRequested && Date.now() < deadline) {
      const svg = parseSvg(await extractFrameSvg(src));
      if (!svg) {
        emptyTries += 1;
        if (emptyTries >= 3) return null;
      } else {
        emptyTries = 0;
        const length = svg.outerHTML.length;
        if (length === lastLength) return svg;
        lastLength = length;
      }
      await sleep(300);
    }
    return null;
  }

  async function enhanceEmbed(item, live, scroller, overlay) {
    await waitFor(() => live.querySelector('iframe'), 3000);
    const iframe = live.querySelector('iframe');
    if (!iframe) return;
    const svg = await extractStableSvg(iframe.src);
    if (svg) {
      item.el = svg;
      return;
    }
    if (cancelRequested) return;
    const { img, reason } = await snapshotIframe(iframe, scroller, overlay);
    if (cancelRequested) return;
    if (img) {
      item.el = img;
      return;
    }
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:4px;color:#d83931';
    note.textContent = `未能自动截图：${reason}`;
    item.el.appendChild(note);
    warn('嵌入图截图失败：', reason);
  }

  // 画板快照可能连大片空白画布一起导出；按 alpha 内容边界裁剪并留出内边距
  function boardContentBox(canvas, cssWidth) {
    const { width, height } = canvas;
    const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      for (let x = 0; x < width; x += 1) {
        if (data[(row + x) * 4 + 3] <= 8) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    if (right < left) return null;
    const pad = Math.round((BOARD_CROP_PADDING * width) / cssWidth);
    const x = Math.max(0, left - pad);
    const y = Math.max(0, top - pad);
    return {
      x,
      y,
      w: Math.min(width, right + 1 + pad) - x,
      h: Math.min(height, bottom + 1 + pad) - y,
    };
  }

  // 画板 canvas 只有块尺寸那么大，超大画板的文字会糊；临时放大容器让引擎按高分辨率重绘后再取快照
  async function enhanceBoard(item, live) {
    const img = item.el.querySelector('img[alt="画布快照"]');
    if (!img) return;
    const layer = live.querySelector(WHITEBOARD_LAYER_SELECTOR);
    const width = layer?.offsetWidth || 0;
    const height = layer?.offsetHeight || 0;
    const baseWidth = layer?.querySelector('canvas')?.width || 0;
    if (!width || !height || !baseWidth) return;
    const boardEl = item.el.matches('.docx-whiteboard-block') ? item.el : item.el.querySelector('.docx-whiteboard-block');
    const cssWidth = parseFloat(img.style.width) || width;
    const style = layer.getAttribute('style');
    try {
      layer.style.width = `${width * BOARD_SCALE}px`;
      layer.style.height = `${height * BOARD_SCALE}px`;
      // 引擎在容器尺寸变化后异步重绘，canvas 位图变大才算完成
      const grown = () => (layer.querySelector('canvas')?.width || 0) > baseWidth;
      await waitFor(grown, 3000);
      const canvases = [...layer.querySelectorAll('canvas')];
      if (!canvases.length) return;
      if (!cancelRequested && !grown()) warn('board upscale timeout, using current canvas');
      await sleep(200); // 等重绘帧提交
      const snapshot = document.createElement('canvas');
      snapshot.width = canvases[0].width;
      snapshot.height = canvases[0].height;
      const context = snapshot.getContext('2d');
      canvases.forEach((canvas) => context.drawImage(canvas, 0, 0));
      const box = boardContentBox(snapshot, cssWidth);
      if (!box) {
        img.src = snapshot.toDataURL('image/png'); // 全透明画布没有可裁的内容
        return;
      }
      const cropped = document.createElement('canvas');
      cropped.width = box.w;
      cropped.height = box.h;
      cropped.getContext('2d').drawImage(snapshot, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      // 裁掉空白画布后按原块宽铺满，块高随图片比例收缩
      const figure = document.createElement('div');
      ['Top', 'Right', 'Bottom', 'Left'].forEach((side) => {
        figure.style[`margin${side}`] = boardEl.style[`margin${side}`] || '0px';
      });
      const croppedImg = document.createElement('img');
      croppedImg.src = cropped.toDataURL('image/png');
      croppedImg.alt = '画布快照';
      croppedImg.style.cssText = 'display:block;width:100%;height:auto';
      figure.appendChild(croppedImg);
      boardEl.replaceWith(figure);
      if (boardEl === item.el) item.el = figure;
    } catch (error) {
      warn('board upscale failed', error);
    } finally {
      if (style === null) layer.removeAttribute('style');
      else layer.setAttribute('style', style);
    }
  }

  // 画板清晰化与嵌入补采原先各扫一趟、各自滚动定位；合并为按文档顺序的一趟
  async function enhanceMedia(pageEl, scroller, collected, overlay) {
    const items = [];
    for (const [id, item] of collected) {
      const isBoard = item.el.matches('.docx-whiteboard-block') || !!item.el.querySelector('.docx-whiteboard-block');
      if (isBoard) {
        if (item.el.querySelector('img[alt="画布快照"]')) items.push({ id, item, kind: 'board' });
      } else if (item.isPlaceholder) {
        items.push({ id, item, kind: 'embed' });
      }
    }
    if (!items.length) return;
    items.sort((a, b) => a.item.top - b.item.top);
    overlay.update('补采嵌入内容…', 0.7);
    for (const { id, item, kind } of items) {
      if (cancelRequested) return;
      scroller.scrollTop = Math.max(0, item.top - (scroller.clientHeight - item.height) / 2);
      await sleep(WAIT_MS);
      const live = pageEl.querySelector(`.block[data-record-id="${id}"]`);
      if (!live) continue;
      if (kind === 'embed' && !EMBED_TYPES[typeOf(live)]?.frame) continue;
      await waitForReady(live); // 长文档滚动后画布/嵌入可能刚挂载
      if (cancelRequested) return;
      if (kind === 'board') await enhanceBoard(item, live);
      else await enhanceEmbed(item, live, scroller, overlay);
    }
  }

  async function collectVisibleBlocks(pageEl, scroller, collected, overlay) {
    const viewTop = getViewTop(scroller);
    const viewBottom = viewTop + scroller.clientHeight;
    const visible = [];
    for (const block of pageEl.querySelectorAll(BLOCK_SELECTOR)) {
      if (cancelRequested) return;
      const type = typeOf(block);
      if (type === 'page') continue;
      const parent = block.parentElement?.closest(BLOCK_SELECTOR);
      if (parent && parent !== pageEl) continue;
      // 只采视口内的块：屏幕外的媒体块还没渲染，提前捕获会拿到空白画布
      const rect = block.getBoundingClientRect();
      if (rect.bottom < viewTop || rect.top > viewBottom) continue;
      visible.push({ block, rect, id: block.getAttribute('data-record-id'), type });
    }

    // 同屏多个画布块各自要等骨架消失，串行等待会累加
    await Promise.all(
      visible.filter(({ id }) => !collected.has(id)).map(({ block }) => waitForReady(block))
    );

    for (const { block, rect, id, type } of visible) {
      if (cancelRequested) return;
      const existing = collected.get(id);
      if (existing) {
        if (type === 'table' && existing.el.querySelector('.bear-virtual-renderUnit-placeholder')) {
          mergeTableCells(existing.el, captureBlock(block));
          imageInliner?.enqueue(existing.el);
        }
        continue;
      }
      const embedOwner = block.closest('[data-block-type]')?.getAttribute('data-block-type');
      const codeLineSets = block.querySelector('.code-block-content')
        ? await collectCodeLineSets(block, scroller, isEmbedType(embedOwner), overlay)
        : null;
      if (cancelRequested) return;
      const el = captureBlock(block, codeLineSets);
      imageInliner?.enqueue(el);
      const top = scroller.scrollTop + rect.top - viewTop;
      // waitForReady 后加载骨架消失，块高可能变化，需重新测量；top 仍用滚动前的位置排序
      collected.set(id, {
        top,
        height: block.getBoundingClientRect().height,
        isPlaceholder: el.classList.contains('placeholder'),
        el,
      });
    }
  }

  async function collectBlocks(pageEl, overlay) {
    const scroller = findScroller(pageEl);
    const origin = scroller.scrollTop;
    const originBehavior = scroller.style.scrollBehavior;
    const collected = new Map();
    const startedAt = Date.now();
    let steps = 0;

    try {
      scroller.style.scrollBehavior = 'auto';
      if (scroller.scrollTop) {
        const settled = waitForDomSettled(pageEl);
        scroller.scrollTop = 0;
        await settled;
      }
      let pos = 0;
      while (!cancelRequested && steps < MAX_STEPS && Date.now() - startedAt < MAX_MS) {
        await collectVisibleBlocks(pageEl, scroller, collected, overlay);
        const height = scroller.scrollHeight;
        pos = Math.min(pos + Math.max(scroller.clientHeight * STEP_RATIO, 400), height);
        const settled = waitForDomSettled(pageEl);
        scroller.scrollTop = pos;
        overlay.update(
          `收集内容… 已找到 ${collected.size} 个块`,
          Math.min(0.7, (0.7 * pos) / Math.max(height, 1))
        );
        steps += 1;
        // 触底后不再进入下一轮收集，末屏同样要等渲染稳定再补采
        await settled;
        if (pos >= scroller.scrollHeight - scroller.clientHeight) break;
      }
      if (!cancelRequested) {
        await collectVisibleBlocks(pageEl, scroller, collected, overlay);
        await enhanceMedia(pageEl, scroller, collected, overlay);
      }
      const limited = steps >= MAX_STEPS || Date.now() - startedAt >= MAX_MS;
      return {
        blocks: [...collected.values()]
          .sort((a, b) => a.top - b.top)
          .map((item) => item.el),
        limited,
      };
    } finally {
      scroller.scrollTop = origin;
      scroller.style.scrollBehavior = originBehavior;
    }
  }

  async function toDataUrl(src) {
    const response = await fetch(src, {
      credentials: 'include',
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  function drawToDataUrl(img) {
    if (!img?.naturalWidth) return '';
    try {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      return canvas.toDataURL('image/png');
    } catch {
      return ''; // 图片未获得 CORS 授权时画布被污染
    }
  }

  // fetch 会受 CORS/临时网络故障影响；活节点可能已被虚拟滚动卸载，再按 URL 重新解码一次
  async function snapshotImage(img, src) {
    if (img?.complete && img.naturalWidth) {
      const dataUrl = drawToDataUrl(img);
      if (dataUrl) return dataUrl;
    }
    const fresh = new Image();
    fresh.crossOrigin = 'use-credentials';
    fresh.src = src;
    // decode 没有超时机制，图片服务无响应时会把整个导出卡住
    const timeout = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), IMAGE_TIMEOUT_MS);
    });
    try {
      await Promise.race([fresh.decode(), timeout]);
    } catch {
      return '';
    }
    return drawToDataUrl(fresh);
  }

  // 图片内联流水线：捕获块时立即入队下载，与滚动采集重叠；flush 时等待队列完成并清扫晚到的图片
  function createImageInliner(overlay) {
    const cache = new Map();
    const seen = new WeakSet();
    const queue = [];
    let active = 0;
    let done = 0;
    let total = 0;
    let failed = 0;
    let reporting = false;

    const pump = () => {
      while (active < IMAGE_CONCURRENCY && queue.length) {
        const job = queue.shift();
        active += 1;
        job().finally(() => {
          active -= 1;
          pump();
        });
      }
    };

    const fetchOnce = (src, liveImg) => {
      if (!cache.has(src)) {
        cache.set(src, new Promise((resolve) => {
          queue.push(async () => {
            if (cancelRequested) {
              resolve('');
              return;
            }
            let dataUrl = await toDataUrl(src).catch(() => null);
            if (!dataUrl && !cancelRequested) dataUrl = await snapshotImage(liveImg, src);
            resolve(dataUrl || '');
          });
          pump();
        }));
      }
      return cache.get(src);
    };

    const apply = (img, dataUrl) => {
      if (dataUrl) {
        img.setAttribute('src', dataUrl);
        return;
      }
      failed += 1;
      img.setAttribute('title', '图片未能内联，需要联网查看');
    };

    const enqueue = (root) => {
      for (const img of root.querySelectorAll('img')) {
        if (seen.has(img)) continue;
        const src = img.getAttribute('src');
        if (!src) {
          img.remove();
          continue;
        }
        if (src.startsWith('data:')) continue;
        seen.add(img);
        total += 1;
        fetchOnce(src, liveImages.get(img)).then((dataUrl) => {
          done += 1;
          apply(img, dataUrl);
          if (reporting) {
            overlay.update(`处理图片 ${done}/${total}`, 0.7 + (0.25 * done) / Math.max(total, 1));
          }
        });
      }
    };

    return {
      enqueue,
      async flush(blocks) {
        reporting = true;
        blocks.forEach((block) => enqueue(block));
        await Promise.all([...cache.values()]);
        return failed;
      },
    };
  }

  function buildHtml(title, blocks, theme, sourceUrl) {
    const content = blocks.map((el) => el.outerHTML).join('\n');
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="source" content="${esc(sourceUrl)}">
<style>${BASE_CSS}</style>
</head>
<body style="background:${theme.background};color:${theme.color}">
<main class="export-root">
<h1>${esc(title)}</h1>
<div class="export-content">
${content}
</div>
</main>
</body>
</html>`;
  }

  function sanitizeFilename(name) {
    const cleaned = String(name || '飞书文档')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    return cleaned || '飞书文档';
  }

  function downloadHtml(filename, html) {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return blob.size;
  }

  function createOverlay(onCancel) {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        .card{width:280px;padding:14px 16px;border-radius:10px;background:#fff;color:#1f2329;
          font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
          box-shadow:0 8px 28px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.06)}
        .head{display:flex;align-items:center;justify-content:space-between;gap:8px}
        .title{font-weight:600}
        .cancel{font:inherit;font-size:12px;color:#646a73;background:none;border:0;border-radius:4px;
          padding:4px 8px;min-block-size:24px;min-inline-size:44px;cursor:pointer}
        .cancel:hover{background:#eff0f1}
        .cancel[aria-disabled="true"]{color:#8f959e;cursor:default}
        .cancel:focus-visible{outline:2px solid #3370ff;outline-offset:2px}
        .msg{color:#646a73;word-break:break-all;margin-top:6px}
        progress{display:block;inline-size:100%;block-size:4px;margin-top:10px;appearance:none;
          border:0 solid;overflow:clip;background:#eff0f1;border-radius:2px}
        progress::-webkit-progress-bar{background:transparent}
        progress::-webkit-progress-value{background:#3370ff;border-radius:2px}
        @media (prefers-reduced-motion: no-preference){
          progress::-webkit-progress-value{transition:inline-size .2s}
        }
        .sr-only{position:absolute;clip-path:inset(50%);overflow:hidden;width:1px;height:1px;
          margin:-1px;padding:0;border:0;white-space:nowrap}
        .ok .title{color:#2ea121}
        .err .title{color:#d83931}
      </style>
      <div class="card">
        <div class="head">
          <div class="title">飞书文档导出</div>
          <button class="cancel" type="button">取消</button>
        </div>
        <div class="msg">准备中…</div>
        <progress max="100" value="0" aria-label="导出进度"></progress>
        <p class="sr-only" role="status"></p>
        <p class="sr-only" role="alert"></p>
      </div>`;
    document.documentElement.appendChild(host);

    const card = root.querySelector('.card');
    const msg = root.querySelector('.msg');
    const bar = root.querySelector('progress');
    const status = root.querySelector('[role="status"]');
    const alert = root.querySelector('[role="alert"]');
    const cancel = root.querySelector('.cancel');
    let cancelled = false;

    if (onCancel) {
      cancel.addEventListener('click', () => {
        if (cancelled) return;
        cancelled = true;
        cancel.setAttribute('aria-disabled', 'true');
        cancel.textContent = '正在取消…';
        msg.textContent = '正在取消，请稍候…';
        onCancel();
      });
    } else {
      cancel.remove();
    }

    return {
      update(text, progress) {
        if (cancelled) return;
        msg.textContent = text;
        if (progress !== undefined) bar.value = Math.round(progress * 100);
      },
      hide() {
        host.style.display = 'none';
      },
      show() {
        host.style.display = '';
      },
      finish(text, kind) {
        const timeout = kind === 'err' ? 8000 : kind === 'info' ? 3000 : 6000;
        cancel.remove();
        if (kind === 'ok' || kind === 'err') card.classList.add(kind);
        if (kind === 'ok') bar.value = 100;
        msg.textContent = text;
        if (kind === 'err') alert.textContent = text;
        else status.textContent = text;
        setTimeout(() => host.remove(), timeout);
      },
    };
  }

  async function start() {
    if (running) {
      createOverlay().finish(cancelRequested ? '正在取消，请稍候' : '正在导出，请稍候', 'info');
      return;
    }
    running = true;
    cancelRequested = false;
    const overlay = createOverlay(() => {
      cancelRequested = true;
    });
    const finishIfCancelled = () => {
      if (!cancelRequested) return false;
      overlay.finish('已取消导出', 'info');
      return true;
    };
    try {
      const pageEl = document.querySelector(PAGE_SELECTOR);
      if (!pageEl) {
        overlay.finish('请在飞书文档页面使用', 'err');
        return;
      }
      const title = getTitle(pageEl);
      const theme = getTheme(pageEl);
      overlay.update('收集内容…', 0);

      imageInliner = createImageInliner(overlay);
      const { blocks, limited } = await collectBlocks(pageEl, overlay);
      if (finishIfCancelled()) return;
      if (!blocks.length) {
        overlay.finish('未找到文档内容', 'err');
        return;
      }

      const failedImages = await imageInliner.flush(blocks);
      if (finishIfCancelled()) return;

      overlay.update('生成文件…', 0.97);
      const html = buildHtml(title, blocks, theme, location.href);
      const size = downloadHtml(`${sanitizeFilename(title)}.html`, html);

      const notes = [];
      if (limited) notes.push('可能不完整');
      if (failedImages) notes.push(`${failedImages} 张图片未内联`);
      const suffix = notes.length ? `（${notes.join('，')}）` : '';
      overlay.finish(`已导出 ${blocks.length} 个块，${(size / 1024 / 1024).toFixed(2)} MB${suffix}`, 'ok');
    } catch (error) {
      if (finishIfCancelled()) return;
      console.error('[feishu-doc-exporter]', error);
      overlay.finish(`导出失败：${error?.message || error}`, 'err');
    } finally {
      running = false;
      cancelRequested = false;
      imageInliner = null;
    }
  }

  window.__feishuDocExporterStart = start;
  start();
})();
