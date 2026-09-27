# Changelog

All notable changes to `@mjaverto/ace`.

## Unreleased

Fixed [#14](https://github.com/mjaverto/ace/issues/14): a cloud-sync client evicting the index made `ace render` silently rewrite every note.
- The `index` strategy's state moved out of the output root to `${XDG_STATE_HOME:-~/.local/state}/ace/index-<hash>.json`, one file per output root. An existing `<output>/.ace.state.json` is migrated on the next run and then deleted by that run.
- An unreadable or corrupt index now aborts before writing anything, with new exit code `5` (State error). `--force` ignores it and rebuilds.
- Notes whose rendered content is unchanged (ignoring `aceRenderedAt`) are no longer rewritten, under either strategy and with `--force`. The summary line gains an `unchanged=N` count; NDJSON reports them as `skipped`.
- Atomic-write temp files are staged in `${XDG_STATE_HOME:-~/.local/state}/ace/tmp` instead of the output dir (same-dir fallback across filesystems). Older versions could leave `*.md.tmp-<pid>-<hex>` files in the output tree; clean them up with `find <output> -name '*.md.tmp-*' -mmin +60 -delete`.
- An existing note that can't be read for comparison (e.g. a cloud-only placeholder whose size matches) is reported as an error (exit `3`) and left untouched instead of being rewritten; it is retried on the next run. Notes whose size differs are rewritten without reading them.
- `--dry-run` now reports unchanged notes as unchanged instead of "would write".
- `--force` with `--source` refuses to rebuild a corrupt index (exit `5`), since that would drop other sources' entries.
- Multi-machine setups sharing one output dir: the first upgraded machine migrates and removes the shared legacy index. Machines still on an older ace recreate and keep using their own legacy file, which upgraded machines then ignore; other upgraded machines start without an index (one full compare pass, no rewrites of unchanged notes). Mixed versions are stable after one run each; upgrade every writer to get the unchanged-note skip everywhere.
- `mtime` strategy: an unchanged note older than its source gets its mtime re-stamped (no content write), so the next run skips it.
- When temp staging in the state dir fails (or crosses filesystems), a warning names the output dir and error once per dir.

Added the `omp` source: renders oh-my-pi's `~/.omp/agent/sessions/<workspace>/*.jsonl` transcripts. omp shares [pi-mono](https://github.com/badlogic/pi-mono)'s flat-event schema but its `toolResult` messages are a single flat object with an array-of-blocks `content` (not pi's `content: PiToolResultItem[]` batch); `omp.ts` handles that divergence directly rather than repointing the `pi` source at the new path.

## 0.1.0

Initial public release. Renders Claude Code, OpenAI Codex CLI, [pi-mono](https://github.com/badlogic/pi-mono), and opencode (sst) transcripts into clean Markdown with consistent YAML frontmatter. Ships a plugin contract, an mtime/index incremental strategy, atomic writes, and `install` subcommands for launchd, systemd, and cron.
