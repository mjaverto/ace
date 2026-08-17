// src/schedule/cron.ts — cron installer via crontab
//
// Fallback for Linux hosts with no reachable systemd user manager (and for
// non-systemd Unixes). Prefer `ace install systemd` where it is available.

import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildRenderArgv,
  describeTrigger,
  formatLocal,
  resolveAceBin,
  resolveTrigger,
  schedulerPath,
  type ScheduleOptions,
  type ScheduleStatus,
  type ScheduleTrigger,
} from "./index.js";
import { ensureLogDir, logActivity, resolveLogPath } from "./logs.js";

export type CronOptions = ScheduleOptions;

const TAG_PREFIX = "# ace:";

// ---------------------------------------------------------------------------
// Cron expression builder
// ---------------------------------------------------------------------------

function buildCronExpr(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "hourly":
      return `${trigger.minute} * * * *`;
    case "daily":
      return `${trigger.minute} ${trigger.hour} * * *`;
    case "interval":
      return intervalCronExpr(trigger.seconds);
  }
}

/**
 * cron's finest granularity is one minute and its step syntax only spaces evenly
 * when the step divides the field, so only intervals that divide an hour (or a
 * day, in whole hours) are expressible.
 */
function intervalCronExpr(seconds: number): string {
  const unsupported = (why: string): Error =>
    new Error(
      `cron cannot express that interval (${why}).\n` +
        `Use --cron-minute <N> (hourly at :N), --at HH:MM (daily), ` +
        `or an interval that divides an hour evenly (5m, 10m, 15m, 20m, 30m, 1h, 2h, 3h, 4h, 6h, 8h, 12h).\n` +
        `On Linux, \`ace install systemd\` supports arbitrary intervals.`
    );

  if (seconds < 60) throw unsupported("cron granularity is one minute");
  if (seconds % 60 !== 0) throw unsupported("not a whole number of minutes");

  const minutes = seconds / 60;
  if (minutes < 60) {
    if (60 % minutes !== 0) throw unsupported(`${minutes}m does not divide an hour evenly`);
    return `*/${minutes} * * * *`;
  }
  if (minutes === 60) return `0 * * * *`;
  if (minutes % 60 !== 0) throw unsupported("not a whole number of hours");

  const hours = minutes / 60;
  if (hours < 24) {
    if (24 % hours !== 0) throw unsupported(`${hours}h does not divide a day evenly`);
    return `0 */${hours} * * *`;
  }
  if (hours === 24) return `0 0 * * *`;
  throw unsupported("longer than a day");
}

// ---------------------------------------------------------------------------
// Build the full cron line
// ---------------------------------------------------------------------------

export function buildCronLine(opts: CronOptions, aceBinTokens: string[]): string {
  const expr = buildCronExpr(resolveTrigger(opts));
  const tag = `${TAG_PREFIX}${opts.label}`;
  const logPath = resolveLogPath(opts.logPath);
  const command = buildRenderArgv(aceBinTokens, opts).map(shellQuote).join(" ");

  // cron gives the job a bare PATH=/usr/bin:/bin, which usually lacks the node
  // that the `ace` shim's shebang needs; `VAR=value cmd` is a plain sh prefix.
  const body =
    `PATH=${shellQuote(schedulerPath())} ${command} >> ${shellQuote(logPath)} 2>&1`;

  // In a crontab command, an unescaped % is a newline directive.
  return `${expr} ${body.replace(/%/g, "\\%")} ${tag}`;
}

function shellQuote(token: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// crontab read/write helpers
// ---------------------------------------------------------------------------

interface CrontabRead {
  ok: boolean;
  content: string;
  error?: string;
}

/** Never exits; used by status where a missing/broken crontab is not fatal. */
function readCrontabSafe(): CrontabRead {
  try {
    return { ok: true, content: execFileSync("crontab", ["-l"], { encoding: "utf8" }) };
  } catch (err) {
    // crontab -l exits 1 with "no crontab for <user>" when the user has no crontab.
    const spawnErr = err as { status?: number; stderr?: string; message?: string };
    const stderr = spawnErr.stderr ?? "";
    if (spawnErr.status === 1 && /no crontab/i.test(stderr)) {
      return { ok: true, content: "" };
    }
    return {
      ok: false,
      content: "",
      error: `crontab -l failed (status=${spawnErr.status ?? "?"}): ${stderr || spawnErr.message || String(err)}`,
    };
  }
}

function readCrontab(): string {
  const result = readCrontabSafe();
  if (!result.ok) {
    // Any failure other than "no crontab" must not silently proceed — writing a
    // fresh crontab on top of an unreadable one would clobber the real content.
    process.stderr.write(
      `ace: ${result.error}\nRefusing to write crontab to avoid data loss.\n`
    );
    process.exit(2);
  }
  return result.content;
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
  const aceBinTokens = resolveAceBin();
  const tag = `${TAG_PREFIX}${opts.label}`;
  const newLine = buildCronLine(opts, aceBinTokens);
  const logPath = resolveLogPath(opts.logPath);

  if (opts.dryRun) {
    console.log("# Cron entry that would be added:");
    console.log(newLine);
    console.log(`# Schedule: ${describeTrigger(resolveTrigger(opts))}`);
    console.log(`# Log dir that would be created: ${path.dirname(logPath)}`);
    return;
  }

  // The `>>` redirect fails if the log directory does not exist yet.
  ensureLogDir(logPath);

  const existing = readCrontab();
  // Strip any lines tagged with our label (idempotency)
  const stripped = existing
    .split("\n")
    .filter((line) => !line.includes(tag))
    .join("\n")
    .replace(/\n+$/, "");

  const updated = stripped ? `${stripped}\n${newLine}\n` : `${newLine}\n`;
  writeCrontab(updated);
  console.log(
    `ace install cron: ${opts.label} → ${describeTrigger(resolveTrigger(opts))}\n` +
      `  entry: ${newLine}\n` +
      `  log:   ${logPath}\n` +
      `  check: ace status`
  );
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

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function statusCron(label: string, logPath: string): Promise<ScheduleStatus> {
  const tag = `${TAG_PREFIX}${label}`;
  const notes: string[] = [];
  const status: ScheduleStatus = {
    kind: "cron",
    label,
    installed: false,
    artifacts: [],
    log: logActivity(logPath),
    notes,
  };

  const read = readCrontabSafe();
  if (!read.ok) {
    status.state = "unknown";
    notes.push(read.error ?? "crontab could not be read");
    return status;
  }

  const line = read.content.split("\n").find((l) => l.includes(tag));
  if (line === undefined) {
    notes.push(`No crontab entry tagged "${tag}". Install with: ace install cron --label ${label}`);
    status.state = "not in crontab";
  } else {
    status.installed = true;
    status.state = "present in crontab";
    status.artifacts.push(`crontab (user ${process.env["USER"] ?? "?"})`);
    const fields = line.trim().split(/\s+/);
    status.schedule = fields.slice(0, 5).join(" ");
    status.command = fields.slice(5).join(" ").replace(new RegExp(`\\s*${escapeRegExp(tag)}$`), "");
  }

  // cron keeps no per-job history, so the log write time is the only "last run".
  if (status.log.lastWriteMs !== undefined) {
    status.lastRun = `${formatLocal(status.log.lastWriteMs)} (inferred from log mtime)`;
  } else {
    notes.push(`Log file ${logPath} does not exist yet — the job has never produced output.`);
  }

  return status;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
