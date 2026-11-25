// B1 background: receives project details from B2 over an external port,
// drives the BID chat on claude.ai via the content script, returns the reply.

const B2_ID = 'nlejmfpbabcofjkfpdinpkccflhbofjf';

const DEFAULTS = {
  chatUrl: '',            // e.g. https://claude.ai/chat/xxxxxxxx (your pinned BID chat)
  chatName: 'BID',        // used to find the chat if chatUrl is empty
  promptTemplate: '{project}',
  focusTab: false,
  timeoutSec: 240,
  relayUrl: '',           // e.g. http://127.0.0.1:8787 when the relay runs on this VPS
  relayToken: ''
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
      .then((bid) => { post({ type: 'RESULT', bid }); return ensureModel(); })
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

let lastBidTabId = null;
const REQUIRED_MODEL = 'Opus 5.5'; // the BID chat is switched back to this model after every bid

// After a bid has been handed back: make sure the BID chat still uses the required model.
async function ensureModel() {
  const model = REQUIRED_MODEL;
  if (!lastBidTabId) return;
  let r;
  try {
    await ensureContentScript(lastBidTabId);
    r = await ask(lastBidTabId, { type: 'ENSURE_MODEL', want: model });
  } catch (e) {
    r = { ok: false, error: String(e?.message || e) };
  }
  const time = new Date().toLocaleTimeString();
  const text = r?.ok
    ? (r.changed ? `✓ switched ${r.before} → ${r.after} at ${time}` : `✓ ${r.after} (checked ${time})`)
    : `✗ ${r?.error || 'check failed'}${r?.before ? ' (shows ' + r.before + ')' : ''} — ${time}`;
  await chrome.storage.local.set({ modelStatus: text });
}

async function generate(projectText, status) {
  if (!projectText || !projectText.trim()) throw new Error('No project details received.');
  const settings = await getSettings();

  const tab = await getBidTab(settings, status);
  lastBidTabId = tab.id;
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

// ---------- remote mode: take jobs from the relay server ----------
// B2 (on another PC) posts jobs to the relay; we long-poll /api/next, run them, post the result.

let relayLoopRunning = false;
let relayLastError = '';

const relayBase = (u) => (u || '').trim().replace(/\/+$/, '');

async function relayFetch(settings, path, opts = {}) {
  return fetch(relayBase(settings.relayUrl) + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + settings.relayToken.trim(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}

async function relayLoop() {
  if (relayLoopRunning) return;
  relayLoopRunning = true;
  try {
    while (true) {
      const settings = await getSettings();
      if (!settings.relayUrl || !settings.relayToken) break;
      let res;
      try {
        res = await relayFetch(settings, '/api/next');
      } catch (e) {
        relayLastError = 'Cannot reach relay: ' + (e?.message || e);
        await sleep(5000);
        continue;
      }
      if (res.status === 401) { relayLastError = 'Relay says the token is wrong'; await sleep(15000); continue; }
      if (res.status === 204) { relayLastError = ''; continue; }
      if (!res.ok) { relayLastError = 'Relay error ' + res.status; await sleep(5000); continue; }
      relayLastError = '';
      const job = await res.json();
      const post = (kind, body) => relayFetch(settings, `/api/jobs/${job.id}/${kind}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
      await new Promise((done) => {
        queue = queue.then(() => generate(job.text, (st) => post('status', { status: st }))
          .then((bid) => post('result', { bid }).then(ensureModel))
          .catch((e) => post('result', { error: String(e?.message || e) }))
          .finally(done));
      });
    }
  } finally {
    relayLoopRunning = false;
  }
}

// Keep B1 awake while it serves the relay: Chrome stops an extension's background after ~30 s
// without activity, and then a new job would wait on the relay until the alarm below wakes B1
// (B2 shows "Preparing…" meanwhile). A small extension call every 20 s counts as activity.
setInterval(async () => {
  const { relayUrl, relayToken } = await getSettings();
  if (relayUrl && relayToken) {
    chrome.runtime.getPlatformInfo(() => {});
    relayLoop(); // restarts the loop if it ever stopped
  }
}, 20000);

// The service worker can still be stopped (Chrome restart, crash); the alarm restarts the loop every 30 s.
chrome.alarms.create('relay', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'relay') relayLoop(); });
chrome.runtime.onStartup.addListener(relayLoop);
chrome.runtime.onInstalled.addListener(relayLoop);
chrome.storage.onChanged.addListener((c) => { if (c.relayUrl || c.relayToken) relayLoop(); });
relayLoop();

// popup "Test relay" button
chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg?.type !== 'RELAY_STATUS') return;
  (async () => {
    const settings = await getSettings();
    if (!settings.relayUrl) return sendResponse({ text: 'No pairing code saved (fine if B2 is in this same Chrome).' });
    try {
      const r = await relayFetch(settings, '/api/health');
      if (r.status === 401) return sendResponse({ text: '✗ The pairing code is wrong (token mismatch).' });
      const h = await r.json();
      sendResponse({ text: relayLoopRunning && !relayLastError
        ? '✓ Connected — waiting for bids from B2'
        : '✗ Not connected yet' + (relayLastError ? ': ' + relayLastError : ' — try again in 30 s') });
    } catch (e) {
      sendResponse({ text: '✗ Cannot reach relay: ' + (e?.message || e) });
    }
  })();
  return true;
});
