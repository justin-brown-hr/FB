const out = document.getElementById('out');
const add = (line) => { out.textContent += line + '\n'; };

document.getElementById('check').onclick = async () => {
  out.textContent = '';

  // 1) this tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (/^https:\/\/(www\.)?freelancer\.[a-z.]+\/projects\/.+/.test(url)) {
    let hasButtons = false;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.getElementById('fba-panel') });
      hasButtons = r?.result;
    } catch (_) {}
    add(hasButtons ? '✓ Buttons are on this project page' : '✗ Buttons missing on this page — refresh the page (F5)');
  } else {
    add('• This tab is not a Freelancer project page (open one to see the buttons)');
  }

  // 2) B1 + claude.ai
  add('… checking B1');
  let answered = false;
  const port = chrome.runtime.connect({ name: 'bid' });
  const timer = setTimeout(() => { if (!answered) { add('✗ B1 did not answer — is "Bid Assistant B1 (Claude)" installed and enabled?'); port.disconnect(); } }, 15000);
  port.onMessage.addListener((m) => {
    if (m.type === 'DIAG') { answered = true; clearTimeout(timer); out.textContent = out.textContent.replace('… checking B1\n', ''); m.lines.forEach(add); add(m.ok ? '\nAll good ✓' : ''); port.disconnect(); }
    if (m.type === 'ERROR') { answered = true; clearTimeout(timer); add('✗ ' + m.error); }
  });
  port.postMessage({ type: 'DIAG' });
};
