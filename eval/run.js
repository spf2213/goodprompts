'use strict';

// Measures a set of rewrite instructions against the test prompts in eval/cases.json.
//
//   node --env-file=.env.local eval/run.js --prompt v0 --split dev --reps 2
//
// --prompt  name of a file in eval/prompts/ (without .txt) holding the instructions to test
// --split   "dev" (the half used for tuning) or "test" (the half kept unseen until the end)
// --reps    how many times to run each prompt (the model is not deterministic)
//
// Each rewrite is graded two ways: fixed rules (was a clear prompt left alone? were the user's
// facts kept? too many guesses or blanks? too long?) and a stronger Claude model acting as judge,
// which reads the draft and the rewrite and lists anything invented, added or dropped.
// Results go to eval/results/<prompt>-<split>/.

const fs = require('node:fs');
const path = require('node:path');
const { Anthropic } = require('@anthropic-ai/sdk');
const engine = require('../lib/rewrite-engine');

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map((part) => {
  const [key, ...rest] = part.trim().split(/\s+/);
  return [key, rest.join(' ') || true];
}));
const promptName = String(args.prompt || 'v0');
const split = String(args.split || 'dev');
const reps = Number(args.reps || 2);
const CONCURRENCY = 6;
const JUDGE_MODEL = 'claude-sonnet-5-5';

const systemPrompt = fs.readFileSync(path.join(__dirname, 'prompts', `${promptName}.txt`), 'utf8');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8')).filter((c) => c.split === split);
const outDir = path.join(__dirname, 'results', `${promptName}-${split}`);
fs.mkdirSync(outDir, { recursive: true });

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Create .env.local with the key and run with --env-file=.env.local.');
  process.exit(1);
}
const client = new Anthropic({ timeout: 60000, maxRetries: 4 });

const JUDGE_SYSTEM = `You grade a prompt-rewriting tool. A person typed a DRAFT prompt for an AI chat assistant, and the tool produced a REWRITE meant to say the same thing more clearly.

The tool is allowed to do exactly these things:
- Reword and reorder the draft, fix grammar, and write it in the first person.
- State up to three preferences it guessed, limited to these four kinds: the AUDIENCE for the output, its FORMAT, its LENGTH, and its TONE. Examples that are allowed: "keep it under 150 words", "in a professional tone", "for a reader with no technical background", "as a bulleted list", "about 8 ideas, one sentence each".
- Leave a blank in square brackets naming a missing fact, like [company], usually inside a sentence that states the fact ("My goal is [your goal]"). A blank is the tool asking the person for a fact, so a blank is never "invented" or "added", whatever fact it asks for.

Everything else is a violation. List each one you find:

- invented: a specific fact in the rewrite that is not in the draft. Dates, names, numbers, quantities, places, currencies or units the draft did not state, events, reasons, background, or a vague word sharpened into a specific one. A guessed length or word count is NOT an invented fact; it is an allowed length preference.
- added: a requirement about the CONTENT of the answer that the person did not ask for. Extra sections, steps, features, inclusions, examples, success criteria, a call to action, comments in code, instructions on how to run something, a number of sessions or days. If it is not about audience, format, length or tone, and the draft did not ask for it, it is added.
- dropped: a fact, name, number, constraint or request that is in the draft but missing from the rewrite.

Also answer:
- missing_blank: true if the request cannot be done well without a fact only the person knows, AND the rewrite neither includes that fact nor leaves a blank for it.

Be strict but fair. Do not list allowed preference guesses. Do not list the same problem twice. Quote the offending words from the rewrite (or from the draft, for "dropped"). If there is nothing wrong, return empty lists.`;

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    invented: { type: 'array', items: { type: 'string' } },
    added: { type: 'array', items: { type: 'string' } },
    dropped: { type: 'array', items: { type: 'string' } },
    missing_blank: { type: 'boolean' },
  },
  required: ['invented', 'added', 'dropped', 'missing_blank'],
  additionalProperties: false,
};

async function judge(draft, rewrite) {
  const message = await client.beta.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: JUDGE_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `<draft>\n${draft}\n</draft>\n\n<rewrite>\n${rewrite}\n</rewrite>` }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
  });
  if (message.stop_reason === 'refusal') throw new Error('judge refused');
  const block = message.content.find((b) => b.type === 'text');
  return { ...JSON.parse(block.text), usage: message.usage };
}

const words = (text) => (String(text).trim().match(/\S+/g) || []).length;

