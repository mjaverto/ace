// src/core/render.ts — runRender orchestrator

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { Logger, RenderResult, SessionHandle } from "../types.js";
import type { AceConfig } from "../config/schema.js";
import type { Registry } from "../registry.js";
import {
  needsRender,
  loadIndex,
  saveIndex,
  pruneLegacyEntries,
  type IndexState,
  type IndexEntry,
} from "./incremental.js";
import { atomicWrite, setSourceMtime } from "./atomic-write.js";
import { buildRelPath, disambiguateRelPath, rawRelPathFor } from "./naming.js";
import { sanitizeFrontmatter, sanitizeMarkdown } from "./redact.js";
import { serializeFrontmatter } from "../frontmatter.js";
import { expandHome } from "../shared/util.js";

// ---------------------------------------------------------------------------
// Report types
// ---------------------------------------------------------------------------

export interface SourceReportEntry {
  outPath: string;
  status: "rendered" | "skipped" | "error";
  error?: string;
}

export interface SourceReport {
  sourceName: string;
  rendered: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
  entries: SourceReportEntry[];
}

export interface RenderReport {
  sources: SourceReport[];
  totalRendered: number;
  totalSkipped: number;
  totalErrors: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// runRender options
// ---------------------------------------------------------------------------

export interface RunRenderOptions {
  config: AceConfig;
  registry: Registry;
  logger: Logger;
  dryRun?: boolean;
  force?: boolean;
  strategyOverride?: "mtime" | "index";
  /** Restrict to one or more sources by name. */
  sourceFilter?: string | string[];
  /** Override concurrency from config. */
  concurrency?: number;
}

// ---------------------------------------------------------------------------
// Tiny inline p-limit-style concurrency gate
// ---------------------------------------------------------------------------

function createGate(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  function release(): void {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  }

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active < limit) {
      active++;
      try {
        return await fn();
      } finally {
        release();
      }
    }

    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn().then(resolve, reject).finally(release);
      });
    });
  };
}

// ---------------------------------------------------------------------------
// Output path registry — collision resolution + rename safety
// ---------------------------------------------------------------------------

interface ResolveRequest {
  outputRoot: string;
  /** Undisambiguated relative path from `buildRelPath`. */
  bareRelPath: string;
  /** Raw source path relative to its root — the disambiguator hash input. */
  rawRelPath: string;
  /** Identity claiming the path — the index `stateKey`. */
  owner: string;
  /** Absolute path this identity wrote last run, if any. */
  previous?: string;
}

/**
 * Run-scoped owner map for output paths.
 *
 * Every path this run writes *or deletes* must first be claimed here. Claiming
 * is a synchronous check-and-set, so no two tasks can end up holding the same
 * path no matter how their awaits interleave, and a relocation's stale-delete
 * can never remove a file another task has claimed (and therefore may be about
 * to write).
 *
 * Ownership carried over from previous runs comes from the index (`outPath` per
 * identity), never from the filesystem: an identity that is skipped this run
 * still owns its note, while a lost index must not make every session mistake
 * its own output for a stranger's and duplicate the entire tree.
 */
class OutputPathRegistry {
  private readonly owners = new Map<string, string>();

  /**
   * @param tracked `outPath` → owning `stateKey`, from the loaded index. Paths
   *   in here belong to their identity for the whole run, even a relocated one
   *   (its freed path becomes available again on the next run).
   */
  constructor(private readonly tracked: ReadonlyMap<string, string> = new Map()) {}

  /** Synchronous, atomic. True when `owner` holds `absPath` afterwards. */
  claim(absPath: string, owner: string): boolean {
    const current = this.owners.get(absPath);
    if (current === undefined) {
      this.owners.set(absPath, owner);
      return true;
    }
    return current === owner;
  }

  ownerOf(absPath: string): string | undefined {
    return this.owners.get(absPath);
  }

