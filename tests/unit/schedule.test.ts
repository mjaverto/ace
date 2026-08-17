// tests/unit/schedule.test.ts — unit tests for the generated scheduler artifacts
//
// These assert the text ACE writes into launchd plists, systemd units and
// crontabs. Log paths are always passed explicitly so nothing depends on the
// host's HOME or platform defaults.

import { describe, it, expect } from "vitest";
import {
  buildCronLine,
  buildPlist,
  buildServiceUnit,
  buildTimerUnit,
  describeTrigger,
  resolveTrigger,
  DEFAULT_CRON_MINUTE,
  type ScheduleOptions,
} from "../../src/schedule/index.js";

const LOG = "/tmp/ace-test/ace.log";
const BIN = ["/opt/homebrew/bin/ace"];

function opts(extra: Partial<ScheduleOptions> = {}): ScheduleOptions {
  return { label: "dev.ace.render", logPath: LOG, skipOnBattery: true, ...extra };
}

// ---------------------------------------------------------------------------
// resolveTrigger
// ---------------------------------------------------------------------------

describe("resolveTrigger", () => {
  it("defaults to hourly at the default minute when no schedule flag is given", () => {
    expect(resolveTrigger(opts())).toEqual({ kind: "hourly", minute: DEFAULT_CRON_MINUTE });
    expect(describeTrigger(resolveTrigger(opts()))).toBe("hourly at :48");
  });

  it("parses --cron-minute, --at and --every", () => {
    expect(resolveTrigger(opts({ cronMinute: 7 }))).toEqual({ kind: "hourly", minute: 7 });
    expect(resolveTrigger(opts({ at: "09:30" }))).toEqual({ kind: "daily", hour: 9, minute: 30 });
    expect(resolveTrigger(opts({ every: "15m" }))).toEqual({
      kind: "interval",
      seconds: 900,
      spec: "15m",
    });
  });

  it("rejects out-of-range and malformed values", () => {
    expect(() => resolveTrigger(opts({ cronMinute: 60 }))).toThrow(/0-59/);
    expect(() => resolveTrigger(opts({ at: "24:00" }))).toThrow(/HH:MM/);
    expect(() => resolveTrigger(opts({ at: "9h30" }))).toThrow(/HH:MM/);
    expect(() => resolveTrigger(opts({ every: "1d" }))).toThrow(/Invalid duration/);
    expect(() => resolveTrigger(opts({ every: "0m" }))).toThrow(/greater than zero/);
  });
});

// ---------------------------------------------------------------------------
// launchd
// ---------------------------------------------------------------------------

describe("buildPlist", () => {
  it("emits an hourly StartCalendarInterval, a pinned PATH and the battery flag", () => {
    const plist = buildPlist(opts({ cronMinute: 48 }), BIN);
    expect(plist).toContain("<key>StartCalendarInterval</key>");
    expect(plist).toContain("<key>Minute</key>\n\t\t<integer>48</integer>");
    expect(plist).toContain("<string>/opt/homebrew/bin/ace</string>");
    expect(plist).toContain("<string>render</string>");
    expect(plist).toContain("<string>--skip-on-battery</string>");
    expect(plist).toContain("<key>EnvironmentVariables</key>");
    expect(plist).toContain(`<string>${LOG}</string>`);
  });

  it("omits the battery flag when skipOnBattery is off", () => {
    const plist = buildPlist(opts({ skipOnBattery: false }), BIN);
    expect(plist).not.toContain("--skip-on-battery");
  });

  it("emits StartInterval for --every", () => {
    expect(buildPlist(opts({ every: "30m" }), BIN)).toContain(
      "<key>StartInterval</key>\n\t<integer>1800</integer>"
    );
  });
});

// ---------------------------------------------------------------------------
// systemd
// ---------------------------------------------------------------------------

