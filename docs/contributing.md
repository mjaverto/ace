# Contributing to ace

This guide covers two things: adding a new source plugin (the most common contribution), and the dev/test conventions the rest of the codebase expects you to follow.

## Adding a new source plugin

The plugin contract is one TS interface, [`AgentSource`](../src/types.ts), with two methods. The recipe:

1. **Find the data.** Most CLIs store conversation logs under one of:
   - `~/.<tool>/` (Claude Code, Codex, Pi)
   - `~/Library/Application Support/<tool>/` (macOS-native apps)
   - `$XDG_DATA_HOME/<tool>/` (XDG-respecting tools — opencode, …)

2. **Inspect the schema.** For JSONL:

   ```sh
   jq -r '.type' ~/.tool/sessions/foo.jsonl | sort -u
   ```

   then dive into payload shapes per type. For SQLite, `sqlite3 ~/.tool/db .schema`. Note opaque blobs (signatures, encrypted content) — those should never end up in rendered Markdown.

3. **Anonymize a small fixture** exercising the interesting shapes: a user message, an assistant message with thinking, a tool call, a tool result, and one unknown/noise event so you can verify drift surfacing. Commit the fixture and an expected-output snapshot to `fixtures/<source>/01-basic.{jsonl,md}`.

4. **Copy the closest existing renderer as template.**
   - Block-style content lists (Anthropic-shaped) → `src/sources/claude.ts`.
   - Envelope-style `{timestamp, type, payload}` → `src/sources/codex.ts`.
   - Flat-event per-line schema → `src/sources/pi.ts`.
   - SQLite-backed → `src/sources/opencode.ts`.

5. **Use canonical frontmatter keys.** Invent new keys only for genuinely-new metadata, and namespace them under `x_<source>`. Never emit `null`-valued keys — omit instead. Full canonical-key list lives in [`AGENTS.md`](AGENTS.md).

6. **Snapshot test** input → expected output, byte-for-byte, with `vitest`'s snapshot helpers. Tests live in `tests/unit/`.

7. **Register your source** in `src/sources/index.ts` so the built-in registry picks it up.

8. **Add a doc page** at `docs/sources/<name>.md` mirroring the existing pages — where it lives, schema summary, what ace extracts, anything the agent-from-cold consumer needs to know.

### Trying it out without a PR

Plugins can be loaded at runtime — no rebuild, no PR needed:

```sh
ace render --plugin ./my-source.js
```

Default-export your `AgentSource` (or a factory). Once you're happy, upstream it via the steps above.

## Schema-drift discipline

Every renderer in this repo follows four rules. New plugins must follow them too:

1. **Skip unknown top-level event types silently.** Telemetry/heartbeat events are routine; tolerating them is how the renderer stays stable across CLI updates.
2. **Surface unknown content/block types as fenced JSON** in the rendered Markdown. Drift visibility beats silent dropping. A maintainer reviewing a fixture diff will see the unknown block immediately.
3. **Drop opaque/encrypted blobs.** Signatures, `encrypted_content`, anything binary — never include in rendered Markdown.
4. **Omit unknown frontmatter keys.** Don't emit `null`. The downstream consumer's "key missing" branch is always the cleanest.

## Dev setup

```sh
gh repo clone mjaverto/ace
cd ace
npm install
npm run build       # tsup
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

Node 20+ is required (engines floor). The repo is ESM (`"type": "module"`); imports must include `.js` extensions in TS source.

## Running tests

| Command                    | What it runs                                             |
| -------------------------- | -------------------------------------------------------- |
| `npm test`                 | All vitest unit + integration tests, one shot.           |
| `npm run test:watch`       | Watch mode for TDD.                                      |
| `npm run typecheck`        | `tsc --noEmit` strict.                                   |

Integration tests (under `tests/integration/`) build the CLI and execute it via `execa` — they exercise `render`, `render-one`, idempotent re-runs, partial failure paths, and `install --dry-run` for all three schedulers.

## Fixture conventions

- **Path**: `fixtures/<source>/<NN>-<slug>.jsonl` (input) and `<NN>-<slug>.md` (expected output). Two-digit prefixes so they sort.
- **Content**: anonymized — no real paths, real names, or real prompts. Keep them small (≤30 events). One scenario per fixture; layered scenarios go in separate files.
- **Updating snapshots**: `npm test -- -u` regenerates snapshots. Review the diff carefully — schema drift shows up here first.
- **Opencode**: don't ship a `.db`. Add a new shape via the seed helper in `tests/helpers/opencode-fixture.ts` and snapshot the rendered Markdown output.

## Code style

- TS strict mode. No `any` outside well-justified boundaries.
- ESM imports with explicit `.js` extensions in source.
- No emoji in source files, comments, or docs (project-wide rule).
- Renderer modules are pure: they take input + context and return `{ markdown, frontmatter }`. No FS writes from inside renderers — the core's atomic-write layer owns that.

## Pull requests

- Branch off `main`. Open a PR via `gh pr create`.
- Title: imperative mood, scoped — `feat(sources): add cursor renderer`, `fix(codex): handle missing turn_context`.
- One feature per PR. Schema-drift fixtures + renderer change can ship together; new source + new docs ship together.
- CI runs `{macos-latest, ubuntu-latest} × {node 20, 22}`. All matrix cells must pass before merge.

## Releases

Releases are managed via [Changesets](https://github.com/changesets/changesets). When your change deserves a version bump, run `npx changeset` and commit the generated `.changeset/<id>.md`.
