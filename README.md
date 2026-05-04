# ace

> Render your AI-agent CLI transcripts to clean, frontmattered Markdown.

<!-- badges -->
<!-- prettier-ignore-start -->
[![CI](https://github.com/mjaverto/ace/actions/workflows/ci.yml/badge.svg)](https://github.com/mjaverto/ace/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mjaverto/ace.svg)](https://www.npmjs.com/package/@mjaverto/ace)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E=20-brightgreen)](https://nodejs.org)
<!-- prettier-ignore-end -->

## TL;DR

```sh
npx @mjaverto/ace render
```

> The npm package is scoped (`@mjaverto/ace`) but the bin name is plain **`ace`** — once installed, every command in this README works as `ace <subcommand>`.

## Why ace

Every AI-agent CLI stores its transcripts in a different blob: Claude Code uses one JSONL per session under `~/.claude/projects/`, OpenAI's Codex CLI rolls its own JSONL under `~/.codex/sessions/`, [pi-mono](https://github.com/badlogic/pi-mono) writes flat-event JSONL under `~/.pi/agent/sessions/`, and opencode (sst) keeps everything in a SQLite database at `~/.local/share/opencode/opencode.db`. Each shape is sensible for the tool that wrote it; none of them are ergonomic for *you*, the human or agent who wants to grep, index, embed, or read those conversations later.

`ace` converts all of them into clean Markdown with consistent YAML frontmatter, into one output directory you control. Once everything is Markdown, the rest of the toolchain just works — drop the output into a [QMD](https://github.com/tobi/qmd)-style indexed vault, sync it to a Drive folder, feed it to embeddings, or scroll through `glow` like any other notes directory. ace owns the conversion pipeline. What you do with the rendered Markdown is your problem (and the entire point).

## Supported sources

| Source           | Status | Default location                                                         | Notes                |
| ---------------- | :----: | ------------------------------------------------------------------------ | -------------------- |
| Claude Code      |   v   | `~/.claude/projects/<slug>/<uuid>.jsonl`                                 | Anthropic CLI        |
| OpenAI Codex CLI |   v   | `~/.codex/{sessions,archived_sessions}/...rollout-*.jsonl`               | rollout JSONL        |
| pi (pi-mono)     |   v   | `~/.pi/agent/sessions/<workspace>/<ts>_<uuid>.jsonl`                     | [badlogic/pi-mono](https://github.com/badlogic/pi-mono) |
| opencode (sst)   |   v   | `~/.local/share/opencode/opencode.db` (SQLite)                           | Read-only access     |

Per-source schema notes: [`docs/sources/claude.md`](docs/sources/claude.md) · [`docs/sources/codex.md`](docs/sources/codex.md) · [`docs/sources/pi.md`](docs/sources/pi.md) · [`docs/sources/opencode.md`](docs/sources/opencode.md).

## 60-second quickstart

```sh
npx @mjaverto/ace init       # writes ace.config.yaml
npx @mjaverto/ace doctor     # validates config + probes sources/output FS
npx @mjaverto/ace render     # one-shot incremental render
```

`init` writes a starter `ace.config.yaml` you can edit. `doctor` checks that every configured source root exists, probes whether your output filesystem preserves mtimes (used by the default incremental strategy), and warns if it doesn't. `render` walks every enabled source, renders only sessions that changed since the last run, and writes Markdown atomically.

## Config reference

YAML by default (`./ace.config.yaml` or `$XDG_CONFIG_HOME/ace/config.yaml`). JSON is also accepted; `.ts`/`.js` configs are supported via `defineConfig()`.

```yaml
# ace.config.yaml — every key documented inline.

# Where rendered Markdown is written. Created on first run.
# Tilde-expanded. Per-source dirs are nested under this root.
output: ~/Drive/_Brain/agent-conversations

# Incremental strategy:
#   mtime  — default. Compare source mtime to output mtime. Cheap and stateless.
#            Requires the output filesystem to preserve mtimes (most do; some
#            cloud-sync FSes don't — see Troubleshooting).
#   index  — write a single `<output>/.ace.state.json` index file with per-entry
#            sha + size + mtime. Use when mtime is unreliable.
strategy: mtime

# Render parallelism. "auto" = os.cpus().length. Or pass an integer.
concurrency: auto

# Truncation budget for tool input/output blocks (in bytes; UTF-8 codepoint-safe).
# Set a value to false to disable truncation for that block kind.
truncate:
  toolOutput: 4000
  toolInput: 4000

# Per-source toggles. Anything not listed inherits source defaults.
sources:
  claude:
    enabled: true
    roots: [~/.claude/projects]
    exclude: ["**/.tmp.*"]
  codex:
    enabled: true
    roots: [~/.codex/sessions, ~/.codex/archived_sessions]
  pi:
    enabled: true
    roots: [~/.pi/agent/sessions]
  opencode:
    enabled: true
    # roots may point at a SQLite db file directly, or its parent dir.
    # Multiple installs supported (one row per).
    roots: [~/.local/share/opencode/opencode.db]

# Optional plugins to load. Each entry resolves like a Node import:
# absolute path, relative path, or installed module name.
plugins: []
```

## CLI reference

Every subcommand below works as both `npx @mjaverto/ace <cmd>` and (after install) `ace <cmd>`.

### `ace render`

One-shot incremental render of every configured source.

| Flag                     | Default            | Notes                                                                |
| ------------------------ | ------------------ | -------------------------------------------------------------------- |
| `--config <path>`        | auto-discover      | Path to config file.                                                 |
| `--source <name>`        | (all enabled)      | Restrict to one source (`claude`, `codex`, `pi`, `opencode`, …).     |
| `--out <dir>`            | from config        | Override config `output`.                                            |
| `--dry-run`              | `false`            | Print what would be rendered; write nothing.                         |
| `--force`                | `false`            | Ignore the incremental cache; re-render everything.                  |
| `--strategy mtime\|index`| from config        | Override config `strategy`.                                          |
| `--plugin <module>`      | (none)             | Repeatable. Load extra `AgentSource` modules at runtime.             |
| `--concurrency <n>`      | `os.cpus().length` | Render parallelism.                                                  |
| `--json`                 | `false`            | Emit NDJSON results to stdout (one line per session).                |

### `ace render-one <jsonl|->`

Render exactly one session — a path on disk, or `-` for stdin.

| Flag              | Default  | Notes                                                                       |
| ----------------- | -------- | --------------------------------------------------------------------------- |
| `--source <name>` | required | Which renderer to use. Required for stdin; auto-detected for paths.         |
| `-o <md\|->`      | stdout   | Output path, or `-` for stdout.                                             |

### `ace list-sources`

Print every registered source — name, displayName, default roots — including any loaded via `--plugin`.

### `ace doctor`

Validates config, probes every source root, and writes+restats a temp file under `output` to detect mtime preservation. Recommends `--strategy index` if mtime resolution is poor or the FS rounds to a future timestamp.

### `ace init`

Interactive starter. Prompts for output dir + which sources to enable, writes `ace.config.yaml`.

### `ace install <launchd|systemd|cron>`

Install a recurring renderer. Idempotent on `--label`. See [`docs/scheduling.md`](docs/scheduling.md).

| Flag                 | Default            | Notes                                                                       |
| -------------------- | ------------------ | --------------------------------------------------------------------------- |
| `--at <HH:MM>`       | (none)             | Daily run at given local time.                                              |
| `--every <duration>` | (none)             | E.g. `15m`, `1h`. Interval-style scheduling.                                |
| `--cron-minute <N>`  | (none)             | Every hour at minute `N` (launchd `StartCalendarInterval`).                 |
| `--label <name>`     | `dev.ace.render`   | Idempotency tag. Re-running with same label replaces prior install.         |
| `--log <path>`       | platform default   | Where to redirect stdout/stderr. See defaults below.                        |
| `--run-now`          | `false`            | Kickstart immediately after install.                                        |
| `--dry-run`          | `false`            | Print artifact + commands; do nothing.                                      |
| `--verbose`          | `false`            | Verbose render inside the scheduled job.                                    |

Default log paths: macOS `~/Library/Logs/ace.log`, Linux `~/.local/state/ace/ace.log`.

### `ace uninstall <launchd|systemd|cron>`

Remove a previously installed schedule.

| Flag             | Default            | Notes                            |
| ---------------- | ------------------ | -------------------------------- |
| `--label <name>` | `dev.ace.render`   | Must match the install `--label`.|

### `ace logs`

Resolves the platform log path and prints it.

| Flag      | Default | Notes                |
| --------- | ------- | -------------------- |
| `--tail`  | `false` | Follow (`tail -f`).  |

### Exit codes

| Code | Meaning                         |
| :--: | ------------------------------- |
| 0    | OK / nothing to do              |
| 1    | Usage error                     |
| 2    | Config error                    |
| 3    | Partial failure (some rendered, some failed) |
| 4    | No plugin matched               |

## Output layout

```
<output>/
  claude/<source-relative>.md
  codex/sessions/<YYYY>/<MM>/<DD>/<rollout>.md
  codex/archived_sessions/<rollout>.md
  pi/<workspace-slug>/<ts>_<uuid>.md
  opencode/<project-slug>/<session_id>.md
  .ace.state.json          # only when strategy = index
```

Top-level dir is the source `name`, so QMD-style indexers and `grep -r` scopes filter trivially.

## Frontmatter schema

Canonical keys are emitted whenever the renderer can infer them. Source-specific extras live under `x_<source>` namespaces. `aceSchema` is the contract version — downstream tools should branch on it. Renderers never emit `null` — keys they can't fill are omitted.

```yaml
---
source: claude                      # required; equals AgentSource.name
sessionId: 7f3a-...                 # plugin best-effort
startedAt: 2026-05-02T14:11:08Z     # ISO-8601, UTC
endedAt:   2026-05-02T15:02:44Z
cwd: /Users/me/code/foo
model: claude-opus-4-7
gitBranch: main
version: 1.2.3
title: "Refactor auth flow"         # plugin best-effort (first user msg, cwd basename, …)
messageCount: 42
toolCallCount: 11
aceSchema: 1                        # frontmatter contract version (NOT package version)
aceRenderedAt: 2026-05-03T09:00:00Z
sourcePath: ~/.claude/projects/foo/abc.jsonl
sourceMtime: 2026-05-02T15:02:44Z
# Source-specific extras — see docs/sources/<source>.md for the full list.
x_claude:
  teamName: acme
  agentName: diagnostician
---
```

Full machine-readable schema for agent consumers: [`docs/AGENTS.md`](docs/AGENTS.md).

## Worked example: Drive output + launchd at :48

Drop rendered Markdown into a Google Drive folder so it indexes alongside the rest of your knowledge base, and re-render every hour at minute 48 via launchd:

```sh
npx @mjaverto/ace init
# Edit ace.config.yaml:
#   output: ~/Library/CloudStorage/GoogleDrive-<account>/My Drive/_Brain/agent-conversations
npx @mjaverto/ace doctor
npx @mjaverto/ace install launchd \
  --cron-minute 48 \
  --label dev.ace.render \
  --run-now
```

`doctor` will probe whether the Drive folder preserves mtimes; if it doesn't, it prints a one-line hint to switch to `--strategy index`. The launchd job writes to `~/Library/Logs/ace.log` by default — `ace logs --tail` will follow it.

## Schedulers

| Platform | Backend  | Generated artifact                                  | Docs                                |
| -------- | -------- | --------------------------------------------------- | ----------------------------------- |
| macOS    | launchd  | `~/Library/LaunchAgents/<label>.plist`              | [`docs/scheduling.md`](docs/scheduling.md) |
| Linux    | systemd  | `~/.config/systemd/user/<label>.{service,timer}`    | [`docs/scheduling.md`](docs/scheduling.md) |
| any      | cron     | line in `crontab -l` tagged `# agent-md:<label>`    | [`docs/scheduling.md`](docs/scheduling.md) |

## Troubleshooting

### "Output mtime not preserved"

Some cloud-sync filesystems (Drive, iCloud, OneDrive) round or rewrite mtimes. The default `mtime` strategy will misbehave there — symptoms include re-rendering everything every run. Run `ace doctor` to confirm; it writes+restats a temp file and reports mtime resolution. If unreliable, switch to `strategy: index` in your config (or pass `--strategy index`). The index strategy stores per-entry sha + mtime + size in a single `<output>/.ace.state.json` file — far friendlier to cloud-sync than per-file sidecars.

### "opencode database is locked"

ace opens `opencode.db` with `{ readonly: true, fileMustExist: true }`, so it should never lock or block a running opencode TUI. If you see a lock error anyway, it usually means another process opened the DB in write-mode with `journal_mode = WAL` and crashed. Quitting opencode and re-running ace clears it. You can override the path via the `OPENCODE_DB` environment variable.

### "Rendered 0 files"

Most often a `--source` filter or the `roots:` in your config pointing at the wrong path. Run `ace doctor` — it lists every configured root, whether it exists, and how many session candidates it sees. If a source's CLI moved its data on you, file an issue.

### "Unknown block type appears as JSON in output"

Intentional. When a renderer encounters a block type it doesn't know (a new event type after a CLI update, e.g.), it surfaces the raw JSON in a fenced block instead of silently dropping it. This way schema drift is visible in the rendered Markdown rather than buried in logs. To add a renderer for the new block type, see [`docs/contributing.md`](docs/contributing.md).

## Add your own source plugin

ace's plugin contract is a single TypeScript interface (`AgentSource`) with two methods: `enumerate()` (yield `SessionHandle`s) and `render()` (return `{ markdown, frontmatter }`). For JSONL-backed sources there's a built-in helper (`jsonlEnumerate`) so a new plugin is roughly 100 lines. Load it at runtime with `--plugin ./my-source.js`, no rebuild required. Full recipe: [`docs/contributing.md`](docs/contributing.md).

## Using ace from an AI agent

If you're an LLM agent that's landed in this repo because the user asked you to export, archive, or render their CLI transcripts, read [`docs/AGENTS.md`](docs/AGENTS.md) — it covers the NDJSON output mode, the full frontmatter schema, exit-code semantics, and the things that look like errors but aren't.

## License

[MIT](LICENSE).

## Acknowledgements

Built on [`citty`](https://github.com/unjs/citty) (CLI), [`tsup`](https://tsup.egoist.dev/) (bundling), [`vitest`](https://vitest.dev/) (tests), [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (opencode reader), and [`yaml`](https://eemeli.org/yaml/) (frontmatter). Inspired by every "I just want this conversation in a file I can grep" frustration.
