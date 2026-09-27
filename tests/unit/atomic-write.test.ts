// tests/unit/atomic-write.test.ts — temp staging outside the destination dir (issue #14)

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWrite } from "../../src/core/atomic-write.js";

let tmpDir: string;
let outDir: string;
let stageDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ace-atomic-write-test-"));
  outDir = path.join(tmpDir, "out");
  stageDir = path.join(tmpDir, "stage");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.chmod(stageDir, 0o700).catch(() => undefined);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const dest = (): string => path.join(outDir, "note.md");
const leftovers = async (dir: string): Promise<string[]> =>
  (await fs.readdir(dir).catch(() => [])).filter((n) => n.includes(".tmp-"));

function failRename(code: string, when: (src: string) => boolean): void {
  const real = fs.rename.bind(fs);
  vi.spyOn(fs, "rename").mockImplementation(async (src, dst) => {
    if (when(String(src))) throw Object.assign(new Error(code), { code });
    return real(src, dst);
  });
}

describe("atomicWrite with tmpDir", () => {
  it("stages the temp file in tmpDir, not next to the destination", async () => {
    const rename = vi.spyOn(fs, "rename");

    await atomicWrite(dest(), "hello", { tmpDir: stageDir, noFsync: true });

    expect(await fs.readFile(dest(), "utf8")).toBe("hello");
    expect(path.dirname(String(rename.mock.calls[0]?.[0]))).toBe(stageDir);
    expect(await leftovers(outDir)).toEqual([]);
  });

  it("falls back to same-dir staging on EXDEV, leaving no temp anywhere", async () => {
    failRename("EXDEV", (src) => path.dirname(src) === stageDir);

    await atomicWrite(dest(), "hello", { tmpDir: stageDir, noFsync: true });

    expect(await fs.readFile(dest(), "utf8")).toBe("hello");
    expect(await leftovers(stageDir)).toEqual([]);
    expect(await leftovers(outDir)).toEqual([]);
  });

  it("removes the temp and rethrows when the rename fails otherwise", async () => {
    failRename("EACCES", () => true);

    await expect(atomicWrite(dest(), "hello", { tmpDir: stageDir, noFsync: true })).rejects.toMatchObject({
      code: "EACCES",
    });
    expect(await leftovers(stageDir)).toEqual([]);
    expect(await leftovers(outDir)).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("falls back to same-dir staging when tmpDir is unwritable", async () => {
    await fs.mkdir(stageDir, { mode: 0o500 });
    await fs.chmod(stageDir, 0o500);

    await atomicWrite(dest(), "hello", { tmpDir: stageDir, noFsync: true });

    expect(await fs.readFile(dest(), "utf8")).toBe("hello");
    expect(await leftovers(outDir)).toEqual([]);
  });

  it("does not retry next to the file after a non-EXDEV rename failure", async () => {
    failRename("EACCES", (src) => path.dirname(src) === stageDir);
    await expect(atomicWrite(dest(), "hello", { tmpDir: stageDir, noFsync: true })).rejects.toMatchObject({ code: "EACCES" });
    await expect(fs.stat(dest())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes a partially written temp when the write fails", async () => {
    const real = fs.writeFile.bind(fs);
    vi.spyOn(fs, "writeFile").mockImplementation(async (p, _d, o) => {
      await real(p, "partial", o as never);
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    });
    await expect(atomicWrite(dest(), "hello", { tmpDir: stageDir, noFsync: true })).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await leftovers(stageDir)).toEqual([]);
    expect(await leftovers(outDir)).toEqual([]);
  });
});
