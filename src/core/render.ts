// src/core/render.ts — runRender orchestrator

import path from "node:path";
import os from "node:os";
import type { Logger, SessionHandle } from "../types.js";
import type { AceConfig } from "../config/schema.js";
import type { Registry } from "../registry.js";
import { needsRender, loadIndex, saveIndex, type IndexState, type IndexEntry } from "./incremental.js";
import { atomicWrite, setSourceMtime } from "./atomic-write.js";
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
  /** Restrict to a single source by name. */
  sourceFilter?: string;
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

  // Resolve sources
  const allSources = registry.list();
  const sources = sourceFilter
    ? allSources.filter((s) => s.name === sourceFilter)
    : allSources.filter((s) => {
        const sc = config.sources[s.name];
        return sc?.enabled !== false;
      });

  if (sourceFilter && sources.length === 0) {
    throw new Error(`[runRender] Source not found: "${sourceFilter}"`);
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

    // Process each handle
    const tasks = handles.map((handle) =>
      gate(async () => {
        const relPath = handle.outputRelPath.endsWith(".md")
          ? handle.outputRelPath
          : handle.outputRelPath + ".md";

        const absOutPath = path.join(outputRoot, relPath);
        const stateKey = `${source.name}/${relPath}`;

        // Check incremental
        const render =
          force ||
          (await needsRender(
            handle.mtimeMs,
            handle.sizeBytes ?? 0,
            absOutPath,
            strategy,
            indexState,
            stateKey
          ));

        if (!render) {
          report.skipped++;
          report.entries.push({ outPath: absOutPath, status: "skipped" });
          return;
        }

        // Render
        let result: import("../types.js").RenderResult;
        try {
          const renderCtx = {
            outPath: absOutPath,
            now: new Date(),
            truncate: config.truncate,
            logger,
          };
          result = await source.render(handle, renderCtx);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          logger.error(`[runRender] render failed for "${handle.id}":`, err);
          report.errors.push({ id: handle.id, error: errMsg });
          report.entries.push({ outPath: absOutPath, status: "error", error: errMsg });
          return;
        }

        if (dryRun) {
          report.rendered++;
          report.entries.push({ outPath: absOutPath, status: "rendered" });
          logger.info(`[dry-run] would write: ${absOutPath}`);
          return;
        }

        // Write output
        const fm = serializeFrontmatter(result.frontmatter);
        const fullContent = fm + result.markdown;

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

        // Update index state
        if (strategy === "index") {
          const entry: IndexEntry = {
            srcMtimeMs: result.sourceMtimeMs,
            srcSizeBytes: result.sourceSizeBytes,
            renderedAt: new Date().toISOString(),
          };
          if (result.sourceSha256) {
            entry.srcSha256 = result.sourceSha256;
          }
          indexState[stateKey] = entry;
        }

        report.rendered++;
        report.entries.push({ outPath: absOutPath, status: "rendered" });
        logger.info(`[runRender] rendered: ${absOutPath}`);
      })
    );

    await Promise.all(tasks);
  }

  // Flush index once at end
  if (strategy === "index" && !dryRun) {
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
