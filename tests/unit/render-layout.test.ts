// tests/unit/render-layout.test.ts — runRender + the frontmatter-derived layout
//
// Covers the identity/layout redesign: raw-identity state keys, paths computed
// after render, relocation (write new, delete old), collision disambiguation,
// self-heal when an output vanishes, and dry-run staying read-only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runRender, type RenderReport } from "../../src/core/render.js";
import { loadIndex } from "../../src/core/incremental.js";
import { buildRelPath, disambiguator, rawRelPathFor } from "../../src/core/naming.js";
import { Registry } from "../../src/registry.js";
import type { AceConfig } from "../../src/config/schema.js";
import type { AgentSource, Frontmatter, Logger, SessionHandle } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface FakeSession {
  /** Raw file name under `rawRoot` — the handle id is the absolute form. */
  file: string;
  sessionId: string;
  startedAt: string;
  title: string;
  mtimeMs: number;
  sizeBytes: number;
}

const SOURCE_NAME = "faketool";

let tmpDir: string;
let outDir: string;
let rawRoot: string;
let logs: string[];
let logger: Logger;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ace-render-layout-test-"));
  outDir = path.join(tmpDir, "out");
  rawRoot = path.join(tmpDir, "raw");
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(rawRoot, { recursive: true });
  logs = [];
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logs.push(`${level} ${args.map((a) => String(a)).join(" ")}`);
    };
  logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function frontmatterFor(session: FakeSession): Frontmatter {
  return {
    source: SOURCE_NAME,
    sessionId: session.sessionId,
    startedAt: session.startedAt,
    title: session.title,
    aceSchema: 1,
  };
}

function handleId(session: FakeSession): string {
  return path.join(rawRoot, session.file);
}

/** A source whose sessions the test mutates between runs. */
function fakeSource(sessions: FakeSession[]): AgentSource {
  return {
    name: SOURCE_NAME,
    displayName: "Fake Tool",
    defaultRoots: () => [rawRoot],
    async *enumerate(): AsyncGenerator<SessionHandle> {
      for (const session of sessions) {
        yield {
          id: handleId(session),
          mtimeMs: session.mtimeMs,
          sizeBytes: session.sizeBytes,
          // Deliberately the *old* layout — the core must not use it.
          outputRelPath: `${SOURCE_NAME}/legacy/${session.file}.md`,
          payload: session,
        };
      }
    },
    async render(handle) {
      const session = handle.payload as FakeSession;
      return {
        markdown: `# ${session.title}\n\nbody of ${session.file}\n`,
        frontmatter: frontmatterFor(session),
        sourceMtimeMs: session.mtimeMs,
        sourceSizeBytes: session.sizeBytes,
      };
    },
  };
}

function configFor(strategy: "mtime" | "index"): AceConfig {
  return {
    output: outDir,
    strategy,
    concurrency: 1,
    truncate: { toolOutput: 4000, toolInput: 4000 },
    sources: { [SOURCE_NAME]: { enabled: true, roots: [rawRoot] } },
    plugins: [],
  };
}

async function render(
  sessions: FakeSession[],
  opts: { strategy?: "mtime" | "index"; dryRun?: boolean } = {}
): Promise<RenderReport> {
  const registry = new Registry();
  registry.register(fakeSource(sessions));
  return runRender({
    config: configFor(opts.strategy ?? "index"),
    registry,
    logger,
    ...(opts.dryRun === undefined ? {} : { dryRun: opts.dryRun }),
  });
}

function expectedAbsPath(session: FakeSession, opts: { disambiguate?: boolean } = {}): string {
  const rel = buildRelPath(SOURCE_NAME, frontmatterFor(session), rawRelPathFor(handleId(session), [rawRoot]), {
    fallbackMtimeMs: session.mtimeMs,
    ...(opts.disambiguate === undefined ? {} : { disambiguate: opts.disambiguate }),
  });
  return path.join(outDir, rel);
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function session(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    file: "a.jsonl",
    sessionId: "58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11",
    startedAt: new Date(2026, 6, 29, 3, 57, 33).toISOString(),
    title: "Restore QA tester agent files from backup",
    mtimeMs: 1_700_000_000_000,
    sizeBytes: 4096,
    ...overrides,
  };
}

