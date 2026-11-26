chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
  } catch (error) {
    console.warn('[feishu-doc-exporter] inject failed', error);
  }
});

// 在目标帧内执行：返回该帧里面积最大的 svg（小组件是 web component，需下钻 shadow root）
function pickLargestSvg() {
  // 矢量图只可能出现在小组件子框架里，主帧无需扫描
  if (window === window.top) return { href: location.href, svg: '' };
  let best = '';
  let bestArea = 0;
  const visit = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.localName !== 'svg') continue;
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (rect.width >= 120 && rect.height >= 80 && area > bestArea) {
        bestArea = area;
        best = el.outerHTML;
      }
    }
  };
  visit(document);
  return { href: location.href, svg: best };
}

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
