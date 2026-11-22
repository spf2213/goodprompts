// Page script. The background worker injects it into the active tab when the
// user triggers the extension; it never runs on a page before that.
//
// It finds the focused text box, reads it, asks the background worker for a
// rewrite, writes the result back and shows a toast. It never presses send.

(() => {
  'use strict';

  // Injected again on every trigger. Keep one live copy per page, and replace
  // a copy orphaned by an extension reload.
  try {
    if (globalThis.__promptRewriter?.alive()) return;
  } catch {
    /* stale copy: fall through and start fresh */
  }

  const TOAST_MS = 8000;
  const state = { busy: false, last: null };
  globalThis.__promptRewriter = { alive: () => Boolean(chrome.runtime?.id) };

  // Fallbacks for when no text box holds the focus or the selection.
  // Best guesses: they have not been checked against the live sites.
  const SITE_SELECTORS = {
    'chatgpt.com': ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
    'chat.openai.com': ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]'],
    'claude.ai': ['div.ProseMirror[contenteditable="true"]'],
    'gemini.google.com': ['rich-textarea .ql-editor', '.ql-editor[contenteditable="true"]'],
  };
  const GENERIC_SELECTOR =
    'textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]';

  const clean = (s) => String(s).replace(/ /g, ' ').replace(/\r\n?/g, '\n');
  const norm = (s) => clean(s).replace(/\s+/g, ' ').trim();
  const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // ---------- finding the text box ----------

  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  function isTextControl(el) {
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
    if (el instanceof HTMLInputElement) {
      return ['text', 'search'].includes(el.type) && !el.disabled && !el.readOnly;
    }
    return false;
  }

  function editingHost(el) {
    if (!el?.isContentEditable) return null;
    let host = el;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return host;
  }

  function asField(el) {
    if (!el) return null;
    if (isTextControl(el)) return { kind: 'control', el };
    const host = editingHost(el);
    return host ? { kind: 'rich', el: host } : null;
  }

  function isVisible(el) {
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== 'hidden';
  }

  function findField() {
    const focused = asField(deepActiveElement());
    if (focused) return focused;

    const anchor = getSelection()?.anchorNode;
    const selected = asField(anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement);
    if (selected) return selected;

    const host = location.hostname.replace(/^www\./, '');
    for (const selector of SITE_SELECTORS[host] || []) {
      const el = document.querySelector(selector);
      const field = el && isVisible(el) ? asField(el) : null;
      if (field) return field;
    }

    const candidates = [...document.querySelectorAll(GENERIC_SELECTOR)]
      .filter(isVisible)
      .map(asField)
      .filter(Boolean);
    const filled = candidates.filter((field) => readAll(field).trim());
    if (filled.length === 1) return filled[0];
    return candidates.length === 1 ? candidates[0] : null;
  }

  // ---------- reading ----------

  // innerText puts a blank line between <p> blocks. Fold that back to one line
  // break per paragraph, so text read here can be written back unchanged.
  function foldParagraphs(root, text) {
    return root.querySelector('p') ? text.replace(/\n\n/g, '\n') : text;
  }

  function readAll(field) {
    if (field.kind === 'control') return field.el.value;
    return foldParagraphs(field.el, clean(field.el.innerText || '')).replace(/\n+$/, '');
  }

  function readSelection(field) {
    if (field.kind === 'control') {
      const { selectionStart: start, selectionEnd: end, value } = field.el;
      if (start == null || end == null || end <= start) return null;
      return { text: value.slice(start, end), start, end };
    }
    const selection = getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0);
    if (!field.el.contains(range.commonAncestorContainer)) return null;
    const text = foldParagraphs(field.el, clean(selection.toString()));
    return text.trim() ? { text, range: range.cloneRange() } : null;
  }

  // ---------- writing ----------

  // Poll briefly instead of sleeping, so a write is confirmed the moment it
  // lands and anything the user types next is never mistaken for a failure.
  async function settles(landed, ms = 150) {
    const end = Date.now() + ms;
    for (;;) {
      const after = landed();
      if (after !== null) return after;
      if (Date.now() >= end) return null;
      await tick(15);
    }
  }

  // Some editors redraw from their own state a moment later and silently drop
  // an outside change. A write only counts if the old text has not come back.
  // (Checking for the old text, not for an exact match, keeps anything the
  // user types in that moment from reading as a failure.)
  async function sticks(field, before, after) {
    await tick(60);
    return !(before !== after && norm(readAll(field)) === before);
  }

  // Each write returns the box's full text once the write has landed and
  // stuck, or null when it did not.
  async function writeControl(field, text, selection) {
    const el = field.el;
    const before = el.value;
    const start = selection ? selection.start : 0;
    const end = selection ? selection.end : before.length;
    const value = before.slice(0, start) + text + before.slice(end);
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;

    el.focus();
    // The native setter plus an input event is what frameworks such as React
    // need in order to register a value they did not set themselves.
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    try {
      el.setSelectionRange(start + text.length, start + text.length);
    } catch {
      /* some input types have no selection */
    }
    if (el.value !== value) return null;
    const after = norm(value);
    return (await sticks(field, norm(before), after)) ? after : null;
  }

  async function writeRich(field, text, selection) {
    const el = field.el;
    const whole = !selection;
    const before = norm(readAll(field));
    const wanted = norm(text);
    const landed = () => {
      const now = norm(readAll(field));
      if (whole) return now === wanted ? now : null;
      return now !== before && now.includes(wanted) ? now : null;
    };
    const placeSelection = async () => {
      el.focus();
      const sel = getSelection();
      sel.removeAllRanges();
      if (whole) {
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
      } else {
        sel.addRange(selection.range);
      }
      await tick(30); // editors pick up the DOM selection asynchronously
    };

    // First the paste path: ProseMirror, Lexical and Quill each handle a
    // paste event themselves and keep their own state in step.
    await placeSelection();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const unhandled = el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
    if (!unhandled) {
      const after = await settles(landed);
      if (after !== null && (await sticks(field, before, after))) return after;
      if (!whole) return null; // the saved range is no longer trustworthy
      await placeSelection();
    }

    // Then plain insertion, for editable regions with no paste handling.
    document.execCommand('insertText', false, text);
    const after = await settles(landed);
    return after !== null && (await sticks(field, before, after)) ? after : null;
  }

  async function write(field, text, selection) {
    if (!field.el.isConnected) return null;
    try {
      return await (field.kind === 'control' ? writeControl(field, text, selection) : writeRich(field, text, selection));
    } catch {
      return null;
    }
  }

  function selectBlank(field, blank) {
    try {
      if (field.kind === 'control') {
        const at = field.el.value.indexOf(blank);
        if (at >= 0) field.el.setSelectionRange(at, at + blank.length);
        return;
      }
      const walker = document.createTreeWalker(field.el, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.nodeValue.indexOf(blank);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + blank.length);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
    } catch {
      /* selecting the blank is a nicety */
    }
  }

  async function copyText(text, refocus) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* needs page focus; fall through */
    }
    try {
      const scratch = document.createElement('textarea');
      scratch.value = text;
      scratch.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.documentElement.appendChild(scratch);
      scratch.select();
      const copied = document.execCommand('copy');
      scratch.remove();
      refocus?.focus();
      return copied;
    } catch {
      return false;
    }
  }

  // ---------- toast ----------
  // Styled through the CSSOM only, so a strict page CSP cannot block it.

  let toastParts = null;
  let toastTimer = 0;

  function ensureToast() {
    if (toastParts?.host.isConnected) return toastParts;
    const host = document.createElement('div');
    host.setAttribute('data-prompt-rewriter', '');
    const root = host.attachShadow({ mode: 'open' });

    const box = document.createElement('div');
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    Object.assign(box.style, {
      position: 'fixed',
      right: '20px',
      bottom: '20px',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      maxWidth: '360px',
      padding: '10px 14px',
      borderRadius: '10px',
      background: '#1c1c1e',
      color: '#f5f5f7',
      font: "13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif",
      boxShadow: '0 6px 24px rgba(0, 0, 0, 0.28)',
      transition: 'opacity 0.15s ease',
      opacity: '0',
      pointerEvents: 'none',
    });

    const label = document.createElement('span');
    const button = document.createElement('button');
    button.type = 'button';
    button.hidden = true;
    Object.assign(button.style, {
      all: 'unset',
      cursor: 'pointer',
      fontWeight: '600',
      color: '#8ab4ff',
      whiteSpace: 'nowrap',
    });

    box.append(label, button);
    root.appendChild(box);
    document.documentElement.appendChild(host);
    toastParts = { host, box, label, button };
    return toastParts;
  }

  function hideToast() {
    clearTimeout(toastTimer);
    if (!toastParts) return;
    toastParts.box.style.opacity = '0';
    toastParts.box.style.pointerEvents = 'none';
  }

  function toast(message, { sticky = false, action = null } = {}) {
    const { box, label, button } = ensureToast();
    clearTimeout(toastTimer);
    label.textContent = message;
    button.hidden = !action;
    button.style.display = action ? '' : 'none';
    button.onclick = null;
    if (action) {
      button.textContent = action.label;
      button.onclick = () => {
        hideToast();
        action.run();
      };
    }
    box.style.opacity = '1';
    box.style.pointerEvents = 'auto';
    if (!sticky) toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  // ---------- the trigger ----------

  function summary(result) {
    const parts = ['Rewritten.'];
    if (result.guesses?.length) parts.push(`Guessed: ${result.guesses.join(', ')}.`);
    if (result.blanks === 1) parts.push('1 blank to fill.');
    if (result.blanks > 1) parts.push(`${result.blanks} blanks to fill.`);
    return parts.join(' ');
  }

  function errorText(reply) {
    const detail = String(reply?.message || 'unknown error').slice(0, 160);
    switch (reply?.code) {
      case 'too_long':
        return 'That is over 1,500 words. Select the instruction part and try again.';
      case 'empty':
        return 'Click into your prompt first.';
      case 'no_consent':
        return 'Finish setup in the extension options first.';
      case 'timeout':
        return 'No reply in time. Nothing changed. Try again.';
      case 'rate_limit':
        return `${detail} Nothing changed.`;
      case 'busy':
        return 'Good Prompts is busy. Nothing changed. Try again in a moment.';
      case 'not_ready':
        return 'Good Prompts is not available right now. Nothing changed.';
      case 'refused':
        return 'This prompt could not be rewritten. Nothing changed.';
      case 'network':
        return 'Could not reach Good Prompts. Nothing changed.';
      default:
        return `Couldn't rewrite. ${detail}`;
    }
  }

  async function undo() {
    const last = state.last;
    if (!last) return;
    state.last = null;
    if ((await write(last.field, last.original, null)) !== null) {
      toast('Original restored.');
    } else if (await copyText(last.original, last.field.el)) {
      toast('Could not restore it here. Original copied: paste to restore.');
    } else {
      toast('Could not restore the original.');
    }
  }

  async function trigger() {
    if (state.busy) return;

    const field = findField();
    if (!field) {
      toast('Click into your prompt first.');
      return;
    }
    const full = readAll(field);

    // A second trigger on an untouched rewrite is an undo.
    if (state.last && state.last.field.el === field.el && norm(full) === state.last.after) {
      await undo();
      return;
    }
    if (!full.trim()) {
      toast('Click into your prompt first.');
      return;
    }

    const picked = readSelection(field);
    const selection = picked && norm(picked.text) !== norm(full) ? picked : null;
    const draft = selection ? selection.text : full;

    state.busy = true;
    toast('Rewriting…', { sticky: true });
    try {
      let reply;
      try {
        reply = await chrome.runtime.sendMessage({ type: 'pr:rewrite', text: draft, host: location.hostname });
      } catch (err) {
        reply = { ok: false, code: 'unknown', message: String(err?.message || err) };
      }
      if (!reply?.ok) {
        toast(errorText(reply));
        return;
      }

      const result = reply.result;
      if (result.verdict !== 'rewritten') {
        toast('Already clear. Nothing changed.');
        return;
      }

      // Never overwrite something typed while the rewrite was in flight.
      if (norm(readAll(field)) !== norm(full)) {
        const copied = await copyText(result.text, field.el);
        toast(
          copied
            ? 'The text changed while I worked. Rewrite copied: paste to use it.'
            : 'The text changed while I worked. Nothing was replaced.',
        );
        return;
      }

      const after = await write(field, result.text, selection);
      if (after === null) {
        const copied = await copyText(result.text, field.el);
        toast(
          copied
            ? 'Could not write into this box. Rewrite copied: paste to replace.'
            : 'Could not write into this box.',
        );
        return;
      }

      state.last = { field, original: full, after };
      if (result.blankList?.length) selectBlank(field, result.blankList[0]);
      toast(summary(result), { action: { label: 'Undo', run: undo } });
    } finally {
      state.busy = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'pr:trigger') return undefined;
    trigger().catch((err) => {
      state.busy = false;
      toast(`Couldn't rewrite. ${String(err?.message || err).slice(0, 160)}`);
    });
    sendResponse({ ok: true });
    return undefined;
  });
})();
