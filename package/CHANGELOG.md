# Changelog

## 0.2.1 (2026-10-23)

- Install keeps symlinked settings files as symlinks (dotfile setups) and keeps their permissions.
- A settings file that exists but can't be read stops the install instead of being overwritten.
- Install works from a path with spaces or non-ASCII characters.
- Everything is checked before anything is written: an unknown `--client` or an unexpected `hooks` format changes nothing.
- Reinstalling after deleting `~/.fewr` no longer duplicates hooks, and uninstall still finds them. Uninstall keeps your own empty hook groups and says so when Fewr isn't installed.
- Compaction never rewrites file contents (`cat`, `sed`, `git diff` and similar) and never collapses blank lines.
- Saved outputs are deleted after 7 days and session records after 30, in owner-only folders.
- Runs on Node.js 20 or later. The README lists what Fewr stores locally, and how to delete it.

## 0.2.0 (2026-10-23)

First release on npm: `npx @fewr/cli` installs it.

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
