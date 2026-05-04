// src/schedule/cron.ts — cron installer via crontab

import { execFileSync, spawnSync } from "node:child_process";
import { resolveAceBin } from "./index.js";

export interface CronOptions {
  label: string;
  at?: string;
  every?: string;
  cronMinute?: number;
  logPath?: string;
  dryRun?: boolean;
}

const TAG_PREFIX = "# ace:";

// ---------------------------------------------------------------------------
// Cron expression builder
// ---------------------------------------------------------------------------

function buildCronExpr(opts: CronOptions): string {
  if (opts.cronMinute !== undefined) {
    // Hourly at :N
    return `${opts.cronMinute} * * * *`;
  }
  if (opts.at) {
    const [hh, mm] = opts.at.split(":").map(Number);
    if (hh === undefined || mm === undefined || isNaN(hh) || isNaN(mm)) {
      throw new Error(`Invalid --at time "${opts.at}". Use HH:MM format.`);
    }
    // Daily at HH:MM — cron is "minute hour * * *"
    return `${mm} ${hh} * * *`;
  }
  if (opts.every) {
    throw new Error(
      `cron does not support --every durations natively. ` +
        `Use --cron-minute <N> for hourly-at-:N or --at HH:MM for daily.`
    );
  }
  throw new Error("Must specify one of: --at, --cron-minute (cron does not support --every)");
}

// ---------------------------------------------------------------------------
// Build the full cron line
// ---------------------------------------------------------------------------

export function buildCronLine(opts: CronOptions, aceBin: string): string {
  const expr = buildCronExpr(opts);
  const tag = `${TAG_PREFIX}${opts.label}`;
  const logRedirect = opts.logPath ? ` >> "${opts.logPath}" 2>&1` : "";
  return `${expr} ${aceBin} render${logRedirect} ${tag}`;
}

// ---------------------------------------------------------------------------
// crontab read/write helpers
// ---------------------------------------------------------------------------

function readCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], { encoding: "utf8" });
  } catch {
    // crontab -l exits non-zero when no crontab exists
    return "";
  }
}

function writeCrontab(content: string): void {
  // Pass content via stdin; spawnSync with input avoids any shell interpolation
  const result = spawnSync("crontab", ["-"], {
    input: content,
    encoding: "utf8",
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`crontab - exited with status ${result.status ?? "unknown"}`);
  }
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

export function installCron(opts: CronOptions): void {
  const aceBin = resolveAceBin();
  const tag = `${TAG_PREFIX}${opts.label}`;
  const newLine = buildCronLine(opts, aceBin);

  if (opts.dryRun) {
    console.log("# Cron entry that would be added:");
    console.log(newLine);
    return;
  }

  const existing = readCrontab();
  // Strip any lines tagged with our label (idempotency)
  const stripped = existing
    .split("\n")
    .filter((line) => !line.includes(tag))
    .join("\n")
    .replace(/\n+$/, "");

  const updated = stripped ? `${stripped}\n${newLine}\n` : `${newLine}\n`;
  writeCrontab(updated);
  console.log(`ace install cron: added entry for label "${opts.label}"`);
}

export function uninstallCron(label: string): void {
  const tag = `${TAG_PREFIX}${label}`;
  const existing = readCrontab();
  const lines = existing.split("\n").filter((line) => !line.includes(tag));

  if (lines.join("\n") === existing.trimEnd()) {
    console.log(`ace uninstall: cron entry for "${label}" already absent`);
    return;
  }

  const updated = lines.join("\n").replace(/\n+$/, "") + "\n";
  writeCrontab(updated);
  console.log(`ace uninstall: removed cron entry for label "${label}"`);
}
