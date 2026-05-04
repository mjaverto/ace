// src/schedule/index.ts — platform dispatch + shared helpers

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// resolveAceBin — returns argv tokens for the `ace` binary as string[].
//
// Resolution order:
//  1. ACE_BIN env var — if set and points to an existing file, use it.
//  2. Candidate path.join(nodeDir, "ace") — if it exists on disk, use it.
//  3. `which ace` — if it resolves to an existing file, use it.
//  4. node <argv1> fallback — for npx / dev runs where no bin symlink exists.
//  5. Throw with actionable message if nothing works.
//
// Returns string[] (always >= 1 token) so callers can spread into
// ProgramArguments arrays or join for ExecStart strings.
// ---------------------------------------------------------------------------

export function resolveAceBin(): string[] {
  const argv1 = process.argv[1] ?? "";

  // 1. ACE_BIN env override
  const envBin = process.env["ACE_BIN"];
  if (envBin) {
    if (!fs.existsSync(envBin)) {
      throw new Error(
        `ACE_BIN is set to "${envBin}" but that file does not exist. ` +
          `Unset ACE_BIN or point it at the real ace binary.`
      );
    }
    return [envBin];
  }

  // 2. Candidate alongside node (standard npm install -g layout)
  const nodeDir = path.dirname(process.execPath);
  const candidate = path.join(nodeDir, "ace");
  if (fs.existsSync(candidate)) {
    return [candidate];
  }

  // 3. which ace
  try {
    const whichOut = execFileSync("which", ["ace"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    if (whichOut && fs.existsSync(whichOut)) {
      return [whichOut];
    }
  } catch {
    // which not available or ace not on PATH — fall through
  }

  // 4. node <argv1> — works for `npx ace` and dev runs
  if (argv1) {
    return [process.execPath, argv1];
  }

  // 5. Nothing worked
  throw new Error(
    `Could not locate the ace binary.\n` +
      `Options:\n` +
      `  • Install globally:          npm install -g @mjaverto/ace\n` +
      `  • Set the binary explicitly: ACE_BIN=/path/to/ace ace install ...\n` +
      `  • Pass a custom label:       ace install launchd --label dev.ace.render`
  );
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
