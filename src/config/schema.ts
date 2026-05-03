// src/config/schema.ts — Zod schema for ace configuration

import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

const truncateSchema = z.object({
  toolOutput: z.number().int().positive().default(4000),
  toolInput: z.number().int().positive().default(4000),
});

const sourceConfigSchema = z.object({
  enabled: z.boolean().optional(),
  roots: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

// ---------------------------------------------------------------------------
// Root config schema
// ---------------------------------------------------------------------------

export const configSchema = z.object({
  /** Output directory (absolute or ~-prefixed). Required. */
  output: z.string(),

  /**
   * Incrementality strategy.
   * - `mtime`: compare source vs output file mtime (default).
   * - `index`: use `.ace.state.json` index file.
   */
  strategy: z.enum(["mtime", "index"]).default("mtime"),

  /**
   * Max concurrent render jobs.
   * `"auto"` → os.cpus().length.
   */
  concurrency: z.union([z.number().int().positive(), z.literal("auto")]).default("auto"),

  truncate: truncateSchema.default({ toolOutput: 4000, toolInput: 4000 }),

  /**
   * Per-source configuration keyed by source name.
   */
  sources: z.record(z.string(), sourceConfigSchema).default({}),

  /**
   * Plugin specifiers — file paths or npm package names.
   * Each should default-export an AgentSource or factory function.
   */
  plugins: z.array(z.string()).default([]),
});

// ---------------------------------------------------------------------------
// Exported inferred types
// ---------------------------------------------------------------------------

export type AceConfig = z.infer<typeof configSchema>;
export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type TruncateConfig = z.infer<typeof truncateSchema>;
