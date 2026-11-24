document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
const $ = (id) => document.getElementById(id);

// "1.2.3.4:8787/TOKEN" or "https://host/TOKEN"  ->  { relayUrl, relayToken }
function parseCode(code) {
  code = code.trim();
  if (!code) return { relayUrl: '', relayToken: '' };
  const m = code.match(/^(https?:\/\/)?([^/\s]+)\/([A-Za-z0-9_-]{8,})\/?$/);
  if (!m) return null;
  return { relayUrl: (m[1] || 'http://') + m[2], relayToken: m[3] };
}
const toCode = (s) => (s.relayUrl && s.relayToken ? `${s.relayUrl.replace(/^http:\/\//, '')}/${s.relayToken}` : '');

chrome.storage.sync.get({ relayUrl: '', relayToken: '' }).then((s) => { $('code').value = toCode(s); });

$('save').onclick = async () => {
  const relay = parseCode($('code').value);
  if (!relay) { $('out').textContent = '✗ That pairing code looks wrong. It should look like 1.2.3.4:8787/abc123…'; return; }
  await chrome.storage.sync.set(relay);
  $('check').click();
};

const out = document.getElementById('out');
const add = (line) => { out.textContent += line + '\n'; };

document.getElementById('check').onclick = async () => {
  out.textContent = '';

  // 1) this tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url || '';
  if (/^https:\/\/(www\.)?freelancer\.[a-z.]+\/projects\/.+/.test(url)) {
    let hasButtons = false;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!document.getElementById('fba-panel') });
      hasButtons = r?.result;
    } catch (_) {}
    add(hasButtons ? '✓ Buttons are on this project page' : '✗ Buttons missing on this page — refresh the page (F5)');
  } else {
    add('• This tab is not a Freelancer project page (open one to see the buttons)');
  }

  // 2) B1 + claude.ai
  add('… checking B1');
  let answered = false;
  const port = chrome.runtime.connect({ name: 'bid' });
  const timer = setTimeout(() => { if (!answered) { add('✗ B1 did not answer — is "Bid Assistant B1 (Claude)" installed and enabled?'); port.disconnect(); } }, 15000);
  port.onMessage.addListener((m) => {
    if (m.type === 'DIAG') { answered = true; clearTimeout(timer); out.textContent = out.textContent.replace('… checking B1\n', ''); m.lines.forEach(add); add(m.ok ? '\nAll good ✓' : ''); port.disconnect(); }
    if (m.type === 'ERROR') { answered = true; clearTimeout(timer); out.textContent = out.textContent.replace('… checking B1\n', ''); add('✗ ' + m.error); }
  });
  port.postMessage({ type: 'DIAG' });
};


// ---------------- Telegram ----------------
chrome.storage.sync.get({ tgToken: '', tgChatId: '' }).then((s) => { $('tgToken').value = s.tgToken; $('tgChat').value = s.tgChatId; });
const tgSay = (t) => { $('tgOut').textContent = t; };

$('tgFind').onclick = async () => {
  const token = $('tgToken').value.trim();
  if (!token) return tgSay('✗ Paste the bot token first.');
  try {
    const r = await (await fetch(`https://api.telegram.org/bot${token}/getUpdates`)).json();
    if (!r.ok) return tgSay('✗ Telegram: ' + (r.description || 'error') + ' (check the token)');
    const chats = r.result.map((u) => (u.message || u.channel_post || u.my_chat_member || {}).chat).filter(Boolean);
    if (!chats.length) return tgSay('✗ No messages yet. Open your bot in Telegram, send it /start, then click Find again.');
    const c = chats[chats.length - 1];
    $('tgChat').value = String(c.id);
    tgSay(`✓ Found: ${c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username} (${c.id})`);
  } catch (e) { tgSay('✗ ' + (e.message || e)); }
};

$('tgSave').onclick = async () => {
  await chrome.storage.sync.set({ tgToken: $('tgToken').value.trim(), tgChatId: $('tgChat').value.trim() });
  tgSay('Sending test…');
  const r = await chrome.runtime.sendMessage({ type: 'TG_SEND', text: '✅ Bid Assistant B2 is connected to Telegram.' });
  tgSay(r?.ok ? '✓ Saved. Test message sent — check Telegram.' : '✗ ' + (r?.error || 'failed'));
};

