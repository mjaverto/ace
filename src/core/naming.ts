// src/core/naming.ts — output path layout (shared by core; sources never compute it)
//
// Layout:
//   <tool>/<YYYY>/<MM>/<YYYY-MM-DD>T<HH-MM-SS>-<slug>-<uuid8>.md
//
// e.g. claude/2026/07/2026-07-29T03-57-33-restore-qa-tester-agent-files-58726b2b.md
//
// The timestamp is LOCAL time (not UTC) — deliberately, so notes bucket into the
// month/day the human experienced. The path is a pure function of
// (sourceName, frontmatter, rawRelPath): no clock reads, no ordering effects.

import path from "node:path";
import { createHash } from "node:crypto";
import type { Frontmatter } from "../types.js";
import { expandHome } from "../shared/util.js";

// ---------------------------------------------------------------------------
// Slug
// ---------------------------------------------------------------------------

/** Max slug length in characters. */
export const SLUG_MAX_LENGTH = 55;

/** Slug used whenever the title carries no information. */
export const UNTITLED_SLUG = "untitled";

/**
 * Slugified titles that are known to be placeholders rather than real titles.
 * Compared post-slugification, so `"Untitled Session"`, `"untitled-session"`
 * and `"UNTITLED  SESSION!"` all collapse to the same check.
 */
const PLACEHOLDER_SLUGS: Record<string, true> = {
  untitled: true,
  "untitled-session": true,
  other: true,
  attachment: true,
};

/** Control characters (incl. CR/LF/TAB) and DEL — never allowed in a filename. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

/**
 * Leading markdown / JSON / quoting noise. Titles are frequently the first line
 * of a message body, so they arrive as `## Fix the thing`, `- [ ] todo`,
 * `{"type":"text"...`, `> quoted`, `` `code` `` …
 */
const LEADING_NOISE = /^[#<>{}[\]()*`~_\-+=|&^$%@!?:;,./\\'"\s]+/;

/** A bare YAML block scalar indicator: `|`, `>`, `|-`, `>+`, `|2`, `>-2` … */
const BARE_YAML_BLOCK = /^[|>][-+]?\d*[-+]?$/;

/**
 * Turn a frontmatter `title` into a filename-safe slug.
 *
 * 1. Control characters and newlines become spaces (multi-line titles flatten
 *    into one slug rather than being truncated at the first line).
 * 2. A bare YAML block indicator (`|`, `>-`, …) is treated as "no title".
 * 3. Leading markdown/JSON noise is stripped.
 * 4. Lowercase; every run of non `[a-z0-9]` becomes a single `-`; ends trimmed.
 * 5. Capped at {@link SLUG_MAX_LENGTH} characters, trailing `-` re-trimmed.
 * 6. Empty results and known placeholders become {@link UNTITLED_SLUG}.
 */
export function slugifyTitle(title: unknown): string {
  if (typeof title !== "string") return UNTITLED_SLUG;

  let s = title.replace(CONTROL_CHARS, " ").trim();
  if (s === "") return UNTITLED_SLUG;
  if (BARE_YAML_BLOCK.test(s)) return UNTITLED_SLUG;

  s = s.replace(LEADING_NOISE, "");
  s = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (s.length > SLUG_MAX_LENGTH) {
    s = s.slice(0, SLUG_MAX_LENGTH).replace(/-+$/, "");
  }

  if (s === "" || PLACEHOLDER_SLUGS[s] === true) return UNTITLED_SLUG;
  return s;
}

// ---------------------------------------------------------------------------
// uuid8
// ---------------------------------------------------------------------------

/** Used when a session has no usable id at all. */
export const NO_SESSION_ID = "nosessid";

/**
 * First 8 hex characters of `sessionId` with dashes removed.
 *
 * Non-UUID ids (opencode's `ses_…`, omp's slugs) are lowercased and reduced to
 * `[a-z0-9]` first, so the result is always filename-safe. Ids shorter than 8
 * usable characters are used as-is rather than padded.
 */
export function uuid8(sessionId: unknown): string {
  if (typeof sessionId !== "string") return NO_SESSION_ID;
  const compact = sessionId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact === "") return NO_SESSION_ID;
  return compact.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Local timestamp
// ---------------------------------------------------------------------------

export interface LocalStamp {
  /** Local calendar year, `YYYY`. */
  year: string;
  /** Local calendar month, `MM`. */
  month: string;
  /** `YYYY-MM-DDTHH-MM-SS` in local time. */
  stamp: string;
}

/** Format a Date in the *local* timezone into path components. */
export function formatLocalStamp(d: Date): LocalStamp {
  const year = String(d.getFullYear()).padStart(4, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return { year, month, stamp: `${year}-${month}-${day}T${hh}-${mm}-${ss}` };
}

function parseTimestamp(value: unknown): Date | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return new Date(value);
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms);
}

