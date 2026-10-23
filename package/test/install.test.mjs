import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, uninstall } from '../src/install.mjs';

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fewr2-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userHome = path.join(root, 'user'), home = path.join(root, 'state');
  fs.mkdirSync(path.join(userHome, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(userHome, '.codex'), { recursive: true });
  return { userHome, home, env: {}, claude: path.join(userHome, '.claude', 'settings.json'), codex: path.join(userHome, '.codex', 'hooks.json') };
}
const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const commands = cfg => Object.values(cfg.hooks || {}).flat().flatMap(g => g.hooks.map(h => h.command));

test('install adds only hooks, preserves unrelated settings, and is idempotent', t => {
  const s = setup(t);
  fs.writeFileSync(s.claude, JSON.stringify({ permissions: { deny: ['Bash(rm *)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  const first = fs.readFileSync(s.claude, 'utf8'), cfg = JSON.parse(first);
  assert.equal(cfg.hooks.SessionStart[0].matcher, undefined);
  assert.deepEqual(cfg.permissions, { deny: ['Bash(rm *)'] });
  assert.ok(commands(cfg).includes('echo mine'));
  assert.equal(cfg.hooks.PostToolUse[0].matcher, '^(Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit)$');
  assert.equal(cfg.hooks.PreToolUse[0].matcher, '^(Agent|Task)$');
  assert.deepEqual(Object.keys(read(s.codex).hooks).sort(), ['SessionStart', 'Stop']);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.equal(fs.readFileSync(s.claude, 'utf8'), first, 'reinstall changes nothing');
  assert.deepEqual(fs.readdirSync(path.join(s.userHome, '.claude', 'agents')).sort(), ['fewr-worker.md'], 'only the worker agent');
  assert.deepEqual(fs.readdirSync(path.join(s.userHome, '.claude', 'skills')), ['fewrstats'], 'only the stats skill');
});

test('fewrstats is installed as a chat command on both clients and removed on uninstall', t => {
  const s = setup(t);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  const claude = fs.readFileSync(path.join(s.userHome, '.claude/skills/fewrstats/SKILL.md'), 'utf8');
  assert.match(claude, /^---\nname: fewrstats\n[\s\S]*disable-model-invocation: true\n---/);
  assert.match(claude, /bin\/fewr\.mjs' stats --client claude --session '\$\{CLAUDE_SESSION_ID\}' --cwd "\$PWD"/);
  const codex = fs.readFileSync(path.join(s.userHome, '.agents/skills/fewrstats/SKILL.md'), 'utf8');
  assert.match(codex, /stats --client codex --cwd "\$PWD"/);
  assert.match(fs.readFileSync(path.join(s.userHome, '.agents/skills/fewrstats/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  const runtime = JSON.parse(fs.readFileSync(path.join(s.home, 'installation.json'), 'utf8')).clients.claude.runtime;
  assert.ok(fs.existsSync(path.join(runtime, 'bin', 'fewr.mjs')), 'skills point at the installed runtime');
  uninstall({ clients: ['claude', 'codex'], home: s.home });
  assert.equal(fs.existsSync(path.join(s.userHome, '.claude/skills/fewrstats')), false);
  assert.equal(fs.existsSync(path.join(s.userHome, '.agents/skills/fewrstats')), false);
});

test('install refuses to run beside the legacy version and changes nothing', t => {
  const s = setup(t);
  const legacy = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "'/n/node' '/u/.shyft/runtime/shyft-905ea940b69c14f2.mjs' hook claude" }] }] } });
  fs.writeFileSync(s.claude, legacy);
  assert.throws(() => install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env }), /previous version \(Shyft\)/);
  assert.equal(fs.readFileSync(s.claude, 'utf8'), legacy);
});

