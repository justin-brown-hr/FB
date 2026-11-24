// B2 background: auto-bid bot + message monitor (MMS).
// Loaded by background.js with importScripts('bot.js').
//
// Both read Freelancer's own API through an open freelancer.com tab
// (same-origin, uses your login), and report to Telegram via tgSend() from background.js.

const BOT_DEFAULTS = {
  botOn: false,
  mmsOn: true,
  minFixedUsd: 260,
  minHourlyUsd: 16,
  skipCountries: 'India, Pakistan, Bangladesh, Indonesia',
  keywords: '',          // optional search words; empty = all new projects
  pauseMin: 2,           // seconds between actions (random in [min, max])
  pauseMax: 5,
  maxAgeMin: 30,         // ignore projects posted longer ago than this
  checkEverySec: 5,      // timer mode: how often to look for new projects
  detectMode: 'live',    // 'live' = Freelancer's real-time feed (no timer), 'timer' = check every N s
  watchUrl: 'https://www.freelancer.com/search/projects'
};
const getBot = () => chrome.storage.sync.get(BOT_DEFAULTS);
const local = (k) => chrome.storage.local.get(k);
const setLocal = (o) => chrome.storage.local.set(o);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- log (shown in the popup) ----------------
// Log entries older than 1 hour are removed automatically.
const LOG_KEEP_MS = 60 * 60 * 1000;
const freshLog = (list) => (list || []).filter((e) => e && typeof e === 'object' && Date.now() - e.t < LOG_KEEP_MS);

async function log(line) {
  const { botLog = [] } = await local('botLog');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const list = freshLog(botLog);
  list.push({ t: Date.now(), s: `${t}  ${line}` });
  await setLocal({ botLog: list.slice(-500) });
}

async function pruneLog() {
  const { botLog = [] } = await local('botLog');
  const list = freshLog(botLog);
  if (list.length !== botLog.length) await setLocal({ botLog: list });
}
async function setStatus(part, text) { await setLocal({ ['status_' + part]: text }); }

// ---------------- worker tab ----------------
const bidTabs = new Set(); // tabs the bot opened for bidding (never used for API calls)

async function workerTab() {
  const { workerTabId } = await local('workerTabId');
  const ok = (t) => t && !bidTabs.has(t.id) && /^https:\/\/www\.freelancer\./.test(t.url || t.pendingUrl || '');
  if (workerTabId) {
    try { const t = await chrome.tabs.get(workerTabId); if (ok(t)) return t; } catch (_) {}
  }
  const open = (await chrome.tabs.query({ url: 'https://www.freelancer.com/*' })).filter(ok);
  let t = open.find((x) => !x.discarded) || open[0];
  if (!t) {
    t = await chrome.tabs.create({ url: 'https://www.freelancer.com/dashboard', active: false });
    await tabLoaded(t.id);
  }
  await setLocal({ workerTabId: t.id });
  return t;
}

function tabLoaded(tabId, timeout = 45000) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(l); clearTimeout(t); resolve(); };
    const l = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const t = setTimeout(done, timeout);
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.get(tabId).then((tab) => { if (tab.status === 'complete') done(); }).catch(done);
  });
}

async function tabReady(tabId) {
  let injectError = '';
  for (let i = 0; i < 30; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.discarded) { await chrome.tabs.reload(tabId); await tabLoaded(tabId); }
      const r = await chrome.tabs.sendMessage(tabId, { type: 'FBA_PING' });
      if (r?.ok) return r;
    } catch (_) {}
    // no answer: load the page script into the tab ourselves (tab opened before a reload, script blocked, …)
    if (i === 3 || i === 15) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId }, files: ['parse.js', 'content.js'] });
        injectError = '';
      } catch (e) {
        injectError = e.message || String(e);
      }
    }
    await wait(1000);
  }
  // still nothing: say why
  let where = '';
  try {
    const t = await chrome.tabs.get(tabId);
    where = ` Tab: ${t.url || t.pendingUrl || '?'} (${t.status}${t.discarded ? ', discarded' : ''}${t.frozen ? ', frozen' : ''}).`;
  } catch (_) { where = ' The tab was closed.'; }
  throw new Error('The Freelancer tab does not respond.' + where + (injectError ? ' Chrome says: ' + injectError : ' Reload that tab, or check that B2 may run on freelancer.com (chrome://extensions → B2 → Details → Site access).'));
}

