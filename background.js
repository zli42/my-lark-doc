chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (error) {
    console.warn('[feishu-doc-exporter] inject failed', error);
  }
});

// 在目标帧内执行：返回该帧里面积最大的 svg（小组件是 web component，需下钻 shadow root）
// probe 只回传体积指纹，避免每轮都把整棵 SVG 序列化后跨进程传输
function pickLargestSvg(targetSrc, mode) {
  // 矢量图只可能出现在小组件子框架里，主帧与非目标帧无需扫描
  if (window === window.top) return { href: location.href, svg: '', sig: '' };
  if (targetSrc && location.href.split('?')[0] !== targetSrc) {
    return { href: location.href, svg: '', sig: '' };
  }
  let best = null;
  let bestArea = 0;
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.localName !== 'svg') continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.width >= 120 && rect.height >= 80 && area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
  };
  visit(document);
  if (!best) return { href: location.href, svg: '', sig: '' };
  if (mode === 'probe') {
    return {
      href: location.href,
      svg: '',
      sig: `${best.getElementsByTagName('*').length}:${(best.textContent || '').length}`,
    };
  }
  return { href: location.href, svg: best.outerHTML, sig: '' };
}

async function handleExtractSvg(message, sender) {
  if (!sender.tab) return { svg: '', sig: '' };
  try {
    const base = String(message.src || '').split('?')[0];
    const mode = message.mode === 'probe' ? 'probe' : 'full';
    const run = (target) =>
      chrome.scripting.executeScript({ target, func: pickLargestSvg, args: [base, mode] });
    const hasSvg = (frames) => !!frames?.some((frame) => frame.result?.svg || frame.result?.sig);
    // 先用上次命中的帧，未命中再扫全部帧兜底
    let frames = Number.isInteger(message.frameId)
      ? await run({ tabId: sender.tab.id, frameIds: [message.frameId] }).catch(() => null)
      : null;
    if (!hasSvg(frames)) {
      frames = await run({ tabId: sender.tab.id, allFrames: true });
    }
    const hit = frames.find((frame) => frame.result?.svg || frame.result?.sig);
    return {
      svg: hit?.result?.svg || '',
      sig: hit?.result?.sig || '',
      frameId: hit?.frameId,
    };
  } catch (error) {
    console.warn('[feishu-doc-exporter] extract svg failed', error);
    return { svg: '', sig: '' };
  }
}

async function handleCaptureTab(sender) {
  // captureVisibleTab 拍的是窗口内当前可见标签页，后台标签会拍到别的页面
  if (!sender.tab || !sender.tab.active) return { error: 'tab-inactive' };
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
    return { dataUrl };
  } catch (error) {
    return { error: String(error?.message || error) };
  }
}

