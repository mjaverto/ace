// src/schedule/launchd.ts — macOS launchd plist generator + installer

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolveAceBin } from "./index.js";
import { resolveLogPath } from "./logs.js";

export interface LaunchdOptions {
  label: string;
  /** Daily schedule: HH:MM */
  at?: string;
  /** Repeating interval, e.g. "1h", "15m", "30s" */
  every?: string;
  /** Hourly at :N */
  cronMinute?: number;
  logPath?: string;
  runNow?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Duration parser — "1h" | "15m" | "30s" → seconds
// ---------------------------------------------------------------------------

function parseDurationSeconds(s: string): number {
  const m = /^(\d+)(h|m|s)$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration "${s}". Use e.g. "1h", "15m", "30s".`);
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case "h": return n * 3600;
    case "m": return n * 60;
    case "s": return n;
    default: throw new Error(`Unexpected unit: ${m[2]}`);
  }
}

// ---------------------------------------------------------------------------
// Plist generation
// ---------------------------------------------------------------------------

function buildScheduleXml(opts: LaunchdOptions): string {
  if (opts.cronMinute !== undefined) {
    return `\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Minute</key>\n\t\t<integer>${opts.cronMinute}</integer>\n\t</dict>`;
  }
  if (opts.at) {
    const [hh, mm] = opts.at.split(":").map(Number);
    if (hh === undefined || mm === undefined || isNaN(hh) || isNaN(mm)) {
      throw new Error(`Invalid --at time "${opts.at}". Use HH:MM format.`);
    }
    return `\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Hour</key>\n\t\t<integer>${hh}</integer>\n\t\t<key>Minute</key>\n\t\t<integer>${mm}</integer>\n\t</dict>`;
  }
  if (opts.every) {
    const secs = parseDurationSeconds(opts.every);
    return `\t<key>StartInterval</key>\n\t<integer>${secs}</integer>`;
  }
  throw new Error("Must specify one of: --at, --every, --cron-minute");
}

export function buildPlist(opts: LaunchdOptions, aceBinTokens: string[]): string {
  const logPath = resolveLogPath(opts.logPath);
  const schedule = buildScheduleXml(opts);
  const programArgs = [...aceBinTokens, "render"]
    .map((t) => `\t\t<string>${t}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${opts.label}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArgs}
\t</array>
${schedule}
\t<key>StandardOutPath</key>
\t<string>${logPath}</string>
\t<key>StandardErrorPath</key>
\t<string>${logPath}</string>
\t<key>RunAtLoad</key>
\t<false/>
</dict>
</plist>
`;
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

function plistPath(label: string): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${label}.plist`);
}

function uid(): number {
  return typeof process.getuid === "function" ? process.getuid() : 501;
}

export async function installLaunchd(opts: LaunchdOptions): Promise<void> {
  const aceBinTokens = resolveAceBin();
  const plist = buildPlist(opts, aceBinTokens);
  const dest = plistPath(opts.label);
  const svc = `gui/${uid()}/${opts.label}`;

  const commands = [
    ["launchctl", "bootout", `gui/${uid()}`, dest],
    ["launchctl", "bootstrap", `gui/${uid()}`, dest],
    ["launchctl", "enable", svc],
    ...(opts.runNow ? [["launchctl", "kickstart", "-k", svc]] : []),
  ] as [string, ...string[]][];

  if (opts.dryRun) {
    console.log("# Plist content:");
    console.log(plist);
    console.log(`# Would write plist to: ${dest}`);
    console.log("# Commands that would be run:");
    for (const [bin, ...args] of commands) {
      console.log(`  ${bin} ${args.join(" ")}`);
    }
    return;
  }

  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, plist, "utf8");

  for (const [bin, ...args] of commands) {
    try {
      execFileSync(bin, args, { stdio: "inherit" });
    } catch {
      // bootout may fail if not loaded; only tolerate that step
      if (args[0] !== "bootout") {
        throw new Error(`launchctl ${args.join(" ")} failed`);
      }
    }
  }
}

export async function uninstallLaunchd(label: string): Promise<void> {
  const dest = plistPath(label);
  const u = uid();

  try {
    execFileSync("launchctl", ["bootout", `gui/${u}`, dest], { stdio: "pipe" });
  } catch {
    // not loaded — idempotent
  }

  try {
    await fs.unlink(dest);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.log(`ace uninstall: ${dest} already absent`);
      return;
    }
    throw err;
  }
  console.log(`ace uninstall: removed ${dest}`);
}