async function api(path) {
  const t = await workerTab();
  await tabReady(t.id);
  const r = await chrome.tabs.sendMessage(t.id, { type: 'FBA_API', path });
  if (!r?.ok) throw new Error(`Freelancer API ${path.split('?')[0]}: ${r?.error || 'no answer'}`);
  return r;
}

// ---------------- helpers ----------------
const usd = (amount, currency) => {
  if (amount == null) return null;
  const rate = toUsdRate(currency && currency.code, currency && currency.exchange_rate);
  return rate ? amount * rate : null;
};
const projectUrl = (p) => 'https://www.freelancer.com/projects/' + (p.seo_url || p.id);
const countryOf = (users, id) => {
  const u = users && (users[id] || users[String(id)]);
  return (u && u.location && u.location.country && u.location.country.name) || '';
};
// Two jobs run side by side:
//   checker: finds new projects every 30 s (also while a bid is running) and PUSHES them on a stack
//   bidder:  POPS the newest project from the stack (last in, first out), removes it, bids, repeats
let polling = false, bidding = false;
Object.defineProperty(globalThis, 'busy', { get: () => polling || bidding }); // used by tests

// ---------------- stack (saved, so nothing is lost if the browser restarts) ----------------
// Stack and seen-list updates run one at a time, so projects arriving together can't overwrite each other.
let lockChain = Promise.resolve();
function locked(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.catch(() => {});
  return run;
}

function stackPush(items) { return locked(() => stackPushNow(items)); }
async function stackPushNow(items) {
  if (!items.length) return;
  const { botStack = [] } = await local('botStack');
  const have = new Set(botStack.map((p) => p.id));
  items.slice().sort((x, y) => x.posted - y.posted)        // oldest first, so the newest ends on top
    .forEach((p) => { if (!have.has(p.id)) botStack.push(p); });
  await setLocal({ botStack });
  await log(`Stack +${items.length} → ${botStack.length} waiting`);
}
function stackPop() { return locked(stackPopNow); }
async function stackPopNow() {
  const { botStack = [] } = await local('botStack');
  const p = botStack.pop();            // newest on top
  await setLocal({ botStack });
  return { p, left: botStack.length };
}

// ---------------- MMS: new client messages -> Telegram ----------------
async function checkMessages() {
  const r = await api('/api/messages/0.1/threads/?limit=30&last_message=true&user_details=true&context_details=true');
  const res = r.result || {};
  const threads = res.threads || [];
  const users = res.users || {};
  const { mmsSeen = null, selfId = null } = await local(['mmsSeen', 'selfId']);
  let me = r.userId || selfId;
  if (!me) {
    try { me = (await api('/api/users/0.1/self/')).result.id; await setLocal({ selfId: me }); } catch (_) {}
  }

  const seen = mmsSeen || {};
  const first = !mmsSeen; // first run: remember everything, alert nothing
  const fresh = [];
  for (const th of threads) {
    const msg = th.message || th.last_message || (th.thread && th.thread.message);
    if (!msg || !msg.id) continue;
    const tid = th.id || (th.thread && th.thread.id);
    if (seen[tid] === msg.id) continue;
    seen[tid] = msg.id;
    if (first || String(msg.from_user) === String(me)) continue;
    fresh.push({ th, msg });
  }
  await setLocal({ mmsSeen: seen });

  for (const { th, msg } of fresh) {
    let name = '';
    const u = users[msg.from_user] || users[String(msg.from_user)];
    if (u) name = u.username || u.display_name || '';
    if (!name) {
      try { const ur = await api(`/api/users/0.1/users/?users[]=${msg.from_user}`); const x = (ur.result.users || {})[msg.from_user]; name = (x && x.username) || ''; } catch (_) {}
    }
    if (/recruiter/i.test(name)) { await log(`MMS: skipped message from ${name}`); continue; }

    const ctx = (th.thread && th.thread.context) || th.context || {};
    let title = (th.context_details && th.context_details.title) || '';
    if (!title && ctx.type === 'project' && ctx.id) {
      try { const pr = await api(`/api/projects/0.1/projects/?projects[]=${ctx.id}`); title = ((pr.result.projects || [])[0] || {}).title || ''; } catch (_) {}
    }
    const text = `💬 New message\nProject: ${title || '(no project)'}\nClient: ${name || msg.from_user}\n\n${msg.message || '(attachment)'}`;
    const sent = await tgSend(text);
    await log(`MMS: message from ${name || msg.from_user}${sent.ok ? ' → Telegram' : ' (Telegram failed: ' + sent.error + ')'}`);
  }
  await setStatus('mms', `checked ${threads.length} chats at ${new Date().toLocaleTimeString()}`);
}

