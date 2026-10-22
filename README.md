<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.png">
    <img src="assets/logo.png" width="260" alt="Fewr">
  </picture>
</p>

<p align="center">
  <em>Less usage. Faster builds. Same quality.</em><br>
  <sub>Built by <a href="https://x.com/flojousselin">@flojousselin</a></sub>
</p>

<p align="center">
  <a href="https://x.com/flojousselin"><img src="https://img.shields.io/badge/follow-%40flojousselin-111111?style=flat-square&logo=x&logoColor=white" alt="Follow @flojousselin on X"></a>
  <a href="https://www.npmjs.com/package/fewr"><img src="https://img.shields.io/npm/v/fewr?style=flat-square&color=111111&label=npm" alt="npm"></a>
  <img src="https://img.shields.io/badge/works%20with-Claude%20Code%20%C2%B7%20Codex-111111?style=flat-square" alt="Works with Claude Code and Codex">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-111111?style=flat-square" alt="AGPL-3.0 license">
</p>

<p align="center">
  <img src="assets/hero.jpg" width="880" alt="Less usage. Faster builds. Same quality. Claude Code: −43% cost, −50% build time. Codex: −51% cost, −22% build time.">
</p>

## Installation

### Prerequisites

- [Node.js](https://nodejs.org) 22 or later
- Claude Code or Codex, signed in

### Claude Code

1. Run this one command and you're set:
   ```sh
   npx fewr
   ```
2. Start a new chat. Fewr loads when a chat starts, so chats already open keep running without it.
3. Type `/fewrstats` in any chat to see your savings.

### Codex

1. Run the same command:
   ```sh
   npx fewr
   ```
2. In Codex, type `/hooks`. Find **Fewr: SessionStart** and **Fewr: record usage**, and trust both. Codex keeps new hooks off until you do.
3. Start a new chat.
4. Type `$fewrstats` in any chat to see your savings.

To remove Fewr: `npx fewr uninstall`.

## Benchmark

<p align="center">
  <img src="assets/chart.png" width="880" alt="Cost with Fewr, same model and same effort: 3D game −51% on Codex and −43% on Claude Code, website + API −38%, security review −28%, presentation video −25%, simple 2D game −19%.">
</p>

Same task, same model, same effort, with and without Fewr. Each result is the average of two runs, and hidden checks graded every build.

## Before / after

<p align="center">
  <img src="assets/before-after.jpg" width="880" alt="The same 3D game built by Claude Code with Opus at max effort, without and with Fewr: 6.3M vs 2.7M raw tokens (−56.9%), $6.14 vs $3.36 (−45.3%), 37 vs 18 minutes (−50.1%). Both games play the same.">
</p>

Same game, same model, same effort. Without Fewr: 6.3M tokens, $6.14, 37 minutes. With Fewr: 2.7M tokens, $3.36, 18 minutes. Both pass all 12 hidden checks and play the same. This is one of the two runs in the benchmark; across both, cost fell 43% on average.

## Why Fewr is different

Most ways to save usage give up some quality to get there:

| Approach | What it does | The catch |
|---|---|---|
| A cheaper model | Runs the whole session on Sonnet or a mini model | The hard parts (architecture, design, security) get the weaker model too |
| Lower effort | Thinks less on every turn | Less thinking on exactly the turns that need it |
| Trimming and compression | Shortens prompts, context or replies | Saved 0–11% in our tests, and rules about *how* to work made models think more, not less |
| Proxies and routers | Re-route your subscription's traffic | Breaks Anthropic's and OpenAI's terms and puts your account at risk |

Fewr doesn't turn anything down across the board. It splits the work:

<p align="center">
  <img src="assets/how-it-works.jpg" width="880" alt="One task split into subtasks: lookups and log summaries to Haiku or Luna at low effort, small changes to Sonnet or Sol at low, logic and tests at medium, tricky logic at high, and design on your own model at your own effort. 5 of 6 steps on cheaper models.">
</p>

- **Your model keeps the decisions.** Architecture, design, security judgement and review stay on the model and effort you chose.
- **Each subtask gets the right model.** Lookups, tests and well-defined code go to the cheapest model and effort that does them well, and escalate if they fail.
- **Nothing in between.** Fewr runs through Claude Code's and Codex's own hooks, with your login, on your machine.
- **Measured, not promised.** Every benchmark compares the same model at the same effort, with hidden checks grading both builds. `/fewrstats` shows what it saves in your own chats.

## Follow along

<p align="center">
  <a href="https://x.com/flojousselin"><img src="assets/follow.png" width="880" alt="Fewr is free. Follow along for what's next: new benchmark results, releases and tips for Claude Code and Codex. @flojousselin on X."></a>
</p>

## License

[AGPL-3.0](LICENSE). Free to use, modify and share. If you distribute a modified version, or offer one as a network service, you must publish its source under the same license. The Fewr name, logo and website content are not covered; see [NOTICE](NOTICE). © 2026 Florian Jousselin.