/** Total `.md` notes under `dir`, recursively. */
async function countMd(dir: string): Promise<number> {
  let n = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) n += await countMd(p);
    else if (entry.name.endsWith(".md")) n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Layout + identity
// ---------------------------------------------------------------------------

describe("runRender — frontmatter-derived layout", () => {
  it("writes to the new layout, not to handle.outputRelPath", async () => {
    const s = session();
    const report = await render([s]);

    expect(report.totalRendered).toBe(1);
    expect(report.totalErrors).toBe(0);

    const expected = expectedAbsPath(s);
    expect(report.sources[0]?.entries[0]?.outPath).toBe(expected);
    expect(await exists(expected)).toBe(true);
    expect(path.relative(outDir, expected)).toBe(
      path.join(
        SOURCE_NAME,
        "2026",
        "07",
        "2026-07-29T03-57-33-restore-qa-tester-agent-files-from-backup-58726b2b.md"
      )
    );
    expect(await exists(path.join(outDir, SOURCE_NAME, "legacy", "a.jsonl.md"))).toBe(false);
  });

  it("keys the index on raw identity, so a retitle is not a cache miss key change", async () => {
    const s = session();
    await render([s]);

    const first = await loadIndex(outDir);
    expect(Object.keys(first)).toEqual([`${SOURCE_NAME}/${handleId(s)}`]);
    expect(first[`${SOURCE_NAME}/${handleId(s)}`]?.outPath).toBe(expectedAbsPath(s));

    // Retitle + touch the source so the entry goes stale.
    const retitled: FakeSession = { ...s, title: "Completely different subject", mtimeMs: s.mtimeMs + 5000 };
    await render([retitled]);

    const second = await loadIndex(outDir);
    expect(Object.keys(second)).toEqual([`${SOURCE_NAME}/${handleId(s)}`]);
    expect(second[`${SOURCE_NAME}/${handleId(s)}`]?.outPath).toBe(expectedAbsPath(retitled));
  });

  it("skips an unchanged session on the second run", async () => {
    const s = session();
    await render([s]);
    const second = await render([s]);

    expect(second.totalRendered).toBe(0);
    expect(second.totalSkipped).toBe(1);
    expect(second.sources[0]?.entries[0]?.outPath).toBe(expectedAbsPath(s));
  });
});

// ---------------------------------------------------------------------------
// Relocation
// ---------------------------------------------------------------------------