// ---------------- bot: find projects ----------------
async function findProjects(cfg) {
  const q = cfg.keywords.trim() ? '&query=' + encodeURIComponent(cfg.keywords.trim()) : '';
  const r = await api('/api/projects/0.1/projects/active/?limit=50&sort_field=time_submitted&reverse_sort=true&compact=true&job_details=true&user_details=true&user_country_details=true&full_description=false' + q);
  const projects = (r.result && r.result.projects) || [];
  const users = (r.result && r.result.users) || {};
  const { botSeen = [], botStartedAt = Date.now(), botBaseline = false } = await local(['botSeen', 'botStartedAt', 'botBaseline']);
  const seen = new Set(botSeen);
  const skip = cfg.skipCountries.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);

  // First check after Start: everything already listed is old — remember it, bid on nothing.
  if (!botBaseline) {
    projects.forEach((p) => seen.add(p.id));
    await setLocal({ botSeen: [...seen].slice(-3000), botBaseline: true });
    await setStatus('find', `watching for new projects (ignoring ${projects.length} already posted) — ${new Date().toLocaleTimeString()}`);
    await log(`Watching for projects posted after ${new Date(botStartedAt).toLocaleTimeString()}`);
    return [];
  }

  const picked = [];
  let counted = 0;
  for (const p of projects) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    // posted before Start (when Freelancer tells us the time) -> old
    if (p.time_submitted && p.time_submitted * 1000 < botStartedAt - 60000) continue;
    counted++;
    const hourly = p.type === 'hourly';
    const b = apiBudget(p);
    const max = b.usdMax;
    const min = hourly ? cfg.minHourlyUsd : cfg.minFixedUsd;
    if (max == null || max <= min) { await log(`Filtered: ${p.title} — budget ${b.text}${hourly ? '/h' : ''} (need over $${min}${hourly ? '/h' : ''})`); continue; }
    const country = countryOf(users, p.owner_id);
    if (country && skip.includes(country.toLowerCase())) { await log(`Filtered: ${p.title} — client from ${country}`); continue; }
    picked.push({ id: p.id, title: p.title, url: projectUrl(p), hourly, usd: Math.round(max), country, posted: p.time_submitted || 0 });
  }
  await setLocal({ botSeen: [...seen].slice(-3000) });
  await setStatus('find', `${counted} new since start, ${picked.length} matched — last check ${new Date().toLocaleTimeString()}`);
  return picked;
}

