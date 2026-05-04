// src/frontmatter.ts — canonical frontmatter serializer

import { stringify } from "yaml";
import type { Frontmatter } from "./types.js";

// Canonical key order (first group)
const CANONICAL_KEYS: (keyof Frontmatter)[] = [
  "source",
  "sessionId",
  "title",
  "startedAt",
  "endedAt",
  "cwd",
  "model",
  "gitBranch",
  "version",
  "messageCount",
  "toolCallCount",
  "aceSchema",
  "aceRenderedAt",
  "sourcePath",
  "sourceMtime",
];

/**
 * Recursively strip null/undefined from plain objects and arrays.
 * Does NOT recurse into class instances (only plain objects where
 * Object.getPrototypeOf(v) === Object.prototype).
 */
function scrubNulls(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v;
  if (Array.isArray(v)) {
    return v
      .map(scrubNulls)
      .filter((item) => item !== undefined);
  }
  if (Object.getPrototypeOf(v) === Object.prototype) {
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const scrubbed = scrubNulls(val);
      if (scrubbed !== undefined) {
        result[k] = scrubbed;
      }
    }
    return result;
  }
  return v;
}

/**
 * Serialize a Frontmatter object to a YAML front-matter block.
 *
 * Rules:
 *  - Keys are emitted in canonical order, then `x_*` extras, then any others.
 *  - Keys whose value is `undefined` or `null` are omitted (recursively for
 *    nested plain objects and arrays).
 *  - `aceSchema` is always forced to `1`.
 *  - Date values are emitted as ISO-8601 strings.
 */
export function serializeFrontmatter(fm: Frontmatter): string {
  const out: Record<string, unknown> = {};

  function set(k: string, v: unknown): void {
    if (v === undefined || v === null) return;
    const cleaned = scrubNulls(v instanceof Date ? v.toISOString() : v);
    if (cleaned !== undefined) out[k] = cleaned;
  }

  // 1. Canonical keys in order
  for (const k of CANONICAL_KEYS) {
    if (k === "aceSchema") {
      // always force to 1
      out["aceSchema"] = 1;
      continue;
    }
    set(k as string, fm[k]);
  }

  // 2. x_* namespaced extras
  for (const k of Object.keys(fm)) {
    if (CANONICAL_KEYS.includes(k as keyof Frontmatter)) continue;
    if (k.startsWith("x_")) {
      set(k, fm[k]);
    }
  }

  // 3. Remaining keys
  for (const k of Object.keys(fm)) {
    if (CANONICAL_KEYS.includes(k as keyof Frontmatter)) continue;
    if (k.startsWith("x_")) continue;
    set(k, fm[k]);
  }

  const yaml = stringify(out, {
    // Emit dates as ISO strings (already converted above), keep keys stable
    lineWidth: 0,
  });

  return `---\n${yaml}---\n`;
}
