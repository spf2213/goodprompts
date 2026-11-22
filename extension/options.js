// Options page: the data notice, standing context, and a test rewrite.

const FIELDS = ['role', 'audience', 'style'];
const $ = (id) => document.getElementById(id);

async function load() {
  const stored = await chrome.storage.local.get([...FIELDS, 'consent']);
  for (const key of FIELDS) $(key).value = stored[key] || '';
  $('consent').checked = Boolean(stored.consent);
}

async function save() {
  const values = { consent: $('consent').checked };
  for (const key of FIELDS) values[key] = $(key).value.trim();
  await chrome.storage.local.set(values);
  $('saved').textContent = values.consent ? 'Saved. Ready to use.' : 'Saved. Tick the box in step 1 to start using it.';
}

async function test() {
  const output = $('output');
  const button = $('test');
  await save();
  button.disabled = true;
  output.hidden = false;
  output.classList.remove('bad');
  output.textContent = 'Rewriting…';
  $('timing').textContent = '';
  const started = performance.now();
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: 'pr:rewrite', text: $('sample').value, host: '' });
  } catch (err) {
    reply = { ok: false, code: 'unknown', message: String(err?.message || err) };
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  button.disabled = false;

  if (!reply?.ok) {
    output.classList.add('bad');
    const status = reply?.status ? `, HTTP ${reply.status}` : '';
    output.textContent = `Failed (${reply?.code || 'unknown'}${status}): ${reply?.message || 'no detail'}`;
    return;
  }
  const { verdict, text, guesses, blanks } = reply.result;
  const lines = [];
  if (verdict === 'rewritten') {
    lines.push(text, '');
    lines.push(`Guessed: ${guesses.length ? guesses.join(', ') : 'nothing'}`);
    lines.push(`Blanks: ${blanks}`);
  } else {
    lines.push('Verdict: already clear. The prompt would be left as it is.');
  }
  output.textContent = lines.join('\n');
  const left = typeof reply.remaining === 'number' ? `, ${reply.remaining} free rewrites left today` : '';
  $('timing').textContent = `${seconds} s${left}`;
}

$('save').addEventListener('click', save);
$('test').addEventListener('click', test);
load();
