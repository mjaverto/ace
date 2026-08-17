// tests/unit/naming.test.ts — unit tests for the output path layout
//
// Layout under test:
//   <tool>/<YYYY>/<MM>/<YYYY-MM-DD>T<HH-MM-SS>-<slug>-<uuid8>.md   (LOCAL time)

import { describe, it, expect, afterAll } from "vitest";
import {
  buildRelPath,
  disambiguateRelPath,
  disambiguator,
  formatLocalStamp,
  rawRelPathFor,
  resolveTimestamp,
  slugifyTitle,
  uuid8,
  SLUG_MAX_LENGTH,
} from "../../src/core/naming.js";
import type { Frontmatter } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fm(extra: Partial<Frontmatter> = {}): Frontmatter {
  return { source: "claude", ...extra };
}

// ---------------------------------------------------------------------------
// slugifyTitle
// ---------------------------------------------------------------------------

describe("slugifyTitle", () => {
  it("slugifies a normal title", () => {
    expect(slugifyTitle("Restore QA tester agent files from backup")).toBe(
      "restore-qa-tester-agent-files-from-backup"
    );
  });

  it("flattens a multi-line title into a single slug", () => {
    expect(slugifyTitle("Fix the parser\n\nIt crashes on empty input")).toBe(
      "fix-the-parser-it-crashes-on-empty-input"
    );
  });

  it("strips control characters (CR/LF/TAB) rather than emitting them", () => {
    const slug = slugifyTitle("tabbed\ttitle\r\nsecond line");
    expect(slug).toBe("tabbed-title-second-line");
    expect(slug).not.toMatch(/[\u0000-\u001f]/);
  });

  it("strips leading markdown noise", () => {
    expect(slugifyTitle("## Fix `foo` in the loader")).toBe("fix-foo-in-the-loader");
    expect(slugifyTitle("- [ ] wire up the gate")).toBe("wire-up-the-gate");
    expect(slugifyTitle('{"type":"text","text":"hello"}')).toBe("type-text-text-hello");
  });

  it("returns untitled for punctuation-only titles", () => {
    expect(slugifyTitle("### ---")).toBe("untitled");
    expect(slugifyTitle("!!!")).toBe("untitled");
    expect(slugifyTitle("***")).toBe("untitled");
    expect(slugifyTitle("   ")).toBe("untitled");
    expect(slugifyTitle("")).toBe("untitled");
  });

  it("returns untitled for a bare YAML block indicator", () => {
    expect(slugifyTitle("|")).toBe("untitled");
    expect(slugifyTitle(">")).toBe("untitled");
    expect(slugifyTitle("|-")).toBe("untitled");
    expect(slugifyTitle(">-")).toBe("untitled");
    expect(slugifyTitle("|2")).toBe("untitled");
  });

  it("returns untitled for known placeholder titles", () => {
    expect(slugifyTitle("Untitled Session")).toBe("untitled");
    expect(slugifyTitle("untitled session")).toBe("untitled");
    expect(slugifyTitle("other")).toBe("untitled");
    expect(slugifyTitle("Other")).toBe("untitled");
    expect(slugifyTitle("attachment")).toBe("untitled");
    expect(slugifyTitle("Attachment")).toBe("untitled");
  });

  it("returns untitled for a missing or non-string title", () => {
    expect(slugifyTitle(undefined)).toBe("untitled");
    expect(slugifyTitle(null)).toBe("untitled");
    expect(slugifyTitle(42)).toBe("untitled");
  });

  it("caps an over-length title at SLUG_MAX_LENGTH characters", () => {
    const slug = slugifyTitle(
      "Investigate why the nightly export pipeline drops attachments when the source directory is renamed"
    );
    expect(slug).toBe("investigate-why-the-nightly-export-pipeline-drops-attac");
    expect(slug.length).toBe(SLUG_MAX_LENGTH);
  });

  it("never leaves a trailing hyphen when truncation lands on a separator", () => {
    // 54 chars, then a separator, then more → the cut falls exactly on the `-`.
    const slug = slugifyTitle(`${"x".repeat(54)} tail`);
    expect(slug).toBe("x".repeat(54));
    expect(slug.endsWith("-")).toBe(false);
  });

  it("drops non-ASCII decoration entirely", () => {
    expect(slugifyTitle("🎉 ship it 🎉")).toBe("ship-it");
    expect(slugifyTitle("🎉🎉🎉")).toBe("untitled");
  });
});

