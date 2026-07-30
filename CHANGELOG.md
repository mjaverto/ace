# Changelog

All notable changes to `@mjaverto/ace`.

## Unreleased

Added the `omp` source: renders oh-my-pi's `~/.omp/agent/sessions/<workspace>/*.jsonl` transcripts. omp shares [pi-mono](https://github.com/badlogic/pi-mono)'s flat-event schema but its `toolResult` messages are a single flat object with an array-of-blocks `content` (not pi's `content: PiToolResultItem[]` batch); `omp.ts` handles that divergence directly rather than repointing the `pi` source at the new path.

## 0.1.0

Initial public release. Renders Claude Code, OpenAI Codex CLI, [pi-mono](https://github.com/badlogic/pi-mono), and opencode (sst) transcripts into clean Markdown with consistent YAML frontmatter. Ships a plugin contract, an mtime/index incremental strategy, atomic writes, and `install` subcommands for launchd, systemd, and cron.
