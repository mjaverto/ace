// src/core/incremental.ts — incremental render decisions

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWrite } from "./atomic-write.js";
import { contentHash } from "../frontmatter.js";
import { stateHome } from "../shared/util.js";
import type { Logger } from "../types.js";

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
  /** sha256 of the written Markdown with `aceRenderedAt` blanked — see `contentHash`. */
  contentHash?: string;
}

export type IndexState = Record<string, IndexEntry>;

/** Pre-#14 location of the index, inside the output root. Read once, then removed. */
const LEGACY_INDEX_FILENAME = ".ace.state.json";

/**
 * ace's private state dir: `${XDG_STATE_HOME:-~/.local/state}/ace`.
 *
 * Kept out of the output root on purpose — output often lives in a cloud-sync
 * folder that can evict files to dataless placeholders (issue #14).
 */
export function stateDir(): string {
  return path.join(stateHome(), "ace");
}

/** Index file for one output root; keyed by its resolved path so `--out` overrides never share entries. */
export function indexPath(outputRoot: string): string {
  const id = createHash("sha256").update(path.resolve(outputRoot)).digest("hex").slice(0, 16);
  return path.join(stateDir(), `index-${id}.json`);
}

/** The index exists but cannot be trusted; rendering must not proceed on a guess. */
export class StateError extends Error {
  /** One-line problem statement without remediation — for callers that already recover (`--force`). */
  readonly problem: string;

  constructor(file: string, cause: unknown) {
    const problem = `cannot read index ${file}: ${cause instanceof Error ? cause.message : String(cause)}`;
    super(
      `${problem}\n` +
        `If it is a cloud-only (evicted) placeholder, download it (open/cat the file) and rerun. ` +
        `Otherwise fix or delete it, or rerun with --force; either re-checks every note against disk.`
    );
    this.name = "StateError";
    this.problem = problem;
  }
}

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

/**
 * Load the index for `outputRoot`. Missing file → `{}` (falling back once to the
 * legacy `<outputRoot>/.ace.state.json`). Anything else — unreadable, evicted
 * cloud placeholder, bad JSON — throws {@link StateError}: an empty index here
 * would re-render and rewrite every note.
 */
export async function loadIndex(outputRoot: string): Promise<IndexState> {
  for (const file of [indexPath(outputRoot), path.join(outputRoot, LEGACY_INDEX_FILENAME)]) {
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new StateError(file, err);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new StateError(file, err);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new StateError(file, "not a JSON object");
    }
    return parsed as IndexState;
  }
  return {};
}

/**
 * Write the index to the state dir, then drop any legacy in-output copy.
 * Legacy removal is best-effort: the new index is already durable.
 */
export async function saveIndex(
  outputRoot: string,
  state: IndexState,
  logger?: Pick<Logger, "warn">
): Promise<void> {
  await atomicWrite(indexPath(outputRoot), JSON.stringify(state, null, 2) + "\n");
  const legacy = path.join(outputRoot, LEGACY_INDEX_FILENAME);
  try {
    await fs.rm(legacy, { force: true });
  } catch (err) {
    logger?.warn(`[saveIndex] could not remove legacy index ${legacy}:`, err);
  }
}

// ---------------------------------------------------------------------------
// Unchanged-output check
// ---------------------------------------------------------------------------

/**
 * True when `dest` already holds content with hash `hash`, so writing would be
 * a byte-for-byte no-op apart from `aceRenderedAt`. Trusts the index entry when
 * it recorded this exact path + hash and the file still exists; otherwise reads
 * and hashes the file. Any read failure → false (write, to be safe).
 */
export async function outputUnchanged(
  dest: string,
  hash: string,
  entry: IndexEntry | undefined
): Promise<boolean> {
  try {
    if (entry?.contentHash === hash && entry.outPath === dest) {
      await fs.stat(dest);
      return true;
    }
    return contentHash(await fs.readFile(dest, "utf8")) === hash;
  } catch {
    return false;
  }
}