// ---------------------------------------------------------------------------
// uuid8
// ---------------------------------------------------------------------------

describe("uuid8", () => {
  it("takes the first 8 hex chars of a UUID with dashes removed", () => {
    expect(uuid8("58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11")).toBe("58726b2b");
  });

  it("lowercases", () => {
    expect(uuid8("58726B2B-9D16-4A1D-9F0F-0D0A2B6C7E11")).toBe("58726b2b");
  });

  it("keeps working for non-UUID session ids", () => {
    expect(uuid8("ses_01k2xyzabc")).toBe("ses01k2x");
  });

  it("uses short ids as-is rather than padding", () => {
    expect(uuid8("abc")).toBe("abc");
  });

  it("falls back to nosessid when there is no usable id", () => {
    expect(uuid8(undefined)).toBe("nosessid");
    expect(uuid8("")).toBe("nosessid");
    expect(uuid8("----")).toBe("nosessid");
    expect(uuid8(12345)).toBe("nosessid");
  });
});

// ---------------------------------------------------------------------------
// Local-time formatting
// ---------------------------------------------------------------------------

describe("formatLocalStamp", () => {
  it("formats local calendar components, zero-padded", () => {
    const stamp = formatLocalStamp(new Date(2026, 6, 29, 3, 57, 33));
    expect(stamp).toEqual({ year: "2026", month: "07", stamp: "2026-07-29T03-57-33" });
  });

  it("pads single-digit month/day/time", () => {
    const stamp = formatLocalStamp(new Date(2026, 0, 2, 4, 5, 6));
    expect(stamp).toEqual({ year: "2026", month: "01", stamp: "2026-01-02T04-05-06" });
  });
});

describe("local time vs UTC (day boundary)", () => {
  const originalTz = process.env["TZ"];

  afterAll(() => {
    if (originalTz === undefined) delete process.env["TZ"];
    else process.env["TZ"] = originalTz;
  });

  it("buckets by the LOCAL day even when UTC says the next day", () => {
    process.env["TZ"] = "America/New_York";

    // Sanity: if the runtime ignored the TZ change this assertion fails loudly
    // rather than silently making the test vacuous.
    expect(new Date("2026-07-29T03:57:33Z").getDate()).toBe(28);

    const relPath = buildRelPath(
      "claude",
      fm({ startedAt: "2026-07-29T03:57:33Z", title: "Late night fix", sessionId: "58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11" }),
      "proj/58726b2b.jsonl"
    );

    // UTC would say 2026/07/29T03-57-33; local (UTC-4 in July) says the 28th.
    expect(relPath).toBe("claude/2026/07/2026-07-28T23-57-33-late-night-fix-58726b2b.md");
  });

  it("buckets into the previous month/year when local time crosses back", () => {
    process.env["TZ"] = "America/New_York";
    expect(new Date("2026-01-01T02:15:00Z").getFullYear()).toBe(2025);

    const relPath = buildRelPath(
      "omp",
      fm({ source: "omp", startedAt: "2026-01-01T02:15:00Z", title: "New year rollover", sessionId: "aaaabbbb-cccc-dddd-eeee-ffff00001111" }),
      "proj/aaaabbbb.jsonl"
    );

    expect(relPath).toBe("omp/2025/12/2025-12-31T21-15-00-new-year-rollover-aaaabbbb.md");
  });
});

