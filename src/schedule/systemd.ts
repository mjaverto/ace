// src/schedule/systemd.ts — Linux systemd user service + timer generator

import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolveAceBin } from "./index.js";
import { resolveLogPath } from "./logs.js";

export interface SystemdOptions {
  label: string;
  at?: string;
  every?: string;
  cronMinute?: number;
  logPath?: string;
  runNow?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Duration parser
// ---------------------------------------------------------------------------

function parseDurationSystemd(s: string): string {
  const m = /^(\d+)(h|m|s)$/.exec(s.trim());
  if (!m) throw new Error(`Invalid duration "${s}". Use e.g. "1h", "15m", "30s".`);
  const n = parseInt(m[1]!, 10);
  switch (m[2]) {
    case "h": return `${n}h`;
    case "m": return `${n}min`;
    case "s": return `${n}s`;
    default: throw new Error(`Unexpected unit: ${m[2]}`);
  }
}

// ---------------------------------------------------------------------------
// Unit file builders
// ---------------------------------------------------------------------------

export function buildServiceUnit(label: string, aceBinTokens: string[], logPath: string): string {
  // systemd ExecStart requires space-separated tokens; paths with spaces would
  // need quoting but ace install paths never contain spaces in practice.
  const execStart = [...aceBinTokens, "render"].join(" ");
  return `[Unit]
Description=ace render — ${label}
After=network.target

[Service]
Type=oneshot
ExecStart=${execStart}
StandardOutput=append:${logPath}
StandardError=append:${logPath}

[Install]
WantedBy=default.target
`;
}

export function buildTimerUnit(opts: SystemdOptions): string {
  let onCalendar = "";
  let onUnitActiveSec = "";

  if (opts.cronMinute !== undefined) {
    // Hourly at :N
    onCalendar = `OnCalendar=*:${opts.cronMinute}`;
  } else if (opts.at) {
    const [hh, mm] = opts.at.split(":").map(Number);
    if (hh === undefined || mm === undefined || isNaN(hh) || isNaN(mm)) {
      throw new Error(`Invalid --at time "${opts.at}". Use HH:MM format.`);
    }
    onCalendar = `OnCalendar=*-*-* ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`;
  } else if (opts.every) {
    onUnitActiveSec = `OnUnitActiveSec=${parseDurationSystemd(opts.every)}`;
  } else {
    throw new Error("Must specify one of: --at, --every, --cron-minute");
  }

  const schedule = onCalendar || onUnitActiveSec;

  return `[Unit]
Description=ace render timer

[Timer]
${schedule}
Persistent=true

[Install]
WantedBy=timers.target
`;
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

export async function installSystemd(opts: SystemdOptions): Promise<void> {
  const aceBinTokens = resolveAceBin();
  const logPath = resolveLogPath(opts.logPath);
  const serviceContent = buildServiceUnit(opts.label, aceBinTokens, logPath);
  const timerContent = buildTimerUnit(opts);
  const dir = unitDir();
  const serviceDest = path.join(dir, `${opts.label}.service`);
  const timerDest = path.join(dir, `${opts.label}.timer`);

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
    console.log("# Commands that would be run:");
    for (const [bin, ...args] of commands) {
      console.log(`  ${bin} ${args.join(" ")}`);
    }
    console.log(
      "\n# Hint: if running headless (no graphical session), run:\n" +
        "#   loginctl enable-linger $USER"
    );
    return;
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(serviceDest, serviceContent, "utf8");
  await fs.writeFile(timerDest, timerContent, "utf8");

  for (const [bin, ...args] of commands) {
    execFileSync(bin, args, { stdio: "inherit" });
  }

  console.log(
    "\nHint: if running headless (no graphical session), run:\n  loginctl enable-linger $USER"
  );
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