// ---------------- page capture ----------------
$('capture').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https:\/\/(www\.)?freelancer\./.test(tab?.url || '')) { $('out').textContent = '✗ Open a freelancer.com page first.'; return; }
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const root = document.documentElement.cloneNode(true);
      root.querySelectorAll('script, style, noscript, svg, link, meta, iframe, img, video, canvas').forEach((e) => e.remove());
      root.querySelectorAll('#fba-panel, #fba-alert, #fba-b1-badge').forEach((e) => e.remove());
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n; (n = walker.nextNode());) {
        const t = n.nodeValue.replace(/\s+/g, ' ');
        n.nodeValue = t.length > 120 ? t.slice(0, 120) + '…' : t;
      }
      root.querySelectorAll('*').forEach((e) => {
        for (const a of [...e.attributes]) {
          if (/^(on|style$|srcset$|ng-reflect)/i.test(a.name)) e.removeAttribute(a.name);
          else if (a.value.length > 200) e.setAttribute(a.name, a.value.slice(0, 200) + '…');
        }
      });
      return '<!-- captured ' + location.href + ' -->\n' + root.outerHTML;
    }
  });
  const name = 'freelancer-' + new URL(tab.url).pathname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) + '.html';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([res.result], { type: 'text/html' }));
  a.download = name || 'freelancer-page.html';
  a.click();
  $('out').textContent = `✓ Saved ${a.download} (${Math.round(res.result.length / 1024)} KB) to your Downloads folder.`;
};


// ---------------- auto bot + MMS ----------------
const BOT_DEFAULTS = { botOn: false, mmsOn: true, minFixedUsd: 260, minHourlyUsd: 16, skipCountries: 'India, Pakistan, Bangladesh, Indonesia', keywords: '', pauseMin: 2, pauseMax: 5 };
const botFields = ['minFixedUsd', 'minHourlyUsd', 'pauseMin', 'pauseMax', 'skipCountries', 'keywords'];

function showBot(s) {
  $('botBtn').textContent = s.botOn ? 'Stop bot' : 'Start bot';
  $('botBtn').classList.toggle('on', s.botOn);
  $('mmsOn').checked = s.mmsOn;
}
chrome.storage.sync.get(BOT_DEFAULTS).then((s) => {
  showBot(s);
  botFields.forEach((f) => { $(f).value = s[f]; });
});
$('botBtn').onclick = async () => {
  const { botOn } = await chrome.storage.sync.get(BOT_DEFAULTS);
  await chrome.storage.sync.set({ botOn: !botOn });
  showBot({ ...(await chrome.storage.sync.get(BOT_DEFAULTS)) });
};
$('mmsOn').onchange = () => chrome.storage.sync.set({ mmsOn: $('mmsOn').checked });
$('botSave').onclick = async () => {
  const o = {};
  botFields.forEach((f) => { o[f] = $(f).type === 'number' ? Number($(f).value) || 0 : $(f).value.trim(); });
  if (o.pauseMax < o.pauseMin) o.pauseMax = o.pauseMin;
  await chrome.storage.sync.set(o);
  $('botSave').textContent = 'Saved ✓';
  setTimeout(() => { $('botSave').textContent = 'Save settings'; }, 1500);
};

async function refreshBotInfo() {
  const l = await chrome.storage.local.get(['botLog', 'status_find', 'status_mms']);
  const lines = [];
  if (l.status_find) lines.push('Projects: ' + l.status_find);
  if (l.status_mms) lines.push('Messages: ' + l.status_mms);
  $('botStatus').textContent = lines.join('\n');
  const text = (l.botLog || []).slice().reverse().join('\n');
  if ($('botLog').textContent !== text) $('botLog').textContent = text || '(empty)';
}
refreshBotInfo();
setInterval(refreshBotInfo, 2000);
$('logCopy').onclick = async () => { await navigator.clipboard.writeText($('botLog').textContent); $('logCopy').textContent = 'Copied ✓'; };
$('logClear').onclick = async () => { await chrome.storage.local.set({ botLog: [] }); refreshBotInfo(); };
