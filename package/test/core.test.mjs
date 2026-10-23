import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { units, weights, emptyCounts, cost } from '../src/cost.mjs';
import { summarize, summarizeFile, claudeCounts } from '../src/usage.mjs';
import { chatReport, formatReport, findTranscript, modelName } from '../src/stats.mjs';
import { compactText, compactShellResult } from '../src/compact.mjs';
import { handleHook } from '../src/hook.mjs';
import { pruneOld } from '../src/session.mjs';
import { readEvents } from '../src/store.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fewr2-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message || ''} ${actual} != ${expected}`);

test('usage weights every token by its model\'s published price, in reference-model input equivalents', () => {
  const c = { ...emptyCounts(), cacheRead: 1_000_000, cacheWrite1h: 10_000, output: 10_000 };
  near(units(c, 'claude', 'claude-opus-5-5'), 1_000_000 * 0.05 + 10_000 * 2 + 10_000 * 5);
  near(units(c, 'claude', 'claude-sonnet-5-5'), units(c, 'claude', 'claude-opus-5-5') / 2, 'Sonnet 5.5 costs half of Opus 5.5');
  near(cost(c, 'claude', 'claude-opus-5-5'), 0.2 + 0.08 + 0.2);
  near(weights('claude', 'claude-fable-5-1').input, 2.5);
  assert.equal(weights('claude', 'claude-haiku-4').cacheRead, 0.1, 'unpriced models keep the usual ratios');
  assert.equal(cost(c, 'claude', 'claude-haiku-4'), null);
  const t = { ...emptyCounts(), input: 100, cacheRead: 1000, output: 10 };
  near(units(t, 'codex', 'gpt-6-astra'), 100 + 100 + 50);
  near(units(t, 'codex', 'gpt-6.1-sol'), 100 * 0.2 + 1000 * 0.01 + 10, 'Sol is a fifth of Astra, cached input a hundredth');
  near(cost(t, 'codex', 'gpt-6-astra'), (100 * 250 + 1000 * 25 + 10 * 1250) / 1e6);
});

test('a session\'s usage includes the workers it spawned, on both clients', t => {
  const dir = tmp(t), msg = (id, model, out) => JSON.stringify({ type: 'assistant', isSidechain: model !== 'claude-opus-5-5', message: { id, model, usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: out } } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), msg('a', 'claude-opus-5-5', 100) + '\n');
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-1.jsonl'), msg('b', 'claude-sonnet-5-5', 200) + '\n');
  const claude = summarizeFile('claude', path.join(dir, 's1.jsonl'));
  assert.equal(claude.transcripts, 2); assert.equal(claude.models['claude-sonnet-5-5'].output, 200);
  near(claude.units, 100 * 5 + 200 * 2.5); near(claude.cost, (100 * 20 + 200 * 10) / 1e6);
  const rollout = (name, id, parent, out) => fs.writeFileSync(path.join(dir, `rollout-${name}.jsonl`), [
    { type: 'session_meta', payload: { id, ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } },
    { type: 'turn_context', payload: { model: parent ? 'gpt-6.1-sol' : 'gpt-6-astra' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: out } } } }].map(r => JSON.stringify(r)).join('\n') + '\n');
  rollout('1', 'lead', null, 10); rollout('2', 'worker', 'lead', 20); rollout('3', 'nested', 'worker', 30); rollout('4', 'other', 'someone-else', 99);
  const codex = summarizeFile('codex', path.join(dir, 'rollout-1.jsonl'));
  assert.equal(codex.transcripts, 3, 'children and grandchildren, not unrelated sessions');
  assert.equal(codex.models['gpt-6.1-sol'].output, 50);
  near(codex.cost, (10 * 1250 + 50 * 250) / 1e6);
});

