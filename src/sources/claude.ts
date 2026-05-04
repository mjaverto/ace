// src/sources/claude.ts — Claude Code JSONL renderer

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
// Type helpers for Claude JSONL schema
// ---------------------------------------------------------------------------

interface TextBlock {
  type: "text";
  text: string;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultContent {
  type: "text";
  text: string;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | ToolResultContent[];
}

type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | Record<string, unknown>;

interface ClaudeMessage {
  role?: string;
  model?: string;
  content: string | ContentBlock[];
}

interface ClaudeJsonlLine {
  type?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
  timestamp?: string;
  teamName?: string;
  agentName?: string;
  message?: ClaudeMessage;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MATCH_RE = /\.claude\/projects\/[^/]+\/[0-9a-f-]+\.jsonl$/;

function outputPathFor(absPath: string, _root: string): string {
  // <parent-dir-basename>/<uuid>.md
  const uuidFile = path.basename(absPath, ".jsonl") + ".md";
  const projectSlug = path.basename(path.dirname(absPath));
  return `${projectSlug}/${uuidFile}`;
}

function extractText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content.trim();
  for (const block of content) {
    if ((block as TextBlock).type === "text") {
      return ((block as TextBlock).text ?? "").trim();
    }
  }
  return "";
}

function toolResultText(content: string | ToolResultContent[]): string {
  if (typeof content === "string") return content;
  return content.map((c) => c.text).join("\n");
}

// ---------------------------------------------------------------------------
// Render blocks
// ---------------------------------------------------------------------------

function renderBlock(block: ContentBlock, truncateToolOutput: number | false): string {
  const b = block as Record<string, unknown>;
  const bType = b["type"] as string | undefined;

  if (bType === "text") {
    const text = (b["text"] as string | undefined) ?? "";
    return text + "\n\n";
  }

  if (bType === "thinking") {
    const thinking = (b["thinking"] as string | undefined) ?? "";
    return detailsBlock("thinking", thinking);
  }

  if (bType === "tool_use") {
    const name = (b["name"] as string | undefined) ?? "unknown";
    const input = (b["input"] as unknown) ?? {};
    const inputStr = JSON.stringify(input, null, 2);
    return toolCallBlock({ name, input: inputStr });
  }

  if (bType === "tool_result") {
    const rawContent = (b["content"] as string | ToolResultContent[] | undefined) ?? "";
    const outputRaw = toolResultText(rawContent as string | ToolResultContent[]);
    const truncated = truncate(outputRaw, truncateToolOutput);
    const wasTruncated =
      typeof truncateToolOutput === "number" &&
      Buffer.from(outputRaw, "utf8").length > truncateToolOutput;
    return toolOutputBlock({
      output: truncated,
      ...(wasTruncated && typeof truncateToolOutput === "number"
        ? { truncatedTo: truncateToolOutput }
        : {}),
    });
  }

  // Unknown block type — surface as fenced JSON for drift visibility
  const label = typeof bType === "string" ? `unknown block: ${bType}` : "unknown block";
  return sectionForUnknown(label, block);
}

function renderContent(
  content: string | ContentBlock[],
  truncateToolOutput: number | false,
  toolCallCountRef: { count: number }
): string {
  if (typeof content === "string") {
    return content + "\n\n";
  }

  let out = "";
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b["type"] === "tool_use") {
      toolCallCountRef.count++;
    }
    out += renderBlock(block, truncateToolOutput);
  }
  return out;
}

// ---------------------------------------------------------------------------
// claudeSource
// ---------------------------------------------------------------------------