// ---------------- bot: bid on one project ----------------
async function bidOn(p, cfg) {
  await log(`Bidding: ${p.title} (${p.hourly ? 'hourly' : 'fixed'} up to $${p.usd}${p.country ? ', ' + p.country : ''})`);
  const t = await chrome.tabs.create({ url: p.url, active: false });
  bidTabs.add(t.id);
  let r = null;
  try {
    const skip = cfg.skipCountries.split(',').map((c) => c.trim()).filter(Boolean);
    // Freelancer can reload / redirect the page while it loads, which cuts the connection: retry then.
    for (let attempt = 1; attempt <= 3 && !r; attempt++) {
      await wait(800);
      await tabLoaded(t.id);
      await tabReady(t.id);
      try {
        r = await chrome.tabs.sendMessage(t.id, {
          type: 'FBA_AUTO_BID',
          opts: { pauseMin: cfg.pauseMin, pauseMax: cfg.pauseMax, skipCountries: skip }
        });
      } catch (e) {
        if (!/message channel closed|Receiving end does not exist|port closed/i.test(e.message) || attempt === 3) throw e;
        await log(`Page reloaded during the bid, retrying (${attempt}/2)…`);
        await wait(2000);
      }
    }
  } finally {
    bidTabs.delete(t.id);
    closeTab(t.id);
  }
  if (r?.skipped) { await log(`Skipped: ${p.title} — ${r.reason}`); return; }
  const line = r?.ok
    ? `✅ Bid placed${r.sealed ? ' (sealed)' : ''}: ${p.title}\n${[r.profile, r.amount != null ? '$' + r.amount : '', r.days != null ? r.days + ' days' : ''].filter(Boolean).join(' · ')}\n${p.url}`
    : `❌ Bid failed: ${p.title}\n${(r && r.reason) || 'no answer from the page'}\n${p.url}`;
  await tgSend(line);
  await log(line.split('\n').slice(0, 2).join(' — '));
}

// close the bid tab once the bid is done (success or failure)
function closeTab(id) {
  chrome.tabs.remove(id).catch(() => {});
}

// ---------------- jobs ----------------
async function settings() {
  const cfg = await getBot();
  const { tgToken, tgChatId } = await chrome.storage.sync.get({ tgToken: '', tgChatId: '' });
  cfg.mmsOn = cfg.mmsOn && !!(tgToken && tgChatId); // message alerts need Telegram
  return cfg;
}

// checker: messages + new projects -> stack
async function poll(opts = {}) {
  if (polling) return;
  polling = true;
  try {
    const cfg = await settings();
    const wantProjects = cfg.botOn && (cfg.detectMode === 'timer' || opts.projects);
    if (cfg.mmsOn && (opts.messagesNow || Date.now() - lastMms >= (cfg.detectMode === 'live' ? 55000 : 15000))) {
      lastMms = Date.now();
      try { await checkMessages(); } catch (e) { await setStatus('mms', '✗ ' + e.message); await log('MMS error: ' + e.message); }
    }
    if (wantProjects) {
      try { await stackPush(await findProjects(cfg)); } catch (e) { await setStatus('find', '✗ ' + e.message); await log('Project search error: ' + e.message); }
    }
  } finally {
    polling = false;
  }
}

// bidder: pop newest, bid, repeat until the stack is empty or the bot is stopped
async function work() {
  if (bidding) return;
  bidding = true;
  try {
    while (true) {
      const cfg = await settings();
      if (!cfg.botOn) break;
      const { p, left } = await stackPop();
      if (!p) break;
      await setStatus('stack', `${left} waiting`);
      try { await bidOn(p, cfg); } catch (e) { await log(`Error on ${p.title}: ${e.message}`); await tgSend(`❌ Bid failed: ${p.title}\n${e.message}\n${p.url}`); }
      await wait((cfg.pauseMin + Math.random() * Math.max(0, cfg.pauseMax - cfg.pauseMin)) * 1000);
    }
  } finally {
    bidding = false;
    const { botStack = [] } = await local('botStack');
    await setStatus('stack', `${botStack.length} waiting`);
  }
}

let lastMms = 0;

async function tick() {
  await poll();
  work(); // not awaited: bidding runs while the next checks keep filling the stack
}

