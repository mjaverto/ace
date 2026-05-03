# Source: OpenAI Codex CLI

[Codex CLI](https://github.com/openai/codex) writes "rollout" JSONL files — one per session — under your home directory.

## Where it lives

| | |
| - | - |
| Default roots | `~/.codex/sessions`, `~/.codex/archived_sessions` |
| Path shape    | `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<id>.jsonl` |
| Match regex   | `/\.codex\/(sessions\|archived_sessions)\/.*\.jsonl$/` |

Archived sessions live in `archived_sessions/`; ace treats them like any other session and renders them under `codex/archived_sessions/...`.

`~/.codex/history.jsonl` and `~/.codex/memories/` are intentionally out of scope — they're shell-prompt history and long-term memory, not conversation rollouts. Override `roots:` in your config if you need them.

## Schema (per line)

Every line is `{ timestamp, type, payload }`. `type` is one of:

- `session_meta` — session header. Contains `id`, `cwd`, `cli_version`, `originator`, `instructions`, `git`.
- `turn_context` — model + reasoning effort for the next turn. Contains `model`, `effort`.
- `response_item` — the meat. `payload.type` is one of:
  - `message` — user/assistant text (`role` + `content[]`).
  - `reasoning` — model's thinking trace.
  - `function_call` — tool call. `arguments` is a JSON-encoded string; ace parses opportunistically.
  - `function_call_output` — tool result. Truncated per config.
- `event_msg` — UI events. Only `payload.type === "user_message"` renders (as a user turn). `token_count` and `agent_reasoning` are skipped (the latter duplicates `response_item.reasoning`).

```jsonc
{ "timestamp": "2026-05-02T14:11:08Z", "type": "session_meta",
  "payload": { "id": "7f3a-…", "cwd": "/me/foo", "cli_version": "0.18.0",
               "originator": "vscode", "git": { "branch": "main", "commit": "abc123" } } }

{ "timestamp": "…", "type": "turn_context",
  "payload": { "model": "gpt-5", "effort": "high" } }

{ "timestamp": "…", "type": "response_item",
  "payload": { "type": "function_call", "call_id": "call_1", "name": "Bash",
               "arguments": "{\"command\":\"ls\"}" } }
```

## What ace extracts

### Frontmatter

Canonical: `source: codex`, `sessionId`, `cwd`, `model`, `startedAt`, `endedAt`, `gitBranch`, `version`, `messageCount`, `toolCallCount`.

`x_codex` extras:

| Key            | Type   | Notes                                                    |
| -------------- | ------ | -------------------------------------------------------- |
| `originator`   | string | What kicked off the session (`vscode`, `cli`, …).        |
| `instructions` | string | Session-level instructions, truncated to 500 chars.      |
| `gitCommit`    | string | Lifted from `session_meta.payload.git.commit`.           |
| `effort`       | string | Last seen reasoning effort (`low`/`medium`/`high`).      |

### Body

| `payload.type`         | Rendered as                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `message` (user)       | `## User · <ts>` + body.                                               |
| `message` (assistant)  | `## Assistant · <ts>` + body.                                          |
| `reasoning`            | `<details><summary>thinking</summary>…</details>` under assistant.     |
| `function_call`        | `### Tool call · <name> · <ts>` + fenced parsed-args block.            |
| `function_call_output` | `#### Output` fenced block, attributed via `call_id` → tool name map.  |
| `event_msg.user_message` | `## User · <ts>` (treated as a user turn).                          |
| _unknown_              | Fenced ```` ```json ```` block.                                        |

ace tracks `call_id → tool name` across the file so `function_call_output` blocks render under the matching tool name even though the output line itself doesn't carry it.

## Dropped fields

`payload.encrypted_content` is dropped — opaque, never useful in Markdown. `agent_reasoning` event messages are also dropped (duplicate of `response_item.reasoning`).
