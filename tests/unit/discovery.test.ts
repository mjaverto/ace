// tests/unit/discovery.test.ts — enumeration/discovery coverage for the JSONL sources.
//
// These tests guard the traversal depth of each source's `match` pattern. The
// patterns used to be pinned to a fixed number of directory levels, which
// silently dropped whole classes of transcript: claude subagent files, omp
// nested subagent files, and pi team sessions. A fixed-depth regression here is
// invisible in rendered output (notes are simply absent), so it needs a test.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeSource } from "../../src/sources/claude.js";
import { ompSource } from "../../src/sources/omp.js";
import { piSource } from "../../src/sources/pi.js";
import type { AgentSource, SessionHandle } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VOID_LOGGER = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** A minimal but realistic first line, so fixture files are non-empty. */
const SESSION_LINE =
  JSON.stringify({ type: "session", version: 3, id: "019e5a5a-417a-791e-bf73-602d9d344290" }) +
  "\n";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ace-discovery-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Create a file (and parents) at `relPath` under the temp store. */
async function writeStoreFile(relPath: string, content = SESSION_LINE): Promise<string> {
  const abs = path.join(tmpDir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, "utf8");
  return abs;
}

/** Run a source's `enumerate` over `roots` and return the handles it yields. */
async function discover(
  source: AgentSource,
  roots: string[],
  exclude?: string[]
): Promise<SessionHandle[]> {
  const handles: SessionHandle[] = [];
  // `exactOptionalPropertyTypes` forbids passing `exclude: undefined` explicitly.
  const ctx = exclude === undefined
    ? { roots, logger: VOID_LOGGER }
    : { roots, exclude, logger: VOID_LOGGER };

  for await (const handle of source.enumerate(ctx)) {
    handles.push(handle);
  }
  return handles;
}

async function discoveredIds(
  source: AgentSource,
  roots: string[],
  exclude?: string[]
): Promise<string[]> {
  const handles = await discover(source, roots, exclude);
  return handles.map((h) => h.id).sort();
}

// ---------------------------------------------------------------------------
// claude — nested subagent transcripts
// ---------------------------------------------------------------------------