// 在页面主世界执行：多维表格由 canvas 绘制，DOM 中没有单元格文本，
// 只能从块内 React 树挂载的 Base 数据模型里读当前视图的字段与记录
function extractBitableTable(blockId) {
  const MAX_ROWS = 1000;
  const MAX_CELL = 5000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const joinText = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(joinText).join('');
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      if (typeof value.link === 'string') return value.text || value.link;
      if (typeof value.name === 'string') return value.name;
      try {
        return JSON.stringify(value);
      } catch {
        return '';
      }
    }
    return '';
  };

  const readBitable = (block) => {
    const isBaseRefer =
      block.getAttribute('data-block-type') === 'base_refer' ||
      block.classList.contains('docx-base_refer-block');
    // 引用块的工具栏标题在块内第一行，替换为表格后用它保留可读标题
    const title = isBaseRefer
      ? (block.innerText || '').split('\n').map((line) => line.trim()).find(Boolean) || ''
      : '';
    let doc = document;
    // Base 引用块的容器就在块内，块里的 iframe 可能是无关的隐藏框架，不能优先读它
    const frame = isBaseRefer ? null : block.querySelector('iframe');
    if (frame) {
      // 分享视图和宿主文档同源时才能读到 frame 内部；跨域只能回退占位块
      try {
        doc = frame.contentDocument;
      } catch {
        return null;
      }
      if (!doc) return null;
    }
    const scope = frame ? doc : block;
    const container = scope.querySelector('#bitable-container') || scope.querySelector('.bitable-container');
    if (!container) return null;
    const fiberKey = Object.keys(container).find(
      (key) => key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')
    );
    if (!fiberKey) return null;

    let store = null;
    let tableId = '';
    let viewId = '';
    for (let node = container[fiberKey], depth = 0; node && depth < 60; node = node.return, depth += 1) {
      const props = node.memoizedProps;
      if (!props) continue;
      if (!store && props.bitableStore?.modelOperator) store = props.bitableStore;
      if (!tableId && typeof props.tableId === 'string') tableId = props.tableId;
      if (!viewId && typeof props.viewId === 'string') viewId = props.viewId;
    }
    if (!store || !tableId) return null;

    const base = store.modelOperator.base;
    const table = typeof base.getTableById === 'function' ? base.getTableById(tableId) : base.tableMap?.[tableId];
    if (!table || !table.fieldsMap) return null;
    // 记录没加载完时返回 null，由外层轮询重试
    if (!table.recordsMap.size && table.recordsNum > 0) return null;

    const view = (table.views || []).find((item) => item.id === viewId) || (table.views || [])[0] || null;
    const fields = view && Array.isArray(view._visibleFieldIds) && view._visibleFieldIds.length
      ? view._visibleFieldIds.map((id) => table.fieldsMap.get(id)).filter(Boolean)
      : [...table.fieldsMap.values()];
    const allIds = [...table.recordsMap.keys()];
    const viewIds = view?._viewFilter && Array.isArray(view._viewFilter.records) ? view._viewFilter.records : null;
    const candidates = viewIds ? viewIds.filter((id) => table.recordsMap.has(id)) : allIds;
    const recordIds = candidates.slice(0, MAX_ROWS);

    const readCell = (recordId, fieldId) => {
      let value = null;
      try {
        value = table.getCellValue(recordId, fieldId);
      } catch {
        value = null;
      }
      if (value !== null && value !== undefined) return value;
      const record = table.recordsMap.get(recordId);
      const raw = record ? record[fieldId] : null;
      return raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
    };

    const optionName = (field, id) => {
      const options = field.property?.options || [];
      const hit = options.find((option) => option.id === id);
      return hit ? hit.name : String(id);
    };
    const userText = (value) => {
      const list = Array.isArray(value) ? value : [value];
      return list
        .map((item) => {
          const id = typeof item === 'string' ? item : item?.id;
          const user = id ? base.userMap?.[id] : null;
          return user?.name || user?.en_name || item?.name || item?.en_name || (id ? String(id) : joinText(item));
        })
        .join('、');
    };
    const linkText = (field, value) => {
      const ids = Array.isArray(value) ? value : value?.link_record_ids || [];
      const targetId = field.property?.tableId;
      const target = targetId
        ? (typeof base.getTableById === 'function' ? base.getTableById(targetId) : base.tableMap?.[targetId])
        : null;
      return ids
        .map((id) => {
          if (!target?.recordsMap) return String(id);
          let cell = null;
          try {
            cell = target.getCellValue(id, target.primaryKey);
          } catch {
            cell = null;
          }
          if (cell === null || cell === undefined) {
            const record = target.recordsMap.get(id);
            const raw = record ? record[target.primaryKey] : null;
            cell = raw && typeof raw === 'object' && 'value' in raw ? raw.value : raw;
          }
          return joinText(cell) || String(id);
        })
        .join('、');
    };
    const dateText = (field, value) => {
      const ms = Number(value);
      if (!ms) return '';
      const date = new Date(ms);
      const pad = (num) => String(num).padStart(2, '0');
      const text = ((field.property?.dateFormat) || 'yyyy/MM/dd')
        .replace(/yyyy/g, date.getFullYear())
        .replace(/MM/g, pad(date.getMonth() + 1))
        .replace(/dd/g, pad(date.getDate()));
      const timeFormat = field.property?.timeFormat || '';
      return timeFormat
        ? `${text} ${timeFormat.replace(/HH/g, pad(date.getHours())).replace(/mm/g, pad(date.getMinutes()))}`
        : text;
    };
    const formatCell = (field, value) => {
      if (value === null || value === undefined) return '';
      const type = String(field.type);
      let text;
      if (type === '3') text = optionName(field, value);
      else if (type === '4') {
        text = (Array.isArray(value) ? value : [value]).map((id) => optionName(field, id)).join('、');
      } else if (type === '5') text = dateText(field, value);
      else if (type === '7') text = value ? '是' : '否';
      else if (type === '11' || type === '1003' || type === '1004') text = userText(value);
      else if (type === '17') {
        text = (Array.isArray(value) ? value : [value])
          .map((item) => item?.name || joinText(item))
          .join('、');
      } else if (type === '18' || type === '21') text = linkText(field, value);
      else text = joinText(value);
      return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
    };

    const rows = recordIds.map((recordId) =>
      fields.map((field) => formatCell(field, readCell(recordId, field.id)))
    );
    return {
      title,
      viewName: view?._name || '',
      fieldNames: fields.map((field) => field.name),
      rows,
      shown: rows.length,
      total: candidates.length,
      truncated: candidates.length > MAX_ROWS,
    };
  };

  return (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const block = [...document.querySelectorAll('.block[data-record-id]')].find(
        (el) => el.getAttribute('data-record-id') === blockId
      );
      if (block) {
        const data = readBitable(block);
        if (data) return data;
      }
      await sleep(150);
    }
    return null;
  })();
}

