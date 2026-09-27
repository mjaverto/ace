// tests/helpers/isolate-state.ts — vitest setup: never touch the real ~/.local/state.
//
// ace keeps its index + temp files under $XDG_STATE_HOME/ace. Point that at a
// per-file temp dir; execa-spawned CLIs inherit it via process.env.

import { afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ace-state-home-"));
process.env["XDG_STATE_HOME"] = dir;

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
