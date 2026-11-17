// B2 content script on freelancer.com project pages.
(() => {
  if (window.__bidAssistantB2) return;
  window.__bidAssistantB2 = true;

  const isProjectPage = () => /^\/projects\/.+/.test(location.pathname);
  const clean = (s) => (s || '').replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // ---------------- scraping ----------------

  function findByOwnText(selector, regex) {
    return Array.from(document.querySelectorAll(selector)).find((el) => regex.test((el.textContent || '').trim()));
  }

  function projectDetailsContainer() {
    const known = document.querySelector(
      'app-project-details-description, .ProjectDescription, [data-qtsb-section="project-details"], fl-project-details'
    );
    if (known && known.innerText.trim().length > 50) return known;

    const heading = findByOwnText('h1,h2,h3,h4,fl-heading,fl-text,div,span', /^Project details$/i);
    if (!heading) return null;
    // climb until we have the full card (description + skills), but not the whole page
    let el = heading;
    for (let i = 0; i < 8 && el.parentElement; i++) {
      el = el.parentElement;
      const t = el.innerText || '';
      if (/Skills Required/i.test(t) || t.length > 400) break;
    }
    return el;
  }

  function projectTitle() {
    const h1 = Array.from(document.querySelectorAll('h1')).find((h) => h.innerText.trim());
    if (h1) return h1.innerText.trim();
    return document.title.replace(/\s*\|\s*Freelancer.*$/i, '').trim();
  }

  function projectSkills(container) {
    const scope = container || document;
    const tags = Array.from(scope.querySelectorAll('a[href*="/jobs/"]'))
      .map((a) => a.innerText.trim())
      .filter((t) => t && t.length < 60);
    return [...new Set(tags)];
  }

  function projectText() {
    const container = projectDetailsContainer();
    const title = projectTitle();
    let details = container ? clean(container.innerText) : '';

    if (!details) {
      // fallback: main page text (trimmed)
      const main = document.querySelector('main') || document.body;
      details = clean(main.innerText).slice(0, 8000);
    }

    // drop the bid form / footer noise if the container grew too large
    details = details.split(/\n(?:Place a bid on this project|Report Project|About the client)\b/i)[0].trim();

    const skills = projectSkills(container);
    const budget = (document.body.innerText.match(/[$€£₹]\s?[\d,.]+\s*[–-]\s*[\d,.]+\s*[A-Z]{3}(?:\s*\/\s*hour)?/) || [])[0];

    const parts = [`Project title: ${title}`, `URL: ${location.href.split(/[?#]/)[0]}`];
    if (budget && !details.includes(budget)) parts.push(`Budget: ${budget}`);
    if (skills.length && !/Skills Required/i.test(details)) parts.push(`Skills: ${skills.join(', ')}`);
    parts.push('', details);
    return parts.join('\n');
  }

  // ---------------- clipboard ----------------

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return; } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  // ---------------- bid textarea ----------------

  function findBidTextarea() {
    return (
      document.querySelector('textarea#descriptionTextArea') ||
      document.querySelector('textarea[placeholder*="best candidate" i]') ||
      document.querySelector('textarea[formcontrolname="description"]') ||
      document.querySelector('app-bid-form textarea, fl-bid-form textarea, .BidForm textarea') ||
      (() => {
        const label = findByOwnText('label,fl-text,div,span', /^Describe your proposal/i);
        let el = label;
        for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
          const ta = el.querySelector && el.querySelector('textarea');
          if (ta) return ta;
        }
        return null;
      })()
    );
  }

  function fire(el, ...types) { types.forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true }))); }

  function flash(el) {
    el.classList.add('fba-filled');
    setTimeout(() => el.classList.remove('fba-filled'), 2500);
  }

  function fillTextarea(ta, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    ta.focus();
    setter.call(ta, text);
    fire(ta, 'input', 'change', 'blur');
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    flash(ta);
  }

  function fillInput(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, String(value));
    fire(input, 'input', 'change', 'blur');
    flash(input);
  }

  // The visible label text (e.g. "Bid Amount") -> the first matching control after it, in the same group.
  function findLabelEl(regex) {
    const cands = Array.from(document.querySelectorAll('label, legend, fl-text, h1, h2, h3, h4, h5, span, div, p'))
      .filter((el) => regex.test((el.innerText || '').trim()) && (el.innerText || '').trim().length < 80);
    // the smallest (innermost) element wins
    return cands.sort((a, b) => a.innerText.length - b.innerText.length || (a.contains(b) ? 1 : -1))[0] || null;
  }

  function controlAfterLabel(regex, selector) {
    const label = findLabelEl(regex);
    if (!label) return null;
    if (label.htmlFor) {
      const byFor = document.getElementById(label.htmlFor);
      if (byFor && byFor.matches(selector)) return byFor;
    }
    let el = label;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      const found = Array.from(el.querySelectorAll(selector))
        .find((c) => label.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (found) return found;
    }
    return null;
  }

  const INPUT = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])';

  function findAmountInput() {
    return document.querySelector('#bidAmountInput, input[name="bidAmount"], input[formcontrolname="amount"], input[formcontrolname="bidAmount"]') ||
      controlAfterLabel(/^(Bid Amount|Your bid|Hourly rate)\b/i, INPUT);
  }

  function findPeriodInput() {
    return document.querySelector('#periodInput, input[name="period"], input[formcontrolname="period"]') ||
      controlAfterLabel(/^(This project will be delivered in|Delivered in|Delivery time)\b/i, INPUT);
  }

  const P = window.FBAParse;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const optMatches = (text, profile) => {
    const t = P.norm(text);
    return t && (t === P.norm(profile.option) || t === P.norm(profile.label) ||
      t.startsWith(P.norm(profile.option) + ' ') || P.matchProfile(text) === profile);
  };

  async function selectProfile(profile) {
    const label = findLabelEl(/^Select a profile\b/i);
    if (!label) return 'profile dropdown not found';

    // native <select>
    const sel = controlAfterLabel(/^Select a profile\b/i, 'select');
    if (sel) {
      const opt = Array.from(sel.options).find((o) => optMatches(o.text, profile));
      if (!opt) return `no "${profile.option}" option in the profile list`;
      sel.value = opt.value;
      opt.selected = true;
      fire(sel, 'input', 'change');
      flash(sel);
      return null;
    }

    // custom dropdown: click the trigger, then click the option
    const trigger = controlAfterLabel(/^Select a profile\b/i,
      '[role="combobox"], [role="button"], button, [aria-haspopup], fl-select, fl-dropdown, .Select, [class*="select" i], [class*="dropdown" i]');
    if (!trigger) return 'profile dropdown not found';
    if (optMatches(trigger.innerText, profile)) return null; // already selected
    trigger.click();
    for (let i = 0; i < 10; i++) {
      await sleep(150);
      const opt = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], li, fl-list-item, button, a, span, div'))
        .filter((o) => o.offsetParent !== null && !trigger.contains(o) && o.innerText && o.innerText.trim().length < 80 && optMatches(o.innerText.trim(), profile))
        .sort((a, b) => a.innerText.length - b.innerText.length)[0];
      if (opt) { opt.click(); flash(trigger); return null; }
    }
    document.body.click(); // close it again
    return `no "${profile.option}" option in the profile list`;
  }

  // Fill the whole bid form from Claude's full reply. Returns a status summary.
  async function fillBidForm(reply) {
    const r = P.parseBidResponse(reply);
    const done = [], missed = [];

    if (r.profile) {
      const err = await selectProfile(r.profile);
      if (err) missed.push(err); else done.push(r.profile.option);
    } else {
      missed.push(r.profileText ? `profile "${r.profileText}" not matched — skipped` : 'no profile in reply — skipped');
    }

    if (r.amount != null) {
      const inp = findAmountInput();
      if (inp) { fillInput(inp, r.amount); done.push('$' + r.amount); } else missed.push('Bid Amount field not found');
    } else missed.push('no price in reply');

    if (r.days != null) {
      const inp = findPeriodInput();
      if (inp) { fillInput(inp, r.days); done.push(r.days + (r.days === 1 ? ' day' : ' days')); } else missed.push('delivery field not found');
    } else missed.push('no timeline in reply');

    const ta = findBidTextarea();
    if (ta && r.bid) { fillTextarea(ta, r.bid); done.unshift('bid text'); }
    else if (r.bid) { copyText(r.bid).catch(() => {}); missed.unshift('proposal box not found — bid copied to clipboard'); }
    else missed.unshift('no bid text in reply');

    return { ok: !!(ta && r.bid), text: (done.length ? 'Filled: ' + done.join(' · ') : '') + (missed.length ? `\n⚠ ${missed.join('; ')}` : '') };
  }

  // ---------------- UI ----------------

  let panel, statusEl, writeBtn, busy = false;

  function setStatus(text, kind = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = kind;
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'fba-panel';
    panel.innerHTML = `
      <div id="fba-status"></div>
      <div class="fba-btns">
        <button id="fba-copy" type="button">Copy project</button>
        <button id="fba-write" type="button">Write bid</button>
      </div>`;
    document.body.appendChild(panel);
    statusEl = panel.querySelector('#fba-status');
    writeBtn = panel.querySelector('#fba-write');

    panel.querySelector('#fba-copy').addEventListener('click', async () => {
      try {
        await copyText(projectText());
        setStatus('Project details copied to clipboard ✓', 'ok');
      } catch (e) {
        setStatus('Copy failed: ' + (e?.message || e), 'err');
      }
      setTimeout(() => !busy && setStatus(''), 3000);
    });

    writeBtn.addEventListener('click', writeBid);
  }

  async function writeBid() {
    if (busy) return;
    const text = projectText();
    try { await copyText(text); } catch (_) {}

    busy = true;
    writeBtn.disabled = true;
    writeBtn.textContent = 'Writing…';
    setStatus('Sending project to Claude (B1)…');

    let port, gotResult = false;
    const done = (msg, kind) => {
      busy = false;
      writeBtn.disabled = false;
      writeBtn.textContent = 'Write bid';
      clearInterval(ping);
      setStatus(msg, kind);
      try { port && port.disconnect(); } catch (_) {}
    };

    // keep both service workers alive while Claude is writing
    const ping = setInterval(() => { try { port.postMessage({ type: 'PING' }); } catch (_) {} }, 20000);

    try {
      port = chrome.runtime.connect({ name: 'bid' });
    } catch (e) {
      done('Extension was reloaded — refresh this page and try again.', 'err');
      return;
    }

    port.onMessage.addListener((m) => {
      if (m.type === 'STATUS') setStatus(m.text);
      else if (m.type === 'ERROR') done('Error: ' + m.error, 'err');
      else if (m.type === 'RESULT') {
        gotResult = true;
        fillBidForm(m.bid)
          .then((r) => done(r.text + (r.ok ? '\nReview it before placing your bid.' : ''), r.ok ? 'ok' : 'err'))
          .catch((e) => done('Error while filling the form: ' + (e?.message || e), 'err'));
      }
    });
    port.onDisconnect.addListener(() => { if (busy && !gotResult) done('Connection to B1 was lost.', 'err'); });

    port.postMessage({ type: 'GENERATE', text });
  }

  // Freelancer is a single-page app: show the panel only on project pages.
  function sync() {
    const show = isProjectPage();
    if (show && !panel) buildPanel();
    if (panel) panel.style.display = show ? '' : 'none';
  }
  sync();
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; sync(); } }, 800);
})();
