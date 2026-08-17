// src/schedule/systemd.ts — Linux systemd user service + timer generator
//
// This is the preferred Linux install path: the user manager gives us
// Persistent=true catch-up after the box was asleep/off, journal integration,
// and a stable `systemctl --user list-timers` view for `ace status`.

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import {
  buildRenderArgv,
  describeTrigger,
  formatLocal,
  resolveAceBin,
  resolveTrigger,
  schedulerPath,
  systemdUserAvailable,
  type ScheduleOptions,
  type ScheduleStatus,
  type ScheduleTrigger,
} from "./index.js";
import { ensureLogDir, logActivity, resolveLogPath } from "./logs.js";

export type SystemdOptions = ScheduleOptions;

// ---------------------------------------------------------------------------
// Unit file builders
// ---------------------------------------------------------------------------

/**
 * systemd splits ExecStart on whitespace, so any token containing a space has to
 * be quoted (ace's own install prefix never has one, but a --log override can).
 */
function quoteExec(token: string): string {
  if (!/[\s"'\\]/.test(token)) return token;
  return `"${token.replace(/(["\\])/g, "\\$1")}"`;
}

export function buildServiceUnit(opts: SystemdOptions, aceBinTokens: string[]): string {
  const logPath = resolveLogPath(opts.logPath);
  const execStart = buildRenderArgv(aceBinTokens, opts).map(quoteExec).join(" ");

  // No [Install] section: this oneshot is pulled in by the .timer, and adding it
  // to default.target would make it run at every login as well.
  return `[Unit]
Description=ace render — ${opts.label}
Documentation=https://github.com/mjaverto/ace

[Service]
Type=oneshot
Environment=PATH=${schedulerPath()}
ExecStart=${execStart}
StandardOutput=append:${logPath}
StandardError=append:${logPath}
Nice=10
IOSchedulingClass=idle
TimeoutStartSec=30min
`;
}

/** The [Timer] schedule directives for a trigger. */
function timerSchedule(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case "hourly":
      // Persistent=true replays a run missed while the box was off/asleep.
      return `OnCalendar=*-*-* *:${String(trigger.minute).padStart(2, "0")}:00\nPersistent=true`;
    case "daily":
      return (
        `OnCalendar=*-*-* ${String(trigger.hour).padStart(2, "0")}:` +
        `${String(trigger.minute).padStart(2, "0")}:00\nPersistent=true`
      );
    case "interval":
      // OnUnitActiveSec alone never fires: with no previous activation there is
      // nothing to measure from. OnBootSec seeds the chain.
      return `OnBootSec=5min\nOnUnitActiveSec=${formatSystemdDuration(trigger.seconds)}`;
  }
}

export function buildTimerUnit(opts: SystemdOptions): string {
  const schedule = timerSchedule(resolveTrigger(opts));

  return `[Unit]
Description=ace render timer — ${opts.label}

[Timer]
Unit=${opts.label}.service
${schedule}
AccuracySec=1min
RandomizedDelaySec=30

[Install]
WantedBy=timers.target
`;
}

function formatSystemdDuration(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}min`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Install / uninstall
// ---------------------------------------------------------------------------

function unitDir(): string {
  const xdgConfig =
    process.env["XDG_CONFIG_HOME"] ??
    path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "systemd", "user");
}

/** Run a command and return trimmed stdout, or undefined when it fails. */
function probe(bin: string, args: string[]): string | undefined {
  try {
    return execFileSync(bin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
  } catch {
    return undefined;
  }
}

export async function installSystemd(opts: SystemdOptions): Promise<void> {
  const aceBinTokens = resolveAceBin();
  const logPath = resolveLogPath(opts.logPath);
  const trigger = resolveTrigger(opts);
  const serviceContent = buildServiceUnit(opts, aceBinTokens);
  const timerContent = buildTimerUnit(opts);
  const dir = unitDir();
  const serviceDest = path.join(dir, `${opts.label}.service`);
  const timerDest = path.join(dir, `${opts.label}.timer`);
  const user = os.userInfo().username;

  const commands = [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", `${opts.label}.timer`],
    ...(opts.runNow
      ? [["systemctl", "--user", "start", `${opts.label}.service`]]
      : []),
  ] as [string, ...string[]][];

  if (opts.dryRun) {
    console.log(`# Service unit (${serviceDest}):`);
    console.log(serviceContent);
    console.log(`# Timer unit (${timerDest}):`);
    console.log(timerContent);
    console.log(`# Schedule: ${describeTrigger(trigger)}`);
    console.log(`# Log dir that would be created: ${path.dirname(logPath)}`);
    console.log("# Commands that would be run:");
    for (const [bin, ...args] of commands) {
      console.log(`  ${bin} ${args.join(" ")}`);
    }
    console.log(`  loginctl enable-linger ${user}`);
    return;
  }

  if (!systemdUserAvailable()) {
    throw new Error(
      `No reachable systemd user manager (\`systemctl --user\` failed).\n` +
        `Options:\n` +
        `  • On a headless box, first run:  loginctl enable-linger ${user}\n` +
        `  • Or install a cron job instead: ace install cron`
    );
  }

  // systemd's append: redirect does not create the parent directory, and the
  // default Linux log path (~/.local/state/ace/) usually does not exist yet.
  ensureLogDir(logPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(serviceDest, serviceContent, "utf8");
  await fs.writeFile(timerDest, timerContent, "utf8");

  for (const [bin, ...args] of commands) {
    execFileSync(bin, args, { stdio: "inherit" });
  }

  // Without lingering, the user manager (and therefore the timer) is torn down
  // when the last session ends — which is exactly the headless-server case.
  const linger = probe("loginctl", ["show-user", user, "--property=Linger"]);
  if (linger !== "Linger=yes") {
    if (probe("loginctl", ["enable-linger", user]) !== undefined) {
      console.log(`ace install systemd: enabled lingering for ${user}`);
    } else {
      console.log(
        `ace install systemd: WARNING could not enable lingering automatically.\n` +
          `  The timer will stop when your session ends. Run manually:\n` +
          `    sudo loginctl enable-linger ${user}`
      );
    }
  }

  const nextRun = probe("systemctl", [
    "--user",
    "list-timers",
    "--no-pager",
    `${opts.label}.timer`,
  ]);

  console.log(
    `\nace install systemd: ${opts.label} → ${describeTrigger(trigger)}\n` +
      `  timer:   ${timerDest}\n` +
      `  service: ${serviceDest}\n` +
      `  log:     ${logPath}\n` +
      `  check:   ace status  |  journalctl --user -u ${opts.label} -n 50`
  );
  if (nextRun !== undefined) console.log(`\n${nextRun}`);
}

