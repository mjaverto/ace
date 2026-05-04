// src/index.ts — public library exports

export * from "./types.js";

// Registry
export { Registry } from "./registry.js";

// Config
export { loadConfig, defineConfig } from "./config/load.js";
export type { AceConfig, SourceConfig, TruncateConfig } from "./config/schema.js";

// Core engine
export { runRender } from "./core/render.js";
export type { RunRenderOptions, RenderReport, SourceReport } from "./core/render.js";
export { needsRender, loadIndex, saveIndex } from "./core/incremental.js";
export type { IndexEntry, IndexState } from "./core/incremental.js";
export { atomicWrite, setSourceMtime, sweepTmp } from "./core/atomic-write.js";
export { walk } from "./core/walk.js";

// Frontmatter
export { serializeFrontmatter } from "./frontmatter.js";

// Markdown helpers
export {
  heading,
  roleHeading,
  fence,
  detailsBlock,
  truncate,
  toolCallBlock,
  toolOutputBlock,
  sectionForUnknown,
} from "./markdown.js";
export type { ToolCallBlockOpts, ToolOutputBlockOpts } from "./markdown.js";

// Shared utilities
export { readJsonl, fmtTs, expandHome, safeStat } from "./shared/util.js";
export type { JsonlLine } from "./shared/util.js";
export { jsonlEnumerate } from "./shared/jsonl-enumerate.js";

// Sources registry
export { createDefaultRegistry, loadPlugins } from "./sources/index.js";
export { claudeSource, codexSource, piSource, opencodeSource } from "./sources/index.js";
