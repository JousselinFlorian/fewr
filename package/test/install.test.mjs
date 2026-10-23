import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { install, uninstall } from '../src/install.mjs';
import { hash } from '../src/store.mjs';

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
  assert.deepEqual(fs.readdirSync(path.join(s.userHome, '.claude', 'skills')), ['fewr'], 'only the stats skill');
});

test('the fewr skill is installed as a chat command on both clients and removed on uninstall', t => {
  const s = setup(t);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  const claude = fs.readFileSync(path.join(s.userHome, '.claude/skills/fewr/SKILL.md'), 'utf8');
  assert.match(claude, /^---\nname: fewr\n[\s\S]*disable-model-invocation: true\n---/);
  assert.match(claude, /bin\/fewr\.mjs' stats --client claude --session '\$\{CLAUDE_SESSION_ID\}' --cwd "\$PWD"/);
  const codex = fs.readFileSync(path.join(s.userHome, '.agents/skills/fewr/SKILL.md'), 'utf8');
  assert.match(codex, /stats --client codex --cwd "\$PWD"/);
  assert.match(fs.readFileSync(path.join(s.userHome, '.agents/skills/fewr/agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/);
  const runtime = JSON.parse(fs.readFileSync(path.join(s.home, 'installation.json'), 'utf8')).clients.claude.runtime;
  assert.ok(fs.existsSync(path.join(runtime, 'bin', 'fewr.mjs')), 'skills point at the installed runtime');
  uninstall({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.equal(fs.existsSync(path.join(s.userHome, '.claude/skills/fewr')), false);
  assert.equal(fs.existsSync(path.join(s.userHome, '.agents/skills/fewr')), false);
});

test('install refuses to run beside the legacy version and changes nothing', t => {
  const s = setup(t);
  const legacy = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: "'/n/node' '/u/.shyft/runtime/shyft-905ea940b69c14f2.mjs' hook claude" }] }] } });
  fs.writeFileSync(s.claude, legacy);
  assert.throws(() => install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env }), /An older version of Fewr \(Shyft\) is installed for claude\. Uninstall it first, then run this again; nothing was changed\./);
  assert.equal(fs.readFileSync(s.claude, 'utf8'), legacy);
});