describe("runRender — relocation", () => {
  it("writes the new path and deletes the old one when the title changes", async () => {
    const s = session();
    await render([s]);
    const oldPath = expectedAbsPath(s);
    expect(await exists(oldPath)).toBe(true);

    const retitled: FakeSession = { ...s, title: "Rewrite the retention policy", mtimeMs: s.mtimeMs + 1000 };
    const report = await render([retitled]);
    const newPath = expectedAbsPath(retitled);

    expect(newPath).not.toBe(oldPath);
    expect(report.totalRendered).toBe(1);
    expect(await exists(newPath)).toBe(true);
    expect(await exists(oldPath)).toBe(false);
    expect(logs.some((l) => l.includes("relocated:") && l.includes(oldPath) && l.includes(newPath))).toBe(true);

    const content = await fs.readFile(newPath, "utf8");
    expect(content).toContain("Rewrite the retention policy");
  });

  it("moves the note across month directories when the timestamp changes", async () => {
    const s = session();
    await render([s]);

    const moved: FakeSession = {
      ...s,
      startedAt: new Date(2026, 7, 2, 10, 0, 0).toISOString(),
      mtimeMs: s.mtimeMs + 1000,
    };
    await render([moved]);

    expect(await exists(expectedAbsPath(s))).toBe(false);
    expect(await exists(expectedAbsPath(moved))).toBe(true);
    expect(path.dirname(expectedAbsPath(moved))).toBe(path.join(outDir, SOURCE_NAME, "2026", "08"));
  });

  it("does not delete anything on a dry run, but reports the path it would write", async () => {
    const s = session();
    await render([s]);
    const oldPath = expectedAbsPath(s);

    const retitled: FakeSession = { ...s, title: "Dry run only", mtimeMs: s.mtimeMs + 1000 };
    const report = await render([retitled], { dryRun: true });
    const newPath = expectedAbsPath(retitled);

    expect(report.totalRendered).toBe(1);
    expect(report.sources[0]?.entries[0]?.outPath).toBe(newPath);
    expect(await exists(newPath)).toBe(false);
    expect(await exists(oldPath)).toBe(true);

    // Index untouched by a dry run.
    const state = await loadIndex(outDir);
    expect(state[`${SOURCE_NAME}/${handleId(s)}`]?.outPath).toBe(oldPath);
  });
});

// ---------------------------------------------------------------------------
// Collisions
// ---------------------------------------------------------------------------

