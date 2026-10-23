# Fewr

**Less usage. Faster builds. Same quality.**

[![Follow @flojousselin on X](https://img.shields.io/badge/Follow-%40flojousselin-000000?logo=x&logoColor=white)](https://x.com/flojousselin) [![npm](https://img.shields.io/npm/v/fewr?color=000000)](https://www.npmjs.com/package/fewr) [![AGPL-3.0 license](https://img.shields.io/badge/license-AGPL--3.0-000000)](https://github.com/JousselinFlorian/fewr/blob/main/package/LICENSE)

<p align="center"><img src="https://raw.githubusercontent.com/JousselinFlorian/fewr/main/assets/hero.jpg" width="880" alt="Less usage. Faster builds. Same quality. Claude Code: −43% cost, −50% build time. Codex: −51% cost, −22% build time."></p>

Fewr makes your Claude Code or Codex subscription go further. Your model stays in charge, and the legwork goes to cheaper models at the right effort. It runs locally through each client's own hooks, uses your existing login, and never routes your traffic anywhere.

```sh
npx fewr
```

Requires Node.js 22+ and a signed-in Claude Code or Codex. In Codex, open `/hooks` once and trust the new Fewr hooks.

## Results

<p align="center"><img src="https://raw.githubusercontent.com/JousselinFlorian/fewr/main/assets/chart.png" width="880" alt="Cost with Fewr, same model and same effort: 3D game −51% on Codex and −43% on Claude Code, website + API −38%, security review −28%, presentation video −25%, simple 2D game −19%."></p>

Each comparison ran the same task twice from a fresh workspace, with the same model and effort on both sides. Fewr was the only difference, and hidden checks graded both builds.

| Task | Client · model | Cost | Hidden checks (without → with Fewr) |
|---|---|---|---|
| 3D game | Claude Code · Opus, max effort | **−43%** (2 pairs) | 24/24 → 24/24 |
| Website + REST API | Claude Code · Opus, max effort | **−38%** (2 pairs) | 58/58 → 57/58 |
| 3D game | Codex · GPT-6 Astra, ultra effort | **−49%, −53%** (2 pairs) | 12/12 → 12/12 |

On non-coding tasks the savings were smaller: −28% on a security review and −25% on a video. Results vary between runs.

## How it works

Cutting tokens alone barely moves usage: most of a session's tokens are context re-read from cache, which costs 5–10% of a fresh token. What costs is which model does the work, so that is where Fewr saves.

- **Your model leads.** At the start of a session, Fewr tells your model it is the lead. It keeps architecture, design-heavy work, security judgement and creative direction, and hands the rest to a worker.
- **The right model and effort for each subtask:**

  | Subtask | Claude Code | Codex |
  |---|---|---|
  | Lookups, log summaries, mechanical edits | Haiku | Luna, low effort |
  | Small, fully specified changes | Sonnet, low | Sol, low |
  | Standard logic and tests | Sonnet, medium | Sol, medium |
  | Tricky logic (algorithms, edge cases) | Sonnet, high | Sol, high |
  | Design, architecture, security judgement | your model, your effort | your model, your effort |

  The lead escalates to its own model only if a worker fails twice.
- **Smaller context (Claude Code).** Shell output is compacted before it enters the conversation; failures stay intact, and the full output is saved locally. Re-reading an unchanged file returns a short note instead of the whole file again.

## See your savings

In any chat, run this in Claude Code:

```text
/fewrstats
```

Or this in Codex:

```text
$fewrstats
```

<p align="center"><img src="https://raw.githubusercontent.com/JousselinFlorian/fewr/main/assets/stats.png" width="880" alt="/fewrstats: this chat's raw tokens, cost and build time with Fewr, next to an estimate without it."></p>

```
| | Without Fewr | With Fewr | Change |
| :-- | --: | --: | --: |
| Raw tokens | — | 4,070,377 | — |
| Cost | $5.12 (est.) | $3.98 | −22.4% |
| Build time | — | 22 min | — |
```

"With Fewr" is the chat's real usage, workers included, at published prices. A chat has no measured run without Fewr, so that cost is a conservative estimate: the lower of two models of the same work done by your model alone. In benchmarks, it stayed under the real cost without Fewr on 5 of 6 tasks. Raw tokens and build time have no reliable per-chat estimate without Fewr, so they show this chat's figures only.

From a terminal:

```sh
fewr stats [--client claude|codex] [--session ID] [--cwd DIR]   # the same report
fewr usage claude ~/.claude/projects/<project>/<session>.jsonl  # one session's usage, by token type and model
```

## Privacy and safety

- Everything runs on your machine. Fewr has no server, and sends no telemetry or code anywhere.
- It installs only native hooks, agent definitions and the `fewrstats` skill. Your other settings are kept, modified files are backed up under `~/.fewr/backups/`, and files you've edited are never overwritten.
- It never touches your login or tokens.

## Configure and uninstall

Switch a mechanism off with an environment variable, or with `{"disable": [...]}` in `~/.fewr/config.json`:

```sh
FEWR_DISABLE=orchestrate   # or compaction, dedupe, digest, all
```

```sh
npx fewr uninstall          # removes exactly what Fewr installed
npx fewr install --client codex   # or claude, or both (the default detects what you have)
```

If the previous version, Shyft, is installed, uninstall it first; Fewr refuses to install beside it.

## Follow along

<p align="center"><a href="https://x.com/flojousselin"><img src="https://raw.githubusercontent.com/JousselinFlorian/fewr/main/assets/follow.png" width="880" alt="Fewr is free. Follow along for what's next: new benchmark results, releases and tips for Claude Code and Codex. @flojousselin on X."></a></p>

Paying for API tokens instead of a subscription? A cost-optimizing mode for API users is next. [DM @flojousselin](https://x.com/flojousselin) to try it early.

If Fewr saves you usage, a ⭐ on GitHub helps others find it.

## Develop

```sh
npm test
```


## License

[AGPL-3.0](https://github.com/JousselinFlorian/fewr/blob/main/package/LICENSE). Free to use, modify and share. If you distribute a modified version, or offer one as a network service, you must publish its source under the same license. The Fewr name and logo are not covered. Copyright © 2026 Florian Jousselin ([@flojousselin](https://x.com/flojousselin)).
