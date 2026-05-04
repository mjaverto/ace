// src/sources/opencode.ts — opencode SQLite renderer

import path from "node:path";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import {
  roleHeading,
  detailsBlock,
  toolCallBlock,
  toolOutputBlock,
  fence,
  sectionForUnknown,
  truncate,
} from "../markdown.js";
import { fmtTs } from "../shared/util.js";
import type {
  AgentSource,
  SessionHandle,
  EnumerateContext,
  RenderContext,
  RenderResult,
  Frontmatter,
} from "../types.js";

// ---------------------------------------------------------------------------
// Type helpers for opencode SQLite schema
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  project_id: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  summary_additions: number | null;
  summary_deletions: number | null;
  summary_files: number | null;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  id: string;
  time_created: number;
  data: string;
}

interface PartRow {
  data: string;
}

// Part data shapes

interface TextPart {
  type: "text";
  text: string;
}

interface ReasoningPart {
  type: "reasoning";
  text: string;
}

type ToolState =
  | { status: "pending" | "running" }
  | {
      status: "completed";
      input?: unknown;
      output?: unknown;
    }
  | {
      status: "error";
      input?: unknown;
      error?: string;
    };

interface ToolPart {
  type: "tool";
  tool: string;
  state: ToolState;
  providerOptions?: Record<string, unknown>;
}

interface StepStartPart {
  type: "step-start";
}

interface StepFinishPart {
  type: "step-finish";
}

interface FilePart {
  type: "file";
  filename: string;
  mimeType?: string;
  body?: string;
}

type OpencodePart =
  | TextPart
  | ReasoningPart
  | ToolPart
  | StepStartPart
  | StepFinishPart
  | FilePart
  | Record<string, unknown>;

