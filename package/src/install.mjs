// Installs native hooks, the orchestrator's worker agents and the fewr skill; no MCP server or
// policy files.
// Unrelated settings are preserved, modified files are backed up, and uninstall removes exactly
// the commands recorded in the manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, hash, readJson } from './store.mjs';
import { workerModels, agentFiles, agentPath } from './orchestrate.mjs';

const LIBRARY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`;
const LEGACY = /[/\\]\.shyft[/\\]runtime[/\\]shyft-[0-9a-f]+\.mjs/;
const CLIENTS = ['claude', 'codex'];
// A hook command Fewr wrote, recognisable without the manifest (the runtime folder is a 16-hex content hash).
const fewrCommand = (command, client) => typeof command === 'string' && new RegExp(`[/\\\\]runtime[/\\\\][0-9a-f]{16}[/\\\\]bin[/\\\\]fewr\\.mjs' hook ${client}(\\s|$)`).test(command);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const checkClients = clients => { for (const client of clients) if (!CLIENTS.includes(client)) throw new Error(`Unknown client "${client}"; use claude, codex or both.`); };

export function clientPaths(home = os.homedir(), env = process.env) {
  const claude = path.resolve(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  const codex = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
  return { claude: path.join(claude, 'settings.json'), codex: path.join(codex, 'hooks.json'), claudeDir: claude, codexDir: codex };
}

// Hook events each client needs. Mechanisms add events here as they are introduced.
export function hookEvents(client) {
  return client === 'claude'
    ? { PreToolUse: '^(Agent|Task)$', PostToolUse: '^(Bash|PowerShell|Read|Edit|Write|MultiEdit|NotebookEdit)$', UserPromptSubmit: undefined, SessionStart: undefined, Stop: undefined, SessionEnd: undefined }
    : { SessionStart: undefined, Stop: undefined };
}

// Only a missing file counts as empty; any other read error must stop before something is overwritten.
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`Cannot read ${file} (${error.code}); nothing was changed.`);
  }
}

// null when the file does not exist.
function readConfig(file) {
  const text = readText(file);
  if (text === null) return null;
  let data;
  try { data = JSON.parse(text || '{}'); } catch { throw new Error(`Cannot parse ${file}; nothing was changed.`); }
  if (!isObject(data)) throw new Error(`Expected a JSON object in ${file}; nothing was changed.`);
  const groupOk = g => isObject(g) && (g.hooks === undefined || (Array.isArray(g.hooks) && g.hooks.every(isObject)));
  if (data.hooks !== undefined && !(isObject(data.hooks) && Object.values(data.hooks).every(groups => Array.isArray(groups) && groups.every(groupOk)))) throw new Error(`Unexpected hooks format in ${file}; nothing was changed.`);
  return data;
}

// Removes the commands `match` accepts; a group or event goes only if this emptied it. Returns how many were removed.
function removeCommands(config, match) {
  let total = 0;
  for (const [event, groups] of Object.entries(config.hooks || {})) {
    let removed = 0;
    const kept = groups.flatMap(g => {
      const hooks = (g.hooks || []).filter(h => !match(h.command));
      if (hooks.length === (g.hooks || []).length) return [g];
      removed += g.hooks.length - hooks.length;
      return hooks.length ? [{ ...g, hooks }] : [];
    });
    if (!removed) continue;
    total += removed;
    if (kept.length) config.hooks[event] = kept; else delete config.hooks[event];
  }
  if (total && !Object.keys(config.hooks).length) delete config.hooks;
  return total;
}

const legacyCommands = config => Object.values(config.hooks || {}).flat().flatMap(g => g?.hooks || []).map(h => h.command).filter(c => typeof c === 'string' && LEGACY.test(c));

// The runtime is a content-addressed copy of the package, so hooks and skills never point into npx's cache.
function runtimeFiles(home) {
  const files = ['bin/fewr.mjs', ...fs.readdirSync(path.join(LIBRARY, 'src')).filter(f => f.endsWith('.mjs')).map(f => `src/${f}`)];
  const contents = files.map(f => [f, fs.readFileSync(path.join(LIBRARY, f), 'utf8')]);
  return { dir: path.join(home, 'runtime', hash(contents.map(([f, t]) => f + '\0' + t).join('\0')).slice(0, 16)), contents };
}

// /fewr (Claude Code skill, with the session id) and $fewr (Codex skill, by working directory).
function statsSkillFiles(client, { node, runtime, home, paths, userHome }) {
  const session = client === 'claude' ? " --session '${CLAUDE_SESSION_ID}'" : '';
  const command = `${quote(node)} ${quote(path.join(runtime, 'bin', 'fewr.mjs'))} stats --client ${client}${session} --cwd "$PWD" --home ${quote(home)}`;
  const text = `---\nname: fewr\ndescription: Show this chat's raw tokens, cost and build time with Fewr, next to an estimate without it. Use only when the user asks for Fewr stats.\n${client === 'claude' ? 'disable-model-invocation: true\n' : ''}---\n\nRun this command in the current working directory:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nReturn its output verbatim: the Markdown table and every line under it. Do not estimate, recalculate or add savings figures yourself. If the command fails, report its error.\n`;
  const dir = client === 'claude' ? path.join(paths.claudeDir, 'skills', 'fewr') : path.join(userHome, '.agents', 'skills', 'fewr');
  return [{ file: path.join(dir, 'SKILL.md'), text }, ...(client === 'codex' ? [{ file: path.join(dir, 'agents', 'openai.yaml'), text: 'policy:\n  allow_implicit_invocation: false\n' }] : [])];
}