test('Claude transcripts count each message once and split cache-write TTL buckets', () => {
  const usage = { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 100 }, output_tokens: 50 };
  const rows = [
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage: { ...usage, output_tokens: 10 } } },
    { type: 'assistant', message: { id: 'm1', model: 'claude-opus-5-5', usage } },
    { type: 'assistant', isSidechain: true, message: { id: 'side', model: 'claude-opus-5-5', usage } },
  ];
  const { models, requests } = claudeCounts(rows);
  assert.equal(requests, 1);
  assert.deepEqual(models['claude-opus-5-5'], { input: 2, cacheRead: 1000, cacheWrite5m: 100, cacheWrite1h: 200, output: 50 });
  const s = summarize('claude', rows);
  assert.equal(Math.round(s.parts.reads), 50); assert.equal(Math.round(s.parts.writes), 525); assert.equal(s.parts.output, 250);
});

test('Codex rollouts use the last cumulative token_count and separate cached input', () => {
  const rows = [
    { type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 20 } } } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 80 } } } },
  ];
  const s = summarize('codex', rows);
  assert.deepEqual(s.models['gpt-6.1-sol'], { input: 500, cacheRead: 1500, cacheWrite5m: 0, cacheWrite1h: 0, output: 80 });
  near(s.units, 500 * 0.2 + 1500 * 0.01 + 80);
  near(s.cost, (500 * 50 + 1500 * 2.5 + 80 * 250) / 1e6); assert.equal(s.unit, 'credits');
});

test('compaction removes terminal noise but keeps every diagnostic', () => {
  const noise = Array.from({ length: 60 }, (_, i) => `\x1b[32mdownloading ${i}%\x1b[0m\r`).join('') + 'done\n';
  const repeated = 'WARN deprecated thing\n'.repeat(40);
  const raw = noise + repeated + 'Error: build failed at src/a.ts:12\n';
  const { text, removedBytes } = compactText(raw);
  assert.ok(removedBytes > 1000);
  assert.match(text, /Error: build failed at src\/a\.ts:12/);
  assert.match(text, /WARN deprecated thing\n\[Fewr: line above repeated 40 times\]/);
  assert.doesNotMatch(text, /\x1b\[/);
  assert.match(text, /^done$/m);
  assert.equal(compactText('short output').removedBytes, 0, 'small outputs are untouched');
});

test('node test reports drop passing records only; failures stay byte-for-byte', () => {
  const pass = n => `# Subtest: case ${n}\nok ${n} - case ${n}\n  ---\n  duration_ms: 0.1\n  type: 'test'\n  ...\n`;
  const fail = `# Subtest: broken\nnot ok 31 - broken\n  ---\n  duration_ms: 0.2\n  error: 'expected 1 got 2'\n  ...\n`;
  const report = 'TAP version 13\n' + Array.from({ length: 30 }, (_, i) => pass(i + 1)).join('') + fail + '1..31\n# tests 31\n# suites 0\n# pass 30\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.3\n';
  const { text, format } = compactText(report, { command: 'npm test' });
  assert.equal(format, 'node-test');
  assert.ok(text.includes(fail), 'failure record intact');
  assert.match(text, /30 passing test records omitted/);
  assert.match(text, /# fail 1/);
  assert.equal(compactText(report, { command: 'cat report.txt' }).format, undefined, 'only test commands use report parsing');
});

test('PostToolUse compacts Claude shell output, archives the original, and can be disabled', t => {
  const home = tmp(t);
  const response = { stdout: 'x\n'.repeat(2000) + 'tail\n', stderr: '', interrupted: false, isImage: false };
  const input = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: response, session_id: 's1', tool_use_id: 'u1' };
  const out = handleHook('claude', input, home, {});
  const value = out.hookSpecificOutput.updatedToolOutput;
  assert.ok(value.stdout.length < 200);
  const archived = value.stdout.match(/original output saved at (.+)\]$/)[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(archived, 'utf8')), response);
  assert.equal(readEvents(home).filter(e => e.type === 'compaction').length, 1);
  assert.deepEqual(handleHook('claude', input, home, { FEWR_DISABLE: 'compaction' }), {});
  assert.deepEqual(handleHook('claude', { ...input, tool_response: { ...response, isImage: true } }, home, {}), {});
});

