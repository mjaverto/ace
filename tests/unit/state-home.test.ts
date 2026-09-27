// tests/unit/state-home.test.ts — XDG state dir resolution shared by the index and log path

import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { stateHome } from "../../src/shared/util.js";

const saved = process.env["XDG_STATE_HOME"];
afterEach(() => { process.env["XDG_STATE_HOME"] = saved; });

describe("stateHome", () => {
  it("falls back to ~/.local/state when XDG_STATE_HOME is empty", () => {
    process.env["XDG_STATE_HOME"] = "";
    expect(stateHome()).toBe(path.join(os.homedir(), ".local", "state"));
  });
});
