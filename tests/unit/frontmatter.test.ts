// tests/unit/frontmatter.test.ts — unit tests for serializeFrontmatter

import { describe, it, expect } from "vitest";
import { serializeFrontmatter } from "../../src/frontmatter.js";

describe("serializeFrontmatter", () => {
  it("strips top-level null values", () => {
    // Cast to bypass exactOptionalPropertyTypes so we can test null runtime values
    const fm = { source: "claude", model: null } as unknown as Parameters<typeof serializeFrontmatter>[0];
    const result = serializeFrontmatter(fm);
    expect(result).not.toContain("model:");
    expect(result).toContain("source: claude");
  });

  it("strips nested null from x_ objects recursively", () => {
    const result = serializeFrontmatter({
      source: "opencode",
      x_opencode: {
        summaryFiles: null as unknown as undefined,
        summaryAdditions: 5,
        summaryDeletions: null as unknown as undefined,
      },
    });
    expect(result).not.toContain("summaryFiles");
    expect(result).not.toContain("summaryDeletions");
    expect(result).toContain("summaryAdditions: 5");
  });

  it("preserves non-null nested values", () => {
    const result = serializeFrontmatter({
      source: "pi",
      x_pi: {
        provider: "anthropic",
        thinkingLevel: 2,
      },
    });
    expect(result).toContain("provider: anthropic");
    expect(result).toContain("thinkingLevel: 2");
  });

  it("strips nested undefined from plain objects", () => {
    const fm = {
      source: "codex",
      x_codex: { originator: undefined, effort: "high" },
    } as unknown as Parameters<typeof serializeFrontmatter>[0];
    const result = serializeFrontmatter(fm);
    expect(result).not.toContain("originator");
    expect(result).toContain("effort: high");
  });

  it("forces aceSchema to 1 always", () => {
    const result = serializeFrontmatter({
      source: "claude",
      aceSchema: 99 as unknown as 1,
    });
    expect(result).toContain("aceSchema: 1");
  });

  it("emits canonical keys in order before x_ keys", () => {
    const result = serializeFrontmatter({
      source: "claude",
      x_claude: { teamName: "acme" },
      title: "My Session",
    });
    const sourceIdx = result.indexOf("source:");
    const titleIdx = result.indexOf("title:");
    const xIdx = result.indexOf("x_claude:");
    expect(sourceIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(xIdx);
  });

  it("wraps output in --- delimiters", () => {
    const result = serializeFrontmatter({ source: "claude" });
    expect(result).toMatch(/^---\n/);
    expect(result).toMatch(/\n---\n$/);
  });
});