export async function uninstallSystemd(label: string): Promise<void> {
  const dir = unitDir();
  const serviceDest = path.join(dir, `${label}.service`);
  const timerDest = path.join(dir, `${label}.timer`);

  try {
    execFileSync("systemctl", ["--user", "disable", "--now", `${label}.timer`], {
      stdio: "pipe",
    });
  } catch {
    // not enabled — idempotent
  }

  let anyRemoved = false;
  for (const dest of [serviceDest, timerDest]) {
    try {
      await fs.unlink(dest);
      anyRemoved = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  if (!anyRemoved) {
    console.log(`ace uninstall: ${label} already absent`);
    return;
  }

  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  } catch {
    // best-effort
  }

  console.log(`ace uninstall: removed ${serviceDest} and ${timerDest}`);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function statusSystemd(label: string, logPath: string): Promise<ScheduleStatus> {
  const dir = unitDir();
  const serviceDest = path.join(dir, `${label}.service`);
  const timerDest = path.join(dir, `${label}.timer`);
  const notes: string[] = [];
  const status: ScheduleStatus = {
    kind: "systemd",
    label,
    installed: false,
    artifacts: [],
    log: logActivity(logPath),
    notes,
  };

  const timerText = await fs.readFile(timerDest, "utf8").catch(() => undefined);
  const serviceText = await fs.readFile(serviceDest, "utf8").catch(() => undefined);

  if (timerText !== undefined) status.artifacts.push(timerDest);
  if (serviceText !== undefined) status.artifacts.push(serviceDest);
  status.installed = timerText !== undefined && serviceText !== undefined;

  if (!status.installed) {
    notes.push(
      `Missing unit file(s) under ${dir}. Install with: ace install systemd --label ${label}`
    );
  }

  if (timerText !== undefined) {
    const scheduleLines = timerText
      .split("\n")
      .filter((l) => /^(OnCalendar|OnUnitActiveSec|OnBootSec)=/.test(l.trim()))
      .map((l) => l.trim());
    if (scheduleLines.length > 0) status.schedule = scheduleLines.join(", ");
  }
  if (serviceText !== undefined) {
    const exec = /^ExecStart=(.*)$/m.exec(serviceText)?.[1];
    if (exec !== undefined) status.command = exec.trim();
  }

  const show = probe("systemctl", [
    "--user",
    "show",
    `${label}.timer`,
    "--property=ActiveState",
    "--property=NextElapseUSecRealtime",
    "--property=NextElapseUSecMonotonic",
    "--property=LastTriggerUSec",
    "--property=UnitFileState",
  ]);

  if (show === undefined) {
    status.state = "unknown (systemctl --user not reachable)";
    notes.push(
      "`systemctl --user` is not reachable from this shell — on a headless box run: " +
        `loginctl enable-linger ${os.userInfo().username}`
    );
  } else {
    const props = parseProps(show);
    const bits: string[] = [];
    const fileState = props["UnitFileState"];
    const activeState = props["ActiveState"];
    if (fileState) bits.push(fileState);
    if (activeState) bits.push(activeState);
    status.state = bits.length > 0 ? bits.join(", ") : "unknown";

    const lastTrigger = usecToMs(props["LastTriggerUSec"]);
    if (lastTrigger !== undefined) {
      status.lastRun = `${formatLocal(lastTrigger)} (timer LastTriggerUSec)`;
    } else if (status.log.lastWriteMs !== undefined) {
      status.lastRun = `${formatLocal(status.log.lastWriteMs)} (inferred from log mtime)`;
    }

    const nextRealtime = usecToMs(props["NextElapseUSecRealtime"]);
    if (nextRealtime !== undefined) {
      status.nextRun = formatLocal(nextRealtime);
    } else if (usecToMs(props["NextElapseUSecMonotonic"]) !== undefined) {
      status.nextRun = "scheduled (monotonic timer — see `systemctl --user list-timers`)";
    }

    if (fileState === "disabled" || activeState === "inactive") {
      notes.push(
        `Timer is ${fileState ?? activeState}. Enable with: systemctl --user enable --now ${label}.timer`
      );
    }

    const linger = probe("loginctl", ["show-user", os.userInfo().username, "--property=Linger"]);
    if (linger === "Linger=no") {
      notes.push(
        `Lingering is off, so the timer dies with your session. Run: ` +
          `loginctl enable-linger ${os.userInfo().username}`
      );
    }
  }

  if (!status.log.exists) {
    notes.push(
      `Log file ${logPath} does not exist yet — the job has never produced output. ` +
        `Also check: journalctl --user -u ${label} -n 50`
    );
  }

  return status;
}

function parseProps(show: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of show.split("\n")) {
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    props[line.slice(0, idx)] = line.slice(idx + 1).trim();
  }
  return props;
}

/** systemd reports microseconds since the epoch; 0 / absent / huge means "never". */
function usecToMs(value: string | undefined): number | undefined {
  if (value === undefined || value === "" || value === "0") return undefined;
  const usec = Number(value);
  if (!Number.isFinite(usec) || usec <= 0) return undefined;
  const ms = Math.round(usec / 1000);
  // systemd uses UINT64_MAX-ish sentinels for "infinity".
  if (ms > 8.64e15) return undefined;
  return ms;
}
