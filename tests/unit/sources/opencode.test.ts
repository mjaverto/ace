// tests/unit/sources/opencode.test.ts — snapshot tests for the opencode renderer

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { opencodeSource } from "../../../src/sources/opencode.js";
import { serializeFrontmatter } from "../../../src/frontmatter.js";
import { seedOpencodeFixture } from "../../helpers/opencode-fixture.js";
import type { RenderContext, EnumerateContext } from "../../../src/types.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "../../../fixtures/opencode");

const VOID_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// Track tmp DB paths for cleanup
let currentDbPath: string | null = null;

afterEach(async () => {
  if (currentDbPath !== null) {
    try {
      await fs.unlink(currentDbPath);
    } catch {
      // best-effort cleanup
    }
    currentDbPath = null;
  }
});

function makeRenderCtx(): RenderContext {
  return {
    outPath: `/tmp/ace-opencode-test.md`,
    now: new Date("2026-05-03T00:00:00.000Z"),
    truncate: { toolOutput: 4000, toolInput: 4000 },
    logger: VOID_LOGGER,
  };
}

function makeEnumerateCtx(dbPath: string): EnumerateContext {
  return {
    roots: [dbPath],
    logger: VOID_LOGGER,
  };
}

/**
 * Normalize dynamic values to placeholders:
 *   - sessionId (varies per test run — contains random hex suffix)
 *   - dbPath (tmp path)
 *   - aceRenderedAt (render timestamp)
 *   - sourcePath (same as dbPath for opencode)
 *   - sourceMtime (ISO from time_updated)
 *
 * The expected files use: <sessionId>, <dbPath>, <aceRenderedAt>.
 */
function normalizeActual(text: string, sessionId: string, dbPath: string): string {
  let out = text;
  // Replace actual dynamic values with expected-file placeholder strings
  out = out.split(sessionId).join("<sessionId>");
  out = out.split(dbPath).join("<dbPath>");
  out = out.replace(/^aceRenderedAt: .+$/m, "aceRenderedAt: <aceRenderedAt>");
  out = out.replace(/^sourcePath: .+$/m, "sourcePath: <dbPath>");
  out = out.replace(/^sourceMtime: .+$/m, "sourceMtime: <sourceMtime>");
  return out;
}

function normalizeExpected(text: string): string {
  // The expected file may have <sourceMtime> or similar; collapse all to same form
  // For fields not in expected files, no-op.
  return text;
}

describe("opencodeSource snapshot tests", () => {
  it("01-basic: renders correctly", async () => {
    const { dbPath, sessionId } = seedOpencodeFixture("01-basic");
    currentDbPath = dbPath;

    const enumerateCtx = makeEnumerateCtx(dbPath);
    const handles: import("../../../src/types.js").SessionHandle[] = [];
    for await (const handle of opencodeSource.enumerate(enumerateCtx)) {
      handles.push(handle);
    }
    expect(handles).toHaveLength(1);

    const result = await opencodeSource.render(handles[0]!, makeRenderCtx());
    const rawActual = serializeFrontmatter(result.frontmatter) + result.markdown;
    const actual = normalizeActual(rawActual, sessionId, dbPath);

    const expectedRaw = await fs.readFile(
      path.join(FIXTURES_DIR, "01-basic.expected.md"),
      "utf8"
    );
    expect(actual).toBe(normalizeExpected(expectedRaw));
  });

  it("02-tool-error: renders correctly", async () => {
    const { dbPath, sessionId } = seedOpencodeFixture("02-tool-error");
    currentDbPath = dbPath;

    const enumerateCtx = makeEnumerateCtx(dbPath);
    const handles: import("../../../src/types.js").SessionHandle[] = [];
    for await (const handle of opencodeSource.enumerate(enumerateCtx)) {
      handles.push(handle);
    }
    expect(handles).toHaveLength(1);

    const result = await opencodeSource.render(handles[0]!, makeRenderCtx());
    const rawActual = serializeFrontmatter(result.frontmatter) + result.markdown;
    const actual = normalizeActual(rawActual, sessionId, dbPath);

    const expectedRaw = await fs.readFile(
      path.join(FIXTURES_DIR, "02-tool-error.expected.md"),
      "utf8"
    );
    expect(actual).toBe(normalizeExpected(expectedRaw));
  });

  it("03-reasoning: renders correctly", async () => {
    const { dbPath, sessionId } = seedOpencodeFixture("03-reasoning");
    currentDbPath = dbPath;

    const enumerateCtx = makeEnumerateCtx(dbPath);
    const handles: import("../../../src/types.js").SessionHandle[] = [];
    for await (const handle of opencodeSource.enumerate(enumerateCtx)) {
      handles.push(handle);
    }
    expect(handles).toHaveLength(1);

    const result = await opencodeSource.render(handles[0]!, makeRenderCtx());
    const rawActual = serializeFrontmatter(result.frontmatter) + result.markdown;
    const actual = normalizeActual(rawActual, sessionId, dbPath);

    const expectedRaw = await fs.readFile(
      path.join(FIXTURES_DIR, "03-reasoning.expected.md"),
      "utf8"
    );
    expect(actual).toBe(normalizeExpected(expectedRaw));
  });

  it("04-archived-skipped: enumerate yields zero handles", async () => {
    const { dbPath } = seedOpencodeFixture("04-archived-skipped");
    currentDbPath = dbPath;

    const enumerateCtx = makeEnumerateCtx(dbPath);
    const handles: import("../../../src/types.js").SessionHandle[] = [];
    for await (const handle of opencodeSource.enumerate(enumerateCtx)) {
      handles.push(handle);
    }
    // Archived sessions (time_archived IS NOT NULL) are excluded from enumerate
    expect(handles).toHaveLength(0);
  });
});
