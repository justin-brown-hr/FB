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
    const parts = blocks.length ? blocks : [el];
    const text = parts.map(withFences).join('\n\n');
    return (text || '').trim();
  }

  // innerText of a block, with each code box wrapped in ``` so B2 can tell where it starts and ends.
  // The full response is still returned unchanged otherwise.
  function withFences(block) {
    let text = block.innerText || '';
    block.querySelectorAll('pre').forEach((pre) => {
      const code = (pre.querySelector('code') || pre).innerText.replace(/\n+$/, '');
      if (!code.trim()) return;
      const whole = pre.innerText.replace(/\n+$/, '');
      const target = text.includes(whole) ? whole : code;
      const i = text.indexOf(target);
      if (i >= 0) text = text.slice(0, i) + '```\n' + code + '\n```' + text.slice(i + target.length);
    });
    return text;
  }

  const isLoggedOut = () => /^\/(login|logout|signup)/.test(location.pathname);

  function state() {
    const msgs = assistantMessages();
    return {
      loggedOut: isLoggedOut(),
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

  async function findChatLink(name) {
    const want = name.trim().toLowerCase();
    // 1) sidebar link (only present when the sidebar is open)
    const links = Array.from(document.querySelectorAll('a[href*="/chat/"]'));
    const link = links.find((a) => a.innerText.trim().toLowerCase() === want) ||
                 links.find((a) => a.innerText.trim().toLowerCase().startsWith(want + ' '));
    if (link) return link.href;
    // 2) claude.ai's own chat list (works with the sidebar collapsed or on a small window)
    try {
      const orgs = await (await fetch('/api/organizations', { credentials: 'include' })).json();
      for (const org of Array.isArray(orgs) ? orgs : []) {
        const res = await fetch(`/api/organizations/${org.uuid}/chat_conversations?limit=500`, { credentials: 'include' });
        if (!res.ok) continue;
        const convs = await res.json();
        const list = Array.isArray(convs) ? convs : (convs.data || convs.conversations || []);
        const hit = list.find((c) => (c.name || '').trim().toLowerCase() === want && c.is_starred) ||
                    list.find((c) => (c.name || '').trim().toLowerCase() === want);
        if (hit?.uuid) return `${location.origin}/chat/${hit.uuid}`;
      }
    } catch (_) {}
    return null;
  }

  // Small badge so you can see B1 is active on claude.ai (click to hide it).
  function badge(text, color) {
    let b = document.getElementById('fba-b1-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'fba-b1-badge';
      b.title = 'Bid Assistant B1 is active (click to hide)';
      b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:8px;z-index:2147483000;padding:3px 10px;border-radius:999px;font:600 11px system-ui,sans-serif;color:#fff;cursor:pointer;opacity:.85;box-shadow:0 1px 4px rgba(0,0,0,.3)';
      b.onclick = () => b.remove();
      document.body.appendChild(b);
    }
    b.textContent = text;
    b.style.background = color;
  }
  const ready = () => badge('B1 ready', '#2e7d4f');
  if (!isLoggedOut()) ready();

  // ---------- model check: make sure the chat uses the required model (e.g. "Opus 5.5") ----------
  const MODEL_RX = /\b(opus|sonnet|haiku|fable)\b\s*\d+(?:\.\d+)?/i;
  const normModel = (t) => (t || '').toLowerCase().replace(/\bclaude\b/g, ' ').replace(/\s+/g, ' ').trim();
  const isWanted = (text, want) => {
    const w = normModel(want), t = normModel(text);
    if (!w || !t.includes(w)) return false;
    const after = t.slice(t.indexOf(w) + w.length);
    return !/^[\d.]/.test(after); // "opus 5.5" must not match "opus 5.55"
  };
  const shown = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';

  function findModelButton() {
    const known = document.querySelector('[data-testid="model-selector-dropdown"], [data-testid*="model-selector" i], button[aria-label*="model" i]');
    if (known) return known;
    const input = findInput();
    const scopes = [input && (input.closest('fieldset') || input.closest('form')), document].filter(Boolean);
    for (const scope of scopes) {
      const b = Array.from(scope.querySelectorAll('button, [role="button"], [role="combobox"]'))
        .find((x) => shown(x) && (x.innerText || '').length < 60 && MODEL_RX.test(x.innerText || ''));
      if (b) return b;
    }
    return null;
  }

  const modelName = (btn) => { const m = (btn && btn.innerText || '').match(MODEL_RX); return m ? m[0] : (btn && btn.innerText || '').trim(); };

  // a real-looking click (claude.ai's menus open on pointer down)
  function press(el) {
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
    el.click();
  }
  function hover(el) {
    const o = { bubbles: true, cancelable: true, pointerType: 'mouse', view: window };
    ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove'].forEach((t) =>
      el.dispatchEvent(t.startsWith('pointer') ? new PointerEvent(t, o) : new MouseEvent(t, o)));
  }
  const escape = () => {
    const k = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
    (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', k));
    document.dispatchEvent(new KeyboardEvent('keydown', k));
  };

  function menuItems() {
    return Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], [role="menuitemcheckbox"]')).filter(shown);
  }

  async function ensureModel(want) {
    const btn = findModelButton();
    if (!btn) return { ok: false, error: 'Model button not found on the page.' };
    const before = modelName(btn);
    if (isWanted(btn.innerText, want)) return { ok: true, before, after: before, changed: false };

    press(btn);
    let option = null;
    for (let i = 0; i < 20 && !option; i++) {
      await sleep(150);
      const items = menuItems();
      option = items.filter((x) => isWanted(x.innerText, want)).sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (!option && i === 5) {
        // the model may be in a "More models" sub-menu
        const more = items.find((x) => /more models|other models|more$/i.test((x.innerText || '').trim().split('\n')[0]));
        if (more) {
          hover(more); press(more);
          more.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, bubbles: true }));
        }
      }
    }
    if (!option) { escape(); return { ok: false, before, error: `"${want}" is not in the model menu.` }; }
    hover(option);
    press(option);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      const now = findModelButton();
      if (now && isWanted(now.innerText, want)) { escape(); return { ok: true, before, after: modelName(now), changed: true }; }
    }
    escape();
    const now = findModelButton();
    return { ok: false, before, after: modelName(now), error: 'Clicked the model, but the chat still shows ' + modelName(now) + '.' };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'ENSURE_MODEL':
        ensureModel(msg.want || '').then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true; // async
      case 'PING': sendResponse({ ok: true, url: location.href }); return;
      case 'STATE': sendResponse(state()); return;
      case 'FIND_CHAT_LINK':
        if (isLoggedOut()) { sendResponse({ loggedOut: true }); return; }
        findChatLink(msg.name || 'BID').then((href) => sendResponse({ href }), () => sendResponse({ href: null }));
        return true; // async
      case 'SEND':
        badge('B1: writing bid…', '#d97757');
        setTimeout(() => document.getElementById('fba-b1-badge') && ready(), 120000);
        send(msg.text).then(() => sendResponse({ ok: true }))
          .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
        return true; // async
    }
  });
})();
