import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const stateHome = (env = process.env) => path.resolve(env.FEWR_HOME || path.join(os.homedir(), '.fewr'));
export const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Writes through a symlink to its target so the link survives, and keeps an existing file's permission bits.
export function atomicWrite(file, text) {
  let mode;
  try {
    if (fs.lstatSync(file).isSymbolicLink()) {
      try { file = fs.realpathSync(file); } catch { file = path.resolve(path.dirname(file), fs.readlinkSync(file)); } // dangling link: create its target
    }
    mode = fs.statSync(file).mode & 0o7777;
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, text, { mode: mode ?? 0o600 });
  if (mode !== undefined) fs.chmodSync(temp, mode);
  fs.renameSync(temp, file);
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function appendEvent(home, event) {
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
}

export function readEvents(home) {
  try {
    return fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

// Every mechanism can be switched off individually, so its effect is measurable:
// FEWR_DISABLE=compaction,... or {"disable": ["compaction"]} in <home>/config.json.
export const MECHANISMS = ['compaction', 'dedupe', 'digest', 'orchestrate'];
export function enabled(mechanism, home, env = process.env) {
  const off = new Set([...(env.FEWR_DISABLE || '').split(','), ...(readJson(path.join(home, 'config.json'), {}).disable || [])].map(s => s.trim()).filter(Boolean));
  return !off.has(mechanism) && !off.has('all');
}
