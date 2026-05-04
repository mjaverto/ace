// src/config/load.ts — config file resolution and loading

import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema, type AceConfig } from "./schema.js";
import { expandHome } from "../shared/util.js";

// ---------------------------------------------------------------------------
// defineConfig — helper for .ts/.js configs
// ---------------------------------------------------------------------------

/**
 * Identity helper so TypeScript config files get type-checking.
 *
 * Usage in ace.config.ts:
 *   import { defineConfig } from "@mjaverto/ace";
 *   export default defineConfig({ output: "~/out", ... });
 */
export function defineConfig(c: Partial<AceConfig>): Partial<AceConfig> {
  return c;
}

// ---------------------------------------------------------------------------
// Path candidates
// ---------------------------------------------------------------------------

const LOCAL_CANDIDATES = [
  "ace.config.yaml",
  "ace.config.yml",
  "ace.config.json",
  "ace.config.ts",
  "ace.config.js",
];

function xdgCandidates(): string[] {
  const xdg = process.env["XDG_CONFIG_HOME"] ?? path.join(process.env["HOME"] ?? "~", ".config");
  return [
    path.join(xdg, "ace", "config.yaml"),
    path.join(xdg, "ace", "config.yml"),
  ];
}

// ---------------------------------------------------------------------------
// Path-shape heuristic — expand ~ in strings that look like paths
// ---------------------------------------------------------------------------

function expandPathsInObject(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.startsWith("~/") || obj === "~" ? expandHome(obj) : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map((v) => expandPathsInObject(v));
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = expandPathsInObject(v);
    }
    return result;
  }
  return obj;
}

// ---------------------------------------------------------------------------
// loadRawConfig — read and parse a single candidate file
// ---------------------------------------------------------------------------

async function loadRawConfig(filePath: string): Promise<unknown> {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".yaml" || ext === ".yml") {
    const raw = await fs.readFile(filePath, "utf8");
    return parseYaml(raw) as unknown;
  }

  if (ext === ".json") {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  }

  if (ext === ".ts" || ext === ".js") {
    // Dynamic import — the module should default-export the config object
    // (possibly wrapped in defineConfig).
    const mod = await import(filePath) as { default?: unknown };
    return mod.default ?? mod;
  }

  throw new Error(`[loadConfig] Unsupported config file extension: ${ext}`);
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

/**
 * Resolve and load the ace configuration.
 *
 * Resolution order:
 *  1. Explicit `configPath` argument (from --config flag)
 *  2. Local candidates: ace.config.{yaml,yml,json,ts,js}
 *  3. XDG: $XDG_CONFIG_HOME/ace/config.{yaml,yml} (falls back to ~/.config/ace/…)
 *
 * After loading, `~` is expanded in any string value.
 * The raw object is validated against `configSchema`.
 */
export async function loadConfig(configPath?: string): Promise<AceConfig> {
  let raw: unknown;

  if (configPath) {
    const abs = expandHome(configPath);
    raw = await loadRawConfig(abs);
  } else {
    // Try local candidates first
    const cwd = process.cwd();
    let found = false;

    for (const candidate of LOCAL_CANDIDATES) {
      const full = path.join(cwd, candidate);
      let accessible = false;
      try {
        await fs.access(full);
        accessible = true;
      } catch {
        // not found, try next
      }
      if (accessible) {
        // File exists — parse must succeed or we propagate the error with path context
        try {
          raw = await loadRawConfig(full);
        } catch (err) {
          throw new Error(`[loadConfig] Failed to parse config file "${full}": ${(err as Error).message}`);
        }
        found = true;
        break;
      }
    }

    if (!found) {
      // Try XDG candidates
      for (const candidate of xdgCandidates()) {
        let accessible = false;
        try {
          await fs.access(candidate);
          accessible = true;
        } catch {
          // not found, try next
        }
        if (accessible) {
          try {
            raw = await loadRawConfig(candidate);
          } catch (err) {
            throw new Error(`[loadConfig] Failed to parse config file "${candidate}": ${(err as Error).message}`);
          }
          found = true;
          break;
        }
      }
    }

    if (!found) {
      // Return defaults (output is required, so this will fail validation)
      raw = {};
    }
  }

  // Expand ~ in all path-shaped values
  const expanded = expandPathsInObject(raw);

  // Validate and return
  const result = configSchema.safeParse(expanded);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`[loadConfig] Invalid configuration:\n${issues}`);
  }

  return result.data;
}
