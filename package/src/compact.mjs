// Transparent tool-output compaction. Nothing here instructs the model; outputs are
// rewritten before they enter the context, so every later request re-reads fewer tokens.
// Test-report parsers are ported unchanged from the legacy implementation: they remove only
// exact passing records after reconciling the framework's own summary, and fail open otherwise.
import path from 'node:path';

export function isTestCommand(command) {
  if (typeof command !== 'string' || /[|<>;&\n]/.test(command)) return false;
  const [executable,...args] = command.trim().split(/\s+/);
  const name = path.basename(executable);
  if (name === 'node') return args.includes('--test') && !args.some(s => /^(?:-e|-p|--eval|--print)(?:=|$)/.test(s));
  const noninteractive = values => !values.some(s => /^(?:--watch(?:All)?|--ui|--api|--interactive)(?:=|$)/.test(s));
  if (name === 'vitest') return args[0] === 'run' && noninteractive(args) && !args.includes('-w');
  if (name === 'jest') return noninteractive(args);
  if (name === 'npx') return args[0] === '--no-install' && args[1] === 'vitest' && args[2] === 'run' && noninteractive(args) && !args.includes('-w');
  // Script names only establish eligibility. The complete framework parser still
  // validates every report before removing passing records; build/lint output and
  // unknown lines are retained even when a script combines several commands.
  return ['npm','pnpm','yarn','bun'].includes(name) && /^(?:test|check|verify)(?::[^\s]+)?$/.test(args[0] === 'run' ? args[1] || '' : args[0] || '') && noninteractive(args) && !args.includes('-w');
}

function reportLines(raw) {
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) || [];
  return { lines, plain: lines.map(s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r?\n$/, '')) };
}

function omitRecords(lines, omit, passed) {
  if (!passed) return null;
  const first = omit.values().next().value;
  return lines.map((s,i) => i === first ? `[Fewr: ${passed} passing test records omitted; summary and diagnostics retained]\n` : omit.has(i) ? '' : s).join('');
}

// Summary arithmetic alone cannot establish a complete report. Match each
// framework's terminal trailer, and reconcile its records before removing any.
function summaryCounts(value, allowed) {
  const total = value.match(/^(.*?)\s*\((\d+)\)$/) || value.match(/^(.*?),\s*(\d+) total$/);
  if (!total) return null;
  const counts = { total: Number(total[2]) };
  const parts = total[1].trim().split(/\s*(?:\||,)\s*/);
  for (const part of parts) {
    const match = part.match(/^(\d+) (\w+)$/);
    if (!match || !allowed.includes(match[2]) || counts[match[2]] !== undefined) return null;
    counts[match[2]] = Number(match[1]);
  }
  return Object.values(counts).slice(1).reduce((a,b) => a+b,0) === counts.total ? counts : null;
}

function compactVitestReport(raw) {
  const {lines, plain} = reportLines(raw);
  if (plain.filter(s => /^\s*RUN\s+v\d+\./.test(s)).length !== 1 || plain.some(s => /^\s*(?:DEV|WATCH)\s|Watching for file changes/.test(s))) return null;
  const summary = plain.flatMap((s,i) => /^\s*Test Files\s+/.test(s) ? [i] : []);
  if (summary.length !== 1) return null;
  const at = summary[0];
  const files = summaryCounts(plain[at].replace(/^\s*Test Files\s+/, ''), ['passed','failed','skipped']);
  const tests = summaryCounts((plain[at+1] || '').replace(/^\s*Tests\s+/, ''), ['passed','failed','skipped','todo']);
  if (!files || !tests || !/^\s*Tests\s+/.test(plain[at+1] || '') || !/^\s*Start at\s+\d\d:\d\d:\d\d$/.test(plain[at+2] || '') || !/^\s*Duration\s+[\d.]+(?:ms|s)\b/.test(plain[at+3] || '')) return null;
  // Fail open on concatenated reports and anything after the terminal summary.
  if (plain.slice(at+4).some(s => s.trim())) return null;
  const records = plain.slice(0,at).flatMap((s,i) => {
    const match = s.match(/^\s*([✓✔❯↓]) (.+\.(?:[cm]?[jt]sx?)) \((\d+) tests?(?: \| (\d+) failed)?(?: \| (\d+) skipped)?(?: \| (\d+) todo)?\) (\d+(?:\.\d+)?ms)$/);
    return match ? [{i, symbol:match[1], total:Number(match[3]), failed:Number(match[4] || 0), skipped:Number(match[5] || 0), todo:Number(match[6] || 0)}] : [];
  });
  if (!records.length || records.length !== files.total || records.reduce((n,r) => n+r.total,0) !== tests.total) return null;
  if (records.some(r => r.failed+r.skipped+r.todo > r.total) || ['failed','skipped','todo'].some(key => records.reduce((n,r) => n+r[key],0) !== (tests[key] || 0))) return null;
  const successful = records.filter(r => /^[✓✔]$/.test(r.symbol) && !r.failed && !r.skipped && !r.todo);
  if (successful.length !== (files.passed || 0) || records.filter(r => r.symbol === '❯').length !== (files.failed || 0) || records.filter(r => r.symbol === '↓').length !== (files.skipped || 0) || successful.reduce((n,r) => n+r.total,0) > (tests.passed || 0)) return null;
  // Only exact default-reporter file lines are removed. Console messages,
  // verbose tests, failures, skipped/todo records and unknown text remain bytewise.
  return omitRecords(lines, new Set(successful.map(r => r.i)), successful.reduce((n,r) => n+r.total,0));
}

