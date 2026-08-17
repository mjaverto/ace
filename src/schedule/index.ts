// src/schedule/index.ts — platform dispatch + shared helpers

import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveLogPath, type LogActivity } from "./logs.js";
import { statusLaunchd } from "./launchd.js";
import { statusSystemd } from "./systemd.js";
import { statusCron } from "./cron.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/** Label used by the shipped install path on every platform. */
export const DEFAULT_LABEL = "dev.ace.render";

/**
 * Default schedule when the caller names none: hourly at :48.
 * Matches the pre-existing hand-written macOS job and stays away from :00,
 * where every other cron/timer on the machine wakes up at once.
 */
export const DEFAULT_CRON_MINUTE = 48;

export type SchedulerKind = "launchd" | "systemd" | "cron";

// ---------------------------------------------------------------------------
// Shared option + status shapes
// ---------------------------------------------------------------------------

/** Options accepted by every installer. Platform modules alias this type. */
export interface ScheduleOptions {
  label: string;
  /** Daily schedule: HH:MM */
  at?: string;
  /** Repeating interval, e.g. "1h", "15m", "30s" */
  every?: string;
  /** Hourly at :N */
  cronMinute?: number;
  logPath?: string;
  /**
   * Append `--skip-on-battery` to the scheduled `ace render` invocation so an
   * unattended run bails out on laptop battery. Defaults to true in the CLI.
   */
  skipOnBattery?: boolean;
  runNow?: boolean;
  dryRun?: boolean;
}

/** What `ace status` reports for a scheduler install. */
export interface ScheduleStatus {
  kind: SchedulerKind;
  label: string;
  installed: boolean;
  /** Files (or crontab lines) backing the install. */
  artifacts: string[];
  /** Human summary of the schedule read back from the installed artifact. */
  schedule?: string;
  /** Supervisor state, e.g. "loaded", "enabled, active", "present in crontab". */
  state?: string;
  /** Last run according to the supervisor, ISO-8601 local. */
  lastRun?: string;
  /** Next run according to the supervisor, ISO-8601 local. */
  nextRun?: string;
  /** The command the scheduler will run. */
  command?: string;
  log: LogActivity;
  notes: string[];
}

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

/**
 * The argv the scheduler should execute. Centralised so launchd, systemd and
 * cron cannot drift on which flags a scheduled (unattended) render gets.
 */
export function buildRenderArgv(aceBinTokens: string[], opts: ScheduleOptions): string[] {
  const argv = [...aceBinTokens, "render"];
  if (opts.skipOnBattery) argv.push("--skip-on-battery");
  return argv;
}

/**
 * PATH to hand a scheduled job.
 *
 * Schedulers run with a minimal environment: launchd agents get
 * `/usr/bin:/bin:/usr/sbin:/sbin`, cron gets `/usr/bin:/bin`. Neither contains
 * Homebrew/nvm/fnm node, so the `#!/usr/bin/env node` shebang inside the `ace`
 * shim fails to resolve and the job dies before it prints anything. Pin the
 * directory of the node that is generating the install.
 */
export function schedulerPath(): string {
  const nodeDir = path.dirname(process.execPath);
  const system =
    process.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
      : ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  return [...new Set([nodeDir, ...system])].join(":");
}

// ---------------------------------------------------------------------------
// Trigger parsing — one implementation shared by all three platforms
// ---------------------------------------------------------------------------

export type ScheduleTrigger =
  /** Every hour at minute N. */
  | { kind: "hourly"; minute: number }
  /** Every day at HH:MM. */
  | { kind: "daily"; hour: number; minute: number }
  /** Every N seconds. */
  | { kind: "interval"; seconds: number; spec: string };

/**
 * Normalise `--cron-minute` / `--at` / `--every` into one trigger.
 * Precedence matches the order the flags are documented in.
 * With no schedule flags at all, falls back to hourly at :DEFAULT_CRON_MINUTE.
 */
export function resolveTrigger(opts: ScheduleOptions): ScheduleTrigger {
  if (opts.cronMinute !== undefined) {
    const minute = opts.cronMinute;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error(`Invalid --cron-minute "${opts.cronMinute}". Use an integer 0-59.`);
    }
    return { kind: "hourly", minute };
  }

  if (opts.at !== undefined) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(opts.at.trim());
    const hour = m ? Number(m[1]) : NaN;
    const minute = m ? Number(m[2]) : NaN;
    if (!m || hour > 23 || minute > 59) {
      throw new Error(`Invalid --at time "${opts.at}". Use HH:MM (00:00-23:59).`);
    }
    return { kind: "daily", hour, minute };
  }

  if (opts.every !== undefined) {
    const m = /^(\d+)(h|m|s)$/.exec(opts.every.trim());
    if (!m) throw new Error(`Invalid duration "${opts.every}". Use e.g. "1h", "15m", "30s".`);
    const n = parseInt(m[1]!, 10);
    if (n <= 0) throw new Error(`Invalid duration "${opts.every}". Must be greater than zero.`);
    const unit = m[2];
    const seconds = unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
    return { kind: "interval", seconds, spec: `${n}${unit}` };
  }

  return { kind: "hourly", minute: DEFAULT_CRON_MINUTE };
}