async function handleExtractBitable(message, sender) {
  if (!sender.tab) return null;
  try {
    // 内容脚本在隔离世界读不到页面对象，提取逻辑必须注入主世界
    const results = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: extractBitableTable,
      args: [String(message.blockId || '')],
    });
    return results?.[0]?.result || null;
  } catch (error) {
    console.warn('[feishu-doc-exporter] extract bitable failed', error);
    return null;
  }
}

// 在页面主世界执行：电子表格同样由 canvas 绘制，DOM 里没有单元格文字，
// 只能按块上的 sheet id 从页面已加载的工作簿模型（window.spread）里读单元格
function extractSheetTable(blockId) {
  const MAX_ROWS = 500;
  const MAX_COLS = 50;
  const MAX_CELL = 5000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const joinText = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.map(joinText).join('');
    if (typeof value === 'object') {
      if (typeof value.text === 'string') return value.text;
      if (value.textRun && typeof value.textRun.text === 'string') return value.textRun.text;
      if (value.segment) return joinText(value.segment);
      if (value.value !== undefined) return joinText(value.value);
    }
    return '';
  };
  const cellText = (content) => {
    if (!content || typeof content !== 'object') return '';
    if (content._segmentArray) return joinText(content._segmentArray);
    if (content._variant && content._variant.value !== undefined) return joinText(content._variant.value);
    if (content._multipleValues) return joinText(content._multipleValues);
    return '';
  };

  const readSheet = (block) => {
    // 块的 .spreadsheet-wrap 带 sheet-id-<id> 类名，用它匹配工作簿里的工作表
    let sheetId = '';
    for (const el of block.querySelectorAll('[class*="sheet-id-"]')) {
      const cls = [...el.classList].find((name) => name.startsWith('sheet-id-'));
      if (cls) {
        sheetId = cls.slice('sheet-id-'.length);
        break;
      }
    }
    const spread = (window.spread && Array.isArray(window.spread.sheets) ? window.spread : null)
      || (window.Spread && window.Spread.spread)
      || null;
    if (!spread || !Array.isArray(spread.sheets)) return null;
    const sheet = spread.sheets.find(
      (item) => item && (item._id_ === sheetId || item._name === sheetId || item.id === sheetId)
    );
    if (!sheet || !sheet._dataModel) return null;

    const dm = sheet._dataModel;
    const rowCount = Math.min(Number(dm.rowCount) || 0, MAX_ROWS);
    const colCount = Math.min(Number(dm.colCount) || 0, MAX_COLS);
    if (!rowCount || !colCount) return null;

    const grid = [];
    let lastRow = -1;
    let lastCol = -1;
    for (let r = 0; r < rowCount; r += 1) {
      const row = [];
      for (let c = 0; c < colCount; c += 1) {
        let text = '';
        try {
          text = cellText(dm.getImmutableContent(r, c));
        } catch {
          text = '';
        }
        if (text.length > MAX_CELL) text = `${text.slice(0, MAX_CELL)}…`;
        if (text) {
          lastRow = r;
          lastCol = Math.max(lastCol, c);
        }
        row.push(text);
      }
      grid.push(row);
    }
    if (lastRow < 0 || lastCol < 0) return null;

    const rows = grid.slice(0, lastRow + 1).map((row) => row.slice(0, lastCol + 1));
    return {
      kind: 'sheet',
      fieldNames: [],
      rows,
      shown: rows.length,
      total: rows.length,
      truncated: Number(dm.rowCount) > MAX_ROWS || Number(dm.colCount) > MAX_COLS,
    };
  };

  return (async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const block = [...document.querySelectorAll('.block[data-record-id]')].find(
        (el) => el.getAttribute('data-record-id') === blockId
      );
      if (block) {
        const data = readSheet(block);
        if (data) return data;
      }
      await sleep(150);
    }
    return null;
  })();
}

async function handleExtractSheet(message, sender) {
  if (!sender.tab) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: extractSheetTable,
      args: [String(message.blockId || '')],
    });
    return results?.[0]?.result || null;
  } catch (error) {
    console.warn('[feishu-doc-exporter] extract sheet failed', error);
    return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 用 sendResponse 兼容旧版 Chrome；端口已关闭时忽略投递失败
  if (message.type === 'extract-svg') {
    handleExtractSvg(message, sender).then(sendResponse, () => {});
    return true;
  }
  if (message.type === 'capture-tab') {
    handleCaptureTab(sender).then(sendResponse, () => {});
    return true;
  }
  if (message.type === 'extract-bitable') {
    handleExtractBitable(message, sender).then(sendResponse, () => {});
    return true;
  }
  if (message.type === 'extract-sheet') {
    handleExtractSheet(message, sender).then(sendResponse, () => {});
    return true;
  }
});
