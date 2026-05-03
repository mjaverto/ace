// src/core/walk.ts — async generator that yields all files under a root

import fs from "node:fs/promises";
import path from "node:path";

/**
 * Recursively yield absolute file paths under `root`.
 *
 * Skips:
 *  - Symlink loops (tracked by real-path set)
 *  - Files/dirs whose basename starts with `.tmp-` (atomic-write temp files)
 */
export async function* walk(root: string): AsyncGenerator<string> {
  const seen = new Set<string>();
  yield* walkDir(root, seen);
}

async function* walkDir(dir: string, seen: Set<string>): AsyncGenerator<string> {
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return;
  }

  if (seen.has(realDir)) return;
  seen.add(realDir);

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".tmp-")) continue;

    const full = path.join(dir, entry.name);

    if (entry.isSymbolicLink()) {
      let resolved: string;
      try {
        resolved = await fs.realpath(full);
      } catch {
        continue;
      }
      if (seen.has(resolved)) continue;

      let stat: import("node:fs").Stats;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }

      if (stat.isDirectory()) {
        yield* walkDir(full, seen);
      } else if (stat.isFile()) {
        yield full;
      }
    } else if (entry.isDirectory()) {
      yield* walkDir(full, seen);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}