test('only SessionStart adds text: the orchestrator brief, switchable off', t => {
  const home = tmp(t);
  for (const client of ['claude', 'codex']) {
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PreCompact', 'Stop']) {
      const out = handleHook(client, { hook_event_name: event, source: 'startup', prompt: 'Build a game', session_id: 's', cwd: home }, home, {});
      assert.equal(out.hookSpecificOutput?.additionalContext, undefined, `${client} ${event}`);
    }
    const brief = handleHook(client, { hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }, home, {}).hookSpecificOutput.additionalContext;
    assert.match(brief, /orchestrator mode: you are the lead/);
    assert.match(brief, client === 'claude' ? /fewr-worker/ : /fewr-medium/); assert.match(brief, /most expensive in this session, so hand off any subtask a cheaper worker can do equally well/);
    assert.match(brief, /escalate to your own model only if that fails twice/);
    assert.match(brief, /Keep for yourself: architecture; design-heavy work/, 'design stays with the lead');
    assert.match(brief, /security judgement \(threat analysis, exploitability, severity, and reviewing every security fix before accepting it\)/);
    assert.match(brief, /creative direction for media \(storyboard, visual style, script\)/);
    assert.match(brief, /asset, rendering or encoding pipelines/);
    assert.match(brief, /mostly design-heavy, do it without delegating/);

    assert.ok(Buffer.byteLength(brief) < 1400, 'brief stays short; it is re-read every turn');
    assert.deepEqual(handleHook(client, { hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }, home, { FEWR_DISABLE: 'orchestrate' }), {});
  }
  const claudeBrief = handleHook('claude', { hook_event_name: 'SessionStart', source: 'startup' }, home, {}).hookSpecificOutput.additionalContext;
  assert.match(claudeBrief, /haiku for lookups/); assert.match(claudeBrief, /sonnet with low effort for small, fully specified changes/); assert.match(claudeBrief, /sonnet high for tricky logic/); assert.match(claudeBrief, /Agent tool model and effort parameters/);
  const codexBrief = handleHook('codex', { hook_event_name: 'SessionStart', source: 'startup' }, home, {}).hookSpecificOutput.additionalContext;
  assert.match(codexBrief, /spawning the agent type that fits the subtask, with fork_turns "none" and no model or reasoning_effort/);
  assert.match(codexBrief, /fewr-light for lookups[\s\S]*fewr-low for small, fully specified changes[\s\S]*fewr-medium for standard logic[\s\S]*fewr-high for tricky logic/);
});

test('Stop records usage-weighted session usage from the transcript', t => {
  const home = tmp(t), transcript = path.join(home, 't.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 100 } } }) + '\n');
  handleHook('claude', { hook_event_name: 'Stop', session_id: 's9', transcript_path: transcript }, home, {});
  const usage = readEvents(home).find(e => e.type === 'usage');
  assert.equal(usage.units, 40000 * 0.05 + 100 * 5);
  assert.equal(usage.requests, 1);
});

const readResult = (file, content, startLine = 1) => ({ type: 'text', file: { filePath: file, content, numLines: content.split('\n').length, startLine, totalLines: 999 } });
const post = (tool, tool_input, tool_response, session = 'sess') => ({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input, tool_response, session_id: session });

test('identical re-reads of unchanged files return a stub until the file changes or context is compacted', t => {
  const home = tmp(t), content = 'const x = 1;\n'.repeat(80);
  const read = () => handleHook('claude', post('Read', { file_path: '/p/a.js' }, readResult('/p/a.js', content)), home, {});
  assert.deepEqual(read(), {}, 'first read passes through');
  const stub = read().hookSpecificOutput.updatedToolOutput;
  assert.equal(stub.type, 'text'); assert.equal(stub.file.filePath, '/p/a.js');
  assert.match(stub.file.content, /unchanged since you last read them/);
  assert.deepEqual(handleHook('claude', post('Read', { file_path: '/p/a.js' }, readResult('/p/a.js', content + 'y;\n')), home, {}), {}, 'new content passes through');
  handleHook('claude', post('Edit', { file_path: '/p/a.js' }, {}), home, {});
  assert.deepEqual(read(), {}, 'an edit invalidates the remembered read');
  handleHook('claude', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess' }, home, { FEWR_DISABLE: 'orchestrate' });
  assert.deepEqual(read(), {}, 'compaction removed the content, so it is sent again');
  assert.deepEqual(handleHook('claude', post('Read', { file_path: '/p/a.js', offset: 10, limit: 5 }, readResult('/p/a.js', content, 10)), home, {}), {}, 'a different range is a different read');
  assert.deepEqual(handleHook('claude', post('Read', { file_path: '/p/a.js' }, readResult('/p/a.js', content)), home, { FEWR_DISABLE: 'dedupe' }), {});
});

test('after compaction a facts-only digest restores changed files and recent requests', t => {
  const home = tmp(t);
  handleHook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'Fix the login bug', session_id: 'd1' }, home, {});
  handleHook('claude', post('Write', { file_path: '/p/login.js' }, {}, 'd1'), home, {});
  handleHook('claude', post('Edit', { file_path: '/p/auth.js' }, {}, 'd1'), home, {});
  const noBrief = { FEWR_DISABLE: 'orchestrate' };
  const out = handleHook('claude', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'd1' }, home, noBrief);
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /Files changed in this session: \/p\/auth\.js, \/p\/login\.js/);
  assert.match(text, /1\. Fix the login bug/);
  assert.doesNotMatch(text, /\b(?:must|should|always|never)\b/i, 'facts, not instructions');
  assert.deepEqual(handleHook('claude', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'empty' }, home, noBrief), {});
  assert.deepEqual(handleHook('claude', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'd1' }, home, { FEWR_DISABLE: 'digest,orchestrate' }), {});
  assert.match(handleHook('claude', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'd1' }, home, {}).hookSpecificOutput.additionalContext, /orchestrator mode/, 'the brief survives compaction');
});