describe("runRender — collision disambiguation", () => {
  it("gives two sessions that compute the same path distinct files", async () => {
    // Parent + subagent: identical sessionId, startedAt and title.
    const parent = session({ file: "a.jsonl" });
    const subagent = session({ file: "b.jsonl" });

    const report = await render([parent, subagent]);

    expect(report.totalRendered).toBe(2);
    expect(report.totalErrors).toBe(0);

    const barePath = expectedAbsPath(parent); // identical for both, undisambiguated
    const subagentPath = expectedAbsPath(subagent, { disambiguate: true });

    expect(subagentPath).toBe(
      `${barePath.slice(0, -".md".length)}-${disambiguator(rawRelPathFor(handleId(subagent), [rawRoot]))}.md`
    );

    const written = report.sources[0]?.entries.map((e) => e.outPath) ?? [];
    expect(new Set(written).size).toBe(2);
    expect(written).toContain(barePath);
    expect(written).toContain(subagentPath);

    expect(await exists(barePath)).toBe(true);
    expect(await exists(subagentPath)).toBe(true);
    expect(await fs.readFile(barePath, "utf8")).toContain("body of a.jsonl");
    expect(await fs.readFile(subagentPath, "utf8")).toContain("body of b.jsonl");
  });

  it("keeps each session on its own path across runs", async () => {
    const parent = session({ file: "a.jsonl" });
    const subagent = session({ file: "b.jsonl" });
    await render([parent, subagent]);

    const state = await loadIndex(outDir);
    const parentPath = state[`${SOURCE_NAME}/${handleId(parent)}`]?.outPath;
    const subagentPath = state[`${SOURCE_NAME}/${handleId(subagent)}`]?.outPath;
    expect(parentPath).not.toBe(subagentPath);

    // Touch only the subagent; it must keep its disambiguated path.
    const touched: FakeSession = { ...subagent, mtimeMs: subagent.mtimeMs + 1000 };
    const report = await render([parent, touched]);

    expect(report.totalRendered).toBe(1);
    expect(report.totalSkipped).toBe(1);

    const after = await loadIndex(outDir);
    expect(after[`${SOURCE_NAME}/${handleId(parent)}`]?.outPath).toBe(parentPath);
    expect(after[`${SOURCE_NAME}/${handleId(touched)}`]?.outPath).toBe(subagentPath);
    expect(await exists(parentPath as string)).toBe(true);
    expect(await exists(subagentPath as string)).toBe(true);
  });

  it("lets a skipped session keep its path against a colliding newcomer", async () => {
    const parent = session({ file: "a.jsonl" });
    await render([parent]);
    const parentPath = expectedAbsPath(parent);
    const parentBody = await fs.readFile(parentPath, "utf8");

    // Brand-new subagent that computes the same bare path; parent is unchanged
    // (so it is skipped and never claims its path this run).
    const subagent = session({ file: "b.jsonl" });
    const report = await render([parent, subagent]);

    expect(report.totalRendered).toBe(1);
    expect(report.totalSkipped).toBe(1);

    const subagentPath = expectedAbsPath(subagent, { disambiguate: true });
    expect(subagentPath).not.toBe(parentPath);
    expect(await exists(subagentPath)).toBe(true);
    expect(await fs.readFile(parentPath, "utf8")).toBe(parentBody);
    expect(await fs.readFile(subagentPath, "utf8")).toContain("body of b.jsonl");
    expect(await countMd(outDir)).toBe(2);
  });

  it("does not duplicate the tree when the index is lost", async () => {
    const parent = session({ file: "a.jsonl" });
    const subagent = session({ file: "b.jsonl" });
    await render([parent, subagent]);
    expect(await countMd(outDir)).toBe(2);

    const before = new Set(Object.values(await loadIndex(outDir)).map((e) => e.outPath));
    await fs.rm(path.join(outDir, ".ace.state.json"));

    const report = await render([parent, subagent]);

    expect(report.totalRendered).toBe(2);
    expect(await countMd(outDir)).toBe(2);
    expect(new Set(Object.values(await loadIndex(outDir)).map((e) => e.outPath))).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Self-heal + legacy state migration
// ---------------------------------------------------------------------------

describe("runRender — self-heal and migration", () => {
  it("re-renders when the recorded output was deleted by hand", async () => {
    const s = session();
    await render([s]);
    const outPath = expectedAbsPath(s);
    await fs.rm(outPath);

    const report = await render([s]);

    expect(report.totalRendered).toBe(1);
    expect(report.totalSkipped).toBe(0);
    expect(await exists(outPath)).toBe(true);
  });

  it("re-renders and prunes a pre-layout state entry", async () => {
    const s = session();
    // A state file as written by the previous ace: output-path derived key, no
    // outPath field, pointing at the old layout.
    const legacyKey = `${SOURCE_NAME}/${SOURCE_NAME}/legacy/${s.file}.md`;
    await fs.writeFile(
      path.join(outDir, ".ace.state.json"),
      JSON.stringify({
        [legacyKey]: {
          srcMtimeMs: s.mtimeMs,
          srcSizeBytes: s.sizeBytes,
          renderedAt: "2026-05-01T00:00:00.000Z",
        },
      }),
      "utf8"
    );

    const report = await render([s]);

    expect(report.totalRendered).toBe(1);
    const state = await loadIndex(outDir);
    expect(Object.keys(state)).toEqual([`${SOURCE_NAME}/${handleId(s)}`]);
    expect(state[`${SOURCE_NAME}/${handleId(s)}`]?.outPath).toBe(expectedAbsPath(s));
    expect(logs.some((l) => l.includes("pruned 1 pre-layout index entry"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mtime strategy
// ---------------------------------------------------------------------------

describe("runRender — mtime strategy", () => {
  it("writes the new layout and skips on the second run", async () => {
    const s = session();
    const first = await render([s], { strategy: "mtime" });
    expect(first.totalRendered).toBe(1);
    expect(await exists(expectedAbsPath(s))).toBe(true);

    const second = await render([s], { strategy: "mtime" });
    expect(second.totalRendered).toBe(0);
    expect(second.totalSkipped).toBe(1);
    expect(second.sources[0]?.entries[0]?.outPath).toBe(expectedAbsPath(s));
  });

  it("writes no index file", async () => {
    await render([session()], { strategy: "mtime" });
    expect(await exists(path.join(outDir, ".ace.state.json"))).toBe(false);
  });
});
