#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { stateHome, readJson } from '../src/store.mjs';
import { handleHook } from '../src/hook.mjs';
import { install, uninstall, clientPaths } from '../src/install.mjs';
import { summarizeFile } from '../src/usage.mjs';
import { findTranscript, chatReport, formatReport } from '../src/stats.mjs';

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const home = path.resolve(option('--home') || stateHome());
const clientArg = option('--client');
const clients = clientArg === 'both' ? ['claude', 'codex'] : clientArg ? [clientArg] : null;
// Bare `npx fewr` installs, as the website shows; `fewr help` lists the commands.
const command = args[0] || 'install';
const fmt = n => Math.round(n).toLocaleString('en-US');

if (command === 'hook') {
  // Hooks must never break the session: any failure yields an empty response.
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let out = {};
  try { out = handleHook(args[1], JSON.parse(raw), home); } catch { out = {}; }
  process.stdout.write(JSON.stringify(out));
} else if (command === 'install' || command === 'uninstall') {
  // Without --client: every client whose configuration folder exists (for uninstall, what was installed).
  const paths = clientPaths(), installed = Object.keys(readJson(path.join(home, 'installation.json'), { clients: {} }).clients);
  const chosen = clients || (command === 'uninstall' ? installed : ['claude', 'codex'].filter(client => fs.existsSync(paths[`${client}Dir`])));
  if (command === 'install' && !chosen.length) { console.error('No Claude Code or Codex configuration found; pass --client claude|codex|both.'); process.exit(1); }
  try {
    const result = command === 'install' ? install({ clients: chosen, home }) : uninstall({ clients, home });
    console.log(`Fewr ${command}ed for ${chosen.join(', ')}. ${result.changed.length} file(s) changed.`);
    for (const note of result.notes || []) console.log(note);
    if (command === 'install') console.log('Fewr is free. Follow @flojousselin on X for new benchmarks and releases: https://x.com/flojousselin');
  } catch (error) { console.error(error.message); process.exit(1); }
} else if (command === 'usage') {
  // fewr usage <claude|codex> <transcript.jsonl>: price-weighted breakdown of one session and its workers.
  const s = summarizeFile(args[1], args[2]);
  const pct = v => s.units ? Math.round(100 * v / s.units) + '%' : '-';
  const reference = args[1] === 'codex' ? 'GPT-6 Astra' : 'Opus 5.5';
  console.log(`${s.transcripts} transcript(s), ${s.requests} requests | ${fmt(s.units)} usage units (${reference} input-token equivalents) | ${s.unit === 'USD' ? '$' + s.cost.toFixed(2) : s.cost.toFixed(2) + ' credits'} at published prices | ${fmt(s.raw)} raw tokens`);
  for (const [part, v] of Object.entries(s.parts)) console.log(`  ${part.padEnd(7)} ${fmt(v).padStart(12)}  ${pct(v)}`);
  for (const [model, counts] of Object.entries(s.models)) console.log(`  ${model}: ${fmt(counts.input + counts.cacheRead + counts.cacheWrite5m + counts.cacheWrite1h)} input (${fmt(counts.cacheRead)} cached), ${fmt(counts.output)} output`);
  if (s.unpriced.length) console.log(`No published price for ${s.unpriced.join(', ')}; counted at ${reference}'s price.`);
} else if (command === 'stats') {
  // fewr stats [--client claude|codex] [--session ID] [--cwd DIR]: this chat with Fewr vs an estimate
  // without it. /fewrstats (Claude Code) and $fewrstats (Codex) run this for the current chat.
  const session = option('--session'), cwd = path.resolve(option('--cwd') || process.cwd());
  const candidates = clients || ['claude', 'codex'];
  const found = candidates.map(client => ({ client, file: findTranscript(client, { session: session || undefined, cwd }) })).filter(x => x.file)
    .sort((a, b) => fs.statSync(b.file).mtimeMs - fs.statSync(a.file).mtimeMs)[0];
  if (!found) { console.error(`No ${candidates.join(' or ')} chat found for ${session ? `session ${session}` : cwd}.`); process.exit(1); }
  console.log(formatReport(chatReport(found.client, found.file, { home })));
} else {
  console.log('fewr [install]|uninstall [--client claude|codex|both] [--home DIR]\nfewr stats [--client claude|codex] [--session ID] [--cwd DIR]\nfewr usage <claude|codex> <transcript.jsonl>');
}