describe("claudeSource.enumerate — recursive discovery", () => {
  it("finds nested subagents/agent-*.jsonl as well as top-level sessions", async () => {
    const root = path.join(tmpDir, ".claude/projects");
    const topLevel = await writeStoreFile(
      ".claude/projects/-Users-mjaverto/a4a7259b-9e98-41d1-94be-3d3d0540eb7b.jsonl"
    );
    const subagent = await writeStoreFile(
      ".claude/projects/-Users-mjaverto/a4a7259b-9e98-41d1-94be-3d3d0540eb7b/subagents/agent-afa19338f465ebad8.jsonl"
    );

    expect(await discoveredIds(claudeSource, [root])).toEqual([topLevel, subagent].sort());
  });

  it("keeps the historical output path for top-level sessions and nests subagents under it", async () => {
    const root = path.join(tmpDir, ".claude/projects");
    await writeStoreFile(".claude/projects/-Users-mjaverto/session-1.jsonl");
    await writeStoreFile(
      ".claude/projects/-Users-mjaverto/session-1/subagents/agent-abc.jsonl"
    );

    const handles = await discover(claudeSource, [root]);
    const byId = new Map(handles.map((h) => [path.basename(h.id), h.outputRelPath] as const));

    // Unchanged from the pre-recursion layout, so existing notes are not orphaned.
    expect(byId.get("session-1.jsonl")).toBe("claude/-Users-mjaverto/session-1.md");
    // Nested transcripts keep project + session grouping instead of flattening.
    expect(byId.get("agent-abc.jsonl")).toBe(
      "claude/-Users-mjaverto/session-1/subagents/agent-abc.md"
    );
  });

  it("does not match transcripts outside the projects/ anchor", async () => {
    // ~/.claude/history.jsonl is a shell-history log, not a session transcript.
    await writeStoreFile(".claude/history.jsonl");
    const root = path.join(tmpDir, ".claude");

    expect(await discoveredIds(claudeSource, [root])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// omp — nested subagent transcripts (the largest share of the corpus)
// ---------------------------------------------------------------------------

describe("ompSource.enumerate — recursive discovery", () => {
  it("finds a nested <session-dir>/<AgentName>.jsonl subagent transcript", async () => {
    const root = path.join(tmpDir, ".omp/agent/sessions");
    const parent = await writeStoreFile(
      ".omp/agent/sessions/-tmp/2026-08-04T20-45-05-292Z_019fce85.jsonl"
    );
    const subagent = await writeStoreFile(
      ".omp/agent/sessions/-tmp/2026-08-04T20-45-05-292Z_019fce85/HermesId.jsonl"
    );

    expect(await discoveredIds(ompSource, [root])).toEqual([parent, subagent].sort());
  });

  it("finds transcripts nested two levels below the session directory", async () => {
    const root = path.join(tmpDir, ".omp/agent/sessions");
    const deep = await writeStoreFile(
      ".omp/agent/sessions/-tmp/2026-08-12T10-36-38-753Z_019ff58b/RiskReview/RiskReview.SemiCorr.jsonl"
    );

    expect(await discoveredIds(ompSource, [root])).toEqual([deep]);
  });

  it("groups a subagent under its parent session in the output path", async () => {
    const root = path.join(tmpDir, ".omp/agent/sessions");
    await writeStoreFile(".omp/agent/sessions/-tmp/sess-1.jsonl");
    await writeStoreFile(".omp/agent/sessions/-tmp/sess-1/HermesId.jsonl");

    const handles = await discover(ompSource, [root]);
    const byId = new Map(handles.map((h) => [path.basename(h.id), h.outputRelPath] as const));

    expect(byId.get("sess-1.jsonl")).toBe("omp/-tmp/sess-1.md");
    expect(byId.get("HermesId.jsonl")).toBe("omp/-tmp/sess-1/HermesId.md");
  });
});

// ---------------------------------------------------------------------------
// pi — teams and paperclips roots
// ---------------------------------------------------------------------------

describe("piSource — teams and paperclips roots", () => {
  it("declares agent/sessions, agent/teams and paperclips as default roots", () => {
    expect(piSource.defaultRoots("/home/mike")).toEqual([
      "/home/mike/.pi/agent/sessions",
      "/home/mike/.pi/agent/teams",
      "/home/mike/.pi/paperclips",
    ]);
  });

  it("finds teams/<id>/sessions/*.jsonl", async () => {
    const root = path.join(tmpDir, ".pi/agent/teams");
    const teamSession = await writeStoreFile(
      ".pi/agent/teams/019e5a5a-417a-791e-bf73-602d9d344290/sessions/2026-05-24T14-19-30-637Z_019e5a5a.jsonl"
    );

    expect(await discoveredIds(piSource, [root])).toEqual([teamSession]);
  });

  it("finds non-empty paperclips transcripts", async () => {
    // Empty scaffolding on some hosts, dozens of real multi-KB sessions on others.
    const root = path.join(tmpDir, ".pi/paperclips");
    const real = await writeStoreFile(
      ".pi/paperclips/2026-05-04T14-18-49-202Z-agent-skill-path.jsonl"
    );

    expect(await discoveredIds(piSource, [root])).toEqual([real]);
  });

  it("prefixes the new roots so they cannot collide with agent/sessions output", async () => {
    // Same basename in all three trees — the output paths must stay distinct.
    const basename = "2026-05-24T14-19-30-637Z_019e5a5a.jsonl";
    await writeStoreFile(`.pi/agent/sessions/-Users-mjaverto/${basename}`);
    await writeStoreFile(`.pi/agent/teams/team-1/sessions/${basename}`);
    await writeStoreFile(`.pi/paperclips/${basename}`);

    const handles = await discover(piSource, [
      path.join(tmpDir, ".pi/agent/sessions"),
      path.join(tmpDir, ".pi/agent/teams"),
      path.join(tmpDir, ".pi/paperclips"),
    ]);

    const outPaths = handles.map((h) => h.outputRelPath).sort();
    expect(outPaths).toEqual([
      "pi/-Users-mjaverto/2026-05-24T14-19-30-637Z_019e5a5a.md",
      "pi/paperclips/2026-05-24T14-19-30-637Z_019e5a5a.md",
      "pi/teams/team-1/sessions/2026-05-24T14-19-30-637Z_019e5a5a.md",
    ]);
    expect(new Set(outPaths).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Missing roots — ace runs on hosts where several roots simply do not exist
// ---------------------------------------------------------------------------

describe("enumerate — missing roots", () => {
  const sources: ReadonlyArray<AgentSource> = [claudeSource, ompSource, piSource];

  for (const source of sources) {
    it(`${source.name}: skips a non-existent root without throwing`, async () => {
      const missing = path.join(tmpDir, "does-not-exist/.claude/projects");

      await expect(discoveredIds(source, [missing])).resolves.toEqual([]);
    });
  }

  it("still enumerates the roots that do exist when another is missing", async () => {
    const teamSession = await writeStoreFile(
      ".pi/agent/teams/team-1/sessions/session-1.jsonl"
    );

    const ids = await discoveredIds(piSource, [
      path.join(tmpDir, ".pi/agent/sessions"), // never created
      path.join(tmpDir, ".pi/agent/teams"),
      path.join(tmpDir, ".pi/paperclips"), // never created
    ]);

    expect(ids).toEqual([teamSession]);
  });
});

// ---------------------------------------------------------------------------
// Empty files — present as test scaffolding in real stores
// ---------------------------------------------------------------------------

describe("enumerate — empty transcripts", () => {
  it("skips a 0-byte file instead of erroring or emitting an empty note", async () => {
    const root = path.join(tmpDir, ".pi/paperclips");
    await writeStoreFile(".pi/paperclips/2026-05-04T14-18-49-202Z-agent-skill-path.jsonl", "");

    await expect(discoveredIds(piSource, [root])).resolves.toEqual([]);
  });

  it("yields the non-empty siblings of a 0-byte file", async () => {
    const root = path.join(tmpDir, ".omp/agent/sessions");
    await writeStoreFile(".omp/agent/sessions/-tmp/sess-1/Empty.jsonl", "");
    const real = await writeStoreFile(".omp/agent/sessions/-tmp/sess-1/Real.jsonl");

    expect(await discoveredIds(ompSource, [root])).toEqual([real]);
  });
});

// ---------------------------------------------------------------------------
// exclude — must keep working for the newly-reachable nested paths
// ---------------------------------------------------------------------------

describe("enumerate — exclude patterns", () => {
  it("applies exclude to nested claude subagent transcripts", async () => {
    const root = path.join(tmpDir, ".claude/projects");
    const topLevel = await writeStoreFile(".claude/projects/proj/session-1.jsonl");
    await writeStoreFile(".claude/projects/proj/session-1/subagents/agent-abc.jsonl");

    const ids = await discoveredIds(claudeSource, [root], ["**/subagents/**"]);

    expect(ids).toEqual([topLevel]);
  });

  it("applies exclude to the pi teams root", async () => {
    const root = path.join(tmpDir, ".pi/agent/teams");
    await writeStoreFile(".pi/agent/teams/team-1/sessions/session-1.jsonl");

    const ids = await discoveredIds(piSource, [root], ["**/teams/**"]);

    expect(ids).toEqual([]);
  });
});