// Fast loop: checks every few seconds while the bot (or MMS) is on.
// The 30 s alarm below only restarts this loop if Chrome ever stopped the background worker.
let looping = false;
async function loop() {
  if (looping) return;
  looping = true;
  try {
    while (true) {
      const cfg = await settings();
      if (!cfg.botOn || cfg.detectMode !== 'timer') break; // live mode: no timer for projects
      await tick();
      await wait(Math.max(3, Number(cfg.botOn ? cfg.checkEverySec : 15) || 5) * 1000);
    }
  } finally {
    looping = false;
  }
}

async function updateBadge() {
  const { botOn } = await getBot();
  chrome.action.setBadgeText({ text: botOn ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1e8e4e' });
}

// ---------------- budgets in USD ----------------
// Freelancer's exchange rate converts the project currency to USD (multiply). Fallback if it is missing.
const FALLBACK_TO_USD = {
  USD: 1, AUD: 0.65, CAD: 0.73, EUR: 1.08, GBP: 1.27, NZD: 0.60, SGD: 0.74,
  INR: 0.012, PKR: 0.0036, HKD: 0.13, JPY: 0.0067, CHF: 1.12, SEK: 0.095,
  NOK: 0.092, DKK: 0.145, ZAR: 0.055, MXN: 0.055, BRL: 0.18, PHP: 0.017,
  MYR: 0.22, THB: 0.028, IDR: 0.000063, AED: 0.27, SAR: 0.27
};
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v.replace(/[^\d.]/g, '')) : v; return typeof n === 'number' && isFinite(n) && n > 0 ? n : null; };

function toUsdRate(code, given) {
  code = String(code || 'USD').toUpperCase();
  if (code === 'USD') return 1;
  const r = num(given);
  const fb = FALLBACK_TO_USD[code];
  if (r && fb && (r > fb * 2 || r < fb / 2)) {        // looks like the inverse (USD -> local)
    const inv = 1 / r;
    return inv < fb * 2 && inv > fb / 2 ? inv : fb;
  }
  return r || fb || null;
}

function budgetResult(lo, hi, code, rate) {
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const usd = (n) => (n != null && rate ? n * rate : null);
  const top = hi != null ? hi : lo;                  // always judge by the highest amount
  const text = lo == null && hi == null ? '?' :
    `${lo != null && hi != null && lo !== hi ? fmt(lo) + '–' + fmt(hi) : fmt(top)} ${code}` +
    (code !== 'USD' && rate ? ` ≈ $${lo != null && hi != null && lo !== hi ? fmt(usd(lo)) + '–$' + fmt(usd(hi)) : fmt(usd(top))}` : '');
  return { usdMax: usd(top), text };
}

// project data from the live feed (fields vary: numbers or text)
function liveBudget(d) {
  const cur = d.currency || {};
  const code = String(cur.code || d.currencyCode || 'USD').toUpperCase();
  const his = [d.maxbudget, d.max_budget, d.budget && d.budget.maximum].map(num).filter((n) => n != null);
  const los = [d.minbudget, d.min_budget, d.budget && d.budget.minimum].map(num).filter((n) => n != null);
  const hi = his.length ? Math.max(...his) : null;
  const lo = los.length ? Math.min(...los) : null;
  return budgetResult(lo, hi != null && lo != null && hi < lo ? lo : hi, code, toUsdRate(code, cur.exchangerate != null ? cur.exchangerate : cur.exchange_rate));
}

// project data from Freelancer's projects API
function apiBudget(p) {
  const cur = p.currency || {};
  const code = String(cur.code || 'USD').toUpperCase();
  const bud = p.budget || {};
  return budgetResult(num(bud.minimum), num(bud.maximum), code, toUsdRate(code, cur.exchange_rate));
}

// ---------------- live mode: Freelancer's real-time notification feed ----------------
// The same feed freelancer.com uses for "VIEW NEW PROJECTS": wss://notifications.freelancer.com
// It is opened inside a freelancer.com tab (content.js) with your login, subscribed to your skills,
// and pushes every new project as a "projectSearchActive" message — no timer.
const ISO_COUNTRY = { IN: 'India', PK: 'Pakistan', BD: 'Bangladesh', ID: 'Indonesia', US: 'United States', GB: 'United Kingdom', CA: 'Canada', AU: 'Australia', DE: 'Germany', AE: 'United Arab Emirates', PH: 'Philippines', NG: 'Nigeria', EG: 'Egypt', NP: 'Nepal', LK: 'Sri Lanka' };