interface MessageEnvelope {
  role?: "user" | "assistant" | string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Payload type
// ---------------------------------------------------------------------------

export interface OpencodePayload {
  dbPath: string;
  sessionId: string;
  projectId: string;
  slug: string;
  directory: string;
  title: string;
  version: string;
  summaryAdditions: number | null;
  summaryDeletions: number | null;
  summaryFiles: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a string for use as a filesystem path component.
 * Replaces non-alphanum/dash/underscore/dot sequences with underscores.
 */
function sanitizePathSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
}

/**
 * Determine the directory component of the output path.
 * Use slug if present and non-empty, otherwise project_id.
 */
function outputDirSegment(slug: string, projectId: string): string {
  const raw = slug && slug.trim() ? slug.trim() : projectId;
  return sanitizePathSegment(raw);
}

/**
 * Resolve a root to an absolute path for the DB file.
 * If the root is a directory, look for opencode.db within it.
 */
async function resolveDbPath(root: string): Promise<string | null> {
  try {
    const st = await fs.stat(root);
    if (st.isDirectory()) {
      const candidate = path.join(root, "opencode.db");
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        return null;
      }
    }
    // Assume it is the DB file itself
    return root;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Part renderer
// ---------------------------------------------------------------------------

interface RenderPartResult {
  text: string;
  isToolCall: boolean;
}

function renderPart(
  part: OpencodePart,
  truncateOpts: { toolOutput: number; toolInput: number }
): RenderPartResult {
  const p = part as Record<string, unknown>;
  const pType = p["type"] as string | undefined;

  // text
  if (pType === "text") {
    const tp = part as TextPart;
    return { text: (tp.text ?? "") + "\n\n", isToolCall: false };
  }

  // reasoning → <details>thinking</details>
  if (pType === "reasoning") {
    const rp = part as ReasoningPart;
    return { text: detailsBlock("thinking", rp.text ?? ""), isToolCall: false };
  }

  // tool
  if (pType === "tool") {
    const tp = part as ToolPart;
    const status = (tp.state as Record<string, unknown>)?.["status"] as string | undefined;

    // Only render completed or error states
    if (status !== "completed" && status !== "error") {
      return { text: "", isToolCall: false };
    }

    const toolName = tp.tool ?? "unknown";
    const state = tp.state as Record<string, unknown>;
    const input = state["input"];
    const inputStr = input !== undefined ? JSON.stringify(input, null, 2) : "{}";
    const truncatedInput = truncate(inputStr, truncateOpts.toolInput);

    let out = toolCallBlock({ name: toolName, input: truncatedInput });

    if (status === "error") {
      const errMsg = (state["error"] as string | undefined) ?? "unknown error";
      out += `#### [ERROR] Tool error\n\n` + fence("", errMsg);
    } else {
      // completed
      const outputVal = state["output"];
      const outputRaw =
        outputVal === undefined
          ? ""
          : typeof outputVal === "string"
            ? outputVal
            : JSON.stringify(outputVal, null, 2);
      const truncatedOutput = truncate(outputRaw, truncateOpts.toolOutput);
      const wasTruncated =
        typeof truncateOpts.toolOutput === "number" &&
        Buffer.from(outputRaw, "utf8").length > truncateOpts.toolOutput;
      if (wasTruncated) {
        out += toolOutputBlock({ output: truncatedOutput, truncatedTo: truncateOpts.toolOutput });
      } else {
        out += toolOutputBlock({ output: truncatedOutput });
      }
    }

    return { text: out, isToolCall: true };
  }

  // step-start / step-finish — silent
  if (pType === "step-start" || pType === "step-finish") {
    return { text: "", isToolCall: false };
  }

  // file
  if (pType === "file") {
    const fp = part as FilePart;
    const header = fp.filename ? `# ${fp.filename}\n\n` : "";
    if (fp.body && typeof fp.body === "string") {
      // Detect if body looks textual
      const lang = fp.mimeType?.startsWith("text/") ? "" : "";
      return { text: header + fence(lang, fp.body), isToolCall: false };
    }
    // Binary or absent body — just emit filename
    return { text: `${header}(binary file: ${fp.filename})\n\n`, isToolCall: false };
  }

  // Unknown type — surface as fenced JSON for drift visibility
  const label =
    typeof pType === "string" ? `unknown part: ${pType}` : "unknown part";
  return { text: sectionForUnknown(label, part), isToolCall: false };
}

// ---------------------------------------------------------------------------
// opencodeSource
// ---------------------------------------------------------------------------

export const opencodeSource: AgentSource = {
  name: "opencode",
  displayName: "opencode",

  defaultRoots(home: string): string[] {
    return [`${home}/.local/share/opencode/opencode.db`];
  },

  enumerate(ctx: EnumerateContext): AsyncIterable<SessionHandle> {
    return {
      [Symbol.asyncIterator](): AsyncIterator<SessionHandle> {
        return makeEnumerateIterator(ctx);
      },
    };
  },

  async render(handle: SessionHandle, ctx: RenderContext): Promise<RenderResult> {
    const payload = handle.payload as OpencodePayload;
    const { dbPath, sessionId, projectId, slug, directory, title, version } = payload;

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      // Load session row for time_created / time_updated
      const sessionRow = db
        .prepare<[string], SessionRow>(
          `SELECT id, project_id, slug, directory, title, version,
                  summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE id = ?`
        )
        .get(sessionId);

      const timeCreated = sessionRow?.time_created ?? 0;
      const timeUpdated = sessionRow?.time_updated ?? 0;

      // Load messages ordered by time_created
      const messages = db
        .prepare<[string], MessageRow>(
          `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created`
        )
        .all(sessionId);

      // Prepare part query
      const partQuery = db.prepare<[string], PartRow>(
        `SELECT data FROM part WHERE message_id = ? ORDER BY time_created`
      );

      const bodyParts: string[] = [];
      let messageCount = 0;
      let toolCallCount = 0;
      let lastMsgTimeCreated = timeCreated;
      let model: string | undefined;

      for (const msg of messages) {
        const envelope = JSON.parse(msg.data) as MessageEnvelope;
        const role = envelope.role;

        if (role !== "user" && role !== "assistant") continue;

        messageCount++;
        if (msg.time_created) lastMsgTimeCreated = msg.time_created;

        const roleLabel = role === "user" ? "User" : "Assistant";
        bodyParts.push(roleHeading(roleLabel, msg.time_created));

        const partRows = partQuery.all(msg.id);
        let lastProviderOptions: Record<string, unknown> | undefined;

        for (const pRow of partRows) {
          const partData = JSON.parse(pRow.data) as OpencodePart;

          // Collect providerOptions from any part for model extraction
          const pd = partData as Record<string, unknown>;
          if (pd["providerOptions"] !== undefined) {
            lastProviderOptions = pd["providerOptions"] as Record<string, unknown>;
          }

          const { text, isToolCall } = renderPart(partData, ctx.truncate);
          if (isToolCall) toolCallCount++;
          bodyParts.push(text);
        }

        // Update model from last assistant message providerOptions
        if (role === "assistant" && lastProviderOptions !== undefined) {
          // Try common keys: model, modelId
          const maybeModel =
            (lastProviderOptions["model"] as string | undefined) ??
            (lastProviderOptions["modelId"] as string | undefined);
          if (maybeModel !== undefined) model = maybeModel;
        }
      }

      // Title heading
      const resolvedTitle = title || sessionId;
      const titleHeading = `# ${resolvedTitle}\n\n`;
      const markdown = titleHeading + bodyParts.join("");

      // Frontmatter
      const fm: Frontmatter = {
        source: "opencode",
      };

      fm.sessionId = sessionId;
      fm.title = resolvedTitle;
      fm.startedAt = fmtTs(timeCreated);
      fm.endedAt = fmtTs(lastMsgTimeCreated);
      fm.cwd = directory;
      if (model !== undefined) fm.model = model;
      fm.version = version;
      fm.messageCount = messageCount;
      fm.toolCallCount = toolCallCount;
      fm.aceSchema = 1;
      fm.aceRenderedAt = ctx.now.toISOString();

      fm.x_opencode = {
        projectId,
        slug,
        directory,
        version,
        summaryFiles: payload.summaryFiles,
        summaryAdditions: payload.summaryAdditions,
        summaryDeletions: payload.summaryDeletions,
        dbPath,
      };

      return {
        markdown,
        frontmatter: fm,
        sourceMtimeMs: timeUpdated,
        sourceSizeBytes: 0,
      };
    } finally {
      db.close();
    }
  },
};

// ---------------------------------------------------------------------------
// Enumerate iterator (async generator wrapped in AsyncIterator protocol)
// ---------------------------------------------------------------------------

async function* generateHandles(
  ctx: EnumerateContext
): AsyncGenerator<SessionHandle> {
  const roots = ctx.roots.length > 0 ? ctx.roots : opencodeSource.defaultRoots(
    process.env["HOME"] ?? process.env["USERPROFILE"] ?? ""
  );

  for (const rawRoot of roots) {
    const dbPath = await resolveDbPath(rawRoot);
    if (dbPath === null) {
      ctx.logger.debug(`[opencode] root not found or no opencode.db: ${rawRoot}`);
      continue;
    }

    let db: Database.Database;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      ctx.logger.warn(`[opencode] failed to open DB ${dbPath}: ${String(err)}`);
      continue;
    }

    try {
      const rows = db
        .prepare<[], SessionRow>(
          `SELECT id, project_id, slug, directory, title, version,
                  summary_additions, summary_deletions, summary_files,
                  time_created, time_updated
           FROM session WHERE time_archived IS NULL ORDER BY time_updated`
        )
        .all();

      for (const row of rows) {
        const dirSegment = outputDirSegment(row.slug, row.project_id);
        const outputRelPath = `${dirSegment}/${row.id}.md`;

        const payload: OpencodePayload = {
          dbPath,
          sessionId: row.id,
          projectId: row.project_id,
          slug: row.slug,
          directory: row.directory,
          title: row.title,
          version: row.version,
          summaryAdditions: row.summary_additions,
          summaryDeletions: row.summary_deletions,
          summaryFiles: row.summary_files,
        };

        yield {
          id: `${dbPath}#${row.id}`,
          mtimeMs: row.time_updated,
          outputRelPath,
          payload,
        };
      }
    } finally {
      db.close();
    }
  }
}

function makeEnumerateIterator(ctx: EnumerateContext): AsyncIterator<SessionHandle> {
  const gen = generateHandles(ctx);
  return {
    next(): Promise<IteratorResult<SessionHandle>> {
      return gen.next();
    },
    return(value?: unknown): Promise<IteratorResult<SessionHandle>> {
      return gen.return(value as SessionHandle);
    },
  };
}

export default opencodeSource;