function compactJestReport(raw) {
  const {lines, plain} = reportLines(raw);
  const summary = plain.flatMap((s,i) => /^Test Suites: /.test(s) ? [i] : []);
  if (summary.length !== 1) return null;
  const at = summary[0];
  const suites = summaryCounts(plain[at].slice(13), ['passed','failed','skipped']);
  const tests = summaryCounts((plain[at+1] || '').replace(/^Tests:\s+/, ''), ['passed','failed','skipped','todo']);
  if (!suites || !tests || !/^Tests:\s+/.test(plain[at+1] || '') || !/^Snapshots:\s+/.test(plain[at+2] || '') || !/^Time:\s+\d+(?:\.\d+)? s\b/.test(plain[at+3] || '') || !/^Ran all test suites(?: matching .+)?\.$/.test(plain[at+4] || '') || plain.slice(at+5).some(s => s.trim())) return null;
  const snapshots = plain[at+2].replace(/^Snapshots:\s+/, '');
  if (snapshots !== '0 total' && !summaryCounts(snapshots, ['passed','failed'])) return null;
  const suitesSeen = plain.slice(0,at).flatMap((s,i) => {
    const match = s.match(/^(PASS|FAIL) (.+\.(?:[cm]?[jt]sx?))(?: \([\d.]+ s\))?$/);
    return match ? [{i,status:match[1]}] : [];
  });
  if (suitesSeen.length !== suites.total || suitesSeen.filter(r => r.status === 'PASS').length !== (suites.passed || 0) || suitesSeen.filter(r => r.status === 'FAIL').length !== (suites.failed || 0)) return null;
  const omit = new Set();
  let failed = 0, skipped = 0, todo = 0;
  // Verbose records are bounded by suite headers and must account for every
  // passing test. Headings and all diagnostic/unknown lines stay in place.
  for (let n=0;n<suitesSeen.length;n++) {
    for (let i=suitesSeen[n].i+1;i<(suitesSeen[n+1]?.i ?? at);i++) {
      if (/^\s+[✓✔] .+ \(\d+(?:\.\d+)? ms\)$/.test(plain[i])) omit.add(i);
      else if (/^\s+[✕✖×] .+ \(\d+(?:\.\d+)? ms\)$/.test(plain[i])) failed++;
      else if (/^\s+○ skipped .+$/.test(plain[i])) skipped++;
      else if (/^\s+✎ todo .+$/.test(plain[i])) todo++;
    }
  }
  if (!omit.size && !failed && !skipped && !todo) {
    // The default reporter prints suite records rather than individual tests.
    // Keep a suite's header whenever it anchors console output or unknown text.
    for (let n=0;n<suitesSeen.length;n++) {
      const suite = suitesSeen[n];
      if (suite.status === 'PASS' && plain.slice(suite.i+1,suitesSeen[n+1]?.i ?? at).every(s => !s.trim())) omit.add(suite.i);
    }
    return omitRecords(lines, omit, omit.size);
  }
  if (omit.size !== (tests.passed || 0) || failed !== (tests.failed || 0) || skipped !== (tests.skipped || 0) || todo !== (tests.todo || 0)) return null;
  return omitRecords(lines, omit, omit.size);
}

