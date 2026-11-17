// B1 content script on claude.ai: low-level primitives used by background.js.
// Selectors have fallbacks because claude.ai changes its markup from time to time.
(() => {
  if (window.__bidAssistantB1) return;
  window.__bidAssistantB1 = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findInput() {
    return (
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[data-testid="chat-input"] [contenteditable="true"]') ||
      document.querySelector('fieldset [contenteditable="true"]') ||
      document.querySelector('div[contenteditable="true"]') ||
      document.querySelector('textarea')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[aria-label="Send message" i]') ||
      document.querySelector('button[aria-label*="Send" i]') ||
      document.querySelector('button[data-testid*="send" i]')
    );
  }

  function isStreaming() {
    if (document.querySelector('[data-is-streaming="true"]')) return true;
    return !!document.querySelector('button[aria-label*="Stop" i]');
  }

  function assistantMessages() {
    let list = document.querySelectorAll('[data-is-streaming]');
    if (!list.length) list = document.querySelectorAll('.font-claude-response, .font-claude-message');
    return Array.from(list);
  }

  function messageText(el) {
    if (!el) return '';
    // Prefer the rendered markdown blocks, skipping thinking / tool panels.
    const blocks = Array.from(el.querySelectorAll('.standard-markdown, .progressive-markdown'))
      .filter((b) => !b.closest('details, [class*="thinking" i], [data-testid*="thinking" i]'))
      .filter((b) => !b.parentElement?.closest('.standard-markdown, .progressive-markdown'));
    const text = blocks.length ? blocks.map((b) => b.innerText).join('\n\n') : el.innerText;
    return (text || '').trim();
  }

  function state() {
    const msgs = assistantMessages();
    return {
      hasInput: !!findInput(),
      streaming: isStreaming(),
      msgCount: msgs.length,
      lastText: messageText(msgs[msgs.length - 1])
    };
  }

  function editorText(el) {
    return (el.value ?? el.innerText ?? '').trim();
  }

  async function insertText(text) {
    const el = findInput();
    if (!el) throw new Error('Claude input box not found.');
    el.focus();

    if (el.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    // clear anything already typed
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // 1) synthetic paste: ProseMirror keeps line breaks properly
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    } catch (_) {}
    await sleep(400);
    const btn = findSendButton();
    if (editorText(el) || (btn && !btn.disabled)) return; // text or a "pasted content" attachment is in

    // 2) fallback: insertText line by line
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (line) document.execCommand('insertText', false, line);
      if (i < lines.length - 1) document.execCommand('insertParagraph', false, null);
    });
    await sleep(200);
    if (!editorText(el)) throw new Error('Could not type into the Claude input box.');
  }

  async function send(text) {
    await insertText(text);
    for (let i = 0; i < 20; i++) {
      const btn = findSendButton();
      if (btn && !btn.disabled) { btn.click(); return; }
      await sleep(250);
    }
    // fallback: press Enter in the editor
    const el = findInput();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }

  function findChatLink(name) {
    const want = name.trim().toLowerCase();
    const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
    const link = links.find((a) => a.innerText.trim().toLowerCase() === want) ||
                 links.find((a) => a.innerText.trim().toLowerCase().startsWith(want + ' '));
    return link ? link.href : null;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'PING': sendResponse({ ok: true, url: location.href }); return;
      case 'STATE': sendResponse(state()); return;
      case 'FIND_CHAT_LINK': sendResponse({ href: findChatLink(msg.name || 'BID') }); return;
      case 'SEND':
        send(msg.text).then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true; // async
    }
  });
})();
