// src/schedule/logs.ts — log path resolution and tail helper

import os from "node:os";
import path from "node:path";
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

/** Stream log to stdout; resolves immediately (tail -f runs until Ctrl-C). */
export function tailLog(logPath: string): void {
  const child = spawn("tail", ["-f", logPath], { stdio: "inherit" });
  child.on("error", (err) => {
    process.stderr.write(`ace logs: ${err.message}\n`);
    process.exit(1);
  });
}
