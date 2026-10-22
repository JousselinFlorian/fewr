// Orchestrator mode: the user's main model leads (understanding, architecture, design-heavy work,
// decisions) and delegates legwork to one generic worker, choosing the worker's model and effort per
// subtask: the cheapest option that will do it well, escalating only on failure. Thinking and
// generated code dominate price-weighted cost, so matching each subtask to the cheapest capable
// model and effort is the largest lever; keeping design and decisions on the lead protects quality.
// A variant that moved design and large implementations to the lead's model at a lower effort was
// screened on the crossing task and cost more.
import fs from 'node:fs';
import path from 'node:path';

export const WORKER = 'fewr-worker';

const LEGWORK = 'Does delegated legwork for the lead session: investigation, log and test summaries, mechanical edits, or implementing a spec (code and tests).';
const DESCRIPTION = `${LEGWORK} The lead sets its model and effort per task.`;
const PROMPT = 'You do the subtask the lead hands you. Investigation: report only the facts asked for, with file paths and line numbers; make no edits. Implementation: write the code and the tests the spec calls for, run the checks it names, and fix failures until they pass. Do not redesign; if the spec is ambiguous or wrong, make the smallest reasonable choice and report it. If the task needs judgement beyond the spec, stop and say so. Finish with a short report: what you found or changed, checks run with results, open issues.';

function codexCatalog(codexHome) {
  try { return (JSON.parse(fs.readFileSync(path.join(codexHome || '', 'models_cache.json'), 'utf8')).models || []).filter(m => m.visibility === 'list' && typeof m.slug === 'string'); } catch { return []; }
}
const pick = (catalog, preferred) => preferred.find(id => catalog.some(m => m.slug === id)) || preferred[0];

// Models the lead chooses between. Claude uses Claude Code's aliases; Codex uses its visible catalog.
export function workerModels(client, codexHome) {
  if (client === 'claude') return { light: 'haiku', standard: 'sonnet', default: { model: 'sonnet', effort: 'medium' } };
  const catalog = codexCatalog(codexHome), standard = pick(catalog, ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-5.6-sol']);
  return { light: pick(catalog, ['gpt-6-luna', 'gpt-5.6-luna']), standard, default: { model: standard, effort: 'medium' } };
}

// Codex runs an agent role at the role's own model and reasoning effort and ignores per-spawn
// overrides (measured 2026-10-22: a spawn asking for high effort ran at the role's medium), so Codex
// gets one role per tier and the lead chooses the effort by choosing the role.
export const codexRoles = models => [
  { name: 'fewr-light', model: models.light, effort: 'low', use: 'lookups, log or test-output summaries and mechanical edits' },
  { name: 'fewr-low', model: models.standard, effort: 'low', use: 'small, fully specified changes' },
  { name: 'fewr-medium', model: models.standard, effort: 'medium', use: 'standard logic, tests and fixes' },
  { name: 'fewr-high', model: models.standard, effort: 'high', use: 'tricky logic (algorithms, subtle bugs, edge cases)' },
];

// Agent files to install: Claude gets one generic worker whose model and effort the lead sets per
// call; Codex gets one file per role.
export function agentFiles(client, models) {
  if (client === 'claude') {
    const d = models.default;
    return [{ name: WORKER, text: `---\nname: ${WORKER}\ndescription: ${DESCRIPTION}\nmodel: ${d.model}\neffort: ${d.effort}\n---\n\n${PROMPT}\n` }];
  }
  return codexRoles(models).map(r => ({ name: r.name, text: `name = "${r.name}"\ndescription = ${JSON.stringify(`${LEGWORK} Runs ${r.model} at ${r.effort} reasoning effort, for ${r.use}.`)}\nmodel = ${JSON.stringify(r.model)}\nmodel_reasoning_effort = ${JSON.stringify(r.effort)}\ndeveloper_instructions = ${JSON.stringify(PROMPT)}\n` }));
}

export const agentPath = (client, base, name = WORKER) => path.join(base, 'agents', `${name}.${client === 'claude' ? 'md' : 'toml'}`);

// The lead brief. Short on purpose: injected text is re-read every turn, and broad working rules
// raised thinking in earlier measurements. It only says who does what and how to pick the worker.
export function leadBrief(client, models) {
  const routes = client === 'claude'
    ? `Delegate to the ${WORKER} subagent, setting its model and effort for each subtask (Agent tool model and effort parameters): ${models.light} for lookups, log or test-output summaries and mechanical edits; ${models.standard} with low effort for small, fully specified changes; ${models.standard} medium for standard logic, tests and fixes; ${models.standard} high for tricky logic (algorithms, subtle bugs, edge cases)`
    : `Delegate by spawning the agent type that fits the subtask, with fork_turns "none" and no model or reasoning_effort, since each type sets its own: ${codexRoles(models).map(r => `${r.name} for ${r.use}`).join('; ')}`;
  return `Fewr orchestrator mode: you are the lead and make the decisions. Your own turns run at the user's chosen model and effort and are the most expensive in this session, so hand off any subtask a cheaper worker can do equally well. ${routes}; escalate to your own model only if that fails twice. Keep for yourself: architecture; design-heavy work (visual rendering, styling, layout, UX, copy); security judgement (threat analysis, exploitability, severity, and reviewing every security fix before accepting it); and creative direction for media (storyboard, visual style, script). Workers still do the legwork around these: inventories and scans, reproductions and regression tests for issues you specify, fixes you have specified, and asset, rendering or encoding pipelines. If a task is mostly design-heavy, do it without delegating. Give each delegation one coherent spec with acceptance checks, read code yourself only when a decision depends on it, and verify through check results and reports.`;
}

// Same agent for benchmark harnesses that cannot read user-level agent files.
export const claudeAgentDefinitions = models => ({ [WORKER]: { description: DESCRIPTION, prompt: PROMPT, model: models.default.model, effort: models.default.effort } });
