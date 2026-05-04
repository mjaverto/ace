# Claude Code fixtures

Each pair of `.jsonl` + `.expected.md` files is a snapshot test for the `claude` renderer.

## Runtime placeholder convention

Three frontmatter fields vary between machines and runs: `aceRenderedAt`, `sourcePath`, and `sourceMtime`. In every `.expected.md` these three keys carry the literal string `<RUNTIME>` as their value. Snapshot tests must substitute the corresponding actual values from `RenderResult` (plus `ctx.now`) in the actual output before comparing, or strip those three lines from both sides of the comparison.

## Fixture inventory

| File | What it exercises |
|------|-------------------|
| 01-basic | One user message + one assistant text reply; `x_claude` extras (teamName, agentName); plain string content. |
| 02-tool-use | Assistant emits a `tool_use` block; the following user turn wraps a `tool_result` block. Verifies `toolCallCount = 1`. |
| 03-thinking | Assistant emits a `thinking` block (signature must be dropped) followed by a `text` block. Verifies `<details>` rendering. |
| 04-malformed-line | Line 2 is invalid JSON. Renderer must silently skip it and emit only lines 1 and 3, yielding `messageCount = 2`. |
| 05-unknown-block | Assistant content includes a block with an unrecognized `type` (`widget`). Rendered as a fenced JSON block via `sectionForUnknown` for drift visibility. |
