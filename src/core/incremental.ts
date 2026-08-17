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
  /**
   * Absolute path last written for this key.
   *
   * Required for entries this version writes. State files produced before the
   * layout redesign have no `outPath`; such "legacy" entries carry no usable
   * output identity and are always treated as needing a render (and are pruned
   * by {@link pruneLegacyEntries} once their session has been re-rendered).
   */
  outPath: string;
}

export type IndexState = Record<string, IndexEntry>;

const INDEX_FILENAME = ".ace.state.json";

// ---------------------------------------------------------------------------
// needsRender
// ---------------------------------------------------------------------------

/**
 * Decide whether a session needs to be re-rendered.
 *
 * - `mtime` strategy: stat `dstAbsPath`; render if missing or src is newer.
 *   The caller must therefore already know the output path — under the
 *   frontmatter-derived layout that is only true *after* rendering, so the core
 *   runs this check post-render and skips the write instead of the render.
 * - `index` strategy: look up `stateKey` in `state`. Renders when the entry is
 *   missing, is a legacy entry with no `outPath`, when srcMtimeMs/srcSizeBytes
 *   changed, or when the recorded `outPath` has disappeared from disk
 *   (self-heals a manually deleted note). `dstAbsPath` is ignored here: the
 *   entry itself is the authority on where the output lives.
 *
 * `stateKey` is only used for the index strategy and is raw-identity derived —
 * `${sourceName}/${handle.id}` — never output-path derived, so a title change
 * (which moves the output file) is not a cache miss.
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
  const entry: IndexEntry | undefined = state[stateKey];
  if (!entry || typeof entry !== "object") return true;

  // Legacy entry from a pre-layout-redesign state file — no output identity.
  if (typeof entry.outPath !== "string" || entry.outPath === "") return true;

  if (entry.srcMtimeMs !== srcMtimeMs || entry.srcSizeBytes !== srcSizeBytes) return true;

  // Output vanished (deleted by hand, lost in a sync conflict) → re-render.
  try {
    await fs.stat(entry.outPath);
  } catch {
    return true;
  }

  return false;
}

/**
 * Drop entries with no `outPath` (written by a pre-layout-redesign ace).
 *
 * Such entries can never produce a skip — {@link needsRender} always returns
 * true for them — so removing them is lossless and stops the state file
 * carrying dead keys forever. Returns the number of entries removed.
 */
export function pruneLegacyEntries(state: IndexState): number {
  let pruned = 0;
  for (const [key, entry] of Object.entries(state)) {
    if (!entry || typeof entry !== "object" || typeof entry.outPath !== "string" || entry.outPath === "") {
      delete state[key];
      pruned++;
    }
  }
  return pruned;
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
