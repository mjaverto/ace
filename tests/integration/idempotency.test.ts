// tests/integration/idempotency.test.ts — focused idempotency test
//
// Renders the claude fixtures twice; verifies the second run skips all entries.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execa } from "execa";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLI = path.resolve(import.meta.dirname, "../../dist/cli.js");
const FIXTURES_CLAUDE = path.resolve(import.meta.dirname, "../../fixtures/claude");

let tmpDir: string;
let configPath: string;
let outDir: string;
let claudeRoot: string;

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ace-idempotency-test-"));
  outDir = path.join(tmpDir, "output");
  await fs.mkdir(outDir, { recursive: true });

  // Create a matching .claude/projects/ structure for the claude source match regex
  claudeRoot = path.join(tmpDir, ".claude", "projects");
  const claudeSessionDir = path.join(claudeRoot, "test-project");
  await fs.mkdir(claudeSessionDir, { recursive: true });

  const fixtureContent = await fs.readFile(
    path.join(FIXTURES_CLAUDE, "01-basic.jsonl"),
    "utf8"
  );
  await fs.writeFile(
    path.join(claudeSessionDir, "a1b2c3d4-e5f6-7890-abcd-ef1234567890.jsonl"),
    fixtureContent,
    "utf8"
  );

  const config = {
    output: outDir,
    strategy: "mtime",
    sources: {
      claude: {
        enabled: true,
        roots: [claudeRoot],
      },
      codex: { enabled: false },
      pi: { enabled: false },
      opencode: { enabled: false },
    },
  };

  configPath = path.join(tmpDir, "ace.config.json");
  await fs.writeFile(configPath, JSON.stringify(config), "utf8");
});

afterAll(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function renderJson(): Promise<Array<{ status: string; outPath: string | null }>> {
  const result = await execa(
    "node",
    [CLI, "render", "--config", configPath, "--out", outDir, "--json"],
    {
      cwd: tmpDir,
      env: process.env,
      reject: false,
    }
  );
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { status: string; outPath: string | null });
}

describe("idempotency", () => {
  it("first run renders all entries, second run skips all", async () => {
    const firstRun = await renderJson();
    expect(firstRun.length).toBeGreaterThan(0);

    // All first-run entries should be rendered
    for (const entry of firstRun) {
      expect(entry.status).toBe("rendered");
    }

    const secondRun = await renderJson();
    expect(secondRun).toHaveLength(firstRun.length);

    // All second-run entries should be skipped
    for (const entry of secondRun) {
      expect(entry.status).toBe("skipped");
    }
  });
});
