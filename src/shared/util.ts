// src/shared/util.ts — shared utilities

import fs from "node:fs/promises";
import readline from "node:readline";
import { createReadStream } from "node:fs";

// ---------------------------------------------------------------------------
// readJsonl
// ---------------------------------------------------------------------------

export interface JsonlLine {
  lineNo: number;
  raw: string;
  parsed?: unknown;
}

export async function* readJsonl(path: string): AsyncIterable<JsonlLine> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    if (raw.trim() === "") continue;
    let parsed: unknown | undefined;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      // yield with parsed undefined so callers can handle gracefully
    }
    yield { lineNo, raw, parsed };
  }
}

// ---------------------------------------------------------------------------
// fmtTs — format a timestamp value to ISO-8601 string
// ---------------------------------------------------------------------------

export function fmtTs(input: number | string | Date): string {
  if (input instanceof Date) {
    return input.toISOString();
  }
  if (typeof input === "number") {
    return new Date(input).toISOString();
  }
  // string — attempt to normalise
  const d = new Date(input);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }
  return input;
}

// ---------------------------------------------------------------------------
// expandHome
// ---------------------------------------------------------------------------

export function expandHome(p: string): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

// ---------------------------------------------------------------------------
// safeStat
// ---------------------------------------------------------------------------

export async function safeStat(p: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.stat(p);
  } catch {
    return undefined;
  }
}
