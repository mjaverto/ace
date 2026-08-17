// src/schedule/launchd.ts — macOS launchd plist generator + installer

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  buildRenderArgv,
  describeTrigger,
  resolveAceBin,
  resolveTrigger,
  formatLocal,
  schedulerPath,
  type ScheduleOptions,
  type ScheduleStatus,
  type ScheduleTrigger,
} from "./index.js";
import { ensureLogDir, logActivity, resolveLogPath } from "./logs.js";

export type LaunchdOptions = ScheduleOptions;

// ---------------------------------------------------------------------------
// Plist generation
// ---------------------------------------------------------------------------

function buildScheduleXml(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "hourly":
      return `\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Minute</key>\n\t\t<integer>${trigger.minute}</integer>\n\t</dict>`;
    case "daily":
      return `\t<key>StartCalendarInterval</key>\n\t<dict>\n\t\t<key>Hour</key>\n\t\t<integer>${trigger.hour}</integer>\n\t\t<key>Minute</key>\n\t\t<integer>${trigger.minute}</integer>\n\t</dict>`;
    case "interval":
      return `\t<key>StartInterval</key>\n\t<integer>${trigger.seconds}</integer>`;
  }
}

export function buildPlist(opts: LaunchdOptions, aceBinTokens: string[]): string {
  const logPath = resolveLogPath(opts.logPath);
  const schedule = buildScheduleXml(resolveTrigger(opts));
  const programArgs = buildRenderArgv(aceBinTokens, opts)
    .map((t) => `\t\t<string>${escapeXml(t)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${escapeXml(opts.label)}</string>
\t<key>ProgramArguments</key>
\t<array>
${programArgs}
\t</array>
${schedule}
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>${escapeXml(schedulerPath())}</string>
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${escapeXml(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${escapeXml(logPath)}</string>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>Nice</key>
\t<integer>10</integer>
\t<key>LowPriorityIO</key>
\t<true/>
</dict>
</plist>
`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
  const logPath = resolveLogPath(opts.logPath);
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
    console.log(`# Schedule: ${describeTrigger(resolveTrigger(opts))}`);
    console.log(`# Log: ${logPath}`);
    console.log("# Commands that would be run:");
    for (const [bin, ...args] of commands) {
      console.log(`  ${bin} ${args.join(" ")}`);
    }
    return;
  }

  ensureLogDir(logPath);
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

  console.log(
    `ace install launchd: ${opts.label} → ${describeTrigger(resolveTrigger(opts))}\n` +
      `  plist: ${dest}\n` +
      `  log:   ${logPath}\n` +
      `  check: ace status`
  );
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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function statusLaunchd(label: string, logPath: string): Promise<ScheduleStatus> {
  const dest = plistPath(label);
  const notes: string[] = [];
  const status: ScheduleStatus = {
    kind: "launchd",
    label,
    installed: false,
    artifacts: [],
    log: logActivity(logPath),
    notes,
  };

  let plist: string | undefined;
  try {
    plist = await fs.readFile(dest, "utf8");
    status.installed = true;
    status.artifacts.push(dest);
  } catch {
    notes.push(`No plist at ${dest}. Install with: ace install launchd`);
  }

  if (plist !== undefined) {
    const summary = summarisePlistSchedule(plist);
    if (summary !== undefined) status.schedule = summary;
    const argvBlock = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1];
    if (argvBlock !== undefined) {
      const argv = [...argvBlock.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] ?? "");
      if (argv.length > 0) status.command = argv.join(" ");
    }
  }

  // launchctl print is the only source of loaded/exit-code state.
  try {
    const out = execFileSync("launchctl", ["print", `gui/${uid()}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    const state = /^\s*state = (.+)$/m.exec(out)?.[1]?.trim();
    const lastExit = /^\s*last exit code = (\d+)$/m.exec(out)?.[1];
    const runs = /^\s*runs = (\d+)$/m.exec(out)?.[1];
    const bits = ["loaded"];
    if (state !== undefined) bits.push(`state=${state}`);
    if (runs !== undefined) bits.push(`runs=${runs}`);
    if (lastExit !== undefined) bits.push(`last exit code=${lastExit}`);
    status.state = bits.join(", ");
  } catch {
    status.state = status.installed ? "not loaded (launchctl print failed)" : "not loaded";
    if (status.installed) {
      notes.push(
        `Plist exists but launchd does not know about it. Re-run: ace install launchd --label ${label}`
      );
    }
  }

  // launchd exposes no "last run" timestamp; the log write time is the proxy.
  if (status.log.lastWriteMs !== undefined) {
    status.lastRun = `${formatLocal(status.log.lastWriteMs)} (inferred from log mtime)`;
  }
  if (!status.log.exists) {
    notes.push(`Log file ${logPath} does not exist yet — the job has never produced output.`);
  }

  return status;
}

function summarisePlistSchedule(plist: string): string | undefined {
  const interval = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(plist)?.[1];
  if (interval !== undefined) return `StartInterval=${interval}s`;

  const cal = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist)?.[1];
  if (cal !== undefined) {
    const hour = /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>/.exec(cal)?.[1];
    const minute = /<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/.exec(cal)?.[1];
    if (hour !== undefined && minute !== undefined) {
      return `StartCalendarInterval — daily at ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    }
    if (minute !== undefined) {
      return `StartCalendarInterval — hourly at :${minute.padStart(2, "0")}`;
    }
  }
  return undefined;
}