  /**
   * Pick and claim the output path for one rendered session.
   *
   * Preference order: the path this identity already owns (stability across
   * runs), then the bare path, then progressively wider disambiguators derived
   * from the raw source path.
   */
  resolve(req: ResolveRequest): string {
    const { outputRoot, bareRelPath, rawRelPath, owner, previous } = req;

    const candidates = [
      path.join(outputRoot, bareRelPath),
      path.join(outputRoot, disambiguateRelPath(bareRelPath, rawRelPath, 4)),
      path.join(outputRoot, disambiguateRelPath(bareRelPath, rawRelPath, 8)),
      path.join(outputRoot, disambiguateRelPath(bareRelPath, rawRelPath, 16)),
    ];

    const held = previous === undefined ? -1 : candidates.indexOf(previous);
    const order =
      held > 0 ? [candidates[held]!, ...candidates.filter((_, i) => i !== held)] : candidates;

    for (const candidate of order) {
      const claimedBy = this.owners.get(candidate);
      if (claimedBy !== undefined) {
        if (claimedBy === owner) return candidate;
        continue; // another identity holds it this run
      }
      const trackedBy = this.tracked.get(candidate);
      if (trackedBy !== undefined && trackedBy !== owner) {
        continue; // another identity's note from a previous run lives here
      }
      if (this.claim(candidate, owner)) return candidate;
    }

    throw new Error(
      `[runRender] no free output path for "${owner}" (base "${bareRelPath}") — ` +
        `all disambiguated candidates are claimed`
    );
  }
}

// ---------------------------------------------------------------------------
// runRender
// ---------------------------------------------------------------------------

