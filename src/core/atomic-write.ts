// src/core/atomic-write.ts — atomic file writes with temp-file sweep

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Track which dirs we've already swept this process run. */
const sweptDirs = new Set<string>();

/**
 * Remove stale `.tmp-*` files older than 1 hour from `dir`.
 * Each dir is only swept once per process run.
 */
export async function sweepTmp(dir: string): Promise<void> {
  if (sweptDirs.has(dir)) return;
  sweptDirs.add(dir);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const now = Date.now();
  for (const entry of entries) {
    if (!entry.name.startsWith(".tmp-")) continue;
    if (!entry.isFile()) continue;
    const full = path.join(dir, entry.name);
    try {
      const stat = await fs.stat(full);
      if (now - stat.mtimeMs > ONE_HOUR_MS) {
        await fs.unlink(full);
      }
    } catch {
      // ignore — file may have already been cleaned up
    }
  }
}

export interface AtomicWriteOptions {
  /** If true, skip fsync (useful in tests). Default: false */
  noFsync?: boolean;
  /**
   * Stage the temp file here instead of next to `absPath`, so sync clients
   * watching the destination never see it. Falls back to the destination dir
   * when a rename across the two would cross filesystems (EXDEV).
   */
  tmpDir?: string;
}

/**
 * Write `contents` to `absPath` atomically.
 *
 * 1. Writes a temp file — in `opts.tmpDir` if given, else next to `absPath`.
 * 2. fsyncs the temp file (best-effort; errors are swallowed).
 * 3. Renames the temp file to `absPath` (retrying from the destination dir on EXDEV).
 *
 * The temp file is removed on any failure. Also calls `sweepTmp` on the temp
 * dir once per process run.
 */
export async function atomicWrite(
  absPath: string,
  contents: string,
  opts: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(absPath);
  await fs.mkdir(dir, { recursive: true });
  if (opts.tmpDir !== undefined) {
    await fs.mkdir(opts.tmpDir, { recursive: true, mode: 0o700 });
    try {
      await writeViaTmp(absPath, contents, opts.tmpDir, opts.noFsync);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    }
  }
  await writeViaTmp(absPath, contents, dir, opts.noFsync);
}

async function writeViaTmp(
  absPath: string,
  contents: string,
  tmpDir: string,
  noFsync = false
): Promise<void> {
  // Sweep stale tmps once per dir per run
  await sweepTmp(tmpDir);

  const rand = randomBytes(4).toString("hex");
  const tmpPath = path.join(tmpDir, `.tmp-${path.basename(absPath)}-${process.pid}-${rand}`);

  try {
    await fs.writeFile(tmpPath, contents, { encoding: "utf8" });

    if (!noFsync) {
      let fd: import("node:fs/promises").FileHandle | undefined;
      try {
        fd = await fs.open(tmpPath, "r+");
        await fd.datasync();
      } catch {
        // fsync is best-effort — cloud FSes and some network mounts ignore it
      } finally {
        await fd?.close().catch(() => undefined);
      }
    }

    await fs.rename(tmpPath, absPath);
  } catch (err) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * Set the mtime of `absPath` to `max(srcMtimeMs, Date.now() + 1)`.
 * This ensures the output mtime tracks the source, surviving sub-second
 * resolution FSes (atime is set to current time).
 */
export async function setSourceMtime(absPath: string, srcMtimeMs: number): Promise<void> {
  const outMtime = Math.max(srcMtimeMs, Date.now() + 1);
  const t = new Date(outMtime);
  try {
    await fs.utimes(absPath, new Date(), t);
  } catch {
    // best-effort — network FSes may not support utimes
  }
}
