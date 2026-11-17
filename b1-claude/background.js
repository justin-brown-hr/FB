// B1 background: receives project details from B2 over an external port,
// drives the BID chat on claude.ai via the content script, returns the reply.

const B2_ID = 'nlejmfpbabcofjkfpdinpkccflhbofjf';

const DEFAULTS = {
  chatUrl: '',            // e.g. https://claude.ai/chat/xxxxxxxx (your pinned BID chat)
  chatName: 'BID',        // used to find the chat if chatUrl is empty
  promptTemplate: '{project}',
  focusTab: false,
  timeoutSec: 240
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getSettings = () => chrome.storage.sync.get(DEFAULTS);

let queue = Promise.resolve();

// Accept B2 by its fixed ID, or by name (its ID can differ, e.g. when loaded from another copy).
async function isB2(id) {
  if (id === B2_ID) return true;
  try { return (await chrome.management.get(id)).name.startsWith('Bid Assistant B2'); } catch (_) { return false; }
}

chrome.runtime.onConnectExternal.addListener(async (port) => {
  const queued = [];
  const early = (m) => queued.push(m);
  port.onMessage.addListener(early);       // don't lose messages sent while we verify the sender
  if (!(await isB2(port.sender?.id))) { port.disconnect(); return; }
  port.onMessage.removeListener(early);
  let alive = true;
  port.onDisconnect.addListener(() => { alive = false; });
  const post = (m) => { if (alive) { try { port.postMessage(m); } catch (_) {} } };

  const handle = (msg) => {
    if (msg?.type === 'DIAG') { diagnose().then((r) => post({ type: 'DIAG', ...r })); return; }
    if (msg?.type !== 'GENERATE') return; // PINGs just keep the worker alive
    queue = queue.then(() => generate(msg.text, (s) => post({ type: 'STATUS', text: s }))
      .then((bid) => post({ type: 'RESULT', bid }))
      .catch((e) => post({ type: 'ERROR', error: String(e?.message || e) })));
  };
  port.onMessage.addListener(handle);
  queued.forEach(handle);
});

// ---------- tab handling ----------

function waitForTabComplete(tabId, timeout = 30000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(t); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

async function ask(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg);
}

// Chrome's Memory Saver unloads background tabs; reload such a tab before using it.
async function wakeTab(tab) {
  const t = await chrome.tabs.get(tab.id);
  if (t.discarded || t.frozen) {
    await chrome.tabs.reload(t.id);
    await sleep(500);
    await waitForTabComplete(t.id);
  }
  return chrome.tabs.get(tab.id);
}

async function ensureContentScript(tabId) {
  for (let i = 0; i < 10; i++) {
    try { const r = await ask(tabId, { type: 'PING' }); if (r?.ok) return; } catch (_) {}
    if (i === 3) {
      try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (_) {}
    }
    await sleep(500);
  }
  throw new Error('Could not talk to the claude.ai page. Reload the Claude tab and try again.');
}

const normUrl = (u) => (u || '').split(/[?#]/)[0].replace(/\/$/, '');

async function getBidTab(settings, status) {
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  const target = normUrl(settings.chatUrl);

  // 1) explicit chat URL from settings
  if (target) {
    let tab = tabs.find((t) => normUrl(t.url) === target);
    if (!tab) {
      status('Opening BID chat…');
      tab = await chrome.tabs.create({ url: settings.chatUrl, active: false });
    }
    await waitForTabComplete(tab.id);
    return wakeTab(tab);
  }

  // 2) an open tab whose title is the chat name ("BID - Claude", "BID", …)
  const name = (settings.chatName || 'BID').trim().toLowerCase();
  let tab = tabs.find((t) => (t.title || '').trim().toLowerCase().split(/\s+[-|–]\s+/)[0] === name);
  if (tab) return wakeTab(tab);

  // 3) open claude.ai and click the sidebar link named BID
  tab = tabs[0];
  if (!tab) {
    status('Opening claude.ai…');
    tab = await chrome.tabs.create({ url: 'https://claude.ai/new', active: false });
  }
  await waitForTabComplete(tab.id);
  tab = await wakeTab(tab);
  await ensureContentScript(tab.id);
  let href = null;
  for (let i = 0; i < 10 && !href; i++) {
    let r = null;
    try { r = await ask(tab.id, { type: 'FIND_CHAT_LINK', name: settings.chatName || 'BID' }); } catch (_) {}
    if (r?.loggedOut) throw new Error('You are not logged in to claude.ai in this Chrome. Log in, then try again.');
    href = r?.href;
    if (!href) await sleep(700);
  }
  if (!href) {
    throw new Error(`Could not find a chat named "${settings.chatName || 'BID'}" in the Claude sidebar. Set the BID chat URL in the B1 popup.`);
  }
  // remember it for next time
  chrome.storage.sync.set({ chatUrl: href });
  status('Opening BID chat…');
  await chrome.tabs.update(tab.id, { url: href });
  await sleep(500);
  await waitForTabComplete(tab.id);
  return tab;
}

// ---------- main flow ----------

async function generate(projectText, status) {
  if (!projectText || !projectText.trim()) throw new Error('No project details received.');
  const settings = await getSettings();

  const tab = await getBidTab(settings, status);
  if (settings.focusTab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  await ensureContentScript(tab.id);

  status('Waiting for Claude input box…');
  let st = null;
  for (let i = 0; i < 60; i++) {
    try { st = await ask(tab.id, { type: 'STATE' }); } catch (_) { st = null; }
    if (st?.hasInput && !st.streaming) break;
    await sleep(500);
  }
  if (!st?.hasInput) {
    if (st?.loggedOut) throw new Error('You are not logged in to claude.ai in this Chrome. Log in, then try again.');
    throw new Error('Claude input box not found. Open the BID chat on claude.ai once, then try again.');
  }
  if (st.streaming) throw new Error('Claude is still answering in the BID chat. Try again when it is done.');

  const before = st;
  const prompt = (settings.promptTemplate || '{project}').includes('{project}')
    ? settings.promptTemplate.replace('{project}', projectText)
    : `${settings.promptTemplate}\n\n${projectText}`;

  status('Sending project to Claude…');
  const sent = await ask(tab.id, { type: 'SEND', text: prompt });
  if (!sent?.ok) throw new Error(sent?.error || 'Failed to send the message to Claude.');

  status('Claude is writing the bid…');
  const deadline = Date.now() + (Number(settings.timeoutSec) || 240) * 1000;
  let lastText = null;
  let stableCount = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    let s;
    try { s = await ask(tab.id, { type: 'STATE' }); } catch (_) { continue; } // page may be re-rendering
    const started = s.msgCount > before.msgCount || (s.lastText && s.lastText !== before.lastText);
    if (!started || s.streaming || !s.lastText) { stableCount = 0; lastText = s.lastText; continue; }
    if (s.lastText === lastText) stableCount++; else stableCount = 0;
    lastText = s.lastText;
    if (stableCount >= 2) return s.lastText.trim();
  }
  if (lastText && lastText !== before.lastText) return lastText.trim();
  throw new Error('Timed out waiting for Claude\'s reply.');
}

// ---------- setup check (B2 popup "Check setup") ----------

async function diagnose() {
  const lines = [];
  const settings = await getSettings();
  lines.push('✓ B1 is installed and reachable');
  lines.push(settings.chatUrl ? `✓ BID chat URL set: ${settings.chatUrl}` : `• No BID chat URL set — B1 will look for a chat named "${settings.chatName}"`);
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/*' });
  if (!tabs.length) {
    lines.push('• No claude.ai tab open — B1 will open one when you click Write bid');
    return { ok: true, lines };
  }
  let tab = tabs.find((t) => normUrl(t.url) === normUrl(settings.chatUrl)) || tabs[0];
  try {
    tab = await wakeTab(tab);
    await ensureContentScript(tab.id);
    const st = await ask(tab.id, { type: 'STATE' });
    if (st.loggedOut) { lines.push('✗ Not logged in to claude.ai in this Chrome'); return { ok: false, lines }; }
    lines.push(`✓ claude.ai tab reachable (${tab.title || tab.url})`);
    if (!settings.chatUrl) {
      const r = await ask(tab.id, { type: 'FIND_CHAT_LINK', name: settings.chatName || 'BID' });
      lines.push(r?.href ? `✓ Found "${settings.chatName}" chat: ${r.href}` : `✗ No chat named "${settings.chatName}" in this claude.ai account — set the BID chat URL in the B1 popup`);
      if (r?.href) chrome.storage.sync.set({ chatUrl: r.href });
      return { ok: !!r?.href, lines };
    }
    return { ok: true, lines };
  } catch (e) {
    lines.push('✗ ' + (e?.message || e));
    return { ok: false, lines };
  }
}