describe("buildServiceUnit", () => {
  const unit = buildServiceUnit(opts(), BIN);

  it("is a oneshot with an absolute ExecStart, pinned PATH and append: logging", () => {
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain("ExecStart=/opt/homebrew/bin/ace render --skip-on-battery");
    expect(unit).toMatch(/^Environment=PATH=\/.+$/m);
    expect(unit).toContain(`StandardOutput=append:${LOG}`);
    expect(unit).toContain(`StandardError=append:${LOG}`);
  });

  it("has no [Install] section — the timer pulls the service in", () => {
    expect(unit).not.toContain("[Install]");
    expect(unit).not.toContain("WantedBy=default.target");
  });

  it("quotes ExecStart tokens containing spaces", () => {
    const spaced = buildServiceUnit(opts({ logPath: "/tmp/ace test/ace.log" }), BIN);
    expect(spaced).toContain('StandardOutput=append:/tmp/ace test/ace.log');
    expect(buildServiceUnit(opts(), ["/opt/my ace/bin/ace"])).toContain(
      'ExecStart="/opt/my ace/bin/ace" render --skip-on-battery'
    );
  });
});

describe("buildTimerUnit", () => {
  it("emits a persistent calendar timer for hourly schedules", () => {
    const timer = buildTimerUnit(opts({ cronMinute: 48 }));
    expect(timer).toContain("OnCalendar=*-*-* *:48:00");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=dev.ace.render.service");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("zero-pads single-digit calendar fields", () => {
    expect(buildTimerUnit(opts({ at: "9:05" }))).toContain("OnCalendar=*-*-* 09:05:00");
    expect(buildTimerUnit(opts({ cronMinute: 5 }))).toContain("OnCalendar=*-*-* *:05:00");
  });

  it("seeds interval timers with OnBootSec so they actually fire", () => {
    const timer = buildTimerUnit(opts({ every: "90m" }));
    expect(timer).toContain("OnBootSec=5min");
    expect(timer).toContain("OnUnitActiveSec=90min");
    expect(timer).not.toContain("Persistent=true");
  });

  it("renders whole-hour intervals in hours", () => {
    expect(buildTimerUnit(opts({ every: "2h" }))).toContain("OnUnitActiveSec=2h");
  });
});

// ---------------------------------------------------------------------------
// cron
// ---------------------------------------------------------------------------

describe("buildCronLine", () => {
  it("emits expression, pinned PATH, redirect and the ace: tag", () => {
    const line = buildCronLine(opts({ cronMinute: 48 }), BIN);
    expect(line.startsWith("48 * * * * ")).toBe(true);
    expect(line).toContain("PATH=");
    expect(line).toContain("/opt/homebrew/bin/ace render --skip-on-battery");
    expect(line).toContain(`>> ${LOG} 2>&1`);
    expect(line.endsWith("# ace:dev.ace.render")).toBe(true);
  });

  it("supports daily and evenly-dividing intervals", () => {
    expect(buildCronLine(opts({ at: "09:30" }), BIN).startsWith("30 9 * * * ")).toBe(true);
    expect(buildCronLine(opts({ every: "15m" }), BIN).startsWith("*/15 * * * * ")).toBe(true);
    expect(buildCronLine(opts({ every: "1h" }), BIN).startsWith("0 * * * * ")).toBe(true);
    expect(buildCronLine(opts({ every: "4h" }), BIN).startsWith("0 */4 * * * ")).toBe(true);
  });

  it("rejects intervals cron cannot express evenly", () => {
    expect(() => buildCronLine(opts({ every: "30s" }), BIN)).toThrow(/granularity/);
    expect(() => buildCronLine(opts({ every: "7m" }), BIN)).toThrow(/divide an hour/);
    expect(() => buildCronLine(opts({ every: "5h" }), BIN)).toThrow(/divide a day/);
  });

  it("escapes % so cron does not treat it as a newline directive", () => {
    const line = buildCronLine(opts({ logPath: "/tmp/ace-100%/ace.log" }), BIN);
    expect(line).toContain("\\%");
    expect(line).not.toMatch(/[^\\]%/);
  });
});
