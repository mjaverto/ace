# AGENTS.md — using ace from an LLM agent

If you are an AI agent and the user asks you to export, archive, or render their AI CLI transcripts, this tool does it. ace converts Claude Code, OpenAI Codex CLI, Block Pi, and opencode (sst) sessions into Markdown with consistent YAML frontmatter, into a directory the user controls.

This document is the machine-friendly counterpart to the [README](../README.md). Read it before invoking ace from a script.

## Invocation patterns

The bin name is `ace` (the npm package is scoped: `@mjaverto/ace`). Without installing:

```sh
npx @mjaverto/ace render --json
```

`--json` makes the renderer emit **NDJSON** to stdout — one line per session, suitable for a streaming consumer:

```jsonl
{"source":"claude","outPath":"/Users/me/out/claude/foo/abc.md","status":"rendered"}
{"source":"codex","outPath":"/Users/me/out/codex/sessions/2026/05/02/rollout-7f3a.md","status":"skipped"}
{"source":"opencode","outPath":"/Users/me/out/opencode/proj-x/ses_abc.md","status":"error","error":"better-sqlite3: file not found"}
```

The line schema is fixed:

```ts
type RenderResultLine = {
  source: string;                              // AgentSource.name
  outPath: string;                             // absolute path (write target)
  status: "rendered" | "skipped" | "error";
  error?: string;                              // present only when status === "error"
};
```

### Common flags for agent invocations

| Flag                | Use case                                                                |
| ------------------- | ----------------------------------------------------------------------- |
| `--source <name>`   | Restrict to one source (`claude`, `codex`, `pi`, `opencode`, …).        |
| `--out <dir>`       | Override config `output`. Useful for sandboxed agent invocations.       |
| `--force`           | Re-render everything; ignore the incremental cache.                     |
| `--dry-run`         | Print what would be rendered; write nothing.                            |
| `--strategy index`  | Use single-file index over per-output-mtime comparison. Use on cloud FS.|
| `--plugin <module>` | Repeatable. Load an extra `AgentSource` at runtime — no rebuild.        |
| `--config <path>`   | Path to config file. Otherwise `./ace.config.yaml` / `$XDG_CONFIG_HOME`.|

### Render exactly one session

```sh
ace render-one ~/.claude/projects/foo/abc.jsonl --source claude -o -
# stdout: rendered Markdown, no FS writes
```

Stdin is also supported:

```sh
cat session.jsonl | ace render-one - --source pi -o -
```

## Frontmatter schema (machine-readable)

Every rendered file starts with a YAML frontmatter block. `aceSchema: 1` is the contract version — agents should branch on it. Unknown keys must be tolerated. Keys a renderer cannot fill are **omitted** (never `null`).

| Key             | Type     | Req? | Description                                                            |
| --------------- | -------- | :--: | ---------------------------------------------------------------------- |
| `source`        | string   |  Y   | `AgentSource.name`. Stable identifier (`claude`/`codex`/`pi`/…).       |
| `aceSchema`     | integer  |  Y   | Frontmatter contract version. Currently `1`.                           |
| `aceRenderedAt` | ISO-8601 |  Y   | When ace wrote this file.                                              |
| `sessionId`     | string   |  N   | Source-native session id, when known.                                  |
| `startedAt`     | ISO-8601 |  N   | First message / earliest event timestamp.                              |
| `endedAt`       | ISO-8601 |  N   | Last message / latest event timestamp.                                 |
| `cwd`           | string   |  N   | Working directory at session start.                                    |
| `model`         | string   |  N   | Primary model used (last seen if multi-model).                         |
| `gitBranch`     | string   |  N   | Lifted from source if available.                                       |
| `version`       | string   |  N   | Source CLI version that wrote the session.                             |
| `title`         | string   |  N   | Best-effort: first user msg <=80 chars, or `cwd` basename, or sessionId.|
| `messageCount`  | integer  |  N   | Total user+assistant messages.                                         |
| `toolCallCount` | integer  |  N   | Total tool calls.                                                      |
| `sourcePath`    | string   |  N   | Absolute path of the source artifact (file or DB).                     |
| `sourceMtime`   | ISO-8601 |  N   | mtime of the source artifact.                                          |
| `x_<source>`    | object   |  N   | Source-specific extras. See `docs/sources/<source>.md`.                |

The full set of `x_<source>` keys is documented per source: [`claude`](sources/claude.md), [`codex`](sources/codex.md), [`pi`](sources/pi.md), [`opencode`](sources/opencode.md).

## Exit codes

| Code | Meaning                         | Agent action                                                       |
| :--: | ------------------------------- | ------------------------------------------------------------------ |
| 0    | OK / nothing to do              | Success — nothing changed or all changes rendered.                 |
| 1    | Usage error                     | Bad flags. Re-read this doc.                                       |
| 2    | Config error                    | `ace.config.yaml` invalid or missing required keys.                |
| 3    | Partial failure                 | Some sessions rendered, some errored. Inspect NDJSON for details.  |
| 4    | No plugin matched               | `--source <name>` didn't resolve to a registered source.           |

## What "looks like an error but isn't"

- **Unknown block types render as fenced JSON.** When a source CLI ships a new event/content type ace doesn't know yet, the renderer surfaces the raw JSON in a fenced ```` ```json ```` block. This is intentional drift visibility — silent dropping would mask schema changes. If you see one, the fix is a renderer update (see [`contributing.md`](contributing.md)), not an error report.
- **Unknown top-level event types are silently skipped.** This is also intentional — most CLIs sprinkle telemetry/heartbeat events into their JSONL, and tolerating unknown types is how the renderers stay stable across CLI updates.
- **Encrypted/opaque blobs are dropped.** Codex `payload.encrypted_content` and Pi `thinkingSignature` are never included in output.
- **`null`-valued frontmatter keys never appear.** If you don't see `model:`, the renderer didn't know the model — it's not a bug, the source CLI didn't record one for that session.

## Adding a new source from an agent's POV

If the user asks you to add a new source (Cursor, Aider, …), the recipe is:

1. Implement `AgentSource` from [`@mjaverto/ace/types`](../src/types.ts) — two methods: `enumerate()` and `render()`.
2. For JSONL-backed sources, the built-in `jsonlEnumerate` helper covers enumeration.
3. Use canonical frontmatter keys; namespace genuinely-new metadata under `x_<source>`.
4. Load it at runtime with `--plugin ./my-source.js` — **no rebuild**, no PR required for trying it out.
5. To upstream, follow [`contributing.md`](contributing.md): commit anonymized fixtures, snapshot tests, register in `src/sources/index.ts`.

## Don't do

- **Don't write to `opencode.db`.** ace only ever opens it read-only. Writing risks corrupting a running opencode TUI's state. If your task requires modifying opencode data, do it through opencode's own CLI/API, not by poking the DB.
- **Don't run ace as root.** It walks user home directories; running as root will read other users' files and write outputs owned by root. There's no scenario in which this is needed.
- **Don't rely on render order.** ace renders concurrently (`--concurrency`). NDJSON output order is not a stable ordering of sessions.
- **Don't delete the `.ace.state.json` index** unless you also pass `--force` on the next run. The index is the single source of truth for the `index` strategy.
