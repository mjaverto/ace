// src/sources/pi.ts — Block Pi / Goose JSONL renderer

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
// Type helpers for Pi JSONL schema (flat-event style)
// ---------------------------------------------------------------------------

interface PiSessionEvent {
  type: "session";
  id: string;
  cwd?: string;
  version?: string;
  timestamp?: string;
}

interface PiModelChangeEvent {
  type: "model_change";
  provider?: string;
  modelId?: string;
  model?: string;
  timestamp?: string;
}

interface PiThinkingLevelChangeEvent {
  type: "thinking_level_change";
  thinkingLevel?: string | number;
  timestamp?: string;
}

interface PiTextBlock {
  type: "text";
  text: string;
}

interface PiThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
}

interface PiToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface PiToolResultItem {
  type: "toolResult";
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

type PiContentBlock = PiTextBlock | PiThinkingBlock | PiToolCallBlock | Record<string, unknown>;

interface PiMessageEvent {
  type: "message";
  timestamp?: string;
  message: {
    role: "user" | "assistant" | "toolResult";
    content: PiContentBlock[] | PiToolResultItem[];
  };
}

type PiEvent =
  | PiSessionEvent
  | PiModelChangeEvent
  | PiThinkingLevelChangeEvent
  | PiMessageEvent
  | Record<string, unknown>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MATCH_RE = /\.pi\/agent\/sessions\/[^/]+\/[^/]+\.jsonl$/;

function outputPathFor(absPath: string, _root: string): string {
  const workspaceSlug = path.basename(path.dirname(absPath));
  const filename = path.basename(absPath, ".jsonl") + ".md";
  return `pi/${workspaceSlug}/${filename}`;
}

function extractFirstUserText(content: PiContentBlock[]): string {
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "text") {
      return ((b["text"] as string | undefined) ?? "").trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Render content blocks for user/assistant messages
// ---------------------------------------------------------------------------

function renderPiBlock(
  block: PiContentBlock,
  _truncateToolOutput: number | false,
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

function renderPiContent(
  content: PiContentBlock[],
  truncateToolOutput: number | false,
  toolCallCountRef: { count: number },
  truncateToolInput: number | false = false
): string {
  let out = "";
  for (const block of content) {
    out += renderPiBlock(block, truncateToolOutput, toolCallCountRef, truncateToolInput);
  }
  return out;
}

// ---------------------------------------------------------------------------
// piSource
// ---------------------------------------------------------------------------

export const piSource: AgentSource = {
  name: "pi",
  displayName: "Block Pi",

  defaultRoots(home: string): string[] {
    return [`${home}/.pi/agent/sessions`];
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

      const event = line.parsed as PiEvent;
      const evType = (event as Record<string, unknown>)["type"] as string | undefined;

      if (evType === "session") {
        const ev = event as PiSessionEvent;
        sessionId = ev.id;
        if (ev.cwd !== undefined) cwd = ev.cwd;
        if (ev.version !== undefined) version = ev.version;
        if (ev.timestamp !== undefined && startedAt === undefined) {
          startedAt = ev.timestamp;
        }
        continue;
      }

      if (evType === "model_change") {
        const ev = event as PiModelChangeEvent;
        // modelId takes priority; fallback to model field
        const mid = ev.modelId ?? ev.model;
        if (mid !== undefined) model = mid;
        if (ev.provider !== undefined) provider = ev.provider;
        continue;
      }

      if (evType === "thinking_level_change") {
        const ev = event as PiThinkingLevelChangeEvent;
        if (ev.thinkingLevel !== undefined) thinkingLevel = ev.thinkingLevel;
        continue;
      }

      if (evType === "message") {
        const ev = event as PiMessageEvent;
        const role = ev.message?.role;
        const ts = ev.timestamp;

        if (ts !== undefined) endedAt = ts;

        if (role === "user" || role === "assistant") {
          const content = (ev.message.content ?? []) as PiContentBlock[];
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
          bodyParts.push(renderPiContent(content, ctx.truncate.toolOutput, toolCallCountRef, ctx.truncate.toolInput));
          continue;
        }

        if (role === "toolResult") {
          const items = (ev.message.content ?? []) as PiToolResultItem[];
          for (const item of items) {
            const isError = item.isError === true;
            const toolName = item.toolName ?? "unknown";
            const headingText = isError
              ? `### [ERROR] Tool result · ${toolName}${ts ? ` · ${ts}` : ""}`
              : `### Tool result · ${toolName}${ts ? ` · ${ts}` : ""}`;

            bodyParts.push(`${headingText}\n\n`);

            const rawContent = item.content ?? "";
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
          }
          continue;
        }

        // Unknown role — surface as fenced JSON for drift visibility
        bodyParts.push(sectionForUnknown(`unknown pi message role: ${role}`, ev.message));
        continue;
      }

      // All other top-level event types: silently skip
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
      source: "pi",
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

    // x_pi extras
    const xPi: Record<string, unknown> = {};
    if (provider !== undefined) xPi["provider"] = provider;
    if (thinkingLevel !== undefined) xPi["thinkingLevel"] = thinkingLevel;
    if (Object.keys(xPi).length > 0) {
      fm.x_pi = xPi;
    }

    return {
      markdown,
      frontmatter: fm,
      sourceMtimeMs: stat.mtimeMs,
      sourceSizeBytes: stat.size,
    };
  },
};

export default piSource;
