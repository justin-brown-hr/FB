// B2 background: auto-bid bot + message monitor (MMS).
// Loaded by background.js with importScripts('bot.js').
//
// Both read Freelancer's own API through a pinned "worker" freelancer.com tab
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
  maxAgeMin: 30          // ignore projects posted longer ago than this
};
const getBot = () => chrome.storage.sync.get(BOT_DEFAULTS);
const local = (k) => chrome.storage.local.get(k);
const setLocal = (o) => chrome.storage.local.set(o);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- log (shown in the popup) ----------------
async function log(line) {
  const { botLog = [] } = await local('botLog');
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  botLog.push(`${t}  ${line}`);
  await setLocal({ botLog: botLog.slice(-80) });
}
async function setStatus(part, text) { await setLocal({ ['status_' + part]: text }); }

// ---------------- worker tab ----------------
async function workerTab() {
  const { workerTabId } = await local('workerTabId');
  if (workerTabId) {
    try {
      const t = await chrome.tabs.get(workerTabId);
      if (/^https:\/\/www\.freelancer\./.test(t.url || t.pendingUrl || '')) return t;
    } catch (_) {}
  }
  const t = await chrome.tabs.create({ url: 'https://www.freelancer.com/dashboard', active: false, pinned: true });
  await setLocal({ workerTabId: t.id });
  await tabLoaded(t.id);
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
  for (let i = 0; i < 30; i++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.discarded) { await chrome.tabs.reload(tabId); await tabLoaded(tabId); }
      const r = await chrome.tabs.sendMessage(tabId, { type: 'FBA_PING' });
      if (r?.ok) return r;
    } catch (_) {}
    await wait(1000);
  }
  throw new Error('The Freelancer worker tab does not respond (reload it).');
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
  if (!currency || currency.code === 'USD') return amount;
  const rate = Number(currency.exchange_rate);
  return rate > 0 ? amount * rate : null;
};
const projectUrl = (p) => 'https://www.freelancer.com/projects/' + (p.seo_url || p.id);
const countryOf = (users, id) => {
  const u = users && (users[id] || users[String(id)]);
  return (u && u.location && u.location.country && u.location.country.name) || '';
};
let busy = false;

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
  const r = await api('/api/projects/0.1/projects/active/?limit=50&compact=true&job_details=true&user_details=true&user_country_details=true&full_description=false' + q);
  const projects = (r.result && r.result.projects) || [];
  const users = (r.result && r.result.users) || {};
  const { botSeen = [], botStartedAt = Date.now() } = await local(['botSeen', 'botStartedAt']);
  const seen = new Set(botSeen);
  const skip = cfg.skipCountries.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean);
  const oldest = Math.max(botStartedAt - 10 * 60000, Date.now() - cfg.maxAgeMin * 60000);

  const picked = [];
  let counted = 0;
  for (const p of projects) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    counted++;
    if (p.time_submitted && p.time_submitted * 1000 < oldest) continue;
    const hourly = p.type === 'hourly';
    const max = usd(p.budget && (p.budget.maximum || p.budget.minimum), p.currency);
    const min = hourly ? cfg.minHourlyUsd : cfg.minFixedUsd;
    if (max == null || max <= min) continue;
    const country = countryOf(users, p.owner_id);
    if (country && skip.includes(country.toLowerCase())) continue;
    picked.push({ id: p.id, title: p.title, url: projectUrl(p), hourly, usd: Math.round(max), country });
  }
  await setLocal({ botSeen: [...seen].slice(-3000) });
  await setStatus('find', `${projects.length} active, ${counted} new, ${picked.length} match filters — ${new Date().toLocaleTimeString()}`);
  return picked;
}

// ---------------- bot: bid on one project ----------------
async function bidOn(p, cfg) {
  await log(`Bidding: ${p.title} (${p.hourly ? 'hourly' : 'fixed'} up to $${p.usd}${p.country ? ', ' + p.country : ''})`);
  const t = await workerTab();
  await chrome.tabs.update(t.id, { url: p.url });
  await wait(800);
  await tabLoaded(t.id);
  await tabReady(t.id);
  const skip = cfg.skipCountries.split(',').map((c) => c.trim()).filter(Boolean);
  const r = await chrome.tabs.sendMessage(t.id, {
    type: 'FBA_AUTO_BID',
    opts: { pauseMin: cfg.pauseMin, pauseMax: cfg.pauseMax, skipCountries: skip }
  });
  if (r?.skipped) { await log(`Skipped: ${p.title} — ${r.reason}`); return; }
  const line = r?.ok
    ? `✅ Bid placed${r.sealed ? ' (sealed)' : ''}: ${p.title}\n${[r.profile, r.amount != null ? '$' + r.amount : '', r.days != null ? r.days + ' days' : ''].filter(Boolean).join(' · ')}\n${p.url}`
    : `❌ Bid failed: ${p.title}\n${(r && r.reason) || 'no answer from the page'}\n${p.url}`;
  await tgSend(line);
  await log(line.split('\n').slice(0, 2).join(' — '));
}

// ---------------- main tick ----------------
async function tick() {
  if (busy) return;
  const cfg = await getBot();
  const { tgToken, tgChatId } = await chrome.storage.sync.get({ tgToken: '', tgChatId: '' });
  cfg.mmsOn = cfg.mmsOn && !!(tgToken && tgChatId); // message alerts need Telegram
  if (!cfg.botOn && !cfg.mmsOn) return;
  busy = true;
  try {
    if (cfg.mmsOn) {
      try { await checkMessages(); } catch (e) { await setStatus('mms', '✗ ' + e.message); await log('MMS error: ' + e.message); }
    }
    if (cfg.botOn) {
      let list = [];
      try { list = await findProjects(cfg); } catch (e) { await setStatus('find', '✗ ' + e.message); await log('Project search error: ' + e.message); }
      for (const p of list) {
        if (!(await getBot()).botOn) break; // stopped
        try { await bidOn(p, cfg); } catch (e) { await log(`Error on ${p.title}: ${e.message}`); await tgSend(`❌ Bid failed: ${p.title}\n${e.message}\n${p.url}`); }
        if (cfg.mmsOn) { try { await checkMessages(); } catch (_) {} }
        await wait((cfg.pauseMin + Math.random() * Math.max(0, cfg.pauseMax - cfg.pauseMin)) * 1000);
      }
    }
  } finally {
    busy = false;
  }
}

async function updateBadge() {
  const { botOn } = await getBot();
  chrome.action.setBadgeText({ text: botOn ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1e8e4e' });
}

chrome.alarms.create('fba-bot', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'fba-bot') tick(); });
chrome.storage.onChanged.addListener(async (c, area) => {
  if (area !== 'sync') return;
  if (c.botOn) {
    if (c.botOn.newValue) { await setLocal({ botStartedAt: Date.now() }); await log('Bot started'); tick(); }
    else await log('Bot stopped');
    updateBadge();
  }
  if (c.mmsOn && c.mmsOn.newValue) tick();
});
chrome.runtime.onStartup.addListener(updateBadge);
updateBadge();
