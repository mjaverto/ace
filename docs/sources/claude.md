# Source: Claude Code

Anthropic's [Claude Code](https://docs.claude.com/claude-code) CLI stores one JSONL file per session under your home directory.

## Where it lives

| | |
| - | - |
| Default root | `~/.claude/projects` |
| Path shape   | `~/.claude/projects/<project-slug>/<uuid>.jsonl` |
| Match regex  | `/\.claude\/projects\/[^/]+\/[0-9a-f-]+\.jsonl$/` |

`<project-slug>` is the absolute working-directory path with `/` flattened to `-`. `<uuid>` is the session UUID Claude Code generates on `claude` start.

## Schema (per line)

Each line is one event. Top-level `type` is the discriminator. Only `user` and `assistant` lines render — everything else (`summary`, `tool-use-status`, telemetry, …) is silently skipped per the schema-drift discipline.

```jsonc
// Minimal user line
{
  "type": "user",
  "uuid": "…",
  "timestamp": "2026-05-02T14:11:08Z",
  "message": { "role": "user", "content": "What does this script do?" }
}

// Assistant line — content can be a string OR a list of blocks.
{
  "type": "assistant",
  "uuid": "…",
  "timestamp": "2026-05-02T14:11:12Z",
  "message": {
    "role": "assistant",
    "content": [
      { "type": "thinking", "thinking": "…" },
      { "type": "text", "text": "Looks like a wrapper around …" },
      { "type": "tool_use", "id": "toolu_…", "name": "Bash", "input": { "command": "ls" } },
      { "type": "tool_result", "tool_use_id": "toolu_…", "content": "…" }
    ]
  }
}
```

## What ace extracts

### Frontmatter

Canonical keys: `source: claude`, `sessionId` (the JSONL filename), `startedAt`, `endedAt`, `cwd`, `model`, `gitBranch`, `version`, `messageCount`, `toolCallCount`, `title` (best-effort: first user message ≤80 chars, else `cwd` basename, else `sessionId`).

`x_claude` extras:

| Key         | Type   | Notes                                              |
| ----------- | ------ | -------------------------------------------------- |
| `teamName`  | string | When session was scoped to a Claude Code team.     |
| `agentName` | string | When invoked via a sub-agent / skill.              |

### Body

Block-type rendering rules:

| Block type    | Rendered as                                                              |
| ------------- | ------------------------------------------------------------------------ |
| `text`        | Inline paragraph under the role heading.                                 |
| `thinking`    | `<details><summary>thinking</summary>…</details>`                        |
| `tool_use`    | `### Tool call · <name> · <ts>` + fenced `bash`/`json` block.            |
| `tool_result` | `#### Output (truncated, N bytes)` fenced block under the matching call. |
| _unknown_     | Fenced ```` ```json ```` block — drift-visibility, on purpose.           |

## Truncation

Tool input/output bytes are clipped at the configured `truncate.toolInput` / `truncate.toolOutput` budgets, on UTF-8 codepoint boundaries. Truncated blocks get a `… [truncated N bytes]` footer. Set the budget to `false` to disable.

## Notes

- Claude Code writes a JSONL line per turn — files grow during a live session. ace's incremental strategies handle this by re-rendering when source mtime changes. There is no partial-render optimization in v0; every render walks the file end-to-end.
- The CLI version field is lifted from `version` if present in the assistant lines, into canonical `version`.
- `summary` lines (Anthropic's session-rename feature) are not rendered into the body, but `title` is best-effort lifted from the most recent `summary` line if present.
