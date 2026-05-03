// src/markdown.ts — markdown rendering helpers

// ---------------------------------------------------------------------------
// heading
// ---------------------------------------------------------------------------

/**
 * Returns a markdown heading at the given level followed by a blank line.
 * e.g. heading(2, "Foo") → "## Foo\n\n"
 */
export function heading(level: number, text: string): string {
  return `${"#".repeat(level)} ${text}\n\n`;
}

// ---------------------------------------------------------------------------
// roleHeading
// ---------------------------------------------------------------------------

/**
 * Returns a role heading like "## User · 2026-05-02T14:11:08Z\n\n".
 * `ts` may be a Date, epoch ms number, or ISO string. If falsy, omit timestamp.
 */
export function roleHeading(role: string, ts?: Date | number | string): string {
  if (ts !== undefined && ts !== null && ts !== "") {
    const iso =
      ts instanceof Date
        ? ts.toISOString()
        : typeof ts === "number"
          ? new Date(ts).toISOString()
          : ts;
    return `## ${role} · ${iso}\n\n`;
  }
  return `## ${role}\n\n`;
}

// ---------------------------------------------------------------------------
// fence
// ---------------------------------------------------------------------------

/**
 * Returns a fenced code block.
 * The body is trimmed of trailing whitespace.
 */
export function fence(lang: string, body: string): string {
  const trimmed = body.replace(/\s+$/, "");
  return `\`\`\`${lang}\n${trimmed}\n\`\`\`\n\n`;
}

// ---------------------------------------------------------------------------
// detailsBlock
// ---------------------------------------------------------------------------

/**
 * Returns an HTML <details> block.
 */
export function detailsBlock(summary: string, body: string): string {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>\n\n`;
}

// ---------------------------------------------------------------------------
// truncate
// ---------------------------------------------------------------------------

/**
 * Truncate a string to at most `max` bytes (UTF-8).
 *
 * - Cuts on a UTF-8 codepoint boundary by using Buffer subarray.
 * - Strips any trailing UTF-8 replacement character (U+FFFD) that may appear
 *   when a multibyte sequence is severed.
 * - Appends `\n\n… [truncated N bytes]` when truncation occurs.
 * - If `max === false`, returns `s` unchanged.
 */
export function truncate(s: string, max: number | false, _label?: string): string {
  if (max === false) return s;
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= max) return s;

  const original = buf.length;
  let cut = Buffer.from(buf.subarray(0, max)).toString("utf8");
  // Remove trailing replacement char that signals a severed multibyte sequence
  cut = cut.replace(/�$/, "");
  const truncatedBytes = original - Buffer.from(cut, "utf8").length;
  return `${cut}\n\n… [truncated ${truncatedBytes} bytes]`;
}

// ---------------------------------------------------------------------------
// toolCallBlock
// ---------------------------------------------------------------------------

export interface ToolCallBlockOpts {
  name: string;
  input: string;
  ts?: Date | number | string;
}

/**
 * Render a tool-call section: a level-3 heading then a fenced block.
 */
export function toolCallBlock(opts: ToolCallBlockOpts): string {
  const tsStr =
    opts.ts !== undefined && opts.ts !== null && opts.ts !== ""
      ? ` · ${
          opts.ts instanceof Date
            ? opts.ts.toISOString()
            : typeof opts.ts === "number"
              ? new Date(opts.ts).toISOString()
              : opts.ts
        }`
      : "";
  const h = `### Tool call · ${opts.name}${tsStr}\n\n`;
  return h + fence("", opts.input);
}

// ---------------------------------------------------------------------------
// toolOutputBlock
// ---------------------------------------------------------------------------

export interface ToolOutputBlockOpts {
  output: string;
  byteCount?: number;
  truncatedTo?: number | false;
}

/**
 * Render a tool-output section: a level-4 heading then a fenced block.
 * Heading notes truncation when `truncatedTo` is set and is a number.
 */
export function toolOutputBlock(opts: ToolOutputBlockOpts): string {
  const wasTruncated = typeof opts.truncatedTo === "number";
  const headerLabel = wasTruncated
    ? `#### Output (truncated, ${opts.truncatedTo as number} bytes)\n\n`
    : "#### Output\n\n";
  return headerLabel + fence("", opts.output);
}

// ---------------------------------------------------------------------------
// sectionForUnknown — drift surfacing
// ---------------------------------------------------------------------------

/**
 * Render an unknown value as a fenced JSON block.
 * Used to surface schema drift visibly in the rendered Markdown.
 */
export function sectionForUnknown(label: string, value: unknown): string {
  const json = JSON.stringify(value, null, 2);
  return `### ${label}\n\n` + fence("json", json);
}
