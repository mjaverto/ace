// src/sources/codex.ts — OpenAI Codex CLI renderer

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentSource, SessionHandle, EnumerateContext, RenderContext, RenderResult, Frontmatter } from "../types.js";
import { jsonlEnumerate } from "../shared/jsonl-enumerate.js";
import { readJsonl } from "../shared/util.js";
import {
  heading,
  roleHeading,
  detailsBlock,
  toolCallBlock,
  toolOutputBlock,
  truncate,
  sectionForUnknown,
} from "../markdown.js";

// ---------------------------------------------------------------------------
// Schema types
// ---------------------------------------------------------------------------

interface CodexLine {
  timestamp: string;
  type: string;
  payload: unknown;
}

interface SessionMetaPayload {
  id?: string;
  cwd?: string;
  cli_version?: string;
  originator?: string;
  instructions?: string;
  git?: {
    commit_hash?: string;
    branch?: string;
  };
}

interface TurnContextPayload {
  model?: string;
  effort?: string;
}

interface ContentItem {
  type: string;
  text?: string;
}

interface MessagePayload {
  type: "message";
  role: "user" | "assistant";
  content: ContentItem[] | string;
}

interface ReasoningPayload {
  type: "reasoning";
  summary?: ContentItem[] | string;
  content?: ContentItem[] | string;
  encrypted_content?: unknown;
}

interface FunctionCallPayload {
  type: "function_call";
  call_id?: string;
  name?: string;
  arguments?: string;
}

interface FunctionCallOutputPayload {
  type: "function_call_output";
  call_id?: string;
  output?: string | { output?: string; metadata?: unknown };
}

interface ResponseItemLine extends CodexLine {
  type: "response_item";
  payload:
    | MessagePayload
    | ReasoningPayload
    | FunctionCallPayload
    | FunctionCallOutputPayload
    | { type: string; [k: string]: unknown };
}

