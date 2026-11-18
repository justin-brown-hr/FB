document.getElementById('ver').textContent = 'v' + chrome.runtime.getManifest().version;
const DEFAULTS = { chatUrl: '', chatName: 'BID', promptTemplate: '{project}', focusTab: false, timeoutSec: 240, relayUrl: '', relayToken: '' };
const $ = (id) => document.getElementById(id);
const say = (t, color = '#6fcf97') => { $('msg').style.color = color; $('msg').textContent = t; };

// "1.2.3.4:8787/TOKEN" or "https://host/TOKEN"  ->  { relayUrl, relayToken }
function parseCode(code) {
  code = code.trim();
  if (!code) return { relayUrl: '', relayToken: '' };
  const m = code.match(/^(https?:\/\/)?([^/\s]+)\/([A-Za-z0-9_-]{8,})\/?$/);
  if (!m) return null;
  return { relayUrl: (m[1] || 'http://') + m[2], relayToken: m[3] };
}
const toCode = (s) => (s.relayUrl && s.relayToken ? `${s.relayUrl.replace(/^http:\/\//, '')}/${s.relayToken}` : '');

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('code').value = toCode(s);
  $('chatUrl').value = s.chatUrl;
  $('chatName').value = s.chatName;
  $('promptTemplate').value = s.promptTemplate;
  $('timeoutSec').value = s.timeoutSec;
  $('focusTab').checked = s.focusTab;
});

$('useCurrent').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://claude.ai/chat/')) $('chatUrl').value = tab.url.split(/[?#]/)[0];
  else say('Current tab is not a claude.ai chat.', '#eb5757');
};

$('save').onclick = async () => {
  const relay = parseCode($('code').value);
  if (!relay) return say('That pairing code looks wrong. It should look like 1.2.3.4:8787/abc123…', '#eb5757');
  await chrome.storage.sync.set({
    ...relay,
    chatUrl: $('chatUrl').value.trim(),
    chatName: $('chatName').value.trim() || 'BID',
    promptTemplate: $('promptTemplate').value || '{project}',
    timeoutSec: Math.max(30, Number($('timeoutSec').value) || 240),
    focusTab: $('focusTab').checked
  });
  say('Saved ✓');
};

$('test').onclick = async () => {
  say('Testing…', '#9aa0aa');
  const r = await chrome.runtime.sendMessage({ type: 'RELAY_STATUS' });
  const t = r?.text || 'No answer';
  say(t, t.startsWith('✗') ? '#eb5757' : '#6fcf97');
};
