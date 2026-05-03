# Source: opencode (sst)

[opencode](https://github.com/sst/opencode) is the **outlier** of the day-one sources: it doesn't write JSONL. Sessions, messages, and parts live in a SQLite database.

## Where it lives

| | |
| - | - |
| Default root | `~/.local/share/opencode/opencode.db` |
| Driver       | [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) (sync, native) |
| Mode         | **Read-only**. `{ readonly: true, fileMustExist: true }` |
| Override     | `OPENCODE_DB` env var, or `roots:` in config (file or parent dir).             |

ace **never writes** to the DB. Opening read-only means a running opencode TUI can keep operating undisturbed, and there's zero risk of corrupting opencode's state.

Multiple installs are supported — list multiple paths in `sources.opencode.roots` and ace yields one session per row across all of them.

## Schema

opencode uses Drizzle ORM. The relevant tables:

```
session (
  id TEXT PRIMARY KEY,           -- "ses_…"
  project_id TEXT,
  slug TEXT,                     -- human-friendly project slug
  directory TEXT,                -- working dir at session start
  title TEXT,
  version TEXT,                  -- opencode version
  time_created INTEGER,          -- epoch ms
  time_updated INTEGER,          -- epoch ms — used as mtime
  time_archived INTEGER          -- when archived; ace skips these
)

message (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  time_created INTEGER,
  time_updated INTEGER,
  data TEXT                      -- JSON-encoded message envelope
)

part (
  message_id TEXT,
  time_created INTEGER,
  data TEXT                      -- JSON-encoded part body
)
```

`data` columns are JSON strings — ace parses them at render time. The envelope/body shape is the same one opencode would have written to JSONL if it had picked that route — only the storage differs.

## What ace extracts

### Enumeration

```sql
SELECT id, time_updated, project_id, slug, directory, title, version
FROM session
WHERE time_archived IS NULL
ORDER BY time_updated;
```

`mtimeMs = time_updated` (already epoch ms, no conversion). `outputRelPath = opencode/<slug-or-projectId>/<id>.md`. The `ses_` prefix on session ids is preserved for traceability — strip it in your indexer if you don't want it.

**Archived sessions are skipped** (`time_archived IS NOT NULL`). If you need them, the simplest path is a custom plugin that drops the `WHERE` clause; in v0 ace does not expose a flag.

### Render

For each session ace runs:

```sql
SELECT id, time_created, data FROM message
WHERE session_id = ? ORDER BY time_created;
```

then per message:

```sql
SELECT data FROM part WHERE message_id = ? ORDER BY time_created;
```

Each part's `data` JSON has a `type` discriminator:

| Part type      | Rendered as                                                            |
| -------------- | ---------------------------------------------------------------------- |
| `text`         | Role-tagged paragraph.                                                 |
| `reasoning`    | `<details><summary>thinking</summary>…</details>`.                     |
| `tool`         | `### Tool call · <toolName>` fenced args + `#### Output` fenced output. `state.status: "error"` → `[ERROR]` marker. |
| `step-start`   | Silent (control event).                                                |
| `step-finish`  | Silent (control event).                                                |
| `file`         | Fenced block with file-path header.                                    |
| _unknown_      | Fenced ```` ```json ```` block — drift-visibility.                     |

### Frontmatter

Canonical: `source: opencode`, `sessionId` (the `ses_…` id), `startedAt` (from earliest message), `endedAt` (from `time_updated`), `cwd` (from `directory`), `version`, `title`, `messageCount`, `toolCallCount`.

`x_opencode` extras:

| Key                  | Type    | Notes                                                            |
| -------------------- | ------- | ---------------------------------------------------------------- |
| `projectId`          | string  | `session.project_id`.                                            |
| `slug`               | string  | `session.slug`.                                                  |
| `directory`          | string  | `session.directory` (also lifted to canonical `cwd`).            |
| `version`            | string  | `session.version` (also lifted to canonical `version`).          |
| `summaryFiles`       | integer | Files touched, when opencode tracks it.                          |
| `summaryAdditions`   | integer | Lines added.                                                     |
| `summaryDeletions`   | integer | Lines deleted.                                                   |
| `dbPath`             | string  | Absolute path of the source SQLite db (multi-DB disambiguation). |

### Encrypted/opaque fields

None observed in opencode's schema as of writing. If new opaque blob fields appear in `part.data`, the renderer drops them (same rule as Codex's `encrypted_content` and Pi's `thinkingSignature`).

## Test fixtures

Because shipping a real `opencode.db` would be huge and full of personal content, ace's snapshot tests don't use one. Instead, [`tests/helpers/opencode-fixture.ts`](../../tests/helpers/opencode-fixture.ts) seeds a tmp SQLite DB with the known schema + rows for each scenario, runs `render()`, and snapshots the Markdown output. To add a new shape variant, extend the helper — never commit a real DB.

## Don't

- **Don't write to the DB.** Use opencode's own commands.
- **Don't run multiple ace renders against the same DB simultaneously.** Reads are safe, but you'd waste cycles. Schedule one job, not several.
- **Don't expect the file path to be portable across machines.** `dbPath` is recorded under `x_opencode` precisely so you can disambiguate if you ever sync rendered output across devices.
