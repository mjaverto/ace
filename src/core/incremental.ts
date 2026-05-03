// src/core/incremental.ts — incremental render decisions

import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./atomic-write.js";

// ---------------------------------------------------------------------------
// Index state types
// ---------------------------------------------------------------------------

export interface IndexEntry {
  srcMtimeMs: number;
  srcSizeBytes: number;
  srcSha256?: string;
  renderedAt: string; // ISO-8601
}

export type IndexState = Record<string, IndexEntry>;

const INDEX_FILENAME = ".ace.state.json";

// ---------------------------------------------------------------------------
// needsRender
// ---------------------------------------------------------------------------

/**
 * Decide whether a session needs to be re-rendered.
 *
 * - `mtime` strategy: stat the output file; render if missing or src is newer.
 * - `index` strategy: look up the entry in the provided state map; render if
 *   missing or if srcMtimeMs or srcSizeBytes changed.
 *
 * `stateKey` is only used for the index strategy and should be
 * `${sourceName}/${outputRelPath}`.
 */
export async function needsRender(
  srcMtimeMs: number,
  srcSizeBytes: number,
  dstAbsPath: string,
  strategy: "mtime" | "index",
  state?: IndexState,
  stateKey?: string
): Promise<boolean> {
  if (strategy === "mtime") {
    try {
      const dst = await fs.stat(dstAbsPath);
      return srcMtimeMs > dst.mtimeMs;
    } catch {
      return true; // no output file yet
    }
  }

  // index strategy
  if (!state || !stateKey) return true;
  const entry = state[stateKey];
  if (!entry) return true;
  return entry.srcMtimeMs !== srcMtimeMs || entry.srcSizeBytes !== srcSizeBytes;
}

// ---------------------------------------------------------------------------
// loadIndex / saveIndex
// ---------------------------------------------------------------------------

export async function loadIndex(outputRoot: string): Promise<IndexState> {
  const indexPath = path.join(outputRoot, INDEX_FILENAME);
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IndexState;
    }
    return {};
  } catch {
    return {};
  }
}

export async function saveIndex(outputRoot: string, state: IndexState): Promise<void> {
  const indexPath = path.join(outputRoot, INDEX_FILENAME);
  await atomicWrite(indexPath, JSON.stringify(state, null, 2) + "\n");
}
