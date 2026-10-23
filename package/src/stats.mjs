// The /fewrstats report ($fewrstats on Codex): this chat's real raw tokens, cost and active time with
// Fewr, next to what it would likely have cost without it. A single chat has no measured run without
// Fewr, so cost is estimated two ways and the lower one shown: (a) every token priced at the lead
// model's rates, and (b) the lead doing each worker's job itself, its new content then staying in the
// lead's context for every later lead turn (as does tool output Fewr kept out). Both leave out the
// extra thinking the lead's effort adds. Checked against measured runs without Fewr, the lower
// estimate stayed under the real cost on 5 of 6 tasks. Raw tokens and build time use (b) alone: the
// worker's new content once plus its re-reads, and the worker's writing at the lead's measured pace,
// one worker after another. Against the same runs, both stayed under the real value on 7 of 9.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, sessionTranscripts, summarizeTranscripts } from './usage.mjs';
import { cost, price, PRICE_UNIT } from './cost.mjs';
import { readEvents } from './store.mjs';

const IDLE_CAP_MS = 15 * 60_000; // gaps longer than this (the user away) are not build time

function firstRow(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').split('\n', 1)[0]); } catch { return null; }
}

const newest = files => files.map(f => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t).map(x => x.f);

// The chat's main transcript: by session id when known, otherwise the latest chat in this directory.
export function findTranscript(client, { session, cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  if (client === 'codex') {
    const root = path.join(path.resolve(env.CODEX_HOME || path.join(home, '.codex')), 'sessions');
    const days = [];
    const walk = (dir, depth) => { for (const name of fs.existsSync(dir) ? fs.readdirSync(dir).sort().reverse() : []) { const p = path.join(dir, name); if (depth < 3 && fs.statSync(p).isDirectory()) walk(p, depth + 1); else if (depth === 3) days.push(p); } };
    walk(root, 0);
    const dayDirs = [...new Set(days.map(d => path.dirname(d)))].slice(0, 14);
    for (const file of newest(dayDirs.flatMap(d => fs.readdirSync(d).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl')).map(f => path.join(d, f))))) {
      const meta = firstRow(file)?.payload || {};
      if (session ? meta.id === session : meta.cwd === cwd && !meta.source?.subagent) return file;
    }
    return null;
  }
  const root = path.join(path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')), 'projects');
  if (!fs.existsSync(root)) return null;
  if (session) for (const dir of fs.readdirSync(root)) { const file = path.join(root, dir, `${session}.jsonl`); if (fs.existsSync(file)) return file; }
  const dir = path.join(root, path.resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-'));
  return fs.existsSync(dir) ? newest(fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)))[0] || null : null;
}

// The lead's own requests: time and context size (tokens it read), one per Claude message id or
// Codex token_count event.
function leadRequests(client, rows) {
  const seen = new Set(), out = [];
  for (const row of rows) {
    const t = Date.parse(row.timestamp);
    if (!Number.isFinite(t)) continue;
    if (client === 'codex') {
      const last = row.type === 'event_msg' && row.payload?.type === 'token_count' ? row.payload.info?.last_token_usage : null;
      if (last) out.push({ t, context: last.input_tokens || 0 });
    } else if (row.type === 'assistant' && !row.isSidechain && row.message?.usage && !seen.has(row.message.id)) {
      seen.add(row.message.id);
      const u = row.message.usage;
      out.push({ t, context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) });
    }
  }
  return out;
}

const MODEL_ITEMS = new Set(['reasoning', 'function_call', 'custom_tool_call', 'local_shell_call', 'web_search_call']);
const fromModel = (client, r) => client === 'codex'
  ? r.type === 'response_item' && (MODEL_ITEMS.has(r.payload?.type) || (r.payload?.type === 'message' && r.payload.role === 'assistant'))
  : r.type === 'assistant';

// Time the model spent writing (the gap before each row it wrote) and the transcript's first and last row.
function timing(client, rows) {
  const sorted = rows.map(r => ({ t: Date.parse(r.timestamp), model: fromModel(client, r) })).filter(r => Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
  let writing = 0;
  for (let i = 1; i < sorted.length; i++) if (sorted[i].model) writing += Math.min(sorted[i].t - sorted[i - 1].t, IDLE_CAP_MS);
  return { writing, start: sorted[0]?.t, end: sorted.at(-1)?.t };
}

// Total length of possibly overlapping intervals.
function covered(spans) {
  let total = 0, end = -Infinity;
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) if (b > end) { total += b - Math.max(a, end); end = b; }
  return total;
}

function activeMs(transcripts) {
  const times = transcripts.flatMap(t => t.rows.map(r => Date.parse(r.timestamp)).filter(Number.isFinite)).sort((a, b) => a - b);
  let total = 0;
  for (let i = 1; i < times.length; i++) total += Math.min(times[i] - times[i - 1], IDLE_CAP_MS);
  return total;
}

export function chatReport(client, file, { home } = {}) {
  const transcripts = sessionTranscripts(client, file).map(t => ({ ...t, rows: readJsonl(t.file) }));
  const all = summarizeTranscripts(client, transcripts), main = summarizeTranscripts(client, [transcripts[0]]);
  const lead = Object.entries(main.models).sort((a, b) => (b[1].output + b[1].cacheRead) - (a[1].output + a[1].cacheRead))[0]?.[0];
  const leadPrice = lead && price(client, lead);

  // (a) Every token at the lead's prices.
  let repriced = 0;
  for (const counts of Object.values(all.models)) repriced += leadPrice ? cost(counts, client, lead) : 0;
  // (b) The lead's own tokens, plus each worker's new content (what it read fresh and wrote) at the
  // lead's prices, re-read on every later lead turn; the worker's re-reads of its own context drop out.
  // The same model in raw tokens, and in time: the worker's writing at the lead's pace, its tool time
  // unchanged, and workers one after another instead of in parallel.
  let modelled = 0, rereads = 0, workerRaw = 0, workerMs = 0;
  for (const counts of Object.values(main.models)) modelled += leadPrice ? cost(counts, client, lead) : 0;
  const leadSteps = leadRequests(client, transcripts[0].rows), laterThan = t => leadSteps.filter(r => r.t > t).length;
  const write = leadPrice ? (client === 'codex' ? leadPrice.input : leadPrice.cacheWrite1h) : 0;
  const leadWriting = timing(client, transcripts[0].rows).writing;
  const pace = leadWriting > 0 ? Object.values(main.models).reduce((n, c) => n + c.output, 0) / leadWriting : 0;
  const spans = [];
  for (const worker of transcripts.slice(1)) {
    const own = summarizeTranscripts(client, [worker]), time = timing(client, worker.rows), start = time.start;
    if (!Number.isFinite(start)) continue;
    const read = Object.values(own.models).reduce((n, c) => n + c.input + c.cacheWrite5m + c.cacheWrite1h, 0), wrote = Object.values(own.models).reduce((n, c) => n + c.output, 0);
    if (leadPrice) modelled += (read * write + wrote * leadPrice.output) / 1e6;
    rereads += (read + wrote) * laterThan(start);
    workerRaw += read + wrote;
    workerMs += activeMs([worker]) - time.writing + (pace ? wrote / pace : NaN);
    spans.push([start, time.end]);
  }
  const session = client === 'codex' ? firstRow(file)?.payload?.id : path.basename(file, '.jsonl');
  let keptTokens = 0;
  for (const e of home ? readEvents(home) : []) {
    if (e.session !== session || !['compaction', 'dedupe'].includes(e.type) || !(e.removedBytes > 0)) continue;
    const tokens = e.removedBytes / 4;
    keptTokens += tokens;
    if (leadPrice) modelled += tokens * write / 1e6;
    rereads += tokens * laterThan(Date.parse(e.at));
  }
  if (leadPrice) modelled += rereads * leadPrice.cacheRead / 1e6;
  // Fewr was active if its session brief reached this chat: a SessionStart hook result on Claude Code,
  // a developer message on Codex. Mentions of it elsewhere in the conversation don't count.
  // Before the rename (2026-10-22) the same brief started with "Shyft orchestrator mode".
  const brief = /(Fewr|Shyft) orchestrator mode/;
  const fewr = transcripts[0].rows.some(r => client === 'codex'
    ? r.type === 'response_item' && r.payload?.role === 'developer' && brief.test(JSON.stringify(r.payload.content || ''))
    : r.type === 'attachment' && r.attachment?.hookEvent === 'SessionStart' && brief.test(JSON.stringify(r.attachment)));
  const workers = transcripts.length - 1, active = activeMs(transcripts), withoutMs = Math.max(0, active - covered(spans)) + workerMs;
  return {
    client, file, lead, workers, active: fewr, keptTokens: Math.round(keptTokens), unit: PRICE_UNIT[client === 'codex' ? 'codex' : 'claude'],
    with: { raw: all.raw, cost: all.cost, activeMs: active },
    without: {
      raw: main.raw + workerRaw + keptTokens + rereads,
      cost: leadPrice ? Math.min(repriced, modelled) : null,
      activeMs: Number.isFinite(withoutMs) ? withoutMs : null,
    },
    unpriced: all.unpriced,
  };
}

// claude-opus-5-5 → Opus 5.5; gpt-6-astra → GPT-6 Astra; gpt-6.1-sol → GPT-6.1 Sol.
export const modelName = (model = '') => {
  const claude = model.match(/^claude-([a-z]+)-(\d+)(?:-(\d))?(?:-\d{6,})?$/);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? '.' + claude[3] : ''}`;
  const gpt = model.match(/^gpt-([\d.]+)-([a-z]+)$/);
  return gpt ? `GPT-${gpt[1]} ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}` : model;
};

const int = n => Math.round(n).toLocaleString('en-US');
const pct = (now, before) => before != null && before > 0 ? `${now <= before ? '−' : '+'}${Math.abs(100 * (now / before - 1)).toFixed(1)}%` : '—';
const minutes = ms => ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

export function formatReport(r) {
  // Without Fewr's brief, workers are the client's own subagents: there is nothing to compare.
  const without = r.active ? r.without : {};
  const money = v => v == null ? '—' : r.unit === 'USD' ? `$${v.toFixed(2)}` : `${v.toFixed(1)} credits`;
  const name = r.client === 'codex' ? 'Codex' : 'Claude Code', lead = r.lead ? modelName(r.lead) : 'the lead model';
  const workers = r.workers ? `, ${r.workers} worker${r.workers > 1 ? 's' : ''}` : ', no workers yet';
  return [
    `**Fewr — this chat** (${name} · ${lead} lead${workers})`,
    ...(r.active ? [] : ['', '> Fewr was not active in this chat (its session brief never arrived), so these numbers show the chat without Fewr. Start a new chat after installing to see its effect.']),
    '',
    '| | Without Fewr | With Fewr | Change |',
    '| :-- | --: | --: | --: |',
    `| Raw tokens | ${without.raw == null ? '—' : `${int(without.raw)} (est.)`} | ${int(r.with.raw)} | ${pct(r.with.raw, without.raw)} |`,
    `| Cost | ${without.cost == null ? '—' : `${money(without.cost)} (est.)`} | ${money(r.with.cost)} | ${pct(r.with.cost, without.cost)} |`,
    `| Build time | ${without.activeMs == null ? '—' : `${minutes(without.activeMs)} (est.)`} | ${minutes(r.with.activeMs)} | ${pct(r.with.activeMs, without.activeMs)} |`,
    ...(r.unpriced.length ? ['', `No published price for ${r.unpriced.join(', ')}; counted at the reference model's price.`] : []),
    '',
    '',
    'Follow [@flojousselin](https://x.com/flojousselin) on X for new benchmarks and releases.',
  ].join('\n');
}
