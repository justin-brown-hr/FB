// B2 background: relays requests from the Freelancer page / popup to B1 (Claude extension).
// B1 is found by name, so it works even if its extension ID differs on this PC.
const B1_FIXED_ID = 'healnpcjminpoeiichodknaejnbjojmp';
const B1_NAME = 'Bid Assistant B1';

async function findB1() {
  try {
    const all = await chrome.management.getAll();
    const b1s = all.filter((e) => e.name.startsWith(B1_NAME));
    const on = b1s.find((e) => e.enabled);
    if (on) return { id: on.id };
    if (b1s.length) return { error: 'B1 (Claude extension) is installed but turned off. Enable it in chrome://extensions.' };
    return { error: 'B1 (Claude extension) is not in this Chrome. If B1 runs on a VPS / other PC, paste the pairing code in the B2 popup (click the B2 icon).' };
  } catch (_) {
    return { id: B1_FIXED_ID };
  }
}

// ---------- remote mode: B1 runs on another machine, reached through the relay server ----------

const getRelay = () => chrome.storage.sync.get({ relayUrl: '', relayToken: '' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function relayFetch(relay, path, opts = {}) {
  return fetch(relay.relayUrl.trim().replace(/\/+$/, '') + path, {
    ...opts,
    headers: { Authorization: 'Bearer ' + relay.relayToken.trim(), 'Content-Type': 'application/json' }
  });
}

async function relayJson(relay, path, opts) {
  let res;
  try { res = await relayFetch(relay, path, opts); }
  catch (e) { throw new Error(`Cannot reach the relay at ${relay.relayUrl} (${e?.message || e}). Is the relay server running and the port open?`); }
  if (res.status === 401) throw new Error('The pairing code is wrong (token mismatch). Paste it again in the B2 popup.');
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Relay error ' + res.status);
  return body;
}

// Returns the message handler for this page connection.
function remoteSession(pagePort, relay) {
  let alive = true;
  pagePort.onDisconnect.addListener(() => { alive = false; });
  const post = (m) => { if (alive) { try { pagePort.postMessage(m); } catch (_) {} } };

  return async (msg) => {
    if (msg?.type === 'DIAG') {
      const lines = [`• Remote mode: relay ${relay.relayUrl}`];
      let ok = false;
      try {
        const h = await relayJson(relay, '/api/health');
        lines.push('✓ Relay reachable, token OK');
        if (h.b1Online) { lines.push('✓ B1 on the VPS is connected to the relay'); ok = true; }
        else lines.push('✗ B1 is not connected to the relay. On the VPS: Chrome must be running with B1, with the pairing code saved in the B1 popup.');
      } catch (e) { lines.push('✗ ' + e.message); }
      post({ type: 'DIAG', ok, lines });
      return;
    }
    if (msg?.type !== 'GENERATE') return;
    try {
      const { id } = await relayJson(relay, '/api/jobs', { method: 'POST', body: JSON.stringify({ text: msg.text }) });
      let since = 0;
      while (alive) {
        let j;
        try { j = await relayJson(relay, `/api/jobs/${id}?since=${since}`); }
        catch (e) { if (/Cannot reach/.test(e.message)) { await sleep(3000); continue; } throw e; }
        since = j.version;
        if (j.state === 'done') return post({ type: 'RESULT', bid: j.bid });
        if (j.state === 'error') return post({ type: 'ERROR', error: j.error });
        if (j.status) post({ type: 'STATUS', text: j.status });
      }
    } catch (e) {
      post({ type: 'ERROR', error: e.message });
    }
  };
}

chrome.runtime.onConnect.addListener(async (pagePort) => {
  if (pagePort.name !== 'bid') return;

  // messages can arrive before we know which mode we're in
  const early = [];
  const hold = (m) => early.push(m);
  pagePort.onMessage.addListener(hold);
  const relay = await getRelay();
  pagePort.onMessage.removeListener(hold);

  if (relay.relayUrl && relay.relayToken) {
    const handle = remoteSession(pagePort, relay);
    pagePort.onMessage.addListener(handle);
    early.forEach(handle);
    return;
  }

  // ---------- local mode: B1 is in this same Chrome ----------
  // hold messages from the page until B1 is connected
  const pending = early;
  let b1 = null;
  pagePort.onMessage.addListener((m) => { if (b1) { try { b1.postMessage(m); } catch (_) {} } else pending.push(m); });
  pagePort.onDisconnect.addListener(() => { try { b1 && b1.disconnect(); } catch (_) {} });

  const fail = (error) => {
    try { pagePort.postMessage({ type: 'ERROR', error }); } catch (_) {}
    try { pagePort.disconnect(); } catch (_) {}
  };

  const found = await findB1();
  if (found.error) return fail(found.error);

  try {
    b1 = chrome.runtime.connect(found.id, { name: 'bid' });
  } catch (e) {
    return fail('Cannot reach B1: ' + (e?.message || e));
  }

  let finished = false;
  b1.onMessage.addListener((m) => {
    if (m.type === 'RESULT' || m.type === 'ERROR' || m.type === 'DIAG') finished = true;
    try { pagePort.postMessage(m); } catch (_) {}
  });
  b1.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (!finished) {
      fail(err
        ? `Cannot reach B1 (${err.message}). Reload both extensions in chrome://extensions, then refresh this page.`
        : 'B1 refused the connection. Reload both extensions in chrome://extensions (B1 and B2 must be the same version).');
    } else {
      try { pagePort.disconnect(); } catch (_) {}
    }
  });

  pending.splice(0).forEach((m) => { try { b1.postMessage(m); } catch (_) {} });
});

// ---------------- Telegram ----------------
async function tgSend(text) {
  const { tgToken, tgChatId } = await chrome.storage.sync.get({ tgToken: '', tgChatId: '' });
  if (!tgToken || !tgChatId) return { ok: false, error: 'Telegram is not set up (bot token / chat ID in the B2 popup).' };
  try {
    const r = await (await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: tgChatId, text: text.slice(0, 4000), disable_web_page_preview: true })
    })).json();
    return r.ok ? { ok: true } : { ok: false, error: 'Telegram: ' + (r.description || 'error') };
  } catch (e) {
    return { ok: false, error: 'Telegram: ' + (e.message || e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'TG_SEND') return;
  tgSend(String(msg.text || '')).then(sendResponse);
  return true;
});