export async function runRender(opts: RunRenderOptions): Promise<RenderReport> {
  const startTime = Date.now();
  const {
    config,
    registry,
    logger,
    dryRun = false,
    force = false,
    strategyOverride,
    sourceFilter,
  } = opts;

  const strategy = strategyOverride ?? config.strategy;
  const outputRoot = expandHome(config.output);

  // Resolve concurrency
  const concurrencyValue = opts.concurrency ?? config.concurrency;
  const concurrency =
    concurrencyValue === "auto" ? Math.max(1, os.cpus().length) : concurrencyValue;

  const gate = createGate(concurrency);

  // Load index state if needed
  let indexState: IndexState = {};
  if (strategy === "index") {
    indexState = await loadIndex(outputRoot);
  }

  // Output paths already owned by an identity, so a session that is skipped
  // this run still holds its note against a colliding newcomer.
  const trackedOutPaths = new Map<string, string>();
  for (const [key, entry] of Object.entries(indexState)) {
    if (entry && typeof entry.outPath === "string" && entry.outPath !== "") {
      trackedOutPaths.set(entry.outPath, key);
    }
  }

  // Owner map for output paths, shared across all sources in this run.
  const claims = new OutputPathRegistry(trackedOutPaths);

  // Normalize sourceFilter to a string[] (empty = no filter)
  const filterNames: string[] =
    sourceFilter === undefined
      ? []
      : Array.isArray(sourceFilter)
        ? sourceFilter
        : [sourceFilter];

  // Resolve sources
  const allSources = registry.list();
  const sources =
    filterNames.length > 0
      ? allSources.filter((s) => filterNames.includes(s.name))
      : allSources.filter((s) => {
          const sc = config.sources[s.name];
          return sc?.enabled !== false;
        });

  if (filterNames.length > 0 && sources.length === 0) {
    throw new Error(
      `[runRender] No matching sources for filter: ${filterNames.map((n) => `"${n}"`).join(", ")}`
    );
  }

  const reports: SourceReport[] = [];

  for (const source of sources) {
    const sourceConfig = config.sources[source.name] ?? {};
    const roots = sourceConfig.roots?.length ? sourceConfig.roots : source.defaultRoots(process.env["HOME"] ?? "~");
    const exclude = sourceConfig.exclude ?? [];

    const report: SourceReport = { sourceName: source.name, rendered: 0, skipped: 0, errors: [], entries: [] };
    reports.push(report);

    const ctx = {
      roots,
      exclude,
      logger,
    };

    // Collect all handles first so we can fan out with concurrency
    const handles: SessionHandle[] = [];
    try {
      for await (const handle of source.enumerate(ctx)) {
        handles.push(handle);
      }
    } catch (err) {
      logger.error(`[runRender] enumerate failed for source "${source.name}":`, err);
      report.errors.push({
        id: "__enumerate__",
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    // Deterministic dispatch order — keeps report ordering and first-run
    // collision outcomes stable between runs.
    handles.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // Output-path claims must not depend on render-completion order.
    //
    // Two sessions whose redacted frontmatter yields the same filename are
    // separated by whichever one claims the bare path first, and that claim
    // happens after `await source.render(...)`. Under concurrency the winner is
    // therefore decided by scheduling: colliding sessions swap paths between
    // runs, so `mtime` (which has no recorded path to fall back on) re-renders
    // them forever and every swap orphans the loser's previous note. Ordering
    // the claim by the dispatch order fixed above restores naming.ts's
    // invariant — the path is a pure function of (sourceName, frontmatter,
    // rawRelPath), with no ordering effects.
    //
    // Renders still overlap: only the synchronous claim is serialized, and the
    // baton is passed on as soon as a task knows its path, before it writes.
    const claimTurn: Array<Promise<void>> = [];
    const passClaimTurn: Array<() => void> = [];
    for (let i = 0; i < handles.length; i++) {
      claimTurn.push(new Promise<void>((release) => passClaimTurn.push(release)));
    }
    passClaimTurn[0]?.();

    // Process each handle
    const tasks = handles.map((handle, index) =>
      gate(async () => {
        // Identity is derived from the RAW session, never from the output path,
        // so a changed title relocates the note without invalidating the cache.
        const stateKey = `${source.name}/${handle.id}`;
        const rawRelPath = rawRelPathFor(handle.id, roots);

        const previousEntry: IndexEntry | undefined =
          strategy === "index" ? indexState[stateKey] : undefined;
        const previousOutPath =
          typeof previousEntry?.outPath === "string" && previousEntry.outPath !== ""
            ? previousEntry.outPath
            : undefined;

        // Legacy source-declared path. Only used for reporting/`ctx.outPath`
        // before the real path is known, and as the provisional render target.
        const legacyRelPath = handle.outputRelPath.endsWith(".md")
          ? handle.outputRelPath
          : handle.outputRelPath + ".md";
        const provisionalOutPath = previousOutPath ?? path.join(outputRoot, legacyRelPath);

        // -- Pre-render skip (index strategy only) -------------------------
        // Under `mtime` the output path is unknown until the frontmatter
        // exists, so that check moves below, after rendering.
        if (!force && strategy === "index") {
          const stillFresh = !(await needsRender(
            handle.mtimeMs,
            handle.sizeBytes ?? 0,
            previousOutPath ?? "",
            "index",
            indexState,
            stateKey
          ));
          if (stillFresh) {
            report.skipped++;
            report.entries.push({ outPath: provisionalOutPath, status: "skipped" });
            return;
          }
        }

        // -- Render ---------------------------------------------------------
        let result: RenderResult;
        try {
          result = await source.render(handle, {
            outPath: provisionalOutPath,
            now: new Date(),
            truncate: config.truncate,
            logger,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[runRender] render failed for "${handle.id}":`, err);
          report.errors.push({ id: handle.id, error: errMsg });
          report.entries.push({ outPath: provisionalOutPath, status: "error", error: errMsg });
          return;
        }

        // -- Content hygiene ------------------------------------------------
        // Runs before the path is computed: the slug comes from the title, so
        // the title must already be redacted.
        const cleanFrontmatter = sanitizeFrontmatter(result.frontmatter);
        const cleanMarkdown = sanitizeMarkdown(result.markdown);
        const hits = [...cleanFrontmatter.hits, ...cleanMarkdown.hits];
        if (hits.length > 0) {
          logger.debug(
            `[runRender] redacted ${stateKey}: ${hits.map((h) => `${h.rule}×${h.count}`).join(", ")}`
          );
        }
        const frontmatter = cleanFrontmatter.frontmatter;

        // -- Final output path (frontmatter-derived) ------------------------
        await claimTurn[index];
        let absOutPath: string;
        try {
          absOutPath = claims.resolve({
            outputRoot,
            bareRelPath: buildRelPath(source.name, frontmatter, rawRelPath, {
              fallbackMtimeMs: result.sourceMtimeMs,
            }),
            rawRelPath,
            owner: stateKey,
            ...(previousOutPath === undefined ? {} : { previous: previousOutPath }),
          });
          // Path in hand — let the next session claim while this one writes.
          passClaimTurn[index + 1]?.();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[runRender] path resolution failed for "${handle.id}":`, err);
          report.errors.push({ id: handle.id, error: errMsg });
          report.entries.push({ outPath: provisionalOutPath, status: "error", error: errMsg });
          return;
        }

        // -- Post-render skip (mtime strategy) ------------------------------
        if (!force && strategy === "mtime") {
          const stillFresh = !(await needsRender(
            result.sourceMtimeMs,
            result.sourceSizeBytes,
            absOutPath,
            "mtime"
          ));
          if (stillFresh) {
            report.skipped++;
            report.entries.push({ outPath: absOutPath, status: "skipped" });
            return;
          }
        }

        if (dryRun) {
          report.rendered++;
          report.entries.push({ outPath: absOutPath, status: "rendered" });
          logger.info(`[dry-run] would write: ${absOutPath}`);
          if (previousOutPath !== undefined && previousOutPath !== absOutPath) {
            logger.info(`[dry-run] would relocate: ${previousOutPath} -> ${absOutPath}`);
          }
          return;
        }

        // -- Write ----------------------------------------------------------
        const fullContent = serializeFrontmatter(frontmatter) + cleanMarkdown.text;

        try {
          await atomicWrite(absOutPath, fullContent);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[runRender] atomicWrite failed for "${absOutPath}":`, err);
          report.errors.push({ id: handle.id, error: errMsg });
          report.entries.push({ outPath: absOutPath, status: "error", error: errMsg });
          return;
        }

        // Set output mtime to match source
        if (strategy === "mtime") {
          await setSourceMtime(absOutPath, result.sourceMtimeMs);
        }

        // -- Relocation cleanup ---------------------------------------------
        // New file is on disk; drop the note this session used to own. Deleting
        // requires winning the same claim the writers use, so a path another
        // task has taken over this run is never removed.
        if (previousOutPath !== undefined && previousOutPath !== absOutPath) {
          if (claims.claim(previousOutPath, stateKey)) {
            try {
              await fs.unlink(previousOutPath);
              logger.info(`[runRender] relocated: ${previousOutPath} -> ${absOutPath}`);
            } catch (err) {
              logger.debug(`[runRender] stale output already gone: ${previousOutPath}`, err);
            }
          } else {
            logger.info(
              `[runRender] relocated: ${previousOutPath} -> ${absOutPath} ` +
                `(old path kept — now owned by "${claims.ownerOf(previousOutPath)}")`
            );
          }
        }

        // Update index state
        if (strategy === "index") {
          const entry: IndexEntry = {
            srcMtimeMs: result.sourceMtimeMs,
            srcSizeBytes: result.sourceSizeBytes,
            renderedAt: new Date().toISOString(),
            outPath: absOutPath,
          };
          if (result.sourceSha256) {
            entry.srcSha256 = result.sourceSha256;
          }
          indexState[stateKey] = entry;
        }

        report.rendered++;
        report.entries.push({ outPath: absOutPath, status: "rendered" });
        logger.info(`[runRender] rendered: ${absOutPath}`);
        // Safety net: a task that returns or throws before claiming its path
        // must still hand the baton on, or every later session would stall.
      }).finally(() => passClaimTurn[index + 1]?.())
    );

    await Promise.all(tasks);
  }

  // Flush index once at end
  if (strategy === "index" && !dryRun) {
    // Entries from a pre-layout-redesign state file can never produce a skip;
    // drop them so the state file does not carry dead keys forever.
    const pruned = pruneLegacyEntries(indexState);
    if (pruned > 0) {
      logger.info(`[runRender] pruned ${pruned} pre-layout index entr${pruned === 1 ? "y" : "ies"}`);
    }
    await saveIndex(outputRoot, indexState);
  }

  const totalRendered = reports.reduce((n, r) => n + r.rendered, 0);
  const totalSkipped = reports.reduce((n, r) => n + r.skipped, 0);
  const totalErrors = reports.reduce((n, r) => n + r.errors.length, 0);

  return {
    sources: reports,
    totalRendered,
    totalSkipped,
    totalErrors,
    durationMs: Date.now() - startTime,
  };
}
