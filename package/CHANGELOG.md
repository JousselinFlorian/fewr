# Changelog

## 0.2.0 (2026-10-23)

First release on npm: `npx fewr` installs it.

- The stats report now estimates raw tokens and build time without Fewr, not only cost.
- A worker is never given a model pricier than the lead's.
- The stats skill is renamed: `/fewrstats` is now `/fewr`, `$fewrstats` is now `$fewr`. Reinstalling removes the old skill.
- The stats report drops its footnote and leaves a blank line above and below the table; the README explains the estimate instead.

## 0.1.0 (2026-10-22)

First public release, under the AGPL-3.0 license.

- Orchestrator mode for Claude Code and Codex: your model leads and hands legwork to cheaper models at a chosen effort; design, architecture and security judgement stay with your model.
- Tool-output compaction and re-read deduplication (Claude Code).
- `/fewrstats` (Claude Code) and `$fewrstats` (Codex): this chat's raw tokens, cost and build time, with a conservative cost estimate without Fewr.
- `fewr usage`: price-weighted usage of any session, including its workers.