test('fewr stats reports this chat with Fewr and a conservative cost estimate without it', t => {
  const home = tmp(t), projects = path.join(home, '.claude', 'projects'), cwd = '/work/my.app';
  const dir = path.join(projects, '-work-my-app');
  fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
  const row = (id, model, at, usage, sidechain) => JSON.stringify({ type: 'assistant', timestamp: at, isSidechain: sidechain, message: { id, model, usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, ...usage } } });
  fs.writeFileSync(path.join(dir, 's1.jsonl'), [row('a', 'claude-opus-5-5', '2026-10-22T10:00:00Z', { cache_creation_input_tokens: 10_000, output_tokens: 1_000 }),
    row('b', 'claude-opus-5-5', '2026-10-22T10:10:00Z', { cache_read_input_tokens: 10_000, output_tokens: 500 })].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 's1', 'subagents', 'agent-1.jsonl'), row('w', 'claude-sonnet-5-5', '2026-10-22T10:01:00Z', { cache_creation_input_tokens: 4_000, cache_read_input_tokens: 40_000, output_tokens: 2_000 }, true) + '\n');
  const file = findTranscript('claude', { cwd, env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') } });
  assert.equal(file, path.join(dir, 's1.jsonl'));
  assert.equal(findTranscript('claude', { session: 's1', env: { CLAUDE_CONFIG_DIR: path.join(home, '.claude') } }), file);
  const r = chatReport('claude', file, {});
  assert.equal(r.workers, 1); assert.equal(r.lead, 'claude-opus-5-5');
  assert.equal(r.with.raw, 11_000 + 10_500 + 46_000);
  near(r.with.cost, (10_000 * 8 + 1_000 * 20 + 10_000 * 0.2 + 500 * 20 + 4_000 * 4 + 40_000 * 0.1 + 2_000 * 10) / 1e6);
  const repriced = (10_000 * 8 + 1_500 * 20 + 10_000 * 0.2 + 4_000 * 8 + 40_000 * 0.2 + 2_000 * 20) / 1e6;
  const modelled = (10_000 * 8 + 1_500 * 20 + 10_000 * 0.2 + 4_000 * 8 + 2_000 * 20 + 6_000 * 1 * 0.2) / 1e6;
  near(r.without.cost, Math.min(repriced, modelled), 'the lower of the two estimates');
  assert.equal(r.with.activeMs, 10 * 60_000);
  // The worker's 6,000 new tokens, written once and re-read by the one later lead turn.
  assert.equal(r.without.raw, 21_500 + 6_000 + 6_000);
  // The lead wrote 1,500 tokens in 10 minutes, so the worker's 2,000 take 13 min 20 s at its pace.
  assert.equal(r.without.activeMs, 10 * 60_000 + 800_000);
  const text = formatReport(r);
  assert.match(text, /Claude Code · Opus 5\.5 lead, 1 worker/);
  assert.equal(r.active, false); assert.match(text, /Fewr was not active in this chat/);
  assert.match(text, /\| Raw tokens \| — \| 67,500 \| — \|/, 'no estimate when Fewr was not active');
  assert.match(text, /\| Cost \| — \| \$0\.\d\d \| — \|/);
  const shown = formatReport({ ...r, active: true });
  assert.match(shown, /\| Raw tokens \| 33,500 \(est\.\) \| 67,500 \| \+101\.5% \|/);
  assert.match(shown, /\| Cost \| \$0\.\d\d \(est\.\) \| \$0\.\d\d \| −\d/);
  assert.match(shown, /\| Build time \| 23 min \(est\.\) \| 10 min \| −57\.1% \|/);
  assert.equal(modelName('gpt-6.1-sol'), 'GPT-6.1 Sol'); assert.equal(modelName('claude-haiku-5-5'), 'Haiku 5.5');
});

