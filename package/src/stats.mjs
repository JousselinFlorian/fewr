// The /fewrstats report ($fewrstats on Codex): this chat's real raw tokens, cost and active time with
// Fewr, next to what it would likely have cost without it. A single chat has no measured run without
// Fewr, so cost is estimated two ways and the lower one shown: (a) every token priced at the lead
// model's rates, and (b) the lead doing each worker's job itself, its new content then staying in the
// lead's context for every later lead turn (as does tool output Fewr kept out). Both leave out the
// extra thinking the lead's effort adds. Checked against measured runs without Fewr, the lower
// estimate stayed under the real cost on 5 of 6 tasks. Raw tokens and build time have no reliable
// per-chat estimate, so the report shows the benchmark result for them, labelled as such.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, sessionTranscripts, summarizeTranscripts } from './usage.mjs';
import { cost, price, PRICE_UNIT } from './cost.mjs';
import { readEvents } from './store.mjs';

const BENCHMARK = { raw: '8–52% fewer on 5 of 6 benchmark tasks', time: '18–50% faster on 5 of 6 benchmark tasks' };
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
  let modelled = 0, rereads = 0;
  for (const counts of Object.values(main.models)) modelled += leadPrice ? cost(counts, client, lead) : 0;
  const requests = leadRequests(client, transcripts[0].rows), laterThan = t => requests.filter(r => r.t > t).length;
  const write = leadPrice ? (client === 'codex' ? leadPrice.input : leadPrice.cacheWrite1h) : 0;
  for (const worker of transcripts.slice(1)) {
    const own = summarizeTranscripts(client, [worker]), start = Math.min(...worker.rows.map(r => Date.parse(r.timestamp)).filter(Number.isFinite));
    if (!Number.isFinite(start) || !leadPrice) continue;
    const read = Object.values(own.models).reduce((n, c) => n + c.input + c.cacheWrite5m + c.cacheWrite1h, 0), wrote = Object.values(own.models).reduce((n, c) => n + c.output, 0);
    modelled += (read * write + wrote * leadPrice.output) / 1e6;
    rereads += (read + wrote) * laterThan(start);
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
  const active = transcripts[0].rows.some(r => client === 'codex'
    ? r.type === 'response_item' && r.payload?.role === 'developer' && brief.test(JSON.stringify(r.payload.content || ''))
    : r.type === 'attachment' && r.attachment?.hookEvent === 'SessionStart' && brief.test(JSON.stringify(r.attachment)));
  const workers = transcripts.length - 1;
  return {
    client, file, lead, workers, active, keptTokens: Math.round(keptTokens), unit: PRICE_UNIT[client === 'codex' ? 'codex' : 'claude'],
    with: { raw: all.raw, cost: all.cost, activeMs: activeMs(transcripts) },
    without: { cost: leadPrice ? Math.min(repriced, modelled) : null },
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
const pct = (now, before) => before ? `${now <= before ? '−' : '+'}${Math.abs(100 * (now / before - 1)).toFixed(1)}%` : '—';
const minutes = ms => ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;

export function formatReport(r) {
  const money = v => v == null ? '—' : r.unit === 'USD' ? `$${v.toFixed(2)}` : `${v.toFixed(1)} credits`;
  const name = r.client === 'codex' ? 'Codex' : 'Claude Code', lead = r.lead ? modelName(r.lead) : 'the lead model';
  const workers = r.workers ? `, ${r.workers} worker${r.workers > 1 ? 's' : ''}` : ', no workers yet';
  return [
    `**Fewr — this chat** (${name} · ${lead} lead${workers})`,
    ...(r.active ? [] : ['', '> Fewr was not active in this chat (its session brief never arrived), so these numbers show the chat without Fewr. Start a new chat after installing to see its effect.']),
    '',
    '| | Without Fewr | With Fewr | Change |',
    '| :-- | --: | --: | --: |',
    `| Raw tokens | — | ${int(r.with.raw)} | ${BENCHMARK.raw} |`,
    `| Cost | ${money(r.without.cost)} (est.) | ${money(r.with.cost)} | ${r.without.cost == null ? '—' : pct(r.with.cost, r.without.cost)} |`,
    `| Build time | — | ${minutes(r.with.activeMs)} | ${BENCHMARK.time} |`,
    '',
    `Cost without Fewr is an estimate, not a measured run: the lower of this chat's tokens priced at ${lead}'s rates, and ${lead} doing the workers' jobs inside its own context${r.keptTokens ? ` (with the ${int(r.keptTokens)} tokens of tool output Fewr kept out)` : ''}. Neither counts the extra thinking your effort level would add. Prices are published rates (${r.unit === 'USD' ? 'USD' : 'Codex credits'}); your plan meter may weigh usage differently. Raw tokens and build time can't be estimated for one chat, so their change is our benchmark result. Build time is this chat's active time.`,
    ...(r.unpriced.length ? ['', `No published price for ${r.unpriced.join(', ')}; counted at the reference model's price.`] : []),
    '',
    'Fewr is free and open source. Follow [@flojousselin](https://x.com/flojousselin) on X for new benchmarks and releases.',
  ].join('\n');
}