// ---------------------------------------------------------------------------
// resolveTimestamp precedence
// ---------------------------------------------------------------------------

describe("resolveTimestamp", () => {
  it("prefers startedAt", () => {
    const d = resolveTimestamp(
      fm({ startedAt: "2026-07-29T03:57:33Z", endedAt: "2026-08-01T00:00:00Z", sourceMtime: "2026-09-01T00:00:00Z" }),
      Date.parse("2026-10-01T00:00:00Z")
    );
    expect(d.toISOString()).toBe("2026-07-29T03:57:33.000Z");
  });

  it("falls back to endedAt when startedAt is absent", () => {
    const d = resolveTimestamp(fm({ endedAt: "2026-08-01T12:00:00Z" }));
    expect(d.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("falls back to endedAt when startedAt is unparseable", () => {
    const d = resolveTimestamp(fm({ startedAt: "not a date", endedAt: "2026-08-01T12:00:00Z" }));
    expect(d.toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("falls back to sourceMtime, then to the raw file mtime", () => {
    expect(resolveTimestamp(fm({ sourceMtime: "2026-09-02T08:00:00Z" })).toISOString()).toBe(
      "2026-09-02T08:00:00.000Z"
    );
    const mtimeMs = Date.parse("2026-10-03T09:30:00Z");
    expect(resolveTimestamp(fm(), mtimeMs).toISOString()).toBe("2026-10-03T09:30:00.000Z");
  });

  it("never consults aceRenderedAt (it would move the path every run)", () => {
    const d = resolveTimestamp(fm({ aceRenderedAt: "2026-11-11T11:11:11Z" }));
    expect(d.getTime()).toBe(0);
  });

  it("falls back to the epoch when nothing is usable", () => {
    expect(resolveTimestamp(fm(), 0).getTime()).toBe(0);
    expect(resolveTimestamp(fm({ startedAt: "" })).getTime()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildRelPath
// ---------------------------------------------------------------------------

describe("buildRelPath", () => {
  it("builds <tool>/<YYYY>/<MM>/<stamp>-<slug>-<uuid8>.md", () => {
    const relPath = buildRelPath(
      "claude",
      fm({
        startedAt: new Date(2026, 6, 29, 3, 57, 33).toISOString(),
        title: "Restore QA tester agent files from backup",
        sessionId: "58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11",
      }),
      "-Users-mjaverto-src-ace/58726b2b.jsonl"
    );
    expect(relPath).toBe(
      "claude/2026/07/2026-07-29T03-57-33-restore-qa-tester-agent-files-from-backup-58726b2b.md"
    );
  });

  it("uses untitled + nosessid when title and sessionId are missing", () => {
    const relPath = buildRelPath("pi", fm({ source: "pi" }), "teams/a.jsonl", {
      fallbackMtimeMs: new Date(2026, 1, 3, 9, 8, 7).getTime(),
    });
    expect(relPath).toBe("pi/2026/02/2026-02-03T09-08-07-untitled-nosessid.md");
  });

  it("normalizes the source name into a single safe path segment", () => {
    const relPath = buildRelPath(
      "My Source/v2",
      fm({ startedAt: new Date(2026, 4, 5, 6, 7, 8).toISOString(), title: "x", sessionId: "deadbeefcafe" }),
      "raw/a.jsonl"
    );
    expect(relPath).toBe("my-source-v2/2026/05/2026-05-05T06-07-08-x-deadbeef.md");
  });

  it("emits POSIX separators regardless of host", () => {
    const relPath = buildRelPath("codex", fm({ source: "codex" }), "a.jsonl", { fallbackMtimeMs: 1 });
    expect(relPath).not.toContain("\\");
    expect(relPath.split("/")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Collision disambiguation
// ---------------------------------------------------------------------------

describe("collision disambiguation", () => {
  const shared = fm({
    startedAt: new Date(2026, 6, 29, 3, 57, 33).toISOString(),
    title: "Restore QA tester agent files from backup",
    sessionId: "58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11",
  });

  // The real-world collision pair: a parent transcript and one of its
  // subagent transcripts share timestamp + sessionId + title.
  const parentRaw = "-Users-mjaverto-src-ace/58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11.jsonl";
  const subagentRaw =
    "-Users-mjaverto-src-ace/58726b2b-9d16-4a1d-9f0f-0d0a2b6c7e11/subagents/agent-reviewer.jsonl";

  it("produces identical bare paths for a colliding pair", () => {
    expect(buildRelPath("claude", shared, parentRaw)).toBe(buildRelPath("claude", shared, subagentRaw));
  });

  it("separates them once the disambiguator is applied", () => {
    const bare = buildRelPath("claude", shared, parentRaw);
    const disambiguated = buildRelPath("claude", shared, subagentRaw, { disambiguate: true });

    expect(disambiguated).not.toBe(bare);
    expect(disambiguated).toBe(
      `${bare.slice(0, -".md".length)}-${disambiguator(subagentRaw)}.md`
    );
    expect(disambiguated).toMatch(
      /^claude\/2026\/07\/2026-07-29T03-57-33-restore-qa-tester-agent-files-from-backup-58726b2b-[0-9a-f]{4}\.md$/
    );
  });

  it("derives the disambiguator deterministically from the raw path only", () => {
    expect(disambiguator(subagentRaw)).toBe(disambiguator(subagentRaw));
    expect(disambiguator(subagentRaw)).not.toBe(disambiguator(parentRaw));
    expect(disambiguator(subagentRaw)).toHaveLength(4);
    expect(disambiguator(subagentRaw, 8)).toHaveLength(8);
    // Wider disambiguators extend the same hash rather than starting over.
    expect(disambiguator(subagentRaw, 8).startsWith(disambiguator(subagentRaw))).toBe(true);
  });

  it("hashes POSIX and Windows spellings of a raw path identically", () => {
    expect(disambiguator("proj\\subagents\\agent-a.jsonl")).toBe(
      disambiguator("proj/subagents/agent-a.jsonl")
    );
  });

  it("inserts the suffix before the .md extension", () => {
    expect(disambiguateRelPath("claude/2026/07/note.md", "raw/a.jsonl")).toMatch(
      /^claude\/2026\/07\/note-[0-9a-f]{4}\.md$/
    );
  });
});

// ---------------------------------------------------------------------------
// rawRelPathFor
// ---------------------------------------------------------------------------

describe("rawRelPathFor", () => {
  it("strips the containing root", () => {
    expect(rawRelPathFor("/home/mike/.claude/projects/proj/a.jsonl", ["/home/mike/.claude/projects"])).toBe(
      "proj/a.jsonl"
    );
  });

  it("prefers the deepest matching root", () => {
    expect(
      rawRelPathFor("/a/b/c/d.jsonl", ["/a", "/a/b"])
    ).toBe("c/d.jsonl");
  });

  it("tolerates a trailing slash on the root", () => {
    expect(rawRelPathFor("/a/b/c.jsonl", ["/a/b/"])).toBe("c.jsonl");
  });

  it("expands ~ in roots", () => {
    const home = process.env["HOME"] ?? "";
    expect(rawRelPathFor(`${home}/.pi/agent/teams/t/a.jsonl`, ["~/.pi/agent"])).toBe(
      "teams/t/a.jsonl"
    );
  });

  it("keeps opencode-style composite ids unique", () => {
    expect(
      rawRelPathFor("/home/mike/.local/share/opencode/db.sqlite#ses_01k2", [
        "/home/mike/.local/share/opencode",
      ])
    ).toBe("db.sqlite#ses_01k2");
  });

  it("falls back to the id when it sits under no root", () => {
    expect(rawRelPathFor("synthetic-id-42", ["/a/b"])).toBe("synthetic-id-42");
  });
});
