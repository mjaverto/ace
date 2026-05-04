// tests/unit/markdown.test.ts — unit tests for markdown rendering helpers

import { describe, it, expect } from "vitest";
import {
  truncate,
  fence,
  detailsBlock,
  roleHeading,
} from "../../src/markdown.js";

describe("truncate", () => {
  it("returns string unchanged when under the byte limit", () => {
    const s = "hello world";
    expect(truncate(s, 100)).toBe(s);
  });

  it("returns string unchanged when exactly at the byte limit", () => {
    const s = "hello";
    expect(truncate(s, 5)).toBe(s);
  });

  it("truncates ASCII at the byte limit and appends truncation footer", () => {
    const s = "hello world";
    const result = truncate(s, 5);
    expect(result).toContain("hello");
    expect(result).toContain("[truncated");
    expect(result).not.toContain("world");
  });

  it("cuts on UTF-8 codepoint boundary for multi-byte characters", () => {
    // '€' is 3 bytes in UTF-8. A 4-byte limit must not cut mid-codepoint.
    // 'ab€' = 2 + 3 = 5 bytes. Cutting at 4 would split '€'.
    const s = "ab€cd";
    const result = truncate(s, 4);
    // Should contain 'ab' (2 bytes) and not a partial '€'
    expect(result).toContain("ab");
    expect(result).not.toMatch(/�/); // no replacement character
    expect(result).toContain("[truncated");
  });

  it("handles multi-byte characters (emoji 4 bytes each)", () => {
    // '🎉' is 4 bytes. '🎉🎉' is 8 bytes. Truncate at 5 → must not split emoji.
    const s = "🎉🎉";
    const result = truncate(s, 5);
    expect(result).toContain("[truncated");
    expect(result).not.toMatch(/�/);
  });

  it("handles empty string input", () => {
    expect(truncate("", 10)).toBe("");
    expect(truncate("", 0)).toBe("");
  });

  it("passes through unchanged when max is false", () => {
    const long = "x".repeat(10000);
    expect(truncate(long, false)).toBe(long);
  });

  it("appends correct truncated byte count", () => {
    const s = "hello world"; // 11 bytes
    const result = truncate(s, 5); // keep 5, drop 6
    expect(result).toContain("[truncated 6 bytes]");
  });
});

describe("fence", () => {
  it("wraps body in backtick fence with lang", () => {
    const result = fence("bash", "ls -la");
    expect(result).toBe("```bash\nls -la\n```\n\n");
  });

  it("wraps body in plain fence when no lang", () => {
    const result = fence("", "output");
    expect(result).toBe("```\noutput\n```\n\n");
  });

  it("trims trailing whitespace from body", () => {
    const result = fence("", "output   \n\n");
    expect(result).toBe("```\noutput\n```\n\n");
  });

  it("handles empty body", () => {
    const result = fence("", "");
    expect(result).toBe("```\n\n```\n\n");
  });

  it("body containing triple backticks is preserved as-is (limitation documented)", () => {
    // The current implementation uses triple-backtick fences.
    // If the body contains ```, the output will have nested ```.
    // This is a known limitation — the implementation does not use tilde fences.
    const body = "some code with ``` inside";
    const result = fence("", body);
    // The fence is still produced; the backtick content is verbatim.
    expect(result).toContain(body);
    expect(result).toMatch(/^```/);
  });

  it("handles multiline body", () => {
    const result = fence("json", '{\n  "key": "value"\n}');
    expect(result).toBe('```json\n{\n  "key": "value"\n}\n```\n\n');
  });
});

describe("detailsBlock", () => {
  it("wraps body in details/summary tags", () => {
    const result = detailsBlock("thinking", "I need to think.");
    expect(result).toBe(
      "<details><summary>thinking</summary>\n\nI need to think.\n\n</details>\n\n"
    );
  });

  it("handles empty body", () => {
    const result = detailsBlock("notes", "");
    expect(result).toBe("<details><summary>notes</summary>\n\n\n\n</details>\n\n");
  });

  it("handles custom summary label", () => {
    const result = detailsBlock("tool output", "foo bar");
    expect(result).toContain("<summary>tool output</summary>");
  });
});

describe("roleHeading", () => {
  it("includes role and ISO timestamp when ts is a string", () => {
    const result = roleHeading("User", "2026-05-01T10:00:00.000Z");
    expect(result).toBe("## User · 2026-05-01T10:00:00.000Z\n\n");
  });

  it("includes role and ISO timestamp when ts is a Date", () => {
    const result = roleHeading("Assistant", new Date("2026-05-01T10:00:00.000Z"));
    expect(result).toBe("## Assistant · 2026-05-01T10:00:00.000Z\n\n");
  });

  it("includes role and ISO timestamp when ts is epoch ms", () => {
    const result = roleHeading("User", 1746094800000);
    expect(result).toMatch(/^## User · \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("omits timestamp when ts is undefined", () => {
    const result = roleHeading("User");
    expect(result).toBe("## User\n\n");
  });

  it("omits timestamp when ts is empty string", () => {
    const result = roleHeading("User", "");
    expect(result).toBe("## User\n\n");
  });

  it("ends with double newline", () => {
    const result = roleHeading("Assistant", "2026-05-01T10:00:00.000Z");
    expect(result).toMatch(/\n\n$/);
  });
});