interface EventMsgLine extends CodexLine {
  type: "event_msg";
  payload: {
    type: string;
    message?: string;
    [k: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from a content array (accepts any item with a text field). */
function extractText(content: ContentItem[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((item) => typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
}

/** Try to pretty-print JSON-encoded string; fall back to raw. */
function prettyArguments(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return raw;
  }
}

/** Derive the output string from a function_call_output payload. */
function extractOutputString(
  output: string | { output?: string; metadata?: unknown } | undefined
): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  return output.output ?? JSON.stringify(output, null, 2);
}

// ---------------------------------------------------------------------------
// match + outputPathFor
// ---------------------------------------------------------------------------

const MATCH_RE = /\.codex\/(sessions|archived_sessions)\/.*\.jsonl$/;

function matchCodex(absPath: string): boolean {
  return MATCH_RE.test(absPath);
}

/**
 * Maps source paths to output-relative paths.
 *
 * ~/.codex/sessions/2026/05/02/rollout-…-<id>.jsonl
 *   → codex/sessions/2026/05/02/rollout-…-<id>.md
 *
 * ~/.codex/archived_sessions/rollout-….jsonl
 *   → codex/archived_sessions/rollout-….md
 */
function outputPathFor(absPath: string, root: string): string {
  const expandedRoot = root.replace(/^~/, process.env["HOME"] ?? "");
  const rel = absPath.startsWith(expandedRoot + "/")
    ? absPath.slice(expandedRoot.length + 1)
    : path.relative(expandedRoot, absPath);

  // rel is like "sessions/2026/05/02/rollout-…" or "rollout-…"
  // Prepend "codex/" and swap extension
  const withMd = rel.replace(/\.jsonl$/, ".md");

  // Determine bucket from root path
  const rootBase = path.basename(expandedRoot); // "sessions" or "archived_sessions"
  return `codex/${rootBase}/${withMd}`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render(
  handle: SessionHandle,
  ctx: RenderContext
): Promise<RenderResult> {
  const payload = handle.payload as { filePath: string };
  const filePath = payload.filePath;

  // Stat the source file
  const stat = await fs.stat(filePath);

  // Accumulated state
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let version: string | undefined;
  let originator: string | undefined;
  let instructions: string | undefined;
  let gitCommit: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  let startedAt: string | undefined;
  let endedAt: string | undefined;

  const callIdToName = new Map<string, string>();

  let messageCount = 0;
  let toolCallCount = 0;

  const bodyParts: string[] = [];

  // First pass: collect all lines
  const lines: CodexLine[] = [];
  for await (const { parsed } of readJsonl(filePath)) {
    if (!parsed || typeof parsed !== "object") continue;
    const rec = parsed as CodexLine;
    if (typeof rec.type !== "string") continue;
    lines.push(rec);
  }

  for (const rec of lines) {
    const ts = rec.timestamp;

    switch (rec.type) {
      case "session_meta": {
        const p = rec.payload as SessionMetaPayload;
        if (!startedAt && ts) startedAt = ts;
        if (p.id) sessionId = p.id;
        if (p.cwd) cwd = p.cwd;
        if (p.cli_version) version = p.cli_version;
        if (p.originator) originator = p.originator;
        if (p.instructions) {
          instructions = p.instructions.slice(0, 500);
        }
        if (p.git?.commit_hash) gitCommit = p.git.commit_hash;
        if (p.git?.branch) gitBranch = p.git.branch;
        break;
      }

      case "turn_context": {
        const p = rec.payload as TurnContextPayload;
        if (p.model) model = p.model;
        if (p.effort) effort = p.effort;
        break;
      }

      case "response_item": {
        const p = (rec as ResponseItemLine).payload as {
          type: string;
          [k: string]: unknown;
        };

        switch (p.type) {
          case "message": {
            const mp = p as unknown as MessagePayload;
            const text = extractText(mp.content as ContentItem[] | string);
            const role = mp.role === "user" ? "User" : "Assistant";
            bodyParts.push(roleHeading(role, ts));
            if (text) bodyParts.push(text + "\n\n");
            messageCount++;
            if (ts) endedAt = ts;
            break;
          }

          case "reasoning": {
            const rp = p as unknown as ReasoningPayload;
            // Drop encrypted_content — never include
            const summarySource = rp.summary ?? rp.content;
            const summaryText = extractText(
              summarySource as ContentItem[] | string | undefined
            );
            if (summaryText) {
              bodyParts.push(detailsBlock("thinking", summaryText));
            }
            if (ts) endedAt = ts;
            break;
          }

          case "function_call": {
            const fp = p as unknown as FunctionCallPayload;
            const name = fp.name ?? "unknown";
            const callId = fp.call_id;
            if (callId) callIdToName.set(callId, name);

            const args = fp.arguments ?? "";
            const pretty = prettyArguments(args);
            bodyParts.push(toolCallBlock({ name, input: pretty, ts }));
            toolCallCount++;
            if (ts) endedAt = ts;
            break;
          }

          case "function_call_output": {
            const op = p as unknown as FunctionCallOutputPayload;
            const callId = op.call_id;
            const toolName = callId ? (callIdToName.get(callId) ?? "unknown") : "unknown";

            const rawOutput = extractOutputString(op.output);
            const maxBytes = ctx.truncate.toolOutput;
            const truncatedOutput = truncate(rawOutput, maxBytes);
            const wasTruncated = truncatedOutput !== rawOutput;

            bodyParts.push(
              `### Tool output · ${toolName}\n\n` +
              toolOutputBlock({
                output: truncatedOutput,
                truncatedTo: wasTruncated ? maxBytes : false,
              })
            );
            if (ts) endedAt = ts;
            break;
          }

          default: {
            // Unknown response_item type — surface as fenced JSON for drift visibility
            bodyParts.push(sectionForUnknown(`Unknown response_item: ${p.type}`, p));
            if (ts) endedAt = ts;
            break;
          }
        }
        break;
      }

      case "event_msg": {
        const em = rec as EventMsgLine;
        const subType = em.payload?.type;

        switch (subType) {
          case "user_message": {
            const text = em.payload.message ?? "";
            bodyParts.push(roleHeading("User", ts));
            if (text) bodyParts.push(String(text) + "\n\n");
            messageCount++;
            if (ts) endedAt = ts;
            break;
          }
          case "token_count":
          case "agent_reasoning":
            // silently skip
            break;
          default:
            // silently skip all other event_msg subtypes
            break;
        }
        break;
      }

      default:
        // silently skip unknown top-level types
        break;
    }
  }

  // Title heuristic: first user message text ≤ 80 chars, else cwd basename, else sessionId
  let title: string | undefined;
  // Scan body for first user role heading and grab the text after it
  for (const part of bodyParts) {
    if (part.startsWith("## User")) {
      // Next part should be the text
      const idx = bodyParts.indexOf(part);
      const next = bodyParts[idx + 1];
      if (next && next.trim()) {
        const firstLine = next.trim().split("\n")[0]?.trim() ?? "";
        title = firstLine.slice(0, 80) || undefined;
        break;
      }
    }
  }
  if (!title && cwd) title = path.basename(cwd);
  if (!title && sessionId) title = sessionId;

  // Frontmatter — build conditionally to satisfy exactOptionalPropertyTypes
  const fm: Frontmatter = { source: "codex" };
  if (sessionId !== undefined) fm["sessionId"] = sessionId;
  if (title !== undefined) fm["title"] = title;
  if (startedAt !== undefined) fm["startedAt"] = startedAt;
  if (endedAt !== undefined) fm["endedAt"] = endedAt;
  if (cwd !== undefined) fm["cwd"] = cwd;
  if (model !== undefined) fm["model"] = model;
  if (gitBranch !== undefined) fm["gitBranch"] = gitBranch;
  if (version !== undefined) fm["version"] = version;
  fm["messageCount"] = messageCount;
  fm["toolCallCount"] = toolCallCount;

  if (originator !== undefined || instructions !== undefined || gitCommit !== undefined || effort !== undefined) {
    const x: Record<string, string> = {};
    if (originator !== undefined) x["originator"] = originator;
    if (instructions !== undefined) x["instructions"] = instructions;
    if (gitCommit !== undefined) x["gitCommit"] = gitCommit;
    if (effort !== undefined) x["effort"] = effort;
    fm["x_codex"] = x;
  }

  const titleHeading = title ? heading(1, title) : "";
  const markdown = titleHeading + bodyParts.join("");

  return {
    markdown,
    frontmatter: fm,
    sourceMtimeMs: stat.mtimeMs,
    sourceSizeBytes: stat.size,
  };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const _defaultRoots = jsonlEnumerate({
  roots: [],
  match: matchCodex,
  outputPathFor,
});

export const codexSource: AgentSource = {
  name: "codex",
  displayName: "OpenAI Codex CLI",

  defaultRoots(home: string): string[] {
    return [`${home}/.codex/sessions`, `${home}/.codex/archived_sessions`];
  },

  enumerate(ctx: EnumerateContext) {
    const roots =
      ctx.roots.length > 0
        ? ctx.roots
        : this.defaultRoots(process.env["HOME"] ?? "~");

    return _defaultRoots({ ...ctx, roots });
  },

  render,
};