test('uninstall removes exactly the installed commands and keeps the user\'s hooks', t => {
  const s = setup(t);
  fs.writeFileSync(s.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  uninstall({ clients: ['claude', 'codex'], home: s.home });
  assert.deepEqual(commands(read(s.claude)), ['echo mine']);
  assert.deepEqual(read(s.codex), {});
});

test('installed hook command runs and returns valid JSON', async t => {
  const s = setup(t);
  install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env });
  const command = read(s.claude).hooks.PostToolUse[0].hooks[0].command;
  const { execSync } = await import('node:child_process');
  const input = JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a\n'.repeat(3000), stderr: '', interrupted: false, isImage: false } });
  const out = JSON.parse(execSync(command, { input }).toString());
  assert.ok(out.hookSpecificOutput.updatedToolOutput.stdout.length < 300);
  assert.deepEqual(JSON.parse(execSync(command, { input: 'not json' }).toString()), {}, 'malformed input never breaks the session');
});

test('Claude gets one dynamic worker, Codex one role per tier from its catalog; user files kept; removed on uninstall', t => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.userHome, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'gpt-6-luna', visibility: 'list' }] }));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.match(fs.readFileSync(path.join(s.userHome, '.claude/agents/fewr-worker.md'), 'utf8'), /^---\nname: fewr-worker\n[\s\S]*model: sonnet\neffort: medium\n---/);
  const roles = ['fewr-high.toml', 'fewr-light.toml', 'fewr-low.toml', 'fewr-medium.toml'];
  assert.deepEqual(fs.readdirSync(path.join(s.userHome, '.codex/agents')).sort(), roles, 'Codex ignores per-spawn effort, so each tier is its own role');
  const role = name => fs.readFileSync(path.join(s.userHome, '.codex/agents', name), 'utf8');
  assert.match(role('fewr-high.toml'), /model = "gpt-6.1-sol"\nmodel_reasoning_effort = "high"/);
  assert.match(role('fewr-low.toml'), /model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"/);
  assert.match(role('fewr-light.toml'), /model = "gpt-6-luna"\nmodel_reasoning_effort = "low"/);
  const manifest = JSON.parse(fs.readFileSync(path.join(s.home, 'installation.json'), 'utf8'));
  assert.equal(manifest.clients.codex.workers.light, 'gpt-6-luna');
  assert.equal(manifest.clients.codex.agents.length, 6, 'four roles plus the fewrstats skill files');
  uninstall({ clients: ['claude', 'codex'], home: s.home });
  for (const f of ['.claude/agents/fewr-worker.md', ...roles.map(r => `.codex/agents/${r}`)]) assert.equal(fs.existsSync(path.join(s.userHome, f)), false, f);
  fs.mkdirSync(path.join(s.userHome, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(s.userHome, '.claude/agents/fewr-worker.md'), 'my own agent');
  assert.throws(() => install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env }), /Keeping your existing file/);
  assert.equal(fs.readFileSync(path.join(s.userHome, '.claude/agents/fewr-worker.md'), 'utf8'), 'my own agent');
});

test('upgrading removes worker files an earlier version installed, if unedited', async t => {
  const s = setup(t);
  const old = path.join(s.userHome, '.claude/agents/fewr-implementer.md');
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'old agent');
  fs.mkdirSync(s.home, { recursive: true });
  const { createHash } = await import('node:crypto');
  fs.writeFileSync(path.join(s.home, 'installation.json'), JSON.stringify({ clients: { claude: { file: s.claude, commands: [], agents: [{ path: old, hash: createHash('sha256').update('old agent').digest('hex') }] } } }));
  install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env });
  assert.equal(fs.existsSync(old), false);
});

test('an agent-file conflict on one client leaves every client untouched', t => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.userHome, '.codex/agents'), { recursive: true });
  fs.writeFileSync(path.join(s.userHome, '.codex/agents/fewr-medium.toml'), 'mine');
  assert.throws(() => install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env }), /Keeping your existing file/);
  assert.equal(fs.existsSync(s.claude), false);
  assert.equal(fs.existsSync(path.join(s.userHome, '.claude/agents/fewr-worker.md')), false);
});