function compactNodeReport(raw) {
  // Preserve original bytes for every retained line, including colors and newlines.
  const {lines, plain} = reportLines(raw);
  const tap = plain.indexOf('TAP version 13');
  const summaryPrefix = tap >= 0 ? '# ' : 'ℹ ';
  const counts = {};
  const summaryLines = [];
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = plain.flatMap((s,i) => s.startsWith(summaryPrefix + key + ' ') && /^\d+$/.test(s.slice(summaryPrefix.length + key.length + 1)) ? [i] : []);
    if (matches.length !== 1) return null;
    counts[key] = Number(plain[matches[0]].split(' ').at(-1)); summaryLines.push(matches[0]);
  }
  // Only flat, complete Node reports. Nested suites and multiple reports need a
  // different parser, so they are deliberately passed through rather than guessed.
  if (counts.suites !== 0 || counts.tests === 0 || counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo ||
      summaryLines.some((n,i) => i && n !== summaryLines[i-1] + 1) ||
      !new RegExp(`^${summaryPrefix}duration_ms [0-9.]+$`).test(plain[summaryLines.at(-1)+1] || '')) return null;
  const startSummary = summaryLines[0];
  const omit = new Set();
  let passed = 0;
  if (tap >= 0) {
    if (plain.filter(s => s === 'TAP version 13').length !== 1 || plain.some(s => /^ +(?:# Subtest:|(?:not )?ok \d+|1\.\.)/.test(s))) return null;
    const results = plain.slice(tap+1,startSummary).flatMap((s,i) => /^(?:not )?ok \d+ - /.test(s) ? [{s,i:i+tap+1}] : []);
    if (results.length !== counts.tests || plain[startSummary-1] !== `1..${counts.tests}` || results.some(({s},i) => Number(s.match(/^(?:not )?ok (\d+)/)[1]) !== i+1)) return null;
    for (const {s,i} of results) {
      const name = s.match(/^ok \d+ - (.+)$/)?.[1];
      if (!name || /# (?:SKIP|TODO)\b/i.test(name)) continue;
      // Delete only the exact successful record with Node's known metadata. Any
      // console output, assertion metadata or unknown YAML makes this record stay.
      if (plain[i-1] !== '# Subtest: ' + name || plain[i+1] !== '  ---' ||
          !/^  duration_ms: [0-9.]+$/.test(plain[i+2])) continue;
      // Older Node reporters omit the type field. Accept both exact forms, never
      // skip arbitrary YAML to find the terminator (it may contain diagnostics).
      const end = plain[i+3] === '  ...' ? i+3 : plain[i+3] === "  type: 'test'" && plain[i+4] === '  ...' ? i+4 : -1;
      if (end < 0) continue;
      for (let n=i-1;n<=end;n++) omit.add(n);
      passed++;
    }
  } else {
    const records = plain.slice(0,startSummary).filter(s => /^[✔✖﹣] .+ \([0-9.]+ms\)(?: # (?:SKIP|TODO).*)?$/.test(s));
    // A suite reporter or indented nested test must never be treated as flat.
    if (records.length !== counts.tests || plain.slice(0,startSummary).some(s => /^\s+[✔✖﹣▶]/.test(s))) return null;
    for (let i=0;i<startSummary;i++) {
      if (/^✔ .+ \([0-9.]+ms\)$/.test(plain[i])) { omit.add(i); passed++; }
    }
  }
  if (!passed || passed > counts.pass) return null;
  return omitRecords(lines, omit, passed);
}


const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Terminal redraws (spinners, progress bars) arrive as \r-separated frames; only the last is shown.
function collapseProgress(text) {
  return text.split('\n').map(line => {
    if (!line.includes('\r')) return line;
    const frames = line.split('\r').filter(frame => frame.trim());
    return frames.at(-1) ?? '';
  }).join('\n');
}

function collapseRepeats(text) {
  const lines = text.split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    let end = i + 1;
    while (end < lines.length && lines[end] === lines[i]) end++;
    if (end - i >= 4) out.push(lines[i], `[Fewr: line above repeated ${end - i} times]`);
    else out.push(...lines.slice(i, end));
    i = end;
  }
  return out.join('\n');
}

// Returns the text the model should see. Diagnostics, failures and unknown text are kept;
// only presentation noise and validated passing test records are removed.
export function compactText(raw, { command } = {}) {
  if (typeof raw !== 'string' || raw.length < 1200) return { text: raw, removedBytes: 0 };
  let text = raw.replace(ANSI, ''), format = text.length < raw.length ? 'ansi' : undefined;
  const progress = collapseProgress(text);
  if (progress !== text) { text = progress; format = 'progress'; }
  if (isTestCommand(command)) {
    for (const [name, parse] of [['node-test', compactNodeReport], ['vitest', compactVitestReport], ['jest', compactJestReport]]) {
      const report = parse(text);
      if (report) { text = report; format = name; break; }
    }
  }
  const repeats = collapseRepeats(text);
  if (repeats !== text) { text = repeats; format ??= 'repeats'; }
  const removedBytes = Buffer.byteLength(raw) - Buffer.byteLength(text);
  return removedBytes > 150 ? { text, removedBytes, format } : { text: raw, removedBytes: 0 };
}

// Claude Bash/PowerShell results: { stdout, stderr, interrupted, isImage }. The original is
// archived first so nothing is lost; the model sees where to find it.
export function compactShellResult(response, command) {
  if (!response || typeof response !== 'object' || typeof response.stdout !== 'string' || typeof response.stderr !== 'string' || response.isImage || response.interrupted) return null;
  const stdout = compactText(response.stdout, { command }), stderr = compactText(response.stderr, { command });
  const removedBytes = stdout.removedBytes + stderr.removedBytes;
  if (!removedBytes) return null;
  return { value: { ...response, stdout: stdout.text, stderr: stderr.text }, removedBytes, originalBytes: Buffer.byteLength(response.stdout + response.stderr), format: stdout.format || stderr.format };
}
