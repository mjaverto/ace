// src/shared/jsonl-enumerate.ts — helper for file-based (JSONL) plugins

import fs from "node:fs/promises";
import { walk } from "../core/walk.js";
import type { EnumerateContext, SessionHandle } from "../types.js";
import { expandHome } from "./util.js";

/**
 * Tiny glob-to-regex translator that handles the patterns used in ace configs.
 *
 * Supports:
 *   **   — any path segments (including none)
 *   *    — any characters except /
 *   ?    — any single character except /
 *   .    — literal dot
 *
 * Good enough for patterns like `**\/.tmp.*` used in v0.
 */
function globToRegex(pattern: string): RegExp {
  let src = "";
  let i = 0;
  while (i < pattern.length) {
    // noUncheckedIndexedAccess: assert non-undefined since we guard with i < pattern.length
    const c = pattern[i] as string;
    if (c === "*" && pattern[i + 1] === "*") {
      // ** — match any path segment including separator
      src += ".*";
      i += 2;
      // consume optional trailing slash
      if (pattern[i] === "/") i++;
    } else if (c === "*") {
      src += "[^/]*";
      i++;
    } else if (c === "?") {
      src += "[^/]";
      i++;
    } else if (c === ".") {
      src += "\\.";
      i++;
    } else {
      // escape regex special chars
      src += c.replace(/[+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(src);
}

/**
 * Returns an `enumerate` function bound to the given options.
 *
 * The returned function:
 *  1. Walks each root directory.
 *  2. Filters files with `match`.
 *  3. Yields a `SessionHandle` for each matched file.
 */
export function jsonlEnumerate(opts: {
  roots: string[];
  match: (absPath: string) => boolean;
  outputPathFor: (absPath: string, root: string) => string;
}): (ctx: EnumerateContext) => AsyncIterable<SessionHandle> {
  return function enumerate(ctx: EnumerateContext): AsyncIterable<SessionHandle> {
    const roots = ctx.roots.length > 0 ? ctx.roots : opts.roots;

    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionHandle> {
        return makeIterator(roots, opts.match, opts.outputPathFor, ctx);
      },
    };
  };
}

async function* generateHandles(
  roots: string[],
  match: (absPath: string) => boolean,
  outputPathFor: (absPath: string, root: string) => string,
  ctx: EnumerateContext
): AsyncGenerator<SessionHandle> {
  // Build exclude matchers once
  const excludeMatchers = (ctx.exclude ?? []).map(globToRegex);

  for (const rawRoot of roots) {
    const root = expandHome(rawRoot);

    // Skip roots that don't exist
    try {
      await fs.access(root);
    } catch {
      ctx.logger.debug(`[jsonlEnumerate] root not found, skipping: ${root}`);
      continue;
    }

    for await (const absPath of walk(root)) {
      if (!match(absPath)) continue;

      // Check exclude patterns
      const excluded = excludeMatchers.some((re) => re.test(absPath));
      if (excluded) continue;

      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(absPath);
      } catch {
        continue;
      }

      const outputRelPath = outputPathFor(absPath, root);

      yield {
        id: absPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        outputRelPath,
        payload: { filePath: absPath },
      };
    }
  }
}

function makeIterator(
  roots: string[],
  match: (absPath: string) => boolean,
  outputPathFor: (absPath: string, root: string) => string,
  ctx: EnumerateContext
): AsyncIterator<SessionHandle> {
  const gen = generateHandles(roots, match, outputPathFor, ctx);
  return {
    next(): Promise<IteratorResult<SessionHandle>> {
      return gen.next();
    },
    return(value?: unknown): Promise<IteratorResult<SessionHandle>> {
      return gen.return(value as SessionHandle);
    },
  };
}