// Removes the emptied folders of a Fewr skill (current or the former fewrstats), stopping at the first one that is not.
function removeEmptySkillDirs(file) {
  for (let dir = path.dirname(file); /[\\/]skills[\\/](fewr|fewrstats)([\\/]|$)/.test(dir); dir = path.dirname(dir)) { try { fs.rmdirSync(dir); } catch { break; } }
}

function backupAndWrite(home, file, text) {
  const original = readText(file);
  if (original === text) return false;
  if (original !== null) atomicWrite(path.join(home, 'backups', `${new Date().toISOString().replaceAll(':', '-')}-${hash(file).slice(0, 8)}.bak`), original);
  atomicWrite(file, text);
  return true;
}

export function install({ clients, home, userHome = os.homedir(), env = process.env, node = process.execPath }) {
  checkClients(clients);
  const paths = clientPaths(userHome, env), manifestFile = path.join(home, 'installation.json');
  const manifest = readJson(manifestFile, { clients: {} });
  // Validate every target before writing anything.
  const configs = Object.fromEntries(clients.map(client => [client, readConfig(paths[client]) || {}]));
  const agents = {}, { dir: runtime, contents } = runtimeFiles(home);
  for (const client of clients) {
    if (legacyCommands(configs[client]).length) throw new Error(`An older version of Fewr (Shyft) is installed for ${client}. Uninstall it first, then run this again; nothing was changed.`);
    // A worker agent file is ours only if we wrote it; never overwrite a user's file.
    const models = workerModels(client, paths.codexDir), owned = manifest.clients[client]?.agents || [];
    const planned = [...agentFiles(client, models).map(({ name, text }) => ({ file: agentPath(client, client === 'claude' ? paths.claudeDir : paths.codexDir, name), text })),
      ...statsSkillFiles(client, { node, runtime, home, paths, userHome })];
    const files = planned.map(({ file, text }) => {
      const current = readText(file);
      if (current !== null && current !== text && !owned.some(o => o.path === file && o.hash === hash(current))) throw new Error(`Keeping your existing file ${file}. Rename or delete it, then run the install again.`);
      return { file, text, current };
    });
    agents[client] = { models, files };
  }
  const changed = [];
  for (const [f, t] of contents) atomicWrite(path.join(runtime, f), t);
  for (const client of clients) {
    const config = configs[client], command = `${quote(node)} ${quote(path.join(runtime, 'bin', 'fewr.mjs'))} hook ${client} --home ${quote(home)}`;
    // Our earlier commands go by the manifest or, if it is gone, by their shape, so a reinstall never duplicates them.
    const recorded = manifest.clients[client]?.commands || [];
    removeCommands(config, c => recorded.includes(c) || fewrCommand(c, client));
    config.hooks ||= {};
    for (const [event, matcher] of Object.entries(hookEvents(client))) {
      (config.hooks[event] ||= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: 10, ...(client === 'codex' ? { statusMessage: `Fewr: ${event === 'Stop' ? 'record usage' : event}` } : {}) }] });
    }
    const { models, files } = agents[client];
    for (const { file, text, current } of files) if (current !== text) { atomicWrite(file, text); changed.push(file); }
    // Agents from an earlier install that this version no longer ships are removed if unedited.
    for (const old of manifest.clients[client]?.agents || []) {
      if (files.some(f => f.file === old.path)) continue;
      try { if (hash(fs.readFileSync(old.path, 'utf8')) === old.hash) { fs.rmSync(old.path); changed.push(old.path); removeEmptySkillDirs(old.path); } } catch { /* gone */ }
    }
    const entry = { file: paths[client], commands: [command], runtime, workers: models, agents: files.map(f => ({ path: f.file, hash: hash(f.text) })) };
    if (backupAndWrite(home, paths[client], JSON.stringify(config, null, 2) + '\n')) changed.push(paths[client]);
    manifest.clients[client] = entry;
  }
  atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return { changed, runtime, notes: clients.includes('codex') ? ['Codex: open /hooks and trust the new Fewr hooks; they stay inactive until reviewed.'] : [] };
}

// Without `clients`: every client that has a manifest entry or a configuration folder. `installed` is false
// when there was nothing of Fewr's to remove.
export function uninstall({ clients, home, userHome = os.homedir(), env = process.env }) {
  const paths = clientPaths(userHome, env), manifestFile = path.join(home, 'installation.json'), manifest = readJson(manifestFile, { clients: {} }), changed = [];
  if (clients) checkClients(clients);
  const targets = (clients || CLIENTS.filter(client => manifest.clients[client] || fs.existsSync(paths[`${client}Dir`]))).map(client => {
    const entry = manifest.clients[client], file = entry?.file || paths[client];
    return { client, entry, file, config: readConfig(file) };
  });
  let installed = false;
  for (const { client, entry, file, config } of targets) {
    if (entry) installed = true;
    if (config) {
      const recorded = entry?.commands || [];
      if (removeCommands(config, c => recorded.includes(c) || fewrCommand(c, client))) {
        installed = true;
        if (backupAndWrite(home, file, JSON.stringify(config, null, 2) + '\n')) changed.push(file);
      }
    }
    for (const agent of entry?.agents || []) {
      let current = null;
      try { current = fs.readFileSync(agent.path, 'utf8'); } catch { /* already gone */ }
      if (current !== null && hash(current) === agent.hash) {
        fs.rmSync(agent.path); changed.push(agent.path); removeEmptySkillDirs(agent.path);
      }
    }
    if (entry) delete manifest.clients[client];
  }
  if (targets.some(t => t.entry)) atomicWrite(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
  return { changed, installed };
}
