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
    return { error: 'B1 (Claude extension) is not installed in this Chrome profile. Load the b1-claude folder in chrome://extensions.' };
  } catch (_) {
    return { id: B1_FIXED_ID };
  }
}

chrome.runtime.onConnect.addListener(async (pagePort) => {
  if (pagePort.name !== 'bid') return;

  // hold messages from the page until B1 is connected
  const pending = [];
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
