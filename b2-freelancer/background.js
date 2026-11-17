// B2 background: relays a "write bid" request from the Freelancer page to B1 (Claude extension).
const B1_ID = 'healnpcjminpoeiichodknaejnbjojmp';

chrome.runtime.onConnect.addListener((pagePort) => {
  if (pagePort.name !== 'bid') return;

  let b1;
  try {
    b1 = chrome.runtime.connect(B1_ID, { name: 'bid' });
  } catch (e) {
    pagePort.postMessage({ type: 'ERROR', error: 'B1 (Claude extension) is not installed or disabled.' });
    pagePort.disconnect();
    return;
  }

  let finished = false;
  b1.onMessage.addListener((m) => {
    if (m.type === 'RESULT' || m.type === 'ERROR') finished = true;
    try { pagePort.postMessage(m); } catch (_) {}
  });
  b1.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (!finished) {
      try {
        pagePort.postMessage({
          type: 'ERROR',
          error: err ? 'Cannot reach B1 (Claude extension). Is it installed and enabled?' : 'B1 disconnected unexpectedly.'
        });
      } catch (_) {}
    }
    try { pagePort.disconnect(); } catch (_) {}
  });

  pagePort.onMessage.addListener((m) => { try { b1.postMessage(m); } catch (_) {} });
  pagePort.onDisconnect.addListener(() => { try { b1.disconnect(); } catch (_) {} });
});
