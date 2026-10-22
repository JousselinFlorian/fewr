// Reads native transcripts (Claude Code JSONL, Codex rollout JSONL) into per-model token counts.
// A session's usage includes the workers it spawned, which each client stores in their own files.
// Counts only; no transcript content is stored.
import fs from 'node:fs';
import path from 'node:path';
import { emptyCounts, units, cost, breakdown, rawTokens, price, PRICE_UNIT } from './cost.mjs';

const add = (a, b) => { for (const k of Object.keys(a)) a[k] += b[k] || 0; return a; };

// Claude writes one row per streamed content block, repeating the same message usage;
// keep the largest value per field for each message id. Worker transcripts are all sidechain rows.
export function claudeCounts(rows, { sidechains = false } = {}) {
  const perMessage = new Map();
  for (const row of rows) {
    if (row.type !== 'assistant' || (row.isSidechain && !sidechains)) continue;
    const m = row.message, u = m?.usage;
    if (!u || typeof m.id !== 'string') continue;
    const cc = u.cache_creation;
    const counts = {
      input: u.input_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite5m: cc ? cc.ephemeral_5m_input_tokens || 0 : 0,
      // Without the split, treat writes as the 1h bucket (Claude Code's subscription default).
      cacheWrite1h: cc ? cc.ephemeral_1h_input_tokens || 0 : u.cache_creation_input_tokens || 0,
      output: u.output_tokens || 0,
    };
    const prev = perMessage.get(m.id);
    if (prev) for (const k of Object.keys(counts)) prev.counts[k] = Math.max(prev.counts[k], counts[k]);
    else perMessage.set(m.id, { model: m.model || 'unknown', counts });
  }
  const models = {};
  for (const { model, counts } of perMessage.values()) add(models[model] ||= emptyCounts(), counts);
  return { models, requests: perMessage.size };
}

// Codex reports cumulative totals in token_count events; the last one is the session total.
export function codexCounts(rows) {
  let total = null, model = 'unknown', requests = 0;
  for (const row of rows) {
    if (row.type === 'turn_context' && typeof row.payload?.model === 'string') model = row.payload.model;
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue;
    const t = row.payload.info?.total_token_usage;
    if (!t) continue;
    total = t; requests++;
  }
  if (!total) return { models: {}, requests: 0 };
  const cached = total.cached_input_tokens || 0;
  return { models: { [model]: { ...emptyCounts(), input: (total.input_tokens || 0) - cached, cacheRead: cached, output: total.output_tokens || 0 } }, requests };
}

export function readJsonl(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* partial final line while the session is live */ }
  }
  return rows;
}

function firstRow(file) {
  try {
    const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536), n = fs.readSync(fd, buffer, 0, buffer.length, 0);
    fs.closeSync(fd);
    return JSON.parse(buffer.subarray(0, n).toString('utf8').split('\n')[0]);
  } catch { return null; }
}

// The session's own transcript plus every worker transcript it spawned, directly or through workers.
// Claude keeps them in <session>/subagents/; Codex writes one rollout per agent beside the parent's,
// each naming its parent thread in session_meta.
export function sessionTranscripts(client, file) {
  const list = [{ file, sidechains: false }];
  if (client === 'codex') {
    const id = firstRow(file)?.payload?.id, dir = path.dirname(file), parents = new Map();
    for (const name of fs.readdirSync(dir).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'))) {
      const meta = firstRow(path.join(dir, name))?.payload;
      const parent = meta?.source?.subagent?.thread_spawn?.parent_thread_id;
      if (meta?.id && parent) parents.set(meta.id, { parent, file: path.join(dir, name) });
    }
    const family = new Set(id ? [id] : []);
    for (let grew = true; grew;) {
      grew = false;
      for (const [child, { parent, file: f }] of parents) if (family.has(parent) && !family.has(child)) { family.add(child); list.push({ file: f, sidechains: false }); grew = true; }
    }
  } else {
    const dir = path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents');
    if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))) list.push({ file: path.join(dir, name), sidechains: true });
  }
  return list;
}

// Transcripts are { rows, sidechains }; models are summed across all of them.
export function summarizeTranscripts(client, transcripts) {
  const models = {};
  let requests = 0;
  for (const t of transcripts) {
    const counted = client === 'codex' ? codexCounts(t.rows) : claudeCounts(t.rows, t);
    requests += counted.requests;
    for (const [model, counts] of Object.entries(counted.models)) add(models[model] ||= emptyCounts(), counts);
  }
  let total = 0, raw = 0, priced = 0, unpriced = [];
  const parts = { reads: 0, writes: 0, output: 0, input: 0 };
  for (const [model, counts] of Object.entries(models)) {
    total += units(counts, client, model); raw += rawTokens(counts);
    if (price(client, model)) priced += cost(counts, client, model); else unpriced.push(model);
    for (const [k, v] of Object.entries(breakdown(counts, client, model))) parts[k] += v;
  }
  return { client, requests, units: total, raw, parts, models, cost: priced, unit: PRICE_UNIT[client === 'codex' ? 'codex' : 'claude'], unpriced, transcripts: transcripts.length };
}

export const summarize = (client, rows) => summarizeTranscripts(client, [{ rows, sidechains: false }]);

// One session, including its workers.
export const summarizeFile = (client, file) => summarizeTranscripts(client, sessionTranscripts(client, file).map(t => ({ ...t, rows: readJsonl(t.file) })));