test('a worker never runs on a pricier model than the lead', t => {
  const dir = tmp(t), transcript = path.join(dir, 'lead.jsonl');
  const lead = model => fs.writeFileSync(transcript, [
    JSON.stringify({ type: 'assistant', message: { id: 'a', model: 'claude-opus-5-5', usage: {} } }),
    JSON.stringify({ type: 'assistant', isSidechain: true, message: { id: 'w', model: 'claude-haiku-5-5', usage: {} } }),
    JSON.stringify({ type: 'assistant', message: { id: 'b', model, usage: {} } }),
  ].join('\n') + '\n');
  const spawn = tool_input => handleHook('claude', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input, transcript_path: transcript, session_id: 's' }, dir, {});
  const denied = out => out.hookSpecificOutput?.permissionDecision === 'deny';
  lead('claude-sonnet-5-5');
  assert.ok(denied(spawn({ subagent_type: 'fewr-worker', model: 'opus' })), 'Sonnet lead: no Opus worker');
  assert.ok(denied(spawn({ subagent_type: 'general-purpose', model: 'fable' })), 'nor Fable, on any agent');
  assert.deepEqual(spawn({ subagent_type: 'fewr-worker', model: 'sonnet' }), {});
  assert.deepEqual(spawn({ subagent_type: 'fewr-worker', model: 'haiku' }), {});
  lead('claude-haiku-5-5');
  assert.ok(denied(spawn({ subagent_type: 'fewr-worker' })), 'Haiku lead: the default Sonnet worker is pricier');
  assert.deepEqual(spawn({ subagent_type: 'Explore' }), {}, 'agents without a model are not Fewr\'s choice');
  lead('claude-fable-5-1');
  assert.deepEqual(spawn({ subagent_type: 'fewr-worker', model: 'opus' }), {});
  assert.deepEqual(handleHook('claude', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { model: 'opus' }, session_id: 's' }, dir, {}), {}, 'no transcript: no check');
  assert.match(handleHook('claude', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }, dir, {}).hookSpecificOutput.additionalContext, /On haiku, don't delegate\./);
});

