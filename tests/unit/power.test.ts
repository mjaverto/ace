// tests/unit/power.test.ts — unit tests for the power gate (checkPower)
//
// Every probe is injected, so these never depend on the host's real power state.

import { describe, it, expect } from "vitest";
import { checkPower, formatPowerCheck } from "../../src/core/power.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PMSET_AC = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=12345678)\t100%; charged; 0:00 remaining present: true
`;

const PMSET_BATTERY = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=12345678)\t74%; discharging; 3:41 remaining present: true
`;

function enoent(path: string): Error {
  const err = new Error(`ENOENT: no such file or directory, open '${path}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

/** Linux sysfs stub: a map of relative sysfs paths → file contents. */
function linuxProbe(entries: string[], files: Record<string, string>) {
  return {
    platform: "linux" as NodeJS.Platform,
    powerSupplyDir: "/fake/power_supply",
    readDir: (dir: string) => {
      if (dir !== "/fake/power_supply") throw enoent(dir);
      return entries;
    },
    readFile: (file: string) => {
      const content = files[file];
      if (content === undefined) throw enoent(file);
      return content;
    },
  };
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

describe("checkPower — macOS", () => {
  it("runs when pmset reports AC power", () => {
    const check = checkPower({ platform: "darwin", pmset: () => PMSET_AC });
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(true);
    expect(check.detail).toContain("external power");
    expect(check.detail).toContain("AC Power");
  });

  it("skips when pmset reports battery power", () => {
    const check = checkPower({ platform: "darwin", pmset: () => PMSET_BATTERY });
    expect(check.ok).toBe(false);
    expect(check.detected).toBe(true);
    expect(check.detail).toContain("on battery power");
  });

  it("fails open with detected: false when pmset is missing", () => {
    const check = checkPower({
      platform: "darwin",
      pmset: () => {
        throw enoent("pmset");
      },
    });
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("pmset");
    expect(check.detail).toContain("undetected");
  });

  it("fails open with detected: false when pmset output is unparseable", () => {
    const check = checkPower({ platform: "darwin", pmset: () => "totally unexpected output\n" });
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("Now drawing from");
  });
});

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

describe("checkPower — Linux", () => {
  it("runs when no battery is present (desktop/server such as openclaw)", () => {
    const check = checkPower(linuxProbe([], {}));
    expect(check.ok).toBe(true);
    // No battery is a positive measurement, not a fail-open guess.
    expect(check.detected).toBe(true);
    expect(check.detail).toContain("no battery present");
  });

  it("runs when only non-battery supplies are present (AC adapter only)", () => {
    const check = checkPower(linuxProbe(["AC", "ADP1"], {}));
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(true);
    expect(check.detail).toContain("no battery present");
  });

  it("skips when a battery reports Discharging", () => {
    const check = checkPower(
      linuxProbe(["AC", "BAT0"], { "/fake/power_supply/BAT0/status": "Discharging\n" })
    );
    expect(check.ok).toBe(false);
    expect(check.detected).toBe(true);
    expect(check.detail).toContain("BAT0 status=Discharging");
  });

  it("runs when the battery is Charging", () => {
    const check = checkPower(
      linuxProbe(["BAT0"], { "/fake/power_supply/BAT0/status": "Charging\n" })
    );
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(true);
    expect(check.detail).toContain("BAT0=Charging");
  });

  it("skips when any of several batteries is discharging", () => {
    const check = checkPower(
      linuxProbe(["BAT0", "BAT1"], {
        "/fake/power_supply/BAT0/status": "Full\n",
        "/fake/power_supply/BAT1/status": "Discharging\n",
      })
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("BAT1 status=Discharging");
  });

  it("fails open with detected: false when the battery status is unreadable", () => {
    const check = checkPower(linuxProbe(["BAT0"], {}));
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("status unreadable");
    expect(check.detail).toContain("BAT0");
  });

  it("fails open with detected: false when the status is Unknown", () => {
    const check = checkPower(
      linuxProbe(["BAT0"], { "/fake/power_supply/BAT0/status": "Unknown\n" })
    );
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("indeterminate");
  });

  it("fails open with detected: false when the sysfs directory is unreadable", () => {
    const check = checkPower({
      platform: "linux",
      powerSupplyDir: "/fake/power_supply",
      readDir: () => {
        throw enoent("/fake/power_supply");
      },
    });
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("not readable");
  });
});

// ---------------------------------------------------------------------------
// Other platforms + formatting
// ---------------------------------------------------------------------------

describe("checkPower — misc", () => {
  it("fails open on platforms with no probe", () => {
    const check = checkPower({ platform: "win32" });
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("win32");
  });

  it("never throws, even when a probe throws a non-Error", () => {
    const check = checkPower({
      platform: "darwin",
      pmset: () => {
        throw "boom";
      },
    });
    expect(check.ok).toBe(true);
    expect(check.detected).toBe(false);
    expect(check.detail).toContain("boom");
  });

  it("always carries a non-empty detail", () => {
    for (const check of [
      checkPower({ platform: "darwin", pmset: () => PMSET_AC }),
      checkPower({ platform: "darwin", pmset: () => PMSET_BATTERY }),
      checkPower(linuxProbe([], {})),
      checkPower({ platform: "win32" }),
    ]) {
      expect(check.detail.length).toBeGreaterThan(0);
    }
  });

  it("formats a one-line log message for both outcomes", () => {
    expect(formatPowerCheck(checkPower({ platform: "darwin", pmset: () => PMSET_AC }))).toMatch(
      /^power: proceeding — /
    );
    expect(
      formatPowerCheck(checkPower({ platform: "darwin", pmset: () => PMSET_BATTERY }))
    ).toMatch(/^power: skipping — /);
  });
});
