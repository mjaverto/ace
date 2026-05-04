// tests/unit/sources/claude.test.ts — snapshot tests for the claude renderer

import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { claudeSource } from "../../../src/sources/claude.js";
import { serializeFrontmatter } from "../../../src/frontmatter.js";
import type { SessionHandle, RenderContext } from "../../../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../fixtures/claude");

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
    outputRelPath: `claude/test/${scenario}.md`,
    payload: { filePath },
  };

  const ctx: RenderContext = {
    outPath: `/tmp/ace-test/${scenario}.md`,
    now: new Date("2026-05-03T00:00:00.000Z"),
    truncate: { toolOutput: 4000, toolInput: 4000 },
    logger: VOID_LOGGER,
  };

  const result = await claudeSource.render(handle, ctx);
  // The core engine writes frontmatter + "\n" + markdown; replicate that join here.
  return serializeFrontmatter(result.frontmatter) + "\n" + result.markdown;
}

const SCENARIOS = [
  "01-basic",
  "02-tool-use",
  "03-thinking",
  "04-malformed-line",
  "05-unknown-block",
] as const;

describe("claudeSource snapshot tests", () => {
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