/** Human description of a trigger, for install output and `ace status`. */
export function describeTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "hourly":
      return `hourly at :${String(trigger.minute).padStart(2, "0")}`;
    case "daily":
      return `daily at ${String(trigger.hour).padStart(2, "0")}:${String(trigger.minute).padStart(2, "0")}`;
    case "interval":
      return `every ${trigger.spec}`;
  }
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

/**
 * Pick the scheduler that actually works on this host.
 *
 * macOS → launchd. Linux → systemd user timer when a user manager is reachable
 * (the preferred path: journal integration, Persistent= catch-up, no PATH
 * surprises), otherwise cron. Anything else → cron.
 */
export function detectScheduler(): SchedulerKind {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    return systemdUserAvailable() ? "systemd" : "cron";
  }
  return "cron";
}

/** True when a systemd *user* manager is reachable for the current user. */
export function systemdUserAvailable(): boolean {
  try {
    execFileSync("systemctl", ["--user", "show-environment"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Warnings for a kind/platform mismatch. Empty when the pairing is normal. */
export function platformNotes(kind: SchedulerKind): string[] {
  const notes: string[] = [];
  if (kind === "launchd" && process.platform !== "darwin") {
    notes.push(`launchd is macOS-only; this host is ${process.platform}.`);
  }
  if (kind === "systemd" && process.platform !== "linux") {
    notes.push(`systemd user timers are Linux-only; this host is ${process.platform}.`);
  }
  if (kind === "cron" && process.platform === "darwin") {
    notes.push(
      "On macOS, cron jobs need Full Disk Access granted to /usr/sbin/cron; " +
        "prefer `ace install launchd`."
    );
  }
  if (kind === "cron" && process.platform === "linux" && systemdUserAvailable()) {
    notes.push("A systemd user manager is available; `ace install systemd` is preferred.");
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Status dispatch
// ---------------------------------------------------------------------------

export async function scheduleStatus(
  kind: SchedulerKind,
  label: string,
  logPathOverride?: string
): Promise<ScheduleStatus> {
  const logPath = resolveLogPath(logPathOverride);
  switch (kind) {
    case "launchd":
      return statusLaunchd(label, logPath);
    case "systemd":
      return statusSystemd(label, logPath);
    case "cron":
      return statusCron(label, logPath);
  }
}

/** Render a ScheduleStatus for humans, in the same style as `ace doctor`. */
export function formatScheduleStatus(status: ScheduleStatus): string {
  const rows: [string, string][] = [
    ["kind", status.kind],
    ["label", status.label],
    ["installed", status.installed ? "yes" : "no"],
  ];
  if (status.artifacts.length > 0) rows.push(["artifacts", status.artifacts.join("\n")]);
  if (status.schedule !== undefined) rows.push(["schedule", status.schedule]);
  if (status.command !== undefined) rows.push(["command", status.command]);
  if (status.state !== undefined) rows.push(["state", status.state]);
  if (status.lastRun !== undefined) rows.push(["last run", status.lastRun]);
  if (status.nextRun !== undefined) rows.push(["next run", status.nextRun]);

  const log = status.log;
  rows.push(["log", log.path]);
  if (log.exists && log.lastWriteMs !== undefined) {
    const kb = ((log.sizeBytes ?? 0) / 1024).toFixed(1);
    rows.push(["log written", `${formatLocal(log.lastWriteMs)} (${kb} KB)`]);
    if (log.lastLine !== undefined) rows.push(["log last line", log.lastLine]);
  } else {
    rows.push(["log written", "never (no log file yet)"]);
  }

  const width = Math.max(...rows.map(([k]) => k.length));
  const lines = rows.flatMap(([k, v]) => {
    const parts = v.split("\n");
    return parts.map((part, i) =>
      `  ${(i === 0 ? `${k}:` : "").padEnd(width + 1)} ${part}`
    );
  });

  for (const note of status.notes) lines.push(`  note: ${note}`);
  return lines.join("\n");
}

/** ISO-8601-ish local timestamp (matches ACE's local-time convention). */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const parts = [
    d.getMonth() + 1,
    d.getDate(),
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
  ].map((n) => String(n).padStart(2, "0"));
  return `${d.getFullYear()}-${parts[0]}-${parts[1]}T${parts[2]}:${parts[3]}:${parts[4]}`;
}

// ---------------------------------------------------------------------------
// Re-export platform helpers
// ---------------------------------------------------------------------------

export { installLaunchd, uninstallLaunchd, buildPlist } from "./launchd.js";
export type { LaunchdOptions } from "./launchd.js";

export {
  installSystemd,
  uninstallSystemd,
  buildServiceUnit,
  buildTimerUnit,
} from "./systemd.js";
export type { SystemdOptions } from "./systemd.js";

export { installCron, uninstallCron, buildCronLine } from "./cron.js";
export type { CronOptions } from "./cron.js";

// resolveLogPath / LogActivity are imported above; re-export the same bindings
// rather than a second entry from ./logs.js.
export { statusLaunchd, statusSystemd, statusCron, resolveLogPath };
export type { LogActivity };

export { tailLog, ensureLogDir, logActivity } from "./logs.js";
