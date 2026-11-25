// B2 content script on freelancer.com project pages.
(() => {
  // A copy left over from before the extension was reloaded can't talk to the extension any more
  // (its chrome.runtime.id is gone). Only skip when a *working* copy is already running.
  const prev = window.__bidAssistantB2;
  if (prev && typeof prev.alive === 'function' && prev.alive()) return;
  document.querySelectorAll('#fba-panel, #fba-alert').forEach((e) => e.remove()); // the dead copy's buttons
  window.__bidAssistantB2 = { alive: () => { try { return !!chrome.runtime.id; } catch (_) { return false; } } };

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

  // Fill the whole bid form from Claude's full reply.
  // success = profile matched + code box found + every field filled.
  async function fillBidForm(reply) {
    const r = P.parseBidResponse(reply);
    const filled = [], problems = [];

    if (!r.bid) problems.push('no code box');
    if (!r.profile) problems.push(r.profileText ? `profile "${r.profileText}" not matched` : 'no Profile line');

    if (r.profile) {
      const err = await selectProfile(r.profile);
      if (err) problems.push('Profile: ' + err); else filled.push(['Profile', r.profile.option]);
    }
    if (r.amount != null) {
      const inp = findAmountInput();
      if (inp) { fillInput(inp, r.amount); filled.push(['Bid amount', '$' + r.amount]); } else problems.push('Bid Amount field not found on the page.');
    } else problems.push('No price in the Profile line.');
    if (r.days != null) {
      const inp = findPeriodInput();
      if (inp) { fillInput(inp, r.days); filled.push(['Delivery', r.days + (r.days === 1 ? ' day' : ' days')]); } else problems.push('Delivery field not found on the page.');
    } else problems.push('No timeline in the Profile line.');

    if (r.bid) {
      const ta = findBidTextarea();
      if (ta) { fillTextarea(ta, r.bid); filled.push(['Proposal', r.bid.length + ' characters']); }
      else { copyText(r.bid).catch(() => {}); problems.push('Proposal box not found — bid copied to clipboard.'); }
      if (r.bid.length < 100) problems.push('Bid is shorter than Freelancer\'s 100-character minimum.');
    } else {
      copyText(reply).catch(() => {});
    }
    return { success: !!(r.profile && r.bid), filled, problems, parsed: r };
  }

  // ---------------- place bid ----------------

  const visible = (el) => !!el && el.offsetParent !== null && getComputedStyle(el).visibility !== 'hidden';

  // The checkbox in the "Optional Upgrades" row whose pill says `name` (e.g. SEALED).
  function findUpgradeCheckbox(name) {
    const want = name.toLowerCase();
    const pills = Array.from(document.querySelectorAll('span, div, label, fl-upgrade-tag, fl-text, button, a'))
      .filter((el) => (el.innerText || '').trim().toLowerCase() === want)
      .sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    for (const pill of pills) {
      let el = pill;
      for (let i = 0; i < 7 && el; i++, el = el.parentElement) {
        const boxes = el.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
        if (boxes.length === 1) return boxes[0];
        if (boxes.length > 1) break; // climbed past this row
      }
    }
    return null;
  }

  const isChecked = (box) => box.checked === true || box.getAttribute('aria-checked') === 'true';

  async function checkBox(box) {
    if (isChecked(box)) return true;
    const label = box.id && document.querySelector(`label[for="${CSS.escape(box.id)}"]`);
    const targets = [box, label, box.closest('label'), box.parentElement].filter(Boolean);
    for (const t of targets) {
      t.click();
      await sleep(300);
      if (isChecked(box)) return true;
    }
    return isChecked(box);
  }

  function findPlaceBidButton() {
    return Array.from(document.querySelectorAll('button, [role="button"], a'))
      .find((b) => /^place bid$/i.test((b.innerText || '').trim()) && visible(b) && !b.closest('#fba-panel, #fba-alert'));
  }

  // pause between clicks: a random time in [min, max] seconds (0 = no pause)
  let pauseRange = [0, 0];
  const pause = () => {
    const [a, b] = pauseRange;
    return b > 0 ? sleep((a + Math.random() * Math.max(0, b - a)) * 1000) : Promise.resolve();
  };

  async function placeBid() {
    const ta = findBidTextarea();
    if (!ta || ta.value.trim().length < 100) return { ok: false, text: 'The proposal box is empty or shorter than 100 characters.' };

    // SEALED is optional: tick it when the project offers it, otherwise just place the bid
    let sealed = false;
    const box = findUpgradeCheckbox('SEALED');
    if (box) {
      await pause();
      sealed = await checkBox(box);
      if (!sealed) return { ok: false, text: 'Could not tick the SEALED option. Nothing was placed.' };
    }

    const btn = findPlaceBidButton();
    if (!btn) return { ok: false, text: 'The Place Bid button was not found.' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, text: 'Place Bid is disabled — check the form for errors.' };
    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await pause();
    btn.click();

    // give Freelancer a moment, then look for a visible error message in the bid form
    await sleep(2500);
    const err = Array.from(document.querySelectorAll('[class*="error" i], [role="alert"], fl-banner-alert'))
      .filter((e) => visible(e) && !e.closest('#fba-alert, #fba-panel') && (e.innerText || '').trim())
      .map((e) => e.innerText.trim())[0];
    if (err) return { ok: false, text: 'Freelancer says: ' + err.slice(0, 200) };
    return { ok: true, sealed, text: sealed ? 'Place Bid clicked with SEALED ticked.' : 'Place Bid clicked (no SEALED option on this project).' };
  }

  // Progress messages from B1 / the relay, reworded without naming the AI.
  function progressText(t) {
    t = (t || '').toLowerCase();
    if (/writing/.test(t)) return 'Writing bid…';
    if (/sending/.test(t)) return 'Sending project…';
    // which preparing step, so a long wait can be traced
    if (/busy with another/.test(t)) return 'Preparing… (B1 is finishing another bid)';
    if (/waiting for b1/.test(t)) return 'Preparing… (waiting for B1 to pick it up)';
    if (/picked up/.test(t)) return 'Preparing… (B1 started)';
    if (/opening/.test(t)) return 'Preparing… (opening the chat)';
    if (/input box/.test(t)) return 'Preparing… (waiting for the chat to be ready)';
    return 'Preparing…';
  }

  // ---------------- UI ----------------

  let panel, writeBtn, bidBtn, busy = false, alertBox;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // One-line toast at the top center. kind: info | ok | err
  // Progress toasts stay until replaced; others hide by themselves (paused while the mouse is over it).
  const HIDE_MS = { info: 4000, ok: 5000, err: 10000, bid: 25000 };
  const MAX_HIDE_MS = 25000;

  function showAlert({ kind = 'info', text, actions = [], autoHide, spinner = false, marquee = false }) {
    if (!alertBox) {
      alertBox = document.createElement('div');
      alertBox.id = 'fba-alert';
      alertBox.addEventListener('mouseenter', () => clearTimeout(alertBox._t));
      alertBox.addEventListener('mouseleave', () => armHide());
      document.body.appendChild(alertBox);
    }
    const icon = spinner ? '<span class="fba-spin"></span>' : '';   // no icon: the color shows success / failure
    alertBox.className = kind;
    alertBox.innerHTML = `${icon}<span class="fba-text" title="${esc(text)}"><span class="fba-inner">${esc(text)}</span></span><span class="fba-actions"></span><button type="button" class="fba-x" title="Close">×</button>`;
    const bar = alertBox.querySelector('.fba-actions');
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = a.label;
      btn.className = 'fba-act';
      if (a.id) btn.id = a.id;
      btn.onclick = () => a.onClick(btn);
      bar.appendChild(btn);
    });
    alertBox.querySelector('.fba-x').onclick = hideAlert;
    alertBox.style.display = '';
    alertBox._hideMs = spinner ? 0 : (autoHide ?? HIDE_MS[kind] ?? 5000);

    // Text longer than one line: cut it with "…", or scroll it sideways when marquee is on.
    const box = alertBox.querySelector('.fba-text');
    const inner = box.firstChild;
    const overflow = inner.scrollWidth - box.clientWidth;
    if (marquee && overflow > 0) {
      const scrollMs = Math.round(overflow / 45 * 1000);      // ~45 px per second
      const total = scrollMs + 3000;                           // 1.5 s pause at each end
      const a = (1500 / total * 100).toFixed(2), b = (100 - 1500 / total * 100).toFixed(2);
      let style = document.getElementById('fba-mq-style');
      if (!style) { style = document.createElement('style'); style.id = 'fba-mq-style'; document.head.appendChild(style); }
      style.textContent = `@keyframes fba-marquee { 0%, ${a}% { transform: translateX(0); } ${b}%, 100% { transform: translateX(-${overflow}px); } }`;
      box.classList.add('fba-marquee');
      inner.style.animationDuration = total + 'ms';
      if (!spinner && autoHide == null) alertBox._hideMs = Math.min(MAX_HIDE_MS, Math.max(alertBox._hideMs, total + 1000)); // one scroll, max 25 s
    }
    armHide();
  }
  function armHide() {
    if (!alertBox) return;
    clearTimeout(alertBox._t);
    if (alertBox._hideMs) alertBox._t = setTimeout(hideAlert, alertBox._hideMs);
  }
  function hideAlert() { if (alertBox) { clearTimeout(alertBox._t); alertBox.style.display = 'none'; } }

  // Claude's reply as a single line (code-box fences removed).
  const oneLine = (t) => (t || '').replace(/```[^\n]*\n?/g, ' ').replace(/\s+/g, ' ').trim();

  function resultAlert(r, reply) {
    if (r.success) {
      // green: profile · budget · timeline (+ a note if a form field could not be set)
      const p = r.parsed;
      const parts = [p.profile.option, p.amount != null ? '$' + p.amount : null, p.days != null ? p.days + (p.days === 1 ? ' day' : ' days') : null].filter(Boolean);
      setBidReady(true);
      showAlert({
        kind: 'ok',
        text: parts.join(' · ') + (r.problems.length ? '  ⚠ ' + r.problems.join(' · ') : ''),
      });
    } else {
      // red alert = failed; the text is just Claude's reply (it explains why)
      showAlert({ kind: 'err', marquee: true, text: oneLine(reply) || r.problems.join(' · ') });
    }
  }

  // The Bid button under Copy project / Write bid: active only when the last Write bid succeeded.
  function setBidReady(on) {
    if (!bidBtn) return;
    bidBtn.disabled = !on;
    bidBtn.textContent = 'Bid';
    bidBtn.title = on ? 'Tick SEALED and click Place Bid' : 'Click Write bid first';
  }

  async function onBidClick() {
    if (bidBtn.disabled) return;
    bidBtn.disabled = true;
    bidBtn.textContent = 'Placing…';
    let r;
    try { r = await placeBid(); } catch (e) { r = { ok: false, text: String(e?.message || e) }; }
    if (r.ok) {
      setBidReady(false);
      showAlert({ kind: 'ok', text: r.sealed ? 'Bid placed (Sealed)' : 'Bid placed' });
    } else {
      setBidReady(true); // let you fix the form and try again
      showAlert({ kind: 'err', text: 'Bid not placed: ' + r.text });
    }
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'fba-panel';
    panel.innerHTML = `
      <div class="fba-btns">
        <button id="fba-copy" type="button">Copy project</button>
        <button id="fba-write" type="button">Write bid</button>
      </div>
      <button id="fba-bid" type="button" disabled>Bid</button>`;
    document.body.appendChild(panel);
    writeBtn = panel.querySelector('#fba-write');
    bidBtn = panel.querySelector('#fba-bid');
    bidBtn.addEventListener('click', onBidClick);
    setBidReady(false);

    panel.querySelector('#fba-copy').addEventListener('click', async () => {
      try {
        await copyText(projectText());
        showAlert({ kind: 'ok', text: 'Project details copied', autoHide: 2000 });
      } catch (e) {
        showAlert({ kind: 'err', text: 'Copy failed: ' + (e?.message || e) });
      }
    });

    writeBtn.addEventListener('click', () => { writeBid(); });
  }

  // Returns { ok, result, reply } or { ok: false, error }.
  function writeBid() {
    if (busy) return Promise.resolve({ ok: false, error: 'Already writing a bid.' });
    let settle;
    const outcome = new Promise((r) => { settle = r; });
    const text = projectText();
    copyText(text).catch(() => {});

    busy = true;
    setBidReady(false);
    writeBtn.disabled = true;
    writeBtn.textContent = 'Writing…';
    showAlert({ text: 'Sending project…', spinner: true });

    let port, gotResult = false;
    const finish = () => {
      busy = false;
      writeBtn.disabled = false;
      writeBtn.textContent = 'Write bid';
      clearInterval(ping);
      try { port && port.disconnect(); } catch (_) {}
    };
    const fail = (msg) => { finish(); showAlert({ kind: 'err', text: 'Failed: ' + msg }); settle({ ok: false, error: msg }); };

    // keep both service workers alive while Claude is writing
    const ping = setInterval(() => { try { port.postMessage({ type: 'PING' }); } catch (_) {} }, 20000);

    try {
      port = chrome.runtime.connect({ name: 'bid' });
    } catch (e) {
      fail('Extension was reloaded — refresh this page and try again.');
      return outcome;
    }

    port.onMessage.addListener((m) => {
      if (m.type === 'STATUS') showAlert({ text: progressText(m.text), spinner: true });
      else if (m.type === 'ERROR') fail(m.error);
      else if (m.type === 'RESULT') {
        gotResult = true;
        fillBidForm(m.bid)
          .then((r) => { finish(); resultAlert(r, m.bid); settle({ ok: true, result: r, reply: m.bid }); })
          .catch((e) => fail('Error while filling the form: ' + (e?.message || e)));
      }
    });
    port.onDisconnect.addListener(() => { if (busy && !gotResult) fail('Connection to B1 was lost.'); });

    port.postMessage({ type: 'GENERATE', text });
    return outcome;
  }

  // ---------------- auto bot (driven by background.js / bot.js) ----------------

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(500); }
    return null;
  }

  function clientCountryOnPage(skip) {
    const box = findLabelEl(/^About the client$/i);
    let el = box;
    for (let i = 0; i < 5 && el && (el.innerText || '').length < 120; i++) el = el.parentElement;
    const text = ((el && el.innerText) || '').toLowerCase();
    return skip.find((c) => c && text.includes(c.toLowerCase())) || null;
  }

  async function autoBid(opts) {
    pauseRange = [Number(opts.pauseMin) || 0, Number(opts.pauseMax) || 0];
    if (!isProjectPage()) return { ok: false, reason: 'Not a project page.' };
    if (!panel) buildPanel();

    const ta = await waitFor(findBidTextarea, 25000);
    if (!ta) return { ok: false, reason: 'No bid form (already bid, project closed, or not allowed).' };
    const badCountry = clientCountryOnPage(opts.skipCountries || []);
    if (badCountry) return { ok: false, skipped: true, reason: 'Client is from ' + badCountry };

    await pause();
    const w = await writeBid();
    if (!w.ok) return { ok: false, reason: w.error };
    const r = w.result;
    if (!r.success) return { ok: false, reason: oneLine(w.reply).slice(0, 300) || r.problems.join(' · ') };

    await pause();
    const placed = await placeBid();
    setBidReady(false);
    const p = r.parsed;
    return {
      ok: placed.ok, reason: placed.ok ? '' : placed.text, sealed: placed.sealed,
      profile: p.profile && p.profile.option, amount: p.amount, days: p.days, title: projectTitle()
    };
  }

  function cookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Same-origin call to Freelancer's own API with this tab's login.
  async function api(path) {
    const uid = cookie('GETAFREE_USER_ID'), hash = cookie('GETAFREE_AUTH_HASH_V2');
    const headers = { Accept: 'application/json' };
    if (uid && hash) headers['freelancer-auth-v2'] = uid + ';' + hash;
    const res = await fetch(path, { credentials: 'include', headers });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.status === 'error') {
      return { ok: false, error: `HTTP ${res.status} ${(body && (body.message || body.error_code)) || ''}`.trim() };
    }
    return { ok: true, result: body.result, userId: uid };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === 'FBA_PING') { sendResponse({ ok: true, url: location.href, loggedIn: !!cookie('GETAFREE_USER_ID') || !!document.querySelector('[href*="/logout"], fl-user-avatar, app-user-avatar') }); return; }
    if (msg?.type === 'FBA_API') { api(msg.path).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message || e) })); return true; }
    if (msg?.type === 'FBA_AUTO_BID') { autoBid(msg.opts || {}).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e?.message || e) })); return true; }
  });

  // ---------------- live feed: Freelancer's real-time notifications (SockJS over WebSocket) ----------------
  // Opened from this freelancer.com tab, like the website does. Started/stopped by bot.js.
  let ws = null, wsCfg = null, wsState = 'off', wsSubscribedAt = 0, wsAuthTimer = null;
  const wsSetState = (st) => { wsState = st; chrome.runtime.sendMessage({ type: 'FBA_WS_STATE_CHANGED', state: st }).catch(() => {}); };
  const wsSend = (o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify([JSON.stringify(o)])); };
  const wsSubscribe = () => {
    clearTimeout(wsAuthTimer);
    wsSend({ channel: 'channels', body: { channels: wsCfg.jobIds } });
    wsSubscribedAt = Date.now();
    wsSetState('live');
  };

  function wsConnect() {
    if (!wsCfg) return;
    const session = Math.random().toString(36).slice(2, 10);
    const server = String(Math.floor(Math.random() * 999)).padStart(3, '0');
    ws = new WebSocket(`wss://notifications.freelancer.com/${server}/${session}/websocket`);
    wsSetState('connecting');
    ws.onmessage = (ev) => {
      const raw = String(ev.data);
      if (raw === 'o') {                    // SockJS open -> log in with this account
        wsSend({ channel: 'auth', body: { hash2: wsCfg.hash2, user_id: wsCfg.userId } });
        wsSetState('authenticating');
        wsAuthTimer = setTimeout(wsSubscribe, 30000); // no OK in time: subscribe anyway
        return;
      }
      if (raw[0] !== 'a') return;           // 'h' = heartbeat
      let list; try { list = JSON.parse(raw.slice(1)); } catch (_) { return; }
      for (const item of list) {
        let m; try { m = JSON.parse(item); } catch (_) { continue; }
        if (m.channel === 'subscribe' && m.body && m.body.body === 'OK') { wsSubscribe(); continue; }
        if (m.channel !== 'user' || !m.body) continue;
        const type = String(m.body.type || '');
        if (type === 'projectSearchActive' && m.body.data && m.body.data.id) {
          if (Date.now() - wsSubscribedAt < 3000) continue; // first batch right after subscribing = not new
          chrome.runtime.sendMessage({ type: 'FBA_WS_PROJECT', data: m.body.data }).catch(() => {});
        } else if (/message|thread|chat/i.test(type)) {
          chrome.runtime.sendMessage({ type: 'FBA_WS_MESSAGE', kind: type }).catch(() => {});
        }
      }
    };
    ws.onclose = () => {
      clearTimeout(wsAuthTimer);
      ws = null;
      if (!wsCfg) { wsSetState('off'); return; }
      wsSetState('reconnecting');
      setTimeout(wsConnect, 5000);
    };
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === 'FBA_WS_STATE') { sendResponse({ state: wsState }); return; }
    if (msg?.type === 'FBA_WS_START') {
      wsCfg = { hash2: msg.hash2, userId: msg.userId, jobIds: msg.jobIds || [] };
      if (ws) { try { ws.close(); } catch (_) {} } else wsConnect();
      sendResponse({ ok: true });
      return;
    }
    if (msg?.type === 'FBA_WS_STOP') {
      wsCfg = null;
      if (ws) { try { ws.close(); } catch (_) {} }
      wsSetState('off');
      sendResponse({ ok: true });
    }
  });

  // Freelancer is a single-page app: show the panel only on project pages.
  function sync() {
    const show = isProjectPage();
    if (show && !panel) buildPanel();
    if (panel) panel.style.display = show ? '' : 'none';
  }
  sync();
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; setBidReady(false); sync(); } }, 800);
})();
