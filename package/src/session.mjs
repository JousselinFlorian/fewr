// Per-session facts Fewr records from hook events. Used to (a) skip re-sending file content the
// model already has in its current context and (b) restore exact facts after compaction.
import path from 'node:path';
import { atomicWrite, hash, readJson } from './store.mjs';

const MAX_PROMPTS = 6, MAX_FILES = 40;
const fileFor = (home, client, session) => path.join(home, 'sessions', `${client}-${hash(String(session)).slice(0, 24)}.json`);
const fresh = () => ({ reads: {}, changed: [], prompts: [], compactions: 0 });

export const loadSession = (home, client, session) => ({ ...fresh(), ...readJson(fileFor(home, client, session), {}) });
export const saveSession = (home, client, session, state) => atomicWrite(fileFor(home, client, session), JSON.stringify(state));

export const readKey = input => JSON.stringify([input?.file_path, input?.offset ?? null, input?.limit ?? null, input?.pages ?? null]);

export function rememberChange(state, file) {
  state.changed = [file, ...state.changed.filter(f => f !== file)].slice(0, MAX_FILES);
  // A changed file must be re-sent in full next time it is read.
  for (const key of Object.keys(state.reads)) if (JSON.parse(key)[0] === file) delete state.reads[key];
}

export function rememberPrompt(state, prompt) {
  const text = String(prompt).replace(/\s+/g, ' ').trim();
  if (text) state.prompts = [...state.prompts, text.length > 240 ? text.slice(0, 240) + '…' : text].slice(-MAX_PROMPTS);
}

// After compaction the earlier file contents are gone from context, so every read is fresh again.
export function afterCompaction(state) {
  state.reads = {};
  state.compactions += 1;
}

// Facts only; no instructions. Restores exact paths and recent requests a summary may blur.
export function digest(state) {
  if (!state.changed.length && !state.prompts.length) return '';
  const lines = ['Fewr session record (facts captured before compaction):'];
  if (state.changed.length) lines.push(`Files changed in this session: ${state.changed.join(', ')}`);
  if (state.prompts.length) lines.push('Recent user requests, oldest first:', ...state.prompts.map((p, i) => `${i + 1}. ${p}`));
  return lines.join('\n');
}
