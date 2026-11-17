const DEFAULTS = { chatUrl: '', chatName: 'BID', promptTemplate: '{project}', focusTab: false, timeoutSec: 240 };
const $ = (id) => document.getElementById(id);
const flash = (t) => { $('msg').textContent = t; setTimeout(() => ($('msg').textContent = ''), 2500); };

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('chatUrl').value = s.chatUrl;
  $('chatName').value = s.chatName;
  $('promptTemplate').value = s.promptTemplate;
  $('timeoutSec').value = s.timeoutSec;
  $('focusTab').checked = s.focusTab;
});

$('useCurrent').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://claude.ai/chat/')) $('chatUrl').value = tab.url.split(/[?#]/)[0];
  else flash('Current tab is not a claude.ai chat.');
};

$('save').onclick = async () => {
  await chrome.storage.sync.set({
    chatUrl: $('chatUrl').value.trim(),
    chatName: $('chatName').value.trim() || 'BID',
    promptTemplate: $('promptTemplate').value || '{project}',
    timeoutSec: Math.max(30, Number($('timeoutSec').value) || 240),
    focusTab: $('focusTab').checked
  });
  flash('Saved ✓');
};
