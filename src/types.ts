// src/types.ts — The plugin contract for ace (Agent Conversation Exporter)

export interface AgentSource {
  /** Stable id used in config keys, CLI flags, frontmatter `source`, output dir */
  readonly name: string;
  /** Human label for `list-sources` / docs */
  readonly displayName: string;
  /** Discovery hints — paths/dirs/files this source reads. Used by `doctor`. */
  defaultRoots(home: string): string[];
  /** Yield one SessionHandle per session known to this source. Cheap — no body load. */
  enumerate(ctx: EnumerateContext): AsyncIterable<SessionHandle>;
  /** Load + render one session. Pure. No FS writes. */
  render(handle: SessionHandle, ctx: RenderContext): Promise<RenderResult>;
}

export interface SessionHandle {
  /** Stable opaque id (e.g. abs file path for JSONL plugins, session id for DB plugins) */
  id: string;
  /** Last-modified epoch ms — drives mtime-strategy incrementality */
  mtimeMs: number;
  /** Size hint when known (file size or row count); used only for telemetry */
  sizeBytes?: number;
  /** Relative output path (no `.md` extension required — core appends if missing) */
  outputRelPath: string;
  /** Opaque per-source data the renderer needs (file path, db id, …) */
  payload: unknown;
}

export interface EnumerateContext {
  roots: string[];     // resolved from config, or from defaultRoots()
  exclude?: string[];  // glob patterns
  logger: Logger;
}

export interface RenderContext {
  outPath: string;     // absolute path the core will write to
  now: Date;
  truncate: { toolOutput: number; toolInput: number };
  logger: Logger;
}

export interface RenderResult {
  markdown: string;
  frontmatter: Frontmatter;
  sourceMtimeMs: number;
  sourceSizeBytes: number;
  sourceSha256?: string;
}

export interface Frontmatter {
  source: string;           // AgentSource.name — required
  sessionId?: string;
  cwd?: string;
  model?: string;
  startedAt?: string;       // ISO-8601
  endedAt?: string;
  gitBranch?: string;
  version?: string;
  // anything else allowed; per-source extras under `x_<source>` namespace
  [k: string]: unknown;
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Helper for JSONL plugins — claude/codex/pi all use this.
 * Signature only — implementation lives in src/shared/jsonl-enumerate.ts (L2).
 */
export declare function jsonlEnumerate(opts: {
  roots: string[];
  match: (absPath: string) => boolean;
  outputPathFor: (absPath: string, root: string) => string;
}): (ctx: EnumerateContext) => AsyncIterable<SessionHandle>;
