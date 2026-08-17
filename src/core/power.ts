// src/core/power.ts — portable "is it safe to run now" power gate.
//
// ACE is scheduled to run unattended (launchd on macOS, a systemd user timer on
// Linux). On a laptop that means it can wake up mid-flight on battery and spend
// minutes walking tens of thousands of JSONL files. This module answers one
// question — "is this machine on wall power right now?" — for the caller to gate on.
//
// Design rules:
//   • FAIL OPEN. If we cannot determine the power state we return ok: true, so a
//     broken/absent probe never silently disables rendering.
//   • ALWAYS EXPLAIN. `detail` is populated on every path and `detected` says
//     whether the answer was measured or guessed. A previous implementation of
//     this gate swallowed the reason, which made "proceeded because AC" and
//     "proceeded because I could not tell" indistinguishable — and therefore made
//     a silently-broken probe invisible. Callers MUST log `detail` on both paths.
//   • INJECTABLE. Every OS touchpoint is overridable so tests never depend on the
//     host's actual power state.

import path from "node:path";
import fsSync from "node:fs";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PowerCheck {
  /** true → safe to run now. Always true when the state could not be determined. */
  ok: boolean;
  /** Human-readable reason for the decision. Never empty. Log this on BOTH paths. */
  detail: string;
  /**
   * true  → the power state was positively measured.
   * false → detection failed and we failed open; the gate is not protecting you.
   */
  detected: boolean;
}

/** Overridable OS touchpoints. Anything omitted falls back to the real probe. */
export interface PowerProbe {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** macOS: returns raw `pmset -g batt` stdout. Throw to simulate a missing binary. */
  pmset?: () => string;
  /** Linux: sysfs directory holding power-supply devices. */
  powerSupplyDir?: string;
  /** Linux: list a directory. Throw to simulate an unreadable sysfs. */
  readDir?: (dir: string) => string[];
  /** Linux: read a file as utf8. Throw to simulate an unreadable attribute. */
  readFile?: (file: string) => string;
}

export const DEFAULT_POWER_SUPPLY_DIR = "/sys/class/power_supply";

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Decide whether it is safe to run right now with respect to power state.
 *
 * Never throws: every failure mode is converted into a fail-open PowerCheck
 * carrying `detected: false` and a `detail` naming the reason.
 */
export function checkPower(probe: PowerProbe = {}): PowerCheck {
  const platform = probe.platform ?? process.platform;
  try {
    if (platform === "darwin") return checkDarwin(probe);
    if (platform === "linux") return checkLinux(probe);
    return {
      ok: true,
      detected: false,
      detail: `${platform}: no power-state probe implemented for this platform — proceeding (undetected)`,
    };
  } catch (err) {
    // Defensive: an unexpected throw must still fail open, loudly.
    return {
      ok: true,
      detected: false,
      detail: `${platform}: power probe threw unexpectedly (${errMsg(err)}) — proceeding (undetected)`,
    };
  }
}

/** One-line log form: "power: proceeding — <detail>" / "power: skipping — <detail>". */
export function formatPowerCheck(check: PowerCheck): string {
  const verb = check.ok ? "proceeding" : "skipping";
  return `power: ${verb} — ${check.detail}`;
}

// ---------------------------------------------------------------------------
// macOS — pmset -g batt
// ---------------------------------------------------------------------------

function defaultPmset(): string {
  return execFileSync("pmset", ["-g", "batt"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 5_000,
  });
}

function checkDarwin(probe: PowerProbe): PowerCheck {
  const run = probe.pmset ?? defaultPmset;

  let out: string;
  try {
    out = run();
  } catch (err) {
    return {
      ok: true,
      detected: false,
      detail: `darwin: could not run \`pmset -g batt\` (${errMsg(err)}) — proceeding (undetected)`,
    };
  }

  const source = /Now drawing from '([^']+)'/.exec(out)?.[1];
  if (source === undefined) {
    return {
      ok: true,
      detected: false,
      detail:
        `darwin: \`pmset -g batt\` output had no "Now drawing from '<source>'" line ` +
        `— proceeding (undetected)`,
    };
  }

  if (source.trim().toLowerCase() === "battery power") {
    return {
      ok: false,
      detected: true,
      detail: `darwin: on battery power (pmset: "${source}")`,
    };
  }

  return {
    ok: true,
    detected: true,
    detail: `darwin: on external power (pmset: "${source}")`,
  };
}

// ---------------------------------------------------------------------------
// Linux — /sys/class/power_supply/BAT*
// ---------------------------------------------------------------------------

function checkLinux(probe: PowerProbe): PowerCheck {
  const dir = probe.powerSupplyDir ?? DEFAULT_POWER_SUPPLY_DIR;
  const readDir = probe.readDir ?? ((d: string) => fsSync.readdirSync(d));
  const readFile = probe.readFile ?? ((f: string) => fsSync.readFileSync(f, "utf8"));

  let entries: string[];
  try {
    entries = readDir(dir);
  } catch (err) {
    return {
      ok: true,
      detected: false,
      detail: `linux: ${dir} is not readable (${errMsg(err)}) — proceeding (undetected)`,
    };
  }

  const batteries = entries.filter((e) => /^BAT/i.test(e)).sort();
  if (batteries.length === 0) {
    // Desktop / server / VM. There is no battery to be discharging from, so this
    // is a measured "always safe", not a fail-open guess.
    return {
      ok: true,
      detected: true,
      detail: `linux: no battery present under ${dir} — desktop/server, always safe to run`,
    };
  }

  const seen: string[] = [];
  const unreadable: string[] = [];

  for (const bat of batteries) {
    const statusFile = path.join(dir, bat, "status");
    let status: string;
    try {
      status = readFile(statusFile).trim();
    } catch (err) {
      unreadable.push(`${bat} (${errMsg(err)})`);
      continue;
    }
    seen.push(`${bat}=${status || "empty"}`);
    if (status.toLowerCase() === "discharging") {
      return {
        ok: false,
        detected: true,
        detail: `linux: on battery power (${bat} status=${status})`,
      };
    }
  }

  if (seen.length === 0) {
    return {
      ok: true,
      detected: false,
      detail:
        `linux: battery present but status unreadable: ${unreadable.join(", ")} ` +
        `— proceeding (undetected)`,
    };
  }

  // "Unknown" is what some firmware reports for a full battery on AC; it is also
  // what a confused driver reports. Either way we cannot claim a measurement.
  if (seen.every((s) => /=unknown$|=empty$/i.test(s))) {
    return {
      ok: true,
      detected: false,
      detail:
        `linux: battery status indeterminate (${seen.join(", ")}) — proceeding (undetected)`,
    };
  }

  const suffix = unreadable.length > 0 ? `; unreadable: ${unreadable.join(", ")}` : "";
  return {
    ok: true,
    detected: true,
    detail: `linux: on external power (${seen.join(", ")})${suffix}`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    // Node's fs/child_process messages already start with the errno code.
    if (code === undefined || err.message.includes(code)) return err.message;
    return `${code}: ${err.message}`;
  }
  return String(err);
}