async function watchTab(cfg) {
  const want = (cfg.watchUrl || BOT_DEFAULTS.watchUrl).split(/[?#]/)[0].replace(/\/$/, '');
  const { watchTabId } = await local('watchTabId');
  const isWatch = (t) => t && (t.url || t.pendingUrl || '').split(/[?#]/)[0].replace(/\/$/, '') === want;
  if (watchTabId) { try { const t = await chrome.tabs.get(watchTabId); if (isWatch(t)) return t; } catch (_) {} }
  let t = (await chrome.tabs.query({ url: 'https://www.freelancer.com/*' })).find(isWatch);
  if (!t) {
    t = await chrome.tabs.create({ url: cfg.watchUrl || BOT_DEFAULTS.watchUrl, active: false });
    await log('Opened a Freelancer search tab for the live feed (keep it open)');
    await tabLoaded(t.id);
  }
  await setLocal({ watchTabId: t.id });
  return t;
}

async function freelancerAuth() {
  const get = (name) => chrome.cookies.get({ url: 'https://www.freelancer.com', name });
  const [h, u] = await Promise.all([get('GETAFREE_AUTH_HASH_V2'), get('GETAFREE_USER_ID')]);
  if (!h || !u) throw new Error('Not logged in to freelancer.com in this Chrome.');
  return { hash2: decodeURIComponent(h.value), userId: Number(u.value) };
}

// skills to listen to: projectSkills=… in the search URL, else the skills on your profile
async function jobIdsFor(cfg) {
  const m = (cfg.watchUrl || '').match(/[?&]projectSkills=([\d,%C]+)/i);
  if (m) {
    const ids = decodeURIComponent(m[1]).split(',').map(Number).filter(Boolean);
    if (ids.length) return ids;
  }
  const r = await api('/api/users/0.1/self/?jobs=true');
  const ids = ((r.result && r.result.jobs) || []).map((j) => j.id).filter(Boolean);
  if (!ids.length) throw new Error('No skills found: add skills to your profile or put projectSkills=… in the search URL.');
  return ids;
}

let liveState = 'off', liveLastProject = 0, liveStarting = false;

async function liveStatus() {
  const parts = [`live feed: ${liveState}`];
  if (liveLastProject) parts.push(`last new project ${new Date(liveLastProject).toLocaleTimeString()}`);
  await setStatus('find', parts.join(' — '));
}

async function liveMode(cfg) {
  if (liveStarting) return;
  liveStarting = true;
  try {
    const t = await watchTab(cfg);
    await tabReady(t.id);
    const st = await chrome.tabs.sendMessage(t.id, { type: 'FBA_WS_STATE' }).catch(() => null);
    if (st && (st.state === 'live' || st.state === 'connecting' || st.state === 'authenticating')) return;
    const auth = await freelancerAuth();
    const jobIds = await jobIdsFor(cfg);
    await chrome.tabs.sendMessage(t.id, { type: 'FBA_WS_START', ...auth, jobIds });
    await log(`Live feed: connecting (${jobIds.length} skills)`);
  } catch (e) {
    liveState = '✗ ' + e.message;
    await liveStatus();
    await log('Live feed error: ' + e.message);
  } finally {
    liveStarting = false;
  }
}

async function liveStop() {
  const { watchTabId } = await local('watchTabId');
  if (watchTabId) chrome.tabs.sendMessage(watchTabId, { type: 'FBA_WS_STOP' }).catch(() => {});
  liveState = 'off';
}

async function countryOfUser(userId) {
  try {
    const r = await api(`/api/users/0.1/users/?users[]=${userId}&user_details=true&user_location_details=true&compact=true`);
    const u = Object.values((r.result && r.result.users) || {})[0];
    const c = u && u.location && u.location.country;
    return (c && (c.name || ISO_COUNTRY[(c.code || '').toUpperCase()])) || '';
  } catch (_) { return ''; }
}

async function onLiveProject(d) {
  const cfg = await settings();
  if (!cfg.botOn || cfg.detectMode !== 'live' || !d || !d.id) return;
  liveLastProject = Date.now();
  const { botStartedAt = Date.now() } = await local('botStartedAt');
  const isNew = await locked(async () => {
    const { botSeen = [] } = await local('botSeen');
    if (botSeen.includes(d.id)) return false;
    await setLocal({ botSeen: [...botSeen, d.id].slice(-3000) });
    return true;
  });
  if (!isNew) return;
  await liveStatus();
  if (d.time_submitted && d.time_submitted * 1000 < botStartedAt - 60000) return; // posted before Start

  const title = d.title || ('Project ' + d.id);
  const hourly = d.projIsHourly === true || d.projIsHourly === 1 || d.projIsHourly === '1' || /hour/i.test(String(d.type || ''));
  let b = liveBudget(d);
  const min = hourly ? cfg.minHourlyUsd : cfg.minFixedUsd;
  if (b.usdMax == null || b.usdMax <= min) {
    // looks too low (or unreadable): check the project's own data before skipping it
    try {
      const r = await api(`/api/projects/0.1/projects/?projects[]=${d.id}&compact=true`);
      const p = ((r.result && r.result.projects) || [])[0];
      if (p) b = apiBudget(p);
    } catch (_) {}
  }
  const max = b.usdMax;
  if (max == null || max <= min) { await log(`Filtered: ${title} — budget ${b.text}${hourly ? '/h' : ''} (need over $${min}${hourly ? '/h' : ''})`); return; }

  const skip = cfg.skipCountries.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  let country = d.userId ? await countryOfUser(d.userId) : '';
  if (!country) country = ISO_COUNTRY[String((d.currency && d.currency.country) || '').toUpperCase()] || '';
  if (country && skip.includes(country.toLowerCase())) { await log(`Filtered: ${title} — client from ${country}`); return; }

  const seo = String(d.seo_url || d.id);
  const url = seo.startsWith('http') ? seo : 'https://www.freelancer.com/projects/' + seo;
  await stackPush([{ id: d.id, title, url, hourly, usd: Math.round(max), country, posted: d.time_submitted || Math.floor(Date.now() / 1000) }]);
  work();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'FBA_WS_PROJECT') { onLiveProject(msg.data); return; }
  if (msg?.type === 'FBA_WS_STATE_CHANGED') {
    liveState = msg.state;
    liveStatus();
    if (msg.state === 'live') log('Live feed: connected, waiting for new projects');
    return;
  }
  if (msg?.type === 'FBA_WS_MESSAGE') { poll({ messagesNow: true }); return; } // a chat event: check messages now
});

async function heartbeat() {
  pruneLog();
  const cfg = await settings();
  if (cfg.mmsOn) poll(); // messages: backup check (live feed also triggers it on chat events)
  if (!cfg.botOn) return;
  if (cfg.detectMode === 'live') { await liveMode(cfg); work(); } else loop();
}

chrome.alarms.create('fba-bot', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'fba-bot') heartbeat(); });
chrome.storage.onChanged.addListener(async (c, area) => {
  if (area !== 'sync') return;
  if (c.botOn) {
    if (c.botOn.newValue) { await setLocal({ botStartedAt: Date.now(), botBaseline: false, botStack: [] }); await setStatus('stack', '0 waiting'); await log('Bot started'); heartbeat(); }
    else { await log('Bot stopped'); liveStop(); }
    updateBadge();
  }
  if (c.detectMode || c.watchUrl) { await liveStop(); heartbeat(); }
  else if (c.mmsOn && c.mmsOn.newValue) heartbeat();
});
chrome.runtime.onStartup.addListener(() => { updateBadge(); heartbeat(); });
updateBadge();
heartbeat();
