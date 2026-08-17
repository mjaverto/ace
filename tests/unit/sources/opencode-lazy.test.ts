// tests/unit/sources/opencode-lazy.test.ts — better-sqlite3 must load lazily
//
// better-sqlite3 is the only native addon ace depends on, and the opencode
// source is the only thing that needs it. Loading it dlopen()s a binding built
// for one specific Node ABI, so on a host that upgraded Node without rebuilding
// (openclaw: Node 25 / NODE_MODULE_VERSION 141 against a binding compiled for
// 137) the *import* throws ERR_DLOPEN_FAILED.
//
// src/sources/index.ts imports every source to build the default registry, so a
// static import in opencode.ts made the entire CLI unstartable there — even
// though that host has no opencode database at all. These tests pin the two
// halves of the fix: the module is not loaded until a database is actually
// found, and when it cannot be loaded the failure lands on the opencode source
// instead of aborting the run.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EnumerateContext, Logger, SessionHandle } from "../../../src/types.js";

/** Verbatim shape of the openclaw failure. */
const ABI_ERROR_MESSAGE =
  "The module '/home/mja311/.bun/install/global/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
  "was compiled against a different Node.js version using\n" +
  "NODE_MODULE_VERSION 137. This version of Node.js requires\n" +
  "NODE_MODULE_VERSION 141.";

const CLAUDE_FIXTURE = path.resolve(import.meta.dirname, "../../../fixtures/claude/01-basic.jsonl");

/**
 * The ways a native dependency can be unusable:
 *   - `abi-broken`     module resolves, obtaining the binding throws the real
 *                      NODE_MODULE_VERSION error. Used wherever the assertion
 *                      is about the message text, because vitest replaces a
 *                      factory-thrown error with its own wrapper text.
 *   - `eval-throws`    module evaluation itself throws (what ERR_DLOPEN_FAILED
 *                      does in production).
 *   - `no-constructor` module resolves but exports nothing callable.
 *   - `stub-ctor`      module works.
 */
type MockKind = "abi-broken" | "eval-throws" | "no-constructor" | "stub-ctor";

/** Number of times the (mocked) better-sqlite3 module was loaded. */
let sqliteLoads = 0;
let tmpDir: string;

interface RecordingLogger extends Logger {
  readonly lines: string[];
}

