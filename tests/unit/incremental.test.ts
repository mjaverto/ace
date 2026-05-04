// tests/unit/incremental.test.ts — unit tests for needsRender (mtime + index strategies)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { needsRender, type IndexState } from "../../src/core/incremental.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ace-incremental-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeTmpFile(name: string, content = "data"): Promise<string> {
  const p = path.join(tmpDir, name);
  await fs.writeFile(p, content, "utf8");
  return p;
}

async function mtimeMs(p: string): Promise<number> {
  return (await fs.stat(p)).mtimeMs;
}

// ---------------------------------------------------------------------------
// mtime strategy
// ---------------------------------------------------------------------------

describe("needsRender — mtime strategy", () => {
  it("returns true when dst does not exist yet", async () => {
    const src = await writeTmpFile("src.jsonl");
    const dst = path.join(tmpDir, "dst.md"); // does not exist
    const srcMtime = await mtimeMs(src);
    const result = await needsRender(srcMtime, 100, dst, "mtime");
    expect(result).toBe(true);
  });

  it("returns false when src does not exist (src missing → skip)", async () => {
    // needsRender with mtime strategy: src mtime of 0 and a dst that is newer
    // simulates a disappeared source: dst exists and mtime > src mtime (0)
    const dst = await writeTmpFile("dst.md");
    // Use srcMtimeMs = 0 (epoch) to simulate a missing/vanished source
    const result = await needsRender(0, 0, dst, "mtime");
    // dst mtime is definitely > 0, so src (0) is older → no render needed
    expect(result).toBe(false);
  });

  it("returns false when src is older than dst", async () => {
    // Write dst first, then ensure src has an older mtime by writing src before dst
    // We manipulate via utimes to be precise.
    const src = await writeTmpFile("src.jsonl");
    const dst = await writeTmpFile("dst.md");

    // Force src mtime to 1000ms in the past relative to dst
    const dstMt = await mtimeMs(dst);
    const srcOlderMt = dstMt - 2000;
    await fs.utimes(src, srcOlderMt / 1000, srcOlderMt / 1000);

    const result = await needsRender(srcOlderMt, 100, dst, "mtime");
    expect(result).toBe(false);
  });

  it("returns true when src is newer than dst", async () => {
    const src = await writeTmpFile("src.jsonl");
    const dst = await writeTmpFile("dst.md");

    // Force src to be 2s in the future relative to dst
    const dstMt = await mtimeMs(dst);
    const srcNewerMt = dstMt + 2000;
    await fs.utimes(src, srcNewerMt / 1000, srcNewerMt / 1000);

    const result = await needsRender(srcNewerMt, 100, dst, "mtime");
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// index strategy
// ---------------------------------------------------------------------------

describe("needsRender — index strategy", () => {
  const DST = "/tmp/fake.md"; // doesn't need to exist for index strategy

  it("returns true when state is missing entirely", async () => {
    const result = await needsRender(1000, 500, DST, "index");
    expect(result).toBe(true);
  });

  it("returns true when stateKey is not in the state map (entry missing)", async () => {
    const state: IndexState = {};
    const result = await needsRender(1000, 500, DST, "index", state, "claude/foo/bar.md");
    expect(result).toBe(true);
  });

  it("returns false when entry matches srcMtimeMs and srcSizeBytes exactly", async () => {
    const state: IndexState = {
      "claude/foo/bar.md": {
        srcMtimeMs: 1000,
        srcSizeBytes: 500,
        renderedAt: "2026-05-01T00:00:00.000Z",
      },
    };
    const result = await needsRender(1000, 500, DST, "index", state, "claude/foo/bar.md");
    expect(result).toBe(false);
  });

  it("returns true when srcMtimeMs differs from entry (entry stale — mtime changed)", async () => {
    const state: IndexState = {
      "claude/foo/bar.md": {
        srcMtimeMs: 1000,
        srcSizeBytes: 500,
        renderedAt: "2026-05-01T00:00:00.000Z",
      },
    };
    const result = await needsRender(2000, 500, DST, "index", state, "claude/foo/bar.md");
    expect(result).toBe(true);
  });

  it("returns true when srcSizeBytes differs from entry (entry stale — size changed)", async () => {
    const state: IndexState = {
      "claude/foo/bar.md": {
        srcMtimeMs: 1000,
        srcSizeBytes: 500,
        renderedAt: "2026-05-01T00:00:00.000Z",
      },
    };
    const result = await needsRender(1000, 600, DST, "index", state, "claude/foo/bar.md");
    expect(result).toBe(true);
  });
});
