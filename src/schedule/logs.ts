// src/schedule/logs.ts — log path resolution, log-dir creation, tail + activity probe

import os from "node:os";
import path from "node:path";
import fsSync, { type Stats } from "node:fs";
import { spawn } from "node:child_process";

/** Returns the per-platform default log path for ace. */
export function resolveLogPath(logOverride?: string): string {
  if (logOverride) return logOverride;

  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Logs", "ace.log");
  }

  // Linux — XDG_STATE_HOME / ~/.local/state/ace/ace.log
  const xdgState =
    process.env["XDG_STATE_HOME"] ??
    path.join(os.homedir(), ".local", "state");
  return path.join(xdgState, "ace", "ace.log");
}

/**
 * Create the directory holding `logPath`.
 *
 * Required before a scheduled install: systemd `StandardOutput=append:<file>`
 * fails the unit outright when the parent directory is missing (the default
 * Linux log path lives under ~/.local/state/ace/, which usually does not exist
 * yet), and cron's `>>` redirect fails the same way.
 */
export function ensureLogDir(logPath: string): void {
  fsSync.mkdirSync(path.dirname(logPath), { recursive: true });
}

/** Stream log to stdout; resolves immediately (tail -f runs until Ctrl-C). */
export function tailLog(logPath: string): void {
  const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
  child.on("error", (err) => {
    process.stderr.write(`ace logs: ${err.message}\n`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// Log activity probe — powers `ace status`'s "when did it last run"
// ---------------------------------------------------------------------------

export interface LogActivity {
  path: string;
  exists: boolean;
  /** mtime of the log file — i.e. when ace last wrote anything. */
  lastWriteMs?: number;
  sizeBytes?: number;
  /** Last non-empty line, useful because `ace render` ends with a summary line. */
  lastLine?: string;
}

const TAIL_BYTES = 8192;

/** Best-effort, never throws. */
export function logActivity(logPath: string): LogActivity {
  let stat: Stats;
  try {
    stat = fsSync.statSync(logPath);
  } catch {
    return { path: logPath, exists: false };
  }

  const activity: LogActivity = {
    path: logPath,
    exists: true,
    lastWriteMs: stat.mtimeMs,
    sizeBytes: stat.size,
  };

  const lastLine = readLastLine(logPath, stat.size);
  if (lastLine !== undefined) activity.lastLine = lastLine;
  return activity;
}

function readLastLine(logPath: string, size: number): string | undefined {
  if (size === 0) return undefined;
  let fd: number | undefined;
  try {
    fd = fsSync.openSync(logPath, "r");
    const length = Math.min(TAIL_BYTES, size);
    const buf = Buffer.allocUnsafe(length);
    fsSync.readSync(fd, buf, 0, length, size - length);
    const lines = buf
      .toString("utf8")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "");
    return lines.at(-1);
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fsSync.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}
