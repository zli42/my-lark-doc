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
});