export const claudeSource: AgentSource = {
  name: "claude",
  displayName: "Claude Code",

  defaultRoots(home: string): string[] {
    return [`${home}/.claude/projects`];
  },

  enumerate: jsonlEnumerate({
    roots: [],
    match: (absPath: string) => MATCH_RE.test(absPath),
    outputPathFor,
  }),

  async render(handle: SessionHandle, ctx: RenderContext): Promise<RenderResult> {
    const payload = handle.payload as { filePath: string };
    const filePath = payload.filePath;

    // Stat for metadata
    const stat = await fs.stat(filePath);

    // Frontmatter fields captured from first message
    let sessionId: string | undefined;
    let cwd: string | undefined;
    let gitBranch: string | undefined;
    let version: string | undefined;
    let startedAt: string | undefined;
    let endedAt: string | undefined;
    let teamName: string | undefined;
    let agentName: string | undefined;
    let model: string | undefined;

    // Title heuristic state
    let title: string | undefined;

    // Counters
    let messageCount = 0;
    const toolCallCountRef = { count: 0 };

    // Body parts
    const bodyParts: string[] = [];

    for await (const line of readJsonl(filePath)) {
      // Skip malformed lines
      if (line.parsed === undefined) continue;

      const row = line.parsed as ClaudeJsonlLine;

      // Skip non-user/assistant lines silently
      const lineType = row.type;
      if (lineType !== "user" && lineType !== "assistant") continue;

      // Capture metadata from first renderable line
      if (messageCount === 0) {
        sessionId = row.sessionId;
        cwd = row.cwd;
        gitBranch = row.gitBranch;
        version = row.version;
        startedAt = row.timestamp;
        teamName = row.teamName;
        agentName = row.agentName;
      }

      // Track model from assistant lines
      if (lineType === "assistant" && row.message?.model) {
        model = row.message.model;
      }

      // Track endedAt as last timestamp
      if (row.timestamp) {
        endedAt = row.timestamp;
      }

      // Title heuristic: first user message text
      if (title === undefined && lineType === "user" && row.message?.content !== undefined) {
        const text = extractText(row.message.content);
        if (text) {
          title = text.slice(0, 80);
        }
      }

      messageCount++;

      // Emit role heading
      const role = lineType === "user" ? "User" : "Assistant";
      bodyParts.push(roleHeading(role, row.timestamp));

      // Render message content
      if (row.message?.content !== undefined) {
        bodyParts.push(
          renderContent(row.message.content, ctx.truncate.toolOutput, toolCallCountRef)
        );
      }
    }

    // If no title yet, fall back to cwd basename then sessionId
    if (!title) {
      if (cwd) {
        title = path.basename(cwd);
      } else if (sessionId) {
        title = sessionId;
      }
    }

    // Build markdown body (title heading + messages)
    const titleHeading = title ? `# ${title}\n\n` : "";
    const markdown = titleHeading + bodyParts.join("");

    // Build frontmatter
    const fm: Frontmatter = {
      source: "claude",
    };

    if (sessionId !== undefined) fm.sessionId = sessionId;
    if (title !== undefined) fm.title = title;
    if (startedAt !== undefined) fm.startedAt = startedAt;
    if (endedAt !== undefined) fm.endedAt = endedAt;
    if (cwd !== undefined) fm.cwd = cwd;
    if (model !== undefined) fm.model = model;
    if (gitBranch !== undefined) fm.gitBranch = gitBranch;
    if (version !== undefined) fm.version = version;
    fm.messageCount = messageCount;
    fm.toolCallCount = toolCallCountRef.count;
    fm.aceSchema = 1;
    fm.aceRenderedAt = ctx.now.toISOString();
    fm.sourcePath = filePath;
    fm.sourceMtime = new Date(stat.mtimeMs).toISOString();

    // x_claude extras (only include defined values)
    const xClaude: Record<string, string> = {};
    if (teamName !== undefined) xClaude["teamName"] = teamName;
    if (agentName !== undefined) xClaude["agentName"] = agentName;
    if (Object.keys(xClaude).length > 0) {
      fm.x_claude = xClaude;
    }

    return {
      markdown,
      frontmatter: fm,
      sourceMtimeMs: stat.mtimeMs,
      sourceSizeBytes: stat.size,
    };
  },
};

export default claudeSource;