async function runCase(testCase, rep) {
  const record = { id: testCase.id, rep, kind: testCase.kind, draft: testCase.text, failures: [] };
  const started = Date.now();
  let result;
  try {
    result = await engine.rewrite({ text: testCase.text, site: testCase.site, client, systemPrompt });
  } catch (error) {
    record.error = `${error.code || error.name}: ${error.message}`;
    record.failures.push('error');
    record.pass = false;
    return record;
  }
  record.seconds = (Date.now() - started) / 1000;
  record.verdict = result.verdict;
  record.usage = result.usage;
  if (result.verdict === 'rewritten') {
    record.rewrite = result.text;
    record.guesses = result.guesses;
    record.blanks = result.blankList;
  }

  if (testCase.kind !== 'rough') {
    // Clear questions, follow-ups, fully specified prompts, pasted material and injection attempts
    // must all come back untouched.
    if (result.verdict !== 'unchanged') record.failures.push('should_be_unchanged');
  } else if (result.verdict !== 'rewritten') {
    record.failures.push('not_rewritten');
  } else {
    if (result.guesses.length > 3) record.failures.push('too_many_guesses');
    if (result.blankList.length > 2) record.failures.push('too_many_blanks');
    const lower = result.text.toLowerCase();
    const lost = testCase.facts.filter((fact) => !lower.includes(fact.toLowerCase()));
    if (lost.length) { record.failures.push('lost_fact'); record.lostFacts = lost; }
    if (words(result.text) > Math.max(70, 4 * words(testCase.text))) record.failures.push('too_long');
    try {
      const verdict = await judge(testCase.text, result.text);
      record.judge = { invented: verdict.invented, added: verdict.added, dropped: verdict.dropped, missing_blank: verdict.missing_blank };
      record.judgeUsage = verdict.usage;
      if (verdict.invented.length) record.failures.push('invented');
      if (verdict.added.length) record.failures.push('added');
      if (verdict.dropped.length) record.failures.push('dropped');
      if (verdict.missing_blank) record.failures.push('missing_blank');
    } catch (error) {
      record.failures.push('judge_error');
      record.judgeError = String(error.message || error);
    }
  }
  record.pass = record.failures.length === 0;
  return record;
}

(async () => {
  const jobs = [];
  for (const testCase of cases) for (let rep = 1; rep <= reps; rep++) jobs.push([testCase, rep]);
  const records = [];
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const [testCase, rep] = jobs[next++];
      records.push(await runCase(testCase, rep));
      process.stderr.write('.');
    }
  }));
  process.stderr.write('\n');
  records.sort((a, b) => a.id.localeCompare(b.id) || a.rep - b.rep);
  fs.writeFileSync(path.join(outDir, 'results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

  // Everything below is recomputed from the per-case records.
  const rate = (list) => (list.length ? `${list.filter((r) => r.pass).length}/${list.length} (${Math.round(100 * list.filter((r) => r.pass).length / list.length)}%)` : 'n/a');
  const rough = records.filter((r) => r.kind === 'rough');
  const leave = records.filter((r) => r.kind !== 'rough');
  const failureCounts = {};
  for (const r of records) for (const f of r.failures) failureCounts[f] = (failureCounts[f] || 0) + 1;
  const seconds = records.map((r) => r.seconds).filter(Boolean).sort((a, b) => a - b);
  const sum = (pick) => records.reduce((total, r) => total + (pick(r) || 0), 0);
  const rewriteCost = (sum((r) => r.usage?.input) * 0.10 + sum((r) => r.usage?.output) * 0.50) / 1e6;
  const judgeCost = (sum((r) => (r.judgeUsage?.input_tokens || 0) + (r.judgeUsage?.cache_read_input_tokens || 0) * 0.05 + (r.judgeUsage?.cache_creation_input_tokens || 0) * 1.25) * 2 + sum((r) => r.judgeUsage?.output_tokens) * 10) / 1e6;
  const summary = {
    prompt: promptName, split, reps, runs: records.length,
    overall: rate(records), rough: rate(rough), leaveAlone: rate(leave),
    byKind: Object.fromEntries([...new Set(records.map((r) => r.kind))].map((k) => [k, rate(records.filter((r) => r.kind === k))])),
    failures: failureCounts,
    medianSeconds: seconds.length ? Number(seconds[Math.floor(seconds.length / 2)].toFixed(2)) : null,
    slowestSeconds: seconds.length ? Number(seconds[seconds.length - 1].toFixed(2)) : null,
    approxCostUsd: { rewrites: Number(rewriteCost.toFixed(4)), judge: Number(judgeCost.toFixed(4)) },
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
})().catch((error) => { console.error('RUN FAILED:', error.message || error); process.exit(2); });
