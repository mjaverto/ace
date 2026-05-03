# Source: Block Pi

[Block's Pi agent](https://block.github.io/goose/) (Goose's successor) writes flat-event JSONL under a per-workspace directory.

## Where it lives

| | |
| - | - |
| Default root | `~/.pi/agent/sessions` |
| Path shape   | `~/.pi/agent/sessions/<workspace>/<ts>_<uuid>.jsonl` |
| Match regex  | `/\.pi\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/` |

`<workspace>` is a slug derived from the project root the session was started from. `<ts>_<uuid>` is the local-time start timestamp + a random session id.

`~/.pi/orchestrator/runs/*.md` are plan artifacts (already Markdown, not conversations) — not rendered. If you want them, point a custom plugin at that root.

## Schema (per line)

Pi uses a flat per-event schema. `type` is the discriminator:

- `session` — session header. Contains `id`, `cwd`, `version`.
- `model_change` — `provider`, `model`.
- `thinking_level_change` — `thinkingLevel`.
- `message` — the conversation. `message.role` ∈ `user` / `assistant` / `toolResult`.
- _everything else_ — silently skipped (telemetry, heartbeat, …).

User/assistant `message` events carry `message.content[]` blocks of type `text`, `thinking` (with a `thinkingSignature` blob ace ignores), or `toolCall` (camelCase; `arguments` is already a parsed object — no JSON re-parse).

`toolResult` messages stand on their own — they get a `## Tool` heading and are matched to the most recent `toolCall` by id. `isError: true` results render with an `[ERROR]` marker.

```jsonc
{ "type": "session", "ts": "2026-05-02T14:11:08Z",
  "id": "abc-…", "cwd": "/me/foo", "version": "0.4.2" }

{ "type": "model_change", "ts": "…",
  "provider": "anthropic", "model": "claude-opus-4-7" }

{ "type": "message", "ts": "…",
  "message": { "role": "assistant",
               "content": [
                 { "type": "thinking", "thinking": "…", "thinkingSignature": "…" },
                 { "type": "text", "text": "Running ls now." },
                 { "type": "toolCall", "id": "tc_1", "name": "Bash",
                   "arguments": { "command": "ls" } } ] } }

{ "type": "message", "ts": "…",
  "message": { "role": "toolResult", "toolCallId": "tc_1",
               "content": "…", "isError": false } }
```

## What ace extracts

### Frontmatter

Canonical: `source: pi`, `sessionId`, `cwd`, `model`, `startedAt`, `endedAt`, `version`, `messageCount`, `toolCallCount`.

`x_pi` extras:

| Key             | Type   | Notes                                          |
| --------------- | ------ | ---------------------------------------------- |
| `provider`      | string | LLM provider (`anthropic`, `openai`, …).       |
| `thinkingLevel` | string | Last seen thinking level.                      |

### Body

| `type` / `role`               | Rendered as                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `message` user                | `## User · <ts>` + text blocks.                              |
| `message` assistant           | `## Assistant · <ts>` + thinking (details) + text + tools.   |
| `message` toolResult          | `## Tool · <name> · <ts>` + fenced output, `[ERROR]` if so.  |
| `session` / `model_change` / `thinking_level_change` | Header metadata only — no body block.   |
| _unknown content block_       | Fenced ```` ```json ```` block.                              |

## Dropped fields

`thinkingSignature` (opaque cryptographic blob) is never rendered.
