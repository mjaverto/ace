// src/schedule/index.ts — platform dispatch + shared helpers

import path from "node:path";

// ---------------------------------------------------------------------------
// resolveAceBin — returns the absolute path to the `ace` binary.
//
// Resolution order:
//  1. If ACE_BIN env var is set, use it (useful in tests).
//  2. If process.argv[1] looks like a dist/cli.js path, infer the installed
//     `ace` bin from the same directory as node (the .bin symlink).
//  3. Fall back to "node <argv1>" so it still runs from dev.
// ---------------------------------------------------------------------------

export function resolveAceBin(): string {
  if (process.env["ACE_BIN"]) {
    return process.env["ACE_BIN"];
  }

  // In production (after `npm install -g` or `npx`), process.argv[1] is the
  // cli entrypoint. Check whether there's an `ace` symlink alongside node.
  const argv1 = process.argv[1] ?? "";
  const nodeDir = path.dirname(process.execPath);
  const aceBinPath = path.join(nodeDir, "ace");

  // If argv1 lives in a dist directory, the installed bin should exist nearby.
  if (argv1.includes("dist/cli") || argv1.includes("dist\\cli")) {
    return aceBinPath;
  }

  // Dev fallback: run via node directly
  return `${process.execPath} ${argv1}`;
}

// ---------------------------------------------------------------------------
// Re-export platform helpers
// ---------------------------------------------------------------------------

export { installLaunchd, uninstallLaunchd, buildPlist } from "./launchd.js";
export type { LaunchdOptions } from "./launchd.js";

export { installSystemd, uninstallSystemd, buildServiceUnit, buildTimerUnit } from "./systemd.js";
export type { SystemdOptions } from "./systemd.js";

export { installCron, uninstallCron, buildCronLine } from "./cron.js";
export type { CronOptions } from "./cron.js";

export { resolveLogPath, tailLog } from "./logs.js";
