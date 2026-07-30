# omp renderer fixtures

Each pair `NN-name.jsonl` + `NN-name.expected.md` is a snapshot test: the renderer
must produce output that matches the expected file byte-for-byte after substituting
the three placeholder values below.

## Placeholder convention

The expected files contain literal placeholder strings for fields that vary at
render time or depend on the local filesystem:

| Placeholder | Field | Why it varies |
|---|---|---|
| `<sourceMtime>` | `sourceMtime` in frontmatter | Filesystem mtime of the fixture .jsonl file; differs per machine / clone time |
| `<aceRenderedAt>` | `aceRenderedAt` in frontmatter | Wall-clock time of the render run |
| `<sourcePath>` | `sourcePath` in frontmatter | Absolute path to the fixture file on the local machine |

Test harnesses should replace these three frontmatter values with their
placeholder strings before doing a byte-for-byte comparison.

## Fixtures

| File | Covers |
|---|---|
| `01-basic` | session + model_change events; one user + one assistant message (text only); a `title` and `custom_message` event that must be silently skipped |
| `02-tool-result-error` | assistant toolCall block + omp's flat `toolResult` message (`content` is a block array, not pi's `PiToolResultItem[]`) with `isError: true`; `[ERROR]` heading |
| `03-thinking-level-change` | `thinking_level_change` event flows into `x_omp.thinkingLevel`; assistant message contains a `thinking` block (`thinkingSignature` is dropped) |

## Divergence from `pi`

omp is pi-mono's successor and shares most of the flat-event schema, but:

- `session.version` is a number (`3`), not a string — rendered as `String(version)`.
- `model_change` carries `model` only (already includes the provider prefix, e.g.
  `anthropic/claude-opus-4-5`); it does not emit a separate `provider` field.
- A `toolResult` message is a single flat object
  (`{ role: "toolResult", toolCallId, toolName, content, isError }`), not pi's
  `content: PiToolResultItem[]` batch — and `content` is an array of blocks
  (usually one `text` block), not a plain string.
- Extra top-level event types (`title`, `title_change`, `custom_message`, `custom`,
  `credential_pin`, …) are emitted and silently skipped, same as any unrecognized
  event type.
