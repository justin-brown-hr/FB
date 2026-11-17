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

  function fillTextarea(ta, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    ta.focus();
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.dispatchEvent(new Event('blur', { bubbles: true }));
    ta.scrollIntoView({ behavior: 'smooth', block: 'center' });
    ta.classList.add('fba-filled');
    setTimeout(() => ta.classList.remove('fba-filled'), 2500);
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

    let port;
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
        const ta = findBidTextarea();
        if (ta) {
          fillTextarea(ta, m.bid);
          done('Bid written ✓  Review it before placing your bid.', 'ok');
        } else {
          copyText(m.bid).catch(() => {});
          done('Bid ready, but the proposal box was not found — bid copied to clipboard.', 'err');
        }
      }
    });
    port.onDisconnect.addListener(() => { if (busy) done('Connection to B1 was lost.', 'err'); });

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