test('file-printing commands are never rewritten; blank lines are never collapsed', () => {
  const file = 'def f():\n' + '    pass\n'.repeat(30) + '\n'.repeat(8) + '    \n'.repeat(6) + '# end\r\n' + '\x1b[0m\n';
  for (const command of ['cat main.py', 'sed -n 1,200p x.py', 'FOO=1 sudo -n head -n 500 a | grep x', 'cd src && git --no-pager show HEAD:a.py', 'git -C . diff', 'ls; tail -f x', 'diff a b']) {
    assert.deepEqual(compactText(file, { command }), { text: file, removedBytes: 0 }, command);
  }
  const log = 'building\n' + 'compiling module\n'.repeat(120) + '\n'.repeat(20) + '   \n'.repeat(10) + 'done\n';
  for (const command of ['make', 'npm run build', 'git status', 'echo cat', undefined]) {
    const { text } = compactText(log, { command });
    assert.match(text, /compiling module\n\[Fewr: line above repeated 120 times\]/, String(command));
    assert.ok(text.includes('\n'.repeat(20) + '   \n'.repeat(10)), 'blank runs intact');
  }
  assert.equal(compactText('\n'.repeat(2000)).removedBytes, 0);
  // Only a pipeline's first stage decides: later stages are filters over its output.
  for (const command of ['cat a.py | head -40', 'git diff | head', 'ls; tail x.log', 'cd x && sed -n 1,80p f.py']) assert.equal(compactText(log, { command }).removedBytes, 0, command);
  for (const command of ['npm test 2>&1 | tail -50', 'make 2>&1 | tail -n 100', 'pytest -q | tee out.txt', 'make | sed s/a/b/ | awk 1']) assert.ok(compactText(log, { command }).removedBytes > 0, command);
});

test('local data directories are private and old saved outputs and sessions are pruned on SessionStart', t => {
  const home = path.join(tmp(t), '.fewr'), day = 864e5, now = Date.now();
  const make = (dir, name, age) => { const f = path.join(home, dir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{}'); fs.utimesSync(f, (now - age) / 1000, (now - age) / 1000); return f; };
  const oldOut = make('outputs', 'old.json', 8 * day), newOut = make('outputs', 'new.json', 6 * day);
  const oldSess = make('sessions', 'old.json', 31 * day), newSess = make('sessions', 'mid.json', 10 * day);
  fs.mkdirSync(path.join(home, 'outputs', 'subdir')); fs.symlinkSync('/nonexistent', path.join(home, 'outputs', 'dangling'));
  fs.writeFileSync(path.join(home, 'outputs', 'x'), ''); fs.rmSync(path.join(home, 'outputs', 'x'));
  assert.doesNotThrow(() => handleHook('claude', { hook_event_name: 'SessionStart', source: 'startup', session_id: 's' }, home, {}));
  assert.ok(!fs.existsSync(oldOut) && !fs.existsSync(oldSess));
  assert.ok(fs.existsSync(newOut) && fs.existsSync(newSess) && fs.existsSync(path.join(home, 'outputs', 'subdir')));
  assert.doesNotThrow(() => pruneOld(path.join(home, 'missing')));
  assert.doesNotThrow(() => pruneOld(path.join(home, 'outputs', 'new.json')), 'a file where a directory is expected');
  // Created directories are owner-only, and an existing looser one is tightened.
  const fresh = path.join(tmp(t), 'h');
  const input = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'make' }, tool_response: { stdout: 'x\n'.repeat(2000), stderr: '' }, session_id: 'p' };
  fs.mkdirSync(path.join(fresh, 'outputs'), { recursive: true, mode: 0o755 }); fs.chmodSync(path.join(fresh, 'outputs'), 0o755);
  handleHook('claude', input, fresh, {});
  handleHook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 'p' }, fresh, {});
  if (process.platform !== 'win32') for (const d of ['outputs', 'sessions']) assert.equal(fs.statSync(path.join(fresh, d)).mode & 0o777, 0o700, d);
});

test('Codex SessionStart and Stop produce valid JSON hook output', t => {
  const home = tmp(t), transcript = path.join(home, 'rollout.jsonl');
  fs.writeFileSync(transcript, '');
  const start = handleHook('codex', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'c1' }, home, {});
  const parsed = JSON.parse(JSON.stringify(start));
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(typeof parsed.hookSpecificOutput.additionalContext, 'string');
  const stop = handleHook('codex', { hook_event_name: 'Stop', session_id: 'c1', transcript_path: transcript }, home, {});
  assert.deepEqual(JSON.parse(JSON.stringify(stop)), {});
  assert.deepEqual(handleHook('codex', { hook_event_name: 'Stop', session_id: 'c1' }, home, {}), {});
});