/**
 * Resolve the timestamp the path is bucketed by.
 *
 * Precedence (first parseable wins):
 *   1. `frontmatter.startedAt`
 *   2. `frontmatter.endedAt`
 *   3. `frontmatter.sourceMtime`
 *   4. `fallbackMtimeMs` — the raw source file's mtime, supplied by the core
 *   5. epoch (`1970-01-01` local) — deterministic last resort
 *
 * `aceRenderedAt` is deliberately *not* consulted: it moves every run, which
 * would make the output path unstable and cause endless relocations.
 */
export function resolveTimestamp(frontmatter: Frontmatter, fallbackMtimeMs?: number): Date {
  return (
    parseTimestamp(frontmatter.startedAt) ??
    parseTimestamp(frontmatter.endedAt) ??
    parseTimestamp(frontmatter.sourceMtime) ??
    parseTimestamp(fallbackMtimeMs) ??
    new Date(0)
  );
}

// ---------------------------------------------------------------------------
// Disambiguator
// ---------------------------------------------------------------------------

/**
 * Short stable hash of the *raw* source path. Used only to break a filename
 * collision between two sessions that share timestamp + sessionId + title
 * (in practice: a parent transcript and one of its subagent transcripts).
 */
export function disambiguator(rawRelPath: string, hexLength = 4): string {
  return createHash("sha256")
    .update(rawRelPath.split("\\").join("/")) // POSIX-normalized → host-stable hash
    .digest("hex")
    .slice(0, hexLength);
}

/** Insert the {@link disambiguator} just before the `.md` extension. */
export function disambiguateRelPath(relPath: string, rawRelPath: string, hexLength = 4): string {
  const suffix = disambiguator(rawRelPath, hexLength);
  return relPath.endsWith(".md")
    ? `${relPath.slice(0, -".md".length)}-${suffix}.md`
    : `${relPath}-${suffix}`;
}

// ---------------------------------------------------------------------------
// buildRelPath
// ---------------------------------------------------------------------------

export interface BuildRelPathOptions {
  /**
   * Raw source mtime, used only if the frontmatter carries no usable timestamp.
   */
  fallbackMtimeMs?: number;
  /**
   * Append the collision disambiguator derived from `rawRelPath`.
   * The core sets this only when the undisambiguated path is already owned.
   */
  disambiguate?: boolean;
  /** Disambiguator width in hex chars. Default 4. */
  disambiguatorLength?: number;
}

/** Make an arbitrary string safe to use as a single path segment. */
function safeSegment(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "");
  return s === "" ? "unknown" : s;
}

/**
 * Build the output path, relative to the output root, for one rendered session.
 *
 * `<tool>/<YYYY>/<MM>/<YYYY-MM-DD>T<HH-MM-SS>-<slug>-<uuid8>.md`, local time.
 *
 * Always returns POSIX separators; callers join it onto the output root with
 * `path.join`, which normalizes for the host platform.
 *
 * @param sourceName  `AgentSource.name` — becomes the top-level directory.
 * @param frontmatter The rendered frontmatter (source of title/sessionId/date).
 * @param rawRelPath  The raw transcript path relative to its discovery root.
 *                    Only used for the collision disambiguator.
 */
export function buildRelPath(
  sourceName: string,
  frontmatter: Frontmatter,
  rawRelPath: string,
  opts: BuildRelPathOptions = {}
): string {
  const { year, month, stamp } = formatLocalStamp(
    resolveTimestamp(frontmatter, opts.fallbackMtimeMs)
  );
  const slug = slugifyTitle(frontmatter.title);
  const id8 = uuid8(frontmatter.sessionId);

  const relPath = `${safeSegment(sourceName)}/${year}/${month}/${stamp}-${slug}-${id8}.md`;

  return opts.disambiguate
    ? disambiguateRelPath(relPath, rawRelPath, opts.disambiguatorLength ?? 4)
    : relPath;
}

// ---------------------------------------------------------------------------
// rawRelPathFor
// ---------------------------------------------------------------------------

/**
 * Reduce a `SessionHandle.id` to a path relative to whichever discovery root
 * contains it. Falls back to the id itself when it sits under no root (e.g. a
 * synthetic id). Machine-independent, so the disambiguator hash is stable
 * across hosts with different `$HOME`s.
 */
export function rawRelPathFor(id: string, roots: readonly string[]): string {
  let best: string | undefined;

  for (const rawRoot of roots) {
    const root = expandHome(rawRoot).replace(/[/\\]+$/, "");
    if (root === "") continue;
    for (const sep of [path.sep, "/"]) {
      const prefix = root + sep;
      if (id.startsWith(prefix)) {
        const rel = id.slice(prefix.length);
        // Deepest matching root wins → shortest relative path.
        if (best === undefined || rel.length < best.length) best = rel;
      }
    }
  }

  return (best ?? id).split("\\").join("/");
}
