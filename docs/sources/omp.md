# Source: omp (oh-my-pi)

oh-my-pi ("omp"), a successor to [pi-mono](https://github.com/badlogic/pi-mono), writes flat-event JSONL under a per-workspace directory — the same layout pi-mono uses, with a handful of schema changes.

## Where it lives

| | |
| - | - |
| Default root | `~/.omp/agent/sessions` |
| Path shape   | `~/.omp/agent/sessions/<workspace>/<ts>_<uuid>.jsonl` |
| Match regex  | `/\.omp\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/` |

`<workspace>` is a slug derived from the project root the session was started from. `<ts>_<uuid>` is the local-time start timestamp + a random session id.

## Schema (per line)

Same flat per-event style as pi. `type` is the discriminator:

- `session` — session header. Contains `id`, `cwd`, `version` (a **number**, not a string — rendered via `String(version)`).
- `model_change` — `model` only. Already includes the provider prefix (e.g. `anthropic/claude-opus-4-8`); there is no separate `provider` field.
- `thinking_level_change` — `thinkingLevel`.
- `message` — the conversation. `message.role` ∈ `user` / `assistant` / `toolResult`.
- `title`, `title_change`, `custom_message`, `custom`, `credential_pin`, … — omp-only event types, silently skipped (same treatment as any unrecognized top-level type).
- _unknown `message.role` values_ — surfaced as a fenced JSON block (drift visibility).

User/assistant `message` events carry `message.content[]` blocks of type `text`, `thinking` (with a `thinkingSignature` blob ace ignores), or `toolCall` (camelCase; `arguments` is already a parsed object — no JSON re-parse).

**Divergence from pi:** a `toolResult` message is a single flat object — `toolCallId`/`toolName`/`content`/`isError` live directly on `message`, not wrapped in a `content: PiToolResultItem[]` batch — and `content` is an array of blocks (usually one `text` block), not a plain string. ace flattens that block array by joining `text` block contents; non-text blocks are stringified as JSON. `isError: true` results render with an `[ERROR]` marker.

```jsonc
{ "type": "session", "timestamp": "2026-05-02T14:11:08Z",
  "id": "abc-…", "cwd": "/me/foo", "version": 3 }

{ "type": "model_change", "timestamp": "…",
  "model": "anthropic/claude-opus-4-8" }

{ "type": "message", "timestamp": "…",
  "message": { "role": "assistant",
               "content": [
                 { "type": "thinking", "thinking": "…", "thinkingSignature": "…" },
                 { "type": "text", "text": "Running ls now." },
                 { "type": "toolCall", "id": "tc_1", "name": "Bash",
                   "arguments": { "command": "ls" } } ] } }

{ "type": "message", "timestamp": "…",
  "message": { "role": "toolResult", "toolCallId": "tc_1", "toolName": "Bash",
               "content": [ { "type": "text", "text": "…" } ], "isError": false } }
```

## What ace extracts

### Frontmatter

Canonical: `source: omp`, `sessionId`, `cwd`, `model`, `startedAt`, `endedAt`, `version`, `messageCount`, `toolCallCount`.

`x_omp` extras:

| Key             | Type   | Notes                                                              |
| --------------- | ------ | ------------------------------------------------------------------- |
| `provider`      | string | Only present if a future omp version emits a separate `provider` field on `model_change`. |
| `thinkingLevel` | string | Last seen thinking level.                                          |

### Body

| `type` / `role`               | Rendered as                                                  |
| ----------------------------- | ------------------------------------------------------------ |
| `message` user                | `## User · <ts>` + text blocks.                              |
| `message` assistant           | `## Assistant · <ts>` + thinking (details) + text + tools.   |
| `message` toolResult          | `### Tool result · <name> · <ts>` + fenced output, `[ERROR]` if so. |
| `session` / `model_change` / `thinking_level_change` | Header metadata only — no body block.   |
| `title` / `title_change` / `custom_message` / `custom` / `credential_pin` | Skipped — no body block.  |
| _unknown content block_       | Fenced ```` ```json ```` block.                              |

## Dropped fields

`thinkingSignature` (opaque cryptographic blob) is never rendered.