test('uninstall removes exactly the installed commands and keeps the user\'s hooks', t => {
  const s = setup(t);
  fs.writeFileSync(s.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  uninstall({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
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
  assert.equal(manifest.clients.codex.agents.length, 6, 'four roles plus the fewr skill files');
  uninstall({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  for (const f of ['.claude/agents/fewr-worker.md', ...roles.map(r => `.codex/agents/${r}`)]) assert.equal(fs.existsSync(path.join(s.userHome, f)), false, f);
  fs.mkdirSync(path.join(s.userHome, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(s.userHome, '.claude/agents/fewr-worker.md'), 'my own agent');
  assert.throws(() => install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env }), /Keeping your existing file .*Rename or delete it, then run the install again\./);
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

// Simulates the skill files an earlier version installed under skills/fewrstats.
function oldSkill(s, client, edited) {
  const dirs = client === 'claude' ? [path.join(s.userHome, '.claude/skills/fewrstats')] : [path.join(s.userHome, '.agents/skills/fewrstats'), path.join(s.userHome, '.agents/skills/fewrstats/agents')];
  const files = [{ file: path.join(dirs[0], 'SKILL.md'), text: '---\nname: fewrstats\n---\nold\n' }, ...(client === 'codex' ? [{ file: path.join(dirs[1], 'openai.yaml'), text: 'policy:\n  allow_implicit_invocation: false\n' }] : [])];
  for (const { file, text } of files) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
  const manifestFile = path.join(s.home, 'installation.json');
  const manifest = fs.existsSync(manifestFile) ? read(manifestFile) : { clients: {} };
  (manifest.clients[client] ||= { agents: [] }).agents.push(...files.map(f => ({ path: f.file, hash: hash(f.text) })));
  fs.mkdirSync(s.home, { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  if (edited) fs.writeFileSync(files[0].file, files[0].text + 'mine\n');
  return files.map(f => f.file);
}

test('a fresh install writes the fewr skill on both clients', t => {
  const s = setup(t);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.match(fs.readFileSync(path.join(s.userHome, '.claude/skills/fewr/SKILL.md'), 'utf8'), /^---\nname: fewr\n/);
  assert.match(fs.readFileSync(path.join(s.userHome, '.agents/skills/fewr/SKILL.md'), 'utf8'), /^---\nname: fewr\n/);
  assert.ok(fs.existsSync(path.join(s.userHome, '.agents/skills/fewr/agents/openai.yaml')));
});

test('upgrading removes the old fewrstats skill and its folders', t => {
  const s = setup(t);
  const old = [...oldSkill(s, 'claude'), ...oldSkill(s, 'codex')];
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  for (const f of old) assert.equal(fs.existsSync(f), false, f);
  assert.equal(fs.existsSync(path.join(s.userHome, '.claude/skills/fewrstats')), false);
  assert.equal(fs.existsSync(path.join(s.userHome, '.agents/skills/fewrstats')), false);
  assert.ok(fs.existsSync(path.join(s.userHome, '.claude/skills/fewr/SKILL.md')));
  assert.ok(fs.existsSync(path.join(s.userHome, '.agents/skills/fewr/SKILL.md')));
});

test('upgrading keeps an old fewrstats skill the user edited', t => {
  const s = setup(t);
  const [file] = oldSkill(s, 'claude', true);
  install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env });
  assert.match(fs.readFileSync(file, 'utf8'), /mine/);
  assert.ok(fs.existsSync(path.join(s.userHome, '.claude/skills/fewr/SKILL.md')));
});

test('uninstall removes the whole fewr skill folder but keeps skills/ when it holds other skills', t => {
  const s = setup(t);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  for (const root of ['.claude', '.agents']) { fs.mkdirSync(path.join(s.userHome, root, 'skills/other'), { recursive: true }); fs.writeFileSync(path.join(s.userHome, root, 'skills/other/SKILL.md'), 'x'); }
  uninstall({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  for (const root of ['.claude', '.agents']) {
    assert.equal(fs.existsSync(path.join(s.userHome, root, 'skills/fewr')), false);
    assert.deepEqual(fs.readdirSync(path.join(s.userHome, root, 'skills')), ['other']);
  }
});

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Runs bin/fewr.mjs from `bin` with a temp HOME so nothing touches the real one.
function cli(s, args, bin = path.join(PACKAGE, 'bin/fewr.mjs')) {
  const env = { ...process.env, HOME: s.userHome, USERPROFILE: s.userHome };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'FEWR_HOME']) delete env[key];
  return spawnSync(process.execPath, [bin, ...args, '--home', s.home], { env, encoding: 'utf8' });
}
const fewrGroups = (cfg, event) => (cfg.hooks[event] || []).filter(g => g.hooks.some(h => /\/runtime\/[0-9a-f]{16}\/bin\/fewr\.mjs' hook /.test(h.command)));

test('installs from a package folder whose path has a space and non-ASCII characters', t => {
  const s = setup(t);
  const lib = path.join(path.dirname(s.home), 'my pkg é');
  for (const dir of ['bin', 'src']) fs.cpSync(path.join(PACKAGE, dir), path.join(lib, dir), { recursive: true });
  const result = cli(s, ['install', '--client', 'claude'], path.join(lib, 'bin/fewr.mjs'));
  assert.equal(result.status, 0, result.stderr);
  assert.ok(commands(read(s.claude)).length > 0);
});

test('a config that cannot be read is never overwritten; only a missing one counts as empty', t => {
  const s = setup(t);
  fs.mkdirSync(s.claude);
  assert.throws(() => install({ clients: ['claude'], home: s.home, userHome: s.userHome, env: s.env }), /Cannot read .*settings\.json \(EISDIR\); nothing was changed\./);
  assert.ok(fs.statSync(s.claude).isDirectory());
  assert.equal(fs.existsSync(s.home), false, 'nothing written');
});

test('uninstall does not recreate a config file that is gone', t => {
  const s = setup(t);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  fs.rmSync(s.claude); fs.rmSync(s.codex);
  uninstall({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.equal(fs.existsSync(s.claude), false);
  assert.equal(fs.existsSync(s.codex), false);
});

test('a symlinked config stays a symlink and its target gets the hooks (Claude and Codex)', t => {
  const s = setup(t);
  for (const [client, link] of [['claude', s.claude], ['codex', s.codex]]) {
    const target = path.join(path.dirname(s.home), `dotfiles-${client}.json`);
    fs.writeFileSync(target, JSON.stringify({ keep: 1 }), { mode: 0o644 });
    fs.symlinkSync(target, link);
    install({ clients: [client], home: s.home, userHome: s.userHome, env: s.env });
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${client} link survives`);
    assert.equal(fs.readlinkSync(link), target);
    assert.equal(read(target).keep, 1);
    assert.ok(commands(read(target)).length > 0, `${client} target has the hooks`);
    uninstall({ clients: [client], home: s.home, userHome: s.userHome, env: s.env });
    assert.ok(fs.lstatSync(link).isSymbolicLink(), `${client} link survives uninstall`);
    assert.deepEqual(read(target), { keep: 1 });
  }
});

test('an existing config keeps its permission bits; new files stay 0600', t => {
  const s = setup(t);
  fs.writeFileSync(s.claude, '{}'); fs.chmodSync(s.claude, 0o644);
  fs.writeFileSync(s.codex, '{}'); fs.chmodSync(s.codex, 0o640);
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.equal(fs.statSync(s.claude).mode & 0o777, 0o644);
  assert.equal(fs.statSync(s.codex).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(s.home, 'installation.json')).mode & 0o777, 0o600);
});

test('an unknown client is refused before anything is written', t => {
  const s = setup(t);
  assert.throws(() => install({ clients: ['claude', 'cluade'], home: s.home, userHome: s.userHome, env: s.env }), /Unknown client "cluade"; use claude, codex or both\./);
  const result = cli(s, ['install', '--client', 'cluade']);
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), 'Unknown client "cluade"; use claude, codex or both.');
  assert.deepEqual(fs.readdirSync(path.join(s.userHome, '.claude')), []);
  assert.deepEqual(fs.readdirSync(path.join(s.userHome, '.codex')), []);
  assert.deepEqual(fs.readdirSync(path.dirname(s.userHome)).sort(), ['user'], 'no state folder either');
});

test('a malformed hooks section is refused and nothing is changed (Claude and Codex)', t => {
  const s = setup(t);
  for (const [client, file] of [['claude', s.claude], ['codex', s.codex]]) {
    for (const bad of [{ hooks: { Stop: { hooks: [] } } }, { hooks: { Stop: [null] } }, { hooks: [] }, { hooks: null }, { hooks: { Stop: [{ hooks: 'x' }] } }]) {
      const text = JSON.stringify(bad);
      fs.writeFileSync(file, text);
      assert.throws(() => install({ clients: [client], home: s.home, userHome: s.userHome, env: s.env }), new RegExp(`Unexpected hooks format in .*${path.basename(file)}; nothing was changed\\.`), text);
      assert.equal(fs.readFileSync(file, 'utf8'), text);
      assert.equal(fs.existsSync(s.home), false, 'no runtime copied');
    }
  }
});

test('reinstalling after the manifest is deleted does not duplicate hooks (Claude and Codex)', t => {
  const s = setup(t);
  fs.writeFileSync(s.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  fs.rmSync(path.join(s.home, 'installation.json'));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  for (const [client, file] of [['claude', s.claude], ['codex', s.codex]]) for (const event of Object.keys(read(file).hooks)) {
    if (client === 'codex' || event !== 'Stop') assert.equal(fewrGroups(read(file), event).length, 1, `${client} ${event}`);
  }
  assert.equal(fewrGroups(read(s.claude), 'Stop').length, 1);
  assert.ok(commands(read(s.claude)).includes('echo mine'));
});

test('uninstalling without a manifest still strips Fewr\'s hooks and keeps the user\'s', t => {
  const s = setup(t);
  fs.writeFileSync(s.claude, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  fs.rmSync(path.join(s.home, 'installation.json'));
  uninstall({ home: s.home, userHome: s.userHome, env: s.env });
  assert.deepEqual(commands(read(s.claude)), ['echo mine']);
  assert.deepEqual(read(s.codex), {});
});

test('install then uninstall leaves the user\'s empty groups and events untouched (Claude and Codex)', t => {
  const s = setup(t);
  const original = { theme: 'dark', hooks: { Stop: [{ matcher: 'x' }, { hooks: [] }, { hooks: [{ type: 'command', command: 'echo mine' }] }], Other: [], SessionStart: [{ matcher: 'y', hooks: [] }] } };
  for (const file of [s.claude, s.codex]) fs.writeFileSync(file, JSON.stringify(original));
  install({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  uninstall({ clients: ['claude', 'codex'], home: s.home, userHome: s.userHome, env: s.env });
  assert.deepEqual(read(s.claude), original);
  assert.deepEqual(read(s.codex), original);
});

test('uninstall when nothing is installed says so and writes no manifest', t => {
  const s = setup(t);
  const result = cli(s, ['uninstall']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'Fewr is not installed.');
  assert.equal(fs.existsSync(path.join(s.home, 'installation.json')), false);
  assert.equal(uninstall({ home: s.home, userHome: s.userHome, env: s.env }).installed, false);
});
