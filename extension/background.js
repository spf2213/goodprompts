// Background worker. It receives the trigger (toolbar icon or shortcut), injects the page
// script into the active tab, and asks the Good Prompts service for the rewrite.
// Nothing runs on any page until the user triggers the extension.

const SERVICE_URL = 'https://www.goodprompts.co/api/rewrite';
const TIMEOUT_MS = 20000;
const MAX_WORDS = 1500;
const SETTINGS_KEYS = ['consent', 'role', 'audience', 'style', 'installId'];

const SITES = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, 'ChatGPT'],
  [/(^|\.)claude\.ai$/, 'Claude'],
  [/(^|\.)gemini\.google\.com$/, 'Gemini'],
  [/(^|\.)perplexity\.ai$/, 'Perplexity'],
  [/(^|\.)manus\.im$/, 'Manus'],
  [/(^|\.)grok\.com$/, 'Grok'],
  [/(^|\.)copilot\.microsoft\.com$/, 'Copilot'],
  [/(^|\.)chat\.deepseek\.com$/, 'DeepSeek'],
  [/(^|\.)meta\.ai$/, 'Meta AI'],
];

function siteName(host = '') {
  const match = SITES.find(([pattern]) => pattern.test(host));
  return match ? match[1] : '';
}

function setBadge(tabId, text) {
  if (tabId == null) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#1c1c1e' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
}

// A random id for this installed copy. It carries no personal information; the service uses it
// only to count each copy's daily free rewrites.
async function installId(settings) {
  if (settings.installId) return settings.installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id == null) return;
  const settings = await chrome.storage.local.get(SETTINGS_KEYS);
  if (!settings.consent) {
    chrome.runtime.openOptionsPage();
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await chrome.tabs.sendMessage(tab.id, { type: 'pr:trigger' });
  } catch (err) {
    // Chrome's own pages, the Web Store and a few others can't be scripted.
    console.warn('Good Prompts cannot run on this page:', err?.message || err);
    setBadge(tab.id, '!');
    setTimeout(() => setBadge(tab.id, ''), 2500);
  }
});

function fail(code, message, status) {
  return { ok: false, code, message, status };
}

async function requestRewrite(message) {
  const settings = await chrome.storage.local.get(SETTINGS_KEYS);
  if (!settings.consent) return fail('no_consent', 'Accept the data notice in the options first.');
  const text = String(message.text ?? '').trim();
  if (!text) return fail('empty', 'There is no text to rewrite.');
  if ((text.match(/\S+/g) || []).length > MAX_WORDS) return fail('too_long', 'The prompt is over 1,500 words.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(SERVICE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        site: siteName(message.host),
        context: { role: settings.role || '', audience: settings.audience || '', style: settings.style || '' },
        installId: await installId(settings),
      }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (payload?.ok && payload.result) return { ok: true, result: payload.result, remaining: payload.remaining };
    return fail(payload?.code || 'server', String(payload?.message || `HTTP ${response.status}`).slice(0, 300), response.status);
  } catch (err) {
    if (err?.name === 'AbortError') return fail('timeout', 'No reply in time.');
    return fail('network', 'Could not reach Good Prompts.');
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'pr:rewrite') return undefined;
  const tabId = sender.tab?.id;
  setBadge(tabId, '…');
  requestRewrite(message)
    .catch(() => fail('unknown', 'Something went wrong. Nothing was changed.'))
    .then((reply) => { setBadge(tabId, ''); sendResponse(reply); });
  return true; // keep the channel open for the async reply
});