function recordingLogger(): RecordingLogger {
  const lines: string[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      lines.push(`${level} ${args.map((a) => String(a)).join(" ")}`);
    };
  return { lines, debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
}

/**
 * A minimal better-sqlite3 stand-in: enough surface for enumerate to open a
 * database, find no sessions, and close it again.
 */
class StubDatabase {
  prepare(): { all: () => never[]; get: () => undefined } {
    return { all: (): never[] => [], get: (): undefined => undefined };
  }
  close(): void {
    /* no-op */
  }
}

/**
 * Re-import src/sources/opencode.ts against a mocked better-sqlite3.
 *
 * The module memoizes its loader, so the graph is reset per test to get a fresh
 * load attempt. `vi.doMock` (not `vi.mock`) is used because the mock must differ
 * per test rather than be hoisted file-wide.
 */
async function freshOpencodeModule(
  kind: MockKind
): Promise<typeof import("../../../src/sources/opencode.js")> {
  vi.resetModules();
  vi.doMock("better-sqlite3", () => {
    sqliteLoads++;
    if (kind === "eval-throws") throw new Error(ABI_ERROR_MESSAGE);
    if (kind === "no-constructor") return { default: null };
    if (kind === "stub-ctor") return { default: StubDatabase };
    return {
      get default(): never {
        throw new Error(ABI_ERROR_MESSAGE);
      },
    };
  });
  return import("../../../src/sources/opencode.js");
}

function enumerateCtx(root: string, logger: Logger): EnumerateContext {
  return { roots: [root], logger };
}

async function drain(iterable: AsyncIterable<SessionHandle>): Promise<SessionHandle[]> {
  const out: SessionHandle[] = [];
  for await (const handle of iterable) out.push(handle);
  return out;
}

beforeEach(async () => {
  sqliteLoads = 0;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ace-lazy-sqlite-"));
});

afterEach(async () => {
  vi.doUnmock("better-sqlite3");
  vi.resetModules();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("opencode lazy better-sqlite3 loading", () => {
  it("does not load better-sqlite3 just to import the module and build a registry", async () => {
    vi.resetModules();
    vi.doMock("better-sqlite3", () => {
      sqliteLoads++;
      return { default: StubDatabase };
    });

    const { opencodeSource } = await import("../../../src/sources/opencode.js");
    const { createDefaultRegistry } = await import("../../../src/sources/index.js");
    const registry = createDefaultRegistry();

    expect(registry.get("opencode")).toBe(opencodeSource);
    expect(registry.list().map((s) => s.name)).toEqual([
      "claude",
      "codex",
      "pi",
      "omp",
      "opencode",
    ]);
    // The whole point: importing the source and registering it touches nothing
    // native. This is what keeps `ace render` startable on a host whose
    // better-sqlite3 binding is built for the wrong Node ABI.
    expect(sqliteLoads).toBe(0);
  });

  it("does not load better-sqlite3 when no opencode database exists", async () => {
    const { opencodeSource, opencodeDbNotFoundMessage } =
      await freshOpencodeModule("abi-broken");
    const logger = recordingLogger();

    const handles = await drain(opencodeSource.enumerate(enumerateCtx(tmpDir, logger)));

    expect(handles).toEqual([]);
    expect(sqliteLoads).toBe(0);
    // A missing database is reported as the benign condition it is: debug level,
    // no error, and explicit that the native module was never touched.
    expect(logger.lines).toContain(`debug ${opencodeDbNotFoundMessage(tmpDir)}`);
    expect(logger.lines.filter((l) => l.startsWith("error"))).toEqual([]);
    expect(logger.lines.filter((l) => l.startsWith("warn"))).toEqual([]);
  });

  it("loads better-sqlite3 exactly once, and only once a database is present", async () => {
    const dbPath = path.join(tmpDir, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");

    const { opencodeSource } = await freshOpencodeModule("stub-ctor");
    const logger = recordingLogger();

    await drain(opencodeSource.enumerate(enumerateCtx(tmpDir, logger)));
    expect(sqliteLoads).toBe(1);

    // Second enumerate reuses the memoized constructor.
    await drain(opencodeSource.enumerate(enumerateCtx(tmpDir, logger)));
    expect(sqliteLoads).toBe(1);
  });

  it("retries the failing import at most once per process", async () => {
    const dbPath = path.join(tmpDir, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");

    const { opencodeSource } = await freshOpencodeModule("abi-broken");
    const logger = recordingLogger();
    const ctx = enumerateCtx(tmpDir, logger);

    await expect(drain(opencodeSource.enumerate(ctx))).rejects.toThrow(/is unavailable/);
    await expect(drain(opencodeSource.enumerate(ctx))).rejects.toThrow(/is unavailable/);

    // A native ABI mismatch cannot heal mid-process; a real run has thousands of
    // sessions and must not attempt thousands of failing imports.
    expect(sqliteLoads).toBe(1);
  });

  it("surfaces an unloadable better-sqlite3 as a typed error, not an opaque crash", async () => {
    const dbPath = path.join(tmpDir, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");

    const { opencodeSource, OpencodeSqliteUnavailableError } =
      await freshOpencodeModule("abi-broken");
    const logger = recordingLogger();

    const failure = await drain(opencodeSource.enumerate(enumerateCtx(tmpDir, logger))).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(OpencodeSqliteUnavailableError);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    // The operator needs the diagnosis and the remedy, plus the raw ABI numbers.
    expect(message).toContain('native module "better-sqlite3" is unavailable');
    expect(message).toContain("NODE_MODULE_VERSION 137");
    expect(message).toContain("npm rebuild better-sqlite3");
    expect(message).toContain("sources.opencode.enabled: false");
    // Multi-line native errors are flattened so the message survives a
    // single-line report entry.
    expect(message).not.toContain("\n");
    expect((failure as Error).cause).toBeInstanceOf(Error);
  });

  it("rejects render() with the same load error when better-sqlite3 is unusable", async () => {
    const { opencodeSource, OpencodeSqliteUnavailableError } =
      await freshOpencodeModule("abi-broken");

    // runRender turns this rejection into a per-session error entry.
    await expect(
      opencodeSource.render(
        {
          id: `${tmpDir}/opencode.db#ses_1`,
          mtimeMs: 0,
          outputRelPath: "opencode/x/ses_1.md",
          payload: {
            dbPath: path.join(tmpDir, "opencode.db"),
            sessionId: "ses_1",
            projectId: "proj",
            slug: "slug",
            directory: "/tmp",
            title: "t",
            version: "1",
          },
        },
        {
          outPath: path.join(tmpDir, "out.md"),
          now: new Date("2026-05-03T00:00:00.000Z"),
          truncate: { toolOutput: 4000, toolInput: 4000 },
          logger: recordingLogger(),
        }
      )
    ).rejects.toThrow(OpencodeSqliteUnavailableError);
  });

  it("treats a module that resolves without a constructor as unavailable too", async () => {
    const dbPath = path.join(tmpDir, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");

    const { opencodeSource, OpencodeSqliteUnavailableError } =
      await freshOpencodeModule("no-constructor");

    await expect(
      drain(opencodeSource.enumerate(enumerateCtx(tmpDir, recordingLogger())))
    ).rejects.toThrow(OpencodeSqliteUnavailableError);
  });

  it("treats a module that throws while evaluating as unavailable too", async () => {
    // This is the production shape: better-sqlite3 is CJS and its require() of
    // the .node binding throws ERR_DLOPEN_FAILED during evaluation.
    const dbPath = path.join(tmpDir, "opencode.db");
    await fs.writeFile(dbPath, "", "utf8");

    const { opencodeSource, OpencodeSqliteUnavailableError } =
      await freshOpencodeModule("eval-throws");

    await expect(
      drain(opencodeSource.enumerate(enumerateCtx(tmpDir, recordingLogger())))
    ).rejects.toThrow(OpencodeSqliteUnavailableError);
  });

  it("words 'module unavailable' and 'database not found' so they cannot be confused", async () => {
    const { sqliteUnavailableMessage, opencodeDbNotFoundMessage } =
      await freshOpencodeModule("stub-ctor");

    const unavailable = sqliteUnavailableMessage(new Error(ABI_ERROR_MESSAGE));
    const notFound = opencodeDbNotFoundMessage("/home/mja311/.local/share/opencode");

    expect(unavailable).not.toBe(notFound);
    // "module/ABI failure" vs "normal": the reader can tell broken code from
    // absent data without reading the stack.
    expect(unavailable).toContain("module/ABI failure, not a missing database");
    expect(unavailable).not.toContain("This is normal");
    expect(notFound).toContain("database not found at /home/mja311/.local/share/opencode");
    expect(notFound).toContain("This is normal on a host that does not run opencode");
    expect(notFound).toContain('"better-sqlite3" was not loaded');
    expect(notFound).not.toContain("NODE_MODULE_VERSION");
    expect(notFound).not.toContain("unavailable");
  });
});

describe("runRender with an unloadable better-sqlite3", () => {
  it("records one opencode error and still renders every other source", async () => {
    // opencode database present but unreadable → the loud path.
    const openDir = path.join(tmpDir, "opencode");
    await fs.mkdir(openDir, { recursive: true });
    await fs.writeFile(path.join(openDir, "opencode.db"), "", "utf8");

    // claude needs .claude/projects/<slug>/<uuid>.jsonl to match.
    const claudeRoot = path.join(tmpDir, ".claude", "projects");
    await fs.mkdir(path.join(claudeRoot, "proj"), { recursive: true });
    await fs.copyFile(
      CLAUDE_FIXTURE,
      path.join(claudeRoot, "proj", "a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl")
    );

    vi.resetModules();
    vi.doMock("better-sqlite3", () => {
      sqliteLoads++;
      return {
        get default(): never {
          throw new Error(ABI_ERROR_MESSAGE);
        },
      };
    });

    const { runRender } = await import("../../../src/core/render.js");
    const { createDefaultRegistry } = await import("../../../src/sources/index.js");
    const { configSchema } = await import("../../../src/config/schema.js");

    const config = configSchema.parse({
      output: path.join(tmpDir, "out"),
      strategy: "mtime",
      concurrency: 2,
      sources: {
        claude: { roots: [claudeRoot] },
        codex: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
        opencode: { roots: [openDir] },
      },
    });

    const logger = recordingLogger();
    const report = await runRender({ config, registry: createDefaultRegistry(), logger, dryRun: true });

    const opencode = report.sources.find((s) => s.sourceName === "opencode");
    const claude = report.sources.find((s) => s.sourceName === "claude");

    // Loud, but only here.
    expect(opencode?.errors).toHaveLength(1);
    expect(opencode?.errors[0]?.id).toBe("__enumerate__");
    expect(opencode?.errors[0]?.error).toContain('native module "better-sqlite3" is unavailable');
    expect(opencode?.errors[0]?.error).toContain("NODE_MODULE_VERSION 137");
    expect(opencode?.rendered).toBe(0);

    // Every other source is untouched by the native failure.
    expect(claude?.rendered).toBe(1);
    expect(claude?.errors).toEqual([]);
    expect(report.totalErrors).toBe(1);
    expect(report.totalRendered).toBe(1);
  });

  it("renders every source with zero errors when opencode has no database", async () => {
    const claudeRoot = path.join(tmpDir, ".claude", "projects");
    await fs.mkdir(path.join(claudeRoot, "proj"), { recursive: true });
    await fs.copyFile(
      CLAUDE_FIXTURE,
      path.join(claudeRoot, "proj", "a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl")
    );

    vi.resetModules();
    vi.doMock("better-sqlite3", () => {
      sqliteLoads++;
      throw new Error(ABI_ERROR_MESSAGE);
    });

    const { runRender } = await import("../../../src/core/render.js");
    const { createDefaultRegistry } = await import("../../../src/sources/index.js");
    const { configSchema } = await import("../../../src/config/schema.js");

    const config = configSchema.parse({
      output: path.join(tmpDir, "out"),
      strategy: "mtime",
      concurrency: 2,
      sources: {
        claude: { roots: [claudeRoot] },
        codex: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
        opencode: { roots: [path.join(tmpDir, "no-such-opencode-dir")] },
      },
    });

    const report = await runRender({
      config,
      registry: createDefaultRegistry(),
      logger: recordingLogger(),
      dryRun: true,
    });

    // This is openclaw: better-sqlite3 is broken, opencode is enabled, and the
    // run is completely clean because opencode is not actually in use.
    expect(report.totalErrors).toBe(0);
    expect(report.totalRendered).toBe(1);
    expect(sqliteLoads).toBe(0);
  });
});
