// src/sources/omp.ts — oh-my-pi (omp) JSONL renderer
//
// omp is the successor to pi-mono: same `~/.<tool>/agent/sessions/<workspace>/*.jsonl`
// layout and mostly the same flat-event schema (session/model_change/message), but it
// diverges in one structural way that matters for rendering: a `toolResult` message is
// a single flat object (`{ role: "toolResult", toolCallId, toolName, content, isError }`)
// rather than pi's `content: PiToolResultItem[]` batch, and `content` itself is an array
// of content blocks (usually one `text` block) instead of a plain string. omp also emits
// several event types pi never had (`title`, `title_change`, `custom_message`, `custom`,
// `credential_pin`, …) — these are silently skipped, same as any unrecognized pi event.

import fs from "node:fs/promises";
import path from "node:path";
import { readJsonl } from "../shared/util.js";
import { jsonlEnumerate } from "../shared/jsonl-enumerate.js";
import {
  roleHeading,
  detailsBlock,
  toolCallBlock,
  toolOutputBlock,
  sectionForUnknown,
  truncate,
} from "../markdown.js";
import type {
  AgentSource,
  SessionHandle,
  RenderContext,
  RenderResult,
  Frontmatter,
} from "../types.js";

// ---------------------------------------------------------------------------
// Type helpers for omp JSONL schema
// ---------------------------------------------------------------------------

interface OmpSessionEvent {
  type: "session";
  id: string;
  cwd?: string;
  version?: string | number;
  timestamp?: string;
}

interface OmpModelChangeEvent {
  type: "model_change";
  provider?: string;
  modelId?: string;
  model?: string;
  timestamp?: string;
}

interface OmpThinkingLevelChangeEvent {
  type: "thinking_level_change";
  thinkingLevel?: string | number;
  timestamp?: string;
}

interface OmpTextBlock {
  type: "text";
  text: string;
}

interface OmpThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

interface OmpToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

type OmpContentBlock = OmpTextBlock | OmpThinkingBlock | OmpToolCallBlock | Record<string, unknown>;

interface OmpUserAssistantMessage {
  role: "user" | "assistant";
  content: OmpContentBlock[];
}

// omp's toolResult message is flat — no wrapping array of items like pi.
interface OmpToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: OmpContentBlock[] | string;
  isError?: boolean;
}

interface OmpMessageEvent {
  type: "message";
  timestamp?: string;
  message: OmpUserAssistantMessage | OmpToolResultMessage | Record<string, unknown>;
}

type OmpEvent =
  | OmpSessionEvent
  | OmpModelChangeEvent
  | OmpThinkingLevelChangeEvent
  | OmpMessageEvent
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MATCH_RE = /\.omp\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/;

function outputPathFor(absPath: string, _root: string): string {
  const workspaceSlug = path.basename(path.dirname(absPath));
  const filename = path.basename(absPath, ".jsonl") + ".md";
  return `omp/${workspaceSlug}/${filename}`;
}

function extractFirstUserText(content: OmpContentBlock[]): string {
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text") {
      return ((b["text"] as string | undefined) ?? "").trim();
    }
  }
  return "";
}

