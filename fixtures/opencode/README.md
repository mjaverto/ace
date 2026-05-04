# opencode fixtures

## Why there are no .db files here

opencode stores sessions in a SQLite database (`~/.local/share/opencode/opencode.db`).
SQLite `.db` files are binary, non-deterministic (they embed page checksums, WAL state, etc.),
and may contain real user data. Committing them would be:

- Fragile (byte-for-byte comparisons would break across SQLite versions)
- Potentially leaky (real conversation content)

## How snapshot tests work instead

`tests/helpers/opencode-fixture.ts` exports `seedOpencodeFixture(scenario)` which:

1. Creates a fresh `.db` file in `os.tmpdir()` with a unique name.
2. Inserts deterministic rows (fixed IDs, timestamps, content).
3. Returns `{ dbPath, sessionId }`.

The caller (test) is responsible for cleanup (`fs.unlink(dbPath)`).

The `.expected.md` files in this directory contain the byte-for-byte expected render output.
Dynamic values that change per-call are replaced with angle-bracket placeholders:
- `<sessionId>` — the seeded session id (includes a random hex suffix)
- `<dbPath>` — the tmp db file path
- `<aceRenderedAt>` — the render timestamp

Tests normalize these fields before comparing.

## Scenarios

| File | Description |
|------|-------------|
| `01-basic.expected.md` | 2-message session (user → assistant), text-only parts |
| `02-tool-error.expected.md` | Tool part with `state.status = "error"` — output marked `[ERROR]` |
| `03-reasoning.expected.md` | Reasoning part rendered as `<details>thinking</details>` then text |
| `04-archived-skipped.expected.md` | Session with `time_archived` set — `enumerate()` yields zero handles |
