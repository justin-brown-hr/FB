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

  // Fill the whole bid form from Claude's full reply.
  // success = profile matched + code box found + every field filled.
  async function fillBidForm(reply) {
    const r = P.parseBidResponse(reply);
    const filled = [], problems = [];

    if (!r.bid) problems.push('No code box (bid) in Claude\'s reply. The full reply was copied to your clipboard.');
    if (!r.profile) problems.push(r.profileText ? `Profile "${r.profileText}" does not match any of your profiles.` : 'No "Profile:" line in Claude\'s reply.');

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
    return { success: problems.length === 0, filled, problems };
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

  async function placeBid() {
    const ta = findBidTextarea();
    if (!ta || ta.value.trim().length < 100) return { ok: false, text: 'The proposal box is empty or shorter than 100 characters.' };

    const box = findUpgradeCheckbox('SEALED');
    if (!box) return { ok: false, text: 'Could not find the SEALED option. Nothing was placed.' };
    if (!(await checkBox(box))) return { ok: false, text: 'Could not tick the SEALED option. Nothing was placed.' };

    const btn = findPlaceBidButton();
    if (!btn) return { ok: false, text: 'SEALED is ticked, but the Place Bid button was not found.' };
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return { ok: false, text: 'SEALED is ticked, but Place Bid is disabled — check the form for errors.' };
    btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    btn.click();

    // give Freelancer a moment, then look for a visible error message in the bid form
    await sleep(2500);
    const err = Array.from(document.querySelectorAll('[class*="error" i], [role="alert"], fl-banner-alert'))
      .filter((e) => visible(e) && !e.closest('#fba-alert, #fba-panel') && (e.innerText || '').trim())
      .map((e) => e.innerText.trim())[0];
    if (err) return { ok: false, text: 'Freelancer says: ' + err.slice(0, 200) };
    return { ok: true, text: 'Place Bid clicked with SEALED ticked.' };
  }

  // ---------------- UI ----------------

  let panel, writeBtn, busy = false, alertBox;
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Alert card in the middle of the screen. kind: info | ok | err
  function showAlert({ kind = 'info', title, html = '', actions = [], autoHide = 0, spinner = false }) {
    if (!alertBox) {
      alertBox = document.createElement('div');
      alertBox.id = 'fba-alert';
      document.body.appendChild(alertBox);
    }
    clearTimeout(alertBox._t);
    alertBox.className = kind;
    alertBox.innerHTML = `
      <div class="fba-title">${spinner ? '<span class="fba-spin"></span>' : ''}${esc(title)}</div>
      ${html ? `<div class="fba-body">${html}</div>` : ''}
      <div class="fba-actions"></div>`;
    const bar = alertBox.querySelector('.fba-actions');
    [...actions, ...(spinner ? [] : [{ label: 'Close', onClick: hideAlert }])].forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.className = a.primary ? 'primary' : '';
      if (a.id) b.id = a.id;
      b.onclick = () => a.onClick(b);
      bar.appendChild(b);
    });
    alertBox.style.display = '';
    if (autoHide) alertBox._t = setTimeout(hideAlert, autoHide);
  }
  function hideAlert() { if (alertBox) alertBox.style.display = 'none'; }

  function resultAlert(r) {
    const rows = r.filled.map(([k, v]) => `<div class="fba-row"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
    if (r.success) {
      showAlert({
        kind: 'ok', title: 'Success — bid is ready',
        html: rows + '<div class="fba-note">Clicking <b>Bid</b> ticks SEALED and clicks Place Bid.</div>',
        actions: [{ label: 'Bid', primary: true, id: 'fba-bid', onClick: onBidClick }]
      });
    } else {
      showAlert({
        kind: 'err', title: 'Failed — bid not ready',
        html: `<ul>${r.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` + (rows ? `<div class="fba-sub">Filled anyway:</div>${rows}` : '') +
          '<div class="fba-note">Check the form and place the bid yourself if you want to.</div>'
      });
    }
  }

  async function onBidClick(btn) {
    btn.disabled = true;
    btn.textContent = 'Placing…';
    let r;
    try { r = await placeBid(); } catch (e) { r = { ok: false, text: String(e?.message || e) }; }
    showAlert(r.ok
      ? { kind: 'ok', title: 'Bid placed ✓', html: esc(r.text), autoHide: 6000 }
      : { kind: 'err', title: 'Bid not placed', html: esc(r.text) });
  }

  function buildPanel() {
    panel = document.createElement('div');
    panel.id = 'fba-panel';
    panel.innerHTML = `
      <div class="fba-btns">
        <button id="fba-copy" type="button">Copy project</button>
        <button id="fba-write" type="button">Write bid</button>
      </div>`;
    document.body.appendChild(panel);
    writeBtn = panel.querySelector('#fba-write');

    panel.querySelector('#fba-copy').addEventListener('click', async () => {
      try {
        await copyText(projectText());
        showAlert({ kind: 'ok', title: 'Project details copied ✓', autoHide: 2000 });
      } catch (e) {
        showAlert({ kind: 'err', title: 'Copy failed', html: esc(e?.message || e) });
      }
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
    showAlert({ title: 'Sending project to Claude…', spinner: true });

    let port, gotResult = false;
    const finish = () => {
      busy = false;
      writeBtn.disabled = false;
      writeBtn.textContent = 'Write bid';
      clearInterval(ping);
      try { port && port.disconnect(); } catch (_) {}
    };
    const fail = (msg) => { finish(); showAlert({ kind: 'err', title: 'Failed', html: esc(msg) }); };

    // keep both service workers alive while Claude is writing
    const ping = setInterval(() => { try { port.postMessage({ type: 'PING' }); } catch (_) {} }, 20000);

    try {
      port = chrome.runtime.connect({ name: 'bid' });
    } catch (e) {
      fail('Extension was reloaded — refresh this page and try again.');
      return;
    }

    port.onMessage.addListener((m) => {
      if (m.type === 'STATUS') showAlert({ title: m.text, spinner: true });
      else if (m.type === 'ERROR') fail(m.error);
      else if (m.type === 'RESULT') {
        gotResult = true;
        fillBidForm(m.bid)
          .then((r) => { finish(); resultAlert(r); })
          .catch((e) => fail('Error while filling the form: ' + (e?.message || e)));
      }
    });
    port.onDisconnect.addListener(() => { if (busy && !gotResult) fail('Connection to B1 was lost.'); });

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