/** Flatten a toolResult's content — string as-is, block array joins its `text` blocks. */
function flattenToolResultContent(content: OmpContentBlock[] | string): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text") {
      parts.push((b["text"] as string | undefined) ?? "");
    } else {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Render content blocks for user/assistant messages
// ---------------------------------------------------------------------------

function renderOmpBlock(
  block: OmpContentBlock,
  toolCallCountRef: { count: number },
  truncateToolInput: number | false = false
): string {
  const b = block as Record<string, unknown>;
  const bType = b["type"] as string | undefined;

  if (bType === "text") {
    const text = (b["text"] as string | undefined) ?? "";
    return text + "\n\n";
  }

  if (bType === "thinking") {
    const thinking = (b["thinking"] as string | undefined) ?? "";
    // Drop thinkingSignature per spec
    return detailsBlock("thinking", thinking);
  }

  if (bType === "toolCall") {
    toolCallCountRef.count++;
    const name = (b["name"] as string | undefined) ?? "unknown";
    // arguments is already an object — no JSON.parse needed
    const args = (b["arguments"] as unknown) ?? {};
    const inputStr = JSON.stringify(args, null, 2);
    const truncatedInputStr = truncate(inputStr, truncateToolInput);
    return toolCallBlock({ name, input: truncatedInputStr });
  }

  // Unknown block type — surface as fenced JSON for drift visibility
  const label = typeof bType === "string" ? `unknown block: ${bType}` : "unknown block";
  return sectionForUnknown(label, block);
}

function renderOmpContent(
  content: OmpContentBlock[],
  toolCallCountRef: { count: number },
  truncateToolInput: number | false = false
): string {
  let out = "";
  for (const block of content) {
    out += renderOmpBlock(block, toolCallCountRef, truncateToolInput);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ompSource
// ---------------------------------------------------------------------------

export const ompSource: AgentSource = {
  name: "omp",
  displayName: "omp (oh-my-pi)",

  defaultRoots(home: string): string[] {
    return [`${home}/.omp/agent/sessions`];
  },

  enumerate: jsonlEnumerate({
    roots: [],
    match: (absPath: string) => MATCH_RE.test(absPath),
    outputPathFor,
  }),

  async render(handle: SessionHandle, ctx: RenderContext): Promise<RenderResult> {
    const payload = handle.payload as { filePath: string };
    const filePath = payload.filePath;

    const stat = await fs.stat(filePath);

    // Frontmatter state
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let version: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let model: string | undefined;
    let provider: string | undefined;
    let thinkingLevel: string | number | undefined;

    // Title heuristic
    let title: string | undefined;

    // Counters
    let messageCount = 0;
    const toolCallCountRef = { count: 0 };

    // Body parts
    const bodyParts: string[] = [];

    for await (const line of readJsonl(filePath)) {
      if (line.parsed === undefined) continue;

      const event = line.parsed as OmpEvent;
      const evType = (event as Record<string, unknown>)["type"] as string | undefined;

      if (evType === "session") {
        const ev = event as OmpSessionEvent;
        sessionId = ev.id;
        if (ev.cwd !== undefined) cwd = ev.cwd;
        if (ev.version !== undefined) version = String(ev.version);
        if (ev.timestamp !== undefined && startedAt === undefined) {
          startedAt = ev.timestamp;
        }
        continue;
      }

      if (evType === "model_change") {
        const ev = event as OmpModelChangeEvent;
        // modelId takes priority; fallback to model field
        const mid = ev.modelId ?? ev.model;
        if (mid !== undefined) model = mid;
        if (ev.provider !== undefined) provider = ev.provider;
        continue;
      }

      if (evType === "thinking_level_change") {
        const ev = event as OmpThinkingLevelChangeEvent;
        if (ev.thinkingLevel !== undefined) thinkingLevel = ev.thinkingLevel;
        continue;
      }

      if (evType === "message") {
        const ev = event as OmpMessageEvent;
        const role = (ev.message as Record<string, unknown>)["role"] as string | undefined;
        const ts = ev.timestamp;

        if (ts !== undefined) endedAt = ts;

        if (role === "user" || role === "assistant") {
          const msg = ev.message as OmpUserAssistantMessage;
          const content = msg.content ?? [];
          messageCount++;

          // Title heuristic: first user text
          if (title === undefined && role === "user") {
            const text = extractFirstUserText(content);
            if (text) {
              title = text.slice(0, 80);
            }
          }

          // Set startedAt from first renderable message if not set by session event
          if (startedAt === undefined && ts !== undefined) {
            startedAt = ts;
          }

          const roleLabel = role === "user" ? "User" : "Assistant";
          bodyParts.push(roleHeading(roleLabel, ts));
          bodyParts.push(renderOmpContent(content, toolCallCountRef, ctx.truncate.toolInput));
          continue;
        }

        if (role === "toolResult") {
          // omp's toolResult message is flat, not a batch of items like pi.
          const msg = ev.message as OmpToolResultMessage;
          const isError = msg.isError === true;
          const toolName = msg.toolName ?? "unknown";
          const headingText = isError
            ? `### [ERROR] Tool result · ${toolName}${ts ? ` · ${ts}` : ""}`
            : `### Tool result · ${toolName}${ts ? ` · ${ts}` : ""}`;

          bodyParts.push(`${headingText}\n\n`);

          const rawContent = flattenToolResultContent(msg.content ?? "");
          const truncated = truncate(rawContent, ctx.truncate.toolOutput);
          const wasTruncated =
            typeof ctx.truncate.toolOutput === "number" &&
            Buffer.from(rawContent, "utf8").length > ctx.truncate.toolOutput;
          bodyParts.push(
            toolOutputBlock({
              output: truncated,
              truncatedTo: wasTruncated ? ctx.truncate.toolOutput : false,
            })
          );
          continue;
        }

        // Unknown role — surface as fenced JSON for drift visibility
        bodyParts.push(sectionForUnknown(`unknown omp message role: ${role}`, ev.message));
        continue;
      }

      // All other top-level event types (title, title_change, custom_message,
      // custom, credential_pin, …): silently skip.
    }

    // Title fallback
    if (!title) {
      if (cwd) {
        title = path.basename(cwd);
      } else if (sessionId) {
        title = sessionId;
      }
    }

    const titleHeading = title ? `# ${title}\n\n` : "";
    const markdown = titleHeading + bodyParts.join("");

    // Build frontmatter
    const fm: Frontmatter = {
      source: "omp",
    };

    if (sessionId !== undefined) fm.sessionId = sessionId;
    if (title !== undefined) fm.title = title;
    if (startedAt !== undefined) fm.startedAt = startedAt;
    if (endedAt !== undefined) fm.endedAt = endedAt;
    if (cwd !== undefined) fm.cwd = cwd;
    if (model !== undefined) fm.model = model;
    if (version !== undefined) fm.version = version;
    fm.messageCount = messageCount;
    fm.toolCallCount = toolCallCountRef.count;
    fm.aceSchema = 1;
    fm.aceRenderedAt = ctx.now.toISOString();
    fm.sourcePath = filePath;
    fm.sourceMtime = new Date(stat.mtimeMs).toISOString();

    // x_omp extras
    const xOmp: Record<string, unknown> = {};
    if (provider !== undefined) xOmp["provider"] = provider;
    if (thinkingLevel !== undefined) xOmp["thinkingLevel"] = thinkingLevel;
    if (Object.keys(xOmp).length > 0) {
      fm.x_omp = xOmp;
    }

    return {
      markdown,
      frontmatter: fm,
      sourceMtimeMs: stat.mtimeMs,
      sourceSizeBytes: stat.size,
    };
  },
};

export default ompSource;
