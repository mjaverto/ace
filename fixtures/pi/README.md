# Pi renderer fixtures

Each pair `NN-name.jsonl` + `NN-name.expected.md` is a snapshot test: the renderer
must produce output that matches the expected file byte-for-byte after substituting
the two placeholder values below.

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
| `01-basic` | session + model_change events; one user + one assistant message (text only) |
| `02-tool-result-error` | assistant toolCall block + toolResult with `isError: true`; `[ERROR]` heading |
| `03-thinking-level-change` | `thinking_level_change` event flows into `x_pi.thinkingLevel`; assistant message contains a `thinking` block (`thinkingSignature` is dropped) |
