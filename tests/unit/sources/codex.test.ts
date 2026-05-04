// tests/unit/sources/codex.test.ts — snapshot tests for the codex renderer

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { codexSource } from "../../../src/sources/codex.js";
import { serializeFrontmatter } from "../../../src/frontmatter.js";
import type { SessionHandle, RenderContext } from "../../../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../fixtures/codex");

const RUNTIME_PLACEHOLDER = "<RUNTIME>";

function normalizeRuntime(text: string): string {
  let out = text;
  out = out.replace(/^aceRenderedAt: .+$/m, `aceRenderedAt: ${RUNTIME_PLACEHOLDER}`);
  out = out.replace(/^sourcePath: .+$/m, `sourcePath: ${RUNTIME_PLACEHOLDER}`);
  out = out.replace(/^sourceMtime: .+$/m, `sourceMtime: ${RUNTIME_PLACEHOLDER}`);
  return out;
}

const VOID_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function renderFixture(scenario: string): Promise<string> {
  const filePath = path.join(FIXTURES_DIR, `${scenario}.jsonl`);
  const stat = await fs.stat(filePath);

  const handle: SessionHandle = {
    id: filePath,
    mtimeMs: stat.mtimeMs,
    sizeBytes: stat.size,
    outputRelPath: `codex/test/${scenario}.md`,
    payload: { filePath },
  };

  const ctx: RenderContext = {
    outPath: `/tmp/ace-test/${scenario}.md`,
    now: new Date("2026-05-03T00:00:00.000Z"),
    truncate: { toolOutput: 4000, toolInput: 4000 },
    logger: VOID_LOGGER,
  };

  const result = await codexSource.render(handle, ctx);
  // The core engine writes frontmatter + "\n" + markdown; replicate that join here.
  return serializeFrontmatter(result.frontmatter) + "\n" + result.markdown;
}

const SCENARIOS = [
  "01-basic",
  "02-function-call",
  "03-reasoning-with-encrypted",
  "04-archived",
] as const;

describe("codexSource snapshot tests", () => {
  for (const scenario of SCENARIOS) {
    it(`renders ${scenario} correctly`, async () => {
      const actual = normalizeRuntime(await renderFixture(scenario));
      const expectedRaw = await fs.readFile(
        path.join(FIXTURES_DIR, `${scenario}.expected.md`),
        "utf8"
      );
      // The expected files may or may not have runtime fields;
      // normalize either way for consistent comparison.
      const expected = normalizeRuntime(expectedRaw);
      expect(actual).toBe(expected);
    });
  }
});
