// Native hook entry point for Claude Code and Codex.
// Design rule: no behavioral rules about how to work. Measured on Claude, injected working rules
// raised thinking (billed as output) by more than they saved. The only injected text is the short
// orchestrator brief (who does what) and, after compaction, recorded facts.
import fs from 'node:fs';
import path from 'node:path';
import { compactShellResult } from './compact.mjs';
import { appendEvent, atomicWrite, enabled, hash, readJson } from './store.mjs';
import { leadBrief, workerModels, tier, WORKER } from './orchestrate.mjs';
import { summarizeFile } from './usage.mjs';
import { loadSession, saveSession, readKey, rememberChange, rememberPrompt, afterCompaction, digest } from './session.mjs';

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);

// The lead's current model: the model of its latest reply, read from the end of the transcript, so a
// /model switch mid-chat counts.
function leadModel(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  try {
    const fd = fs.openSync(file, 'r'), size = fs.fstatSync(fd).size, length = Math.min(size, 1 << 20), buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    fs.closeSync(fd);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      let row;
      try { row = JSON.parse(lines[i]); } catch { continue; }
      const model = row.type === 'assistant' && !row.isSidechain ? row.message?.model : null;
      if (typeof model === 'string' && tier(model) != null) return model;
    }
  } catch { /* unreadable transcript: no check */ }
  return null;
}

// A worker never runs on a pricier model than the lead; the lead is told why and picks again.
function guardWorker(input) {
  const ti = input.tool_input || {};
  const worker = ti.model || (ti.subagent_type === WORKER ? workerModels('claude').default.model : null);
  const lead = worker ? leadModel(input.transcript_path) : null;
  if (!lead || !(tier(worker) > tier(lead))) return {};
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Fewr: a ${worker} worker costs more than your own model (${lead}). Use a cheaper worker model, or do this yourself.` } };
}

function compactShell(input, home) {
  const result = compactShellResult(input.tool_response, input.tool_input?.command);
  if (!result) return {};
  // Archive the original before replacing it, so nothing is ever unrecoverable.
  const file = path.join(home, 'outputs', hash(JSON.stringify(input.tool_response)).slice(0, 32) + '.json');
  try { atomicWrite(file, JSON.stringify(input.tool_response)); } catch { return {}; }
  const value = { ...result.value, stdout: result.value.stdout + `\n[Fewr: original output saved at ${file}]` };
  appendEvent(home, { type: 'compaction', client: 'claude', session: input.session_id, format: result.format, originalBytes: result.originalBytes, removedBytes: result.removedBytes });
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: value } };
}

// An identical re-read of unchanged content returns a stub: the full text is already in context.
function dedupeRead(input, home, state) {
  const r = input.tool_response, f = r?.file;
  if (r?.type !== 'text' || typeof f?.content !== 'string' || typeof f.filePath !== 'string') return null;
  const key = readKey(input.tool_input), digestOf = hash(f.content);
  const seen = state.reads[key];
  state.reads[key] = digestOf;
  if (seen !== digestOf || f.content.length < 400) return null;
  const end = f.startLine + f.numLines - 1;
  const stub = `[Fewr: lines ${f.startLine}-${end} of ${f.filePath} are unchanged since you last read them in this conversation; content not repeated.]`;
  appendEvent(home, { type: 'dedupe', client: 'claude', session: input.session_id, removedBytes: Buffer.byteLength(f.content) - Buffer.byteLength(stub) });
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...r, file: { ...f, content: stub, numLines: 1 } } } };
}

export function handleHook(client, input, home, env = process.env) {
  if (!['claude', 'codex'].includes(client) || !input || typeof input !== 'object') return {};
  const event = input.hook_event_name, session = input.session_id;
  const tracked = typeof session === 'string' && session.length > 0 && !input.agent_id;

  if (event === 'PreToolUse' && client === 'claude') return AGENT_TOOLS.has(input.tool_name) ? guardWorker(input) : {};

  if (event === 'PostToolUse' && client === 'claude') {
    if (SHELL_TOOLS.has(input.tool_name) && enabled('compaction', home, env)) return compactShell(input, home);
    if (!tracked) return {};
    const state = loadSession(home, client, session);
    let out = {};
    if (input.tool_name === 'Read' && enabled('dedupe', home, env)) out = dedupeRead(input, home, state) || {};
    else if (EDIT_TOOLS.has(input.tool_name) && typeof input.tool_input?.file_path === 'string') rememberChange(state, input.tool_input.file_path);
    saveSession(home, client, session, state);
    return out;
  }

  if (event === 'UserPromptSubmit' && tracked && typeof input.prompt === 'string') {
    const state = loadSession(home, client, session);
    rememberPrompt(state, input.prompt);
    saveSession(home, client, session, state);
    return {};
  }

  // Session start: the lead brief (orchestrator mode). After compaction the brief would be lost,
  // so it is restored together with the recorded facts; earlier reads are gone from context.
  if (event === 'SessionStart') {
    const parts = [];
    if (enabled('orchestrate', home, env)) {
      const installed = readJson(path.join(home, 'installation.json'), { clients: {} }).clients[client]?.workers;
      parts.push(leadBrief(client, installed?.default ? installed : workerModels(client, '')));
    }
    if (input.source === 'compact' && tracked) {
      const state = loadSession(home, client, session);
      afterCompaction(state);
      saveSession(home, client, session, state);
      const facts = enabled('digest', home, env) ? digest(state) : '';
      if (facts) parts.push(facts);
      appendEvent(home, { type: 'compacted', client, session, digestBytes: Buffer.byteLength(facts) });
    }
    return parts.length ? { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } } : {};
  }

  if ((event === 'Stop' || event === 'SessionEnd') && typeof input.transcript_path === 'string' && path.isAbsolute(input.transcript_path)) {
    try {
      const s = summarizeFile(client, input.transcript_path);
      appendEvent(home, { type: 'usage', client, session, transcript: input.transcript_path, requests: s.requests, units: Math.round(s.units), raw: s.raw, parts: Object.fromEntries(Object.entries(s.parts).map(([k, v]) => [k, Math.round(v)])) });
    } catch { /* Usage capture is best effort and never blocks the session. */ }
  }
  return {};
}
