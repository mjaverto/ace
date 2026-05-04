// tests/unit/sources/pi.test.ts — snapshot tests for the pi renderer

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { piSource } from "../../../src/sources/pi.js";
import { serializeFrontmatter } from "../../../src/frontmatter.js";
import type { SessionHandle, RenderContext } from "../../../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../fixtures/pi");

// The pi fixture READme uses angle-bracket placeholders like <aceRenderedAt>,
// <sourcePath>, <sourceMtime>. We normalize both actual and expected to the
// same generic <RUNTIME> string so the comparison is machine-independent.
function normalizeRuntime(text: string): string {
  let out = text;
  // Replace actual ISO timestamps / absolute paths in the rendered output
  out = out.replace(/^aceRenderedAt: .+$/m, "aceRenderedAt: <RUNTIME>");
  out = out.replace(/^sourcePath: .+$/m, "sourcePath: <RUNTIME>");
  out = out.replace(/^sourceMtime: .+$/m, "sourceMtime: <RUNTIME>");
  // Replace the placeholder variants used in the fixture files
  out = out.replace(/^aceRenderedAt: <aceRenderedAt>$/m, "aceRenderedAt: <RUNTIME>");
  out = out.replace(/^sourcePath: <sourcePath>$/m, "sourcePath: <RUNTIME>");
  out = out.replace(/^sourceMtime: <sourceMtime>$/m, "sourceMtime: <RUNTIME>");
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
    outputRelPath: `pi/test/${scenario}.md`,
    payload: { filePath },
  };

  const ctx: RenderContext = {
    outPath: `/tmp/ace-test/${scenario}.md`,
    now: new Date("2026-05-03T00:00:00.000Z"),
    truncate: { toolOutput: 4000, toolInput: 4000 },
    logger: VOID_LOGGER,
  };

  const result = await piSource.render(handle, ctx);
  // The core engine writes frontmatter + "\n" + markdown; replicate that join here.
  return serializeFrontmatter(result.frontmatter) + "\n" + result.markdown;
}

const SCENARIOS = [
  "01-basic",
  "02-tool-result-error",
  "03-thinking-level-change",
] as const;

describe("piSource snapshot tests", () => {
  for (const scenario of SCENARIOS) {
    it(`renders ${scenario} correctly`, async () => {
      const actual = normalizeRuntime(await renderFixture(scenario));
      const expectedRaw = await fs.readFile(
        path.join(FIXTURES_DIR, `${scenario}.expected.md`),
        "utf8"
      );
      const expected = normalizeRuntime(expectedRaw);
      expect(actual).toBe(expected);
    });
  }
});
