// src/cli.ts — ace CLI entry point (citty)

import { defineCommand, runMain } from "citty";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "./config/load.js";
import { runRender } from "./core/render.js";
import { expandHome } from "./shared/util.js";
import { createDefaultRegistry, loadPlugins } from "./sources/index.js";
import {
  installLaunchd,
  uninstallLaunchd,
  installSystemd,
  uninstallSystemd,
  installCron,
  uninstallCron,
  resolveLogPath,
  tailLog,
} from "./schedule/index.js";
import type { Logger } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(verbose = false): Logger {
  return {
    debug: verbose
      ? (...a: unknown[]) => process.stderr.write("[debug] " + a.join(" ") + "\n")
      : () => undefined,
    info: (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n"),
    warn: (...a: unknown[]) => process.stderr.write("[warn] " + a.join(" ") + "\n"),
    error: (...a: unknown[]) => process.stderr.write("[error] " + a.join(" ") + "\n"),
  };
}

async function packageVersion(): Promise<string> {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const raw = await fs.readFile(pkgUrl, "utf8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Normalize citty string args that can be repeated
function toArray(val: string | string[] | boolean | undefined): string[] {
  if (!val) return [];
  if (typeof val === "boolean") return [];
  return Array.isArray(val) ? val : [val];
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

// ---- render ----------------------------------------------------------------

const renderCmd = defineCommand({
  meta: { name: "render", description: "Render all configured sources to Markdown" },
  args: {
    config: { type: "string", description: "Path to config file" },
    source: { type: "string", description: "Restrict to a specific source" },
    out: { type: "string", description: "Override output directory" },
    "dry-run": { type: "boolean", description: "Preview without writing", default: false },
    force: { type: "boolean", description: "Ignore incremental cache", default: false },
    strategy: { type: "string", description: "mtime or index" },
    plugin: { type: "string", description: "Extra plugin module" },
    concurrency: { type: "string", description: "Max concurrent renders" },
    json: {
      type: "boolean",
      description: "Emit NDJSON results to stdout",
      default: false,
    },
    verbose: { type: "boolean", description: "Debug logging", default: false },
  },
  async run({ args }) {
    const logger = makeLogger(args.verbose);

    let config = await loadConfig(args.config as string | undefined).catch(
      (err: unknown) => {
        process.stderr.write(
          `ace: config error — ${(err as Error).message}\n`
        );
        process.exit(2);
      }
    );

    if (args.out) {
      config = { ...config, output: expandHome(args.out as string) };
    }
    const strat = args.strategy as string | undefined;
    if (strat === "mtime" || strat === "index") {
      config = { ...config, strategy: strat };
    }

    const registry = createDefaultRegistry();
    const plugins = toArray(args.plugin);
    if (plugins.length) await loadPlugins(registry, plugins);

    const sources = toArray(args.source);
    const concurrencyArg = args.concurrency as string | undefined;
    const concurrency = concurrencyArg ? parseInt(concurrencyArg, 10) : undefined;

    const report = await runRender({
      config,
      registry,
      logger,
      dryRun: args["dry-run"],
      force: args.force,
      ...(strat === "mtime" || strat === "index"
        ? { strategyOverride: strat }
        : {}),
      ...(sources.length === 1 ? { sourceFilter: sources[0] } : {}),
      ...(concurrency !== undefined ? { concurrency } : {}),
    });

    if (args.json) {
      for (const s of report.sources) {
        for (const e of s.errors) {
          process.stdout.write(
            JSON.stringify({
              source: s.sourceName,
              outPath: null,
              status: "error",
              error: e.error,
            }) + "\n"
          );
        }
        for (let i = 0; i < s.rendered; i++) {
          process.stdout.write(
            JSON.stringify({
              source: s.sourceName,
              outPath: null,
              status: "rendered",
            }) + "\n"
          );
        }
        for (let i = 0; i < s.skipped; i++) {
          process.stdout.write(
            JSON.stringify({
              source: s.sourceName,
              outPath: null,
              status: "skipped",
            }) + "\n"
          );
        }
      }
    } else {
      for (const s of report.sources) {
        process.stderr.write(
          `  ${s.sourceName}: rendered=${s.rendered} skipped=${s.skipped} errors=${s.errors.length}\n`
        );
      }
      process.stderr.write(
        `\nrendered=${report.totalRendered} skipped=${report.totalSkipped} errors=${report.totalErrors} (${report.durationMs}ms)\n`
      );
    }

    if (report.totalErrors > 0) process.exit(3);
  },
});

// ---- render-one ------------------------------------------------------------

const renderOneCmd = defineCommand({
  meta: {
    name: "render-one",
    description: "Render a single JSONL file or stdin to Markdown",
  },
  args: {
    source: {
      type: "string",
      description: "Source name (required unless path is unambiguous)",
    },
    o: {
      type: "string",
      description: "Output file path, or - for stdout",
      default: "-",
    },
    _: {
      type: "positional",
      description: "Path to JSONL file, or - for stdin",
      required: false,
    },
  },
  async run({ args }) {
    const inputArg = (args._ as unknown as string | undefined) ?? "-";

    if (!args.source) {
      process.stderr.write("ace render-one: --source <name> is required\n");
      process.exit(1);
    }

    if (args.source === "opencode") {
      process.stderr.write(
        "ace render-one: opencode reads from a SQLite database — " +
          "use `ace render --source opencode` instead.\n"
      );
      process.exit(1);
    }

    const registry = createDefaultRegistry();
    const source = registry.get(args.source);
    if (!source) {
      process.stderr.write(
        `ace render-one: unknown source "${args.source}"\n`
      );
      process.exit(4);
    }

    let inputPath: string;
    let tmpPath: string | undefined;

    if (inputArg === "-") {
      tmpPath = path.join(
        os.tmpdir(),
        `ace-render-one-${process.pid}.jsonl`
      );
      const chunks: Buffer[] = [];
      process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
      await new Promise<void>((resolve, reject) => {
        process.stdin.on("end", resolve);
        process.stdin.on("error", reject);
      });
      await fs.writeFile(tmpPath, Buffer.concat(chunks));
      inputPath = tmpPath;
    } else {
      inputPath = path.resolve(inputArg);
    }

    try {
      const stat = await fs.stat(inputPath);
      const noop = (): void => undefined;
      const logger: Logger = {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
      };

      const handle = {
        id: inputPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
        outputRelPath: path.basename(inputPath, ".jsonl"),
        payload: inputPath,
      };

      const result = await source.render(handle, {
        outPath: inputPath,
        now: new Date(),
        truncate: { toolOutput: 4000, toolInput: 4000 },
        logger,
      });

      const { serializeFrontmatter } = await import("./frontmatter.js");
      const output =
        serializeFrontmatter(result.frontmatter) + result.markdown;

      if (args.o === "-") {
        process.stdout.write(output);
      } else {
        await fs.writeFile(path.resolve(args.o as string), output, "utf8");
      }
    } finally {
      if (tmpPath) {
        await fs.unlink(tmpPath).catch(() => undefined);
      }
    }
  },
});

// ---- list-sources ----------------------------------------------------------

const listSourcesCmd = defineCommand({
  meta: { name: "list-sources", description: "List all registered sources" },
  args: {
    json: { type: "boolean", description: "Emit JSON array", default: false },
    plugin: { type: "string", description: "Extra plugin (repeatable)" },
    config: { type: "string", description: "Config file path" },
  },
  async run({ args }) {
    const registry = createDefaultRegistry();
    const plugins = toArray(args.plugin);
    if (plugins.length) await loadPlugins(registry, plugins);

    const home = os.homedir();
    const sources = registry.list().map((s) => ({
      name: s.name,
      displayName: s.displayName,
      defaultRoot: s.defaultRoots(home)[0] ?? "(none)",
    }));

    if (args.json) {
      process.stdout.write(JSON.stringify(sources, null, 2) + "\n");
      return;
    }

    const nameW = Math.max(6, ...sources.map((s) => s.name.length));
    const dispW = Math.max(12, ...sources.map((s) => s.displayName.length));
    const rootW = 40;

    const header = `${"Name".padEnd(nameW)}  ${"Display Name".padEnd(dispW)}  ${"Default Root".padEnd(rootW)}`;
    const sep =
      `${"-".repeat(nameW)}  ${"-".repeat(dispW)}  ${"-".repeat(rootW)}`;

    process.stdout.write(header + "\n" + sep + "\n");
    for (const s of sources) {
      process.stdout.write(
        `${s.name.padEnd(nameW)}  ${s.displayName.padEnd(dispW)}  ${s.defaultRoot}\n`
      );
    }
  },
});

// ---- doctor ----------------------------------------------------------------

const doctorCmd = defineCommand({
  meta: {
    name: "doctor",
    description:
      "Validate config, probe source roots, test mtime preservation on output FS",
  },
  args: {
    config: { type: "string", description: "Path to config file" },
    plugin: { type: "string", description: "Extra plugin (repeatable)" },
  },
  async run({ args }) {
    let exitCode = 0;
    const pass = (msg: string): void =>
      void process.stdout.write(`  [PASS] ${msg}\n`);
    const fail = (msg: string): void => {
      process.stdout.write(`  [FAIL] ${msg}\n`);
      exitCode = 2;
    };
    const warn = (msg: string): void =>
      void process.stdout.write(`  [WARN] ${msg}\n`);

    process.stdout.write("ace doctor\n\n");

    // 1. Config
    process.stdout.write("Config\n");
    let config;
    try {
      config = await loadConfig(args.config as string | undefined);
      pass(`Config loaded (output: ${config.output})`);
    } catch (err) {
      fail(`Config error: ${(err as Error).message}`);
      process.exit(2);
    }

    // 2. Source roots
    process.stdout.write("\nSource roots\n");
    const registry = createDefaultRegistry();
    const plugins = toArray(args.plugin);
    if (plugins.length) await loadPlugins(registry, plugins);

    const home = os.homedir();
    for (const source of registry.list()) {
      const sourceConfig = config.sources[source.name];
      const roots =
        sourceConfig?.roots?.length
          ? sourceConfig.roots
          : source.defaultRoots(home);

      for (const root of roots) {
        const expanded = expandHome(root);
        try {
          await fs.access(expanded);
          pass(`${source.name}: ${expanded}`);
        } catch {
          warn(
            `${source.name}: ${expanded} (not found — source may not be installed)`
          );
        }
      }
    }

    // 3. Output dir + mtime probe
    process.stdout.write("\nOutput filesystem\n");
    const outputDir = expandHome(config.output);
    try {
      await fs.mkdir(outputDir, { recursive: true });
      pass(`Output dir accessible: ${outputDir}`);
    } catch (err) {
      fail(`Cannot access/create output dir: ${(err as Error).message}`);
      process.exit(2);
    }

    const tmpFile = path.join(
      outputDir,
      `.ace-doctor-probe-${process.pid}`
    );
    try {
      await fs.writeFile(tmpFile, "probe", "utf8");
      const targetMtime = Date.now() - 5000;
      await fs.utimes(tmpFile, new Date(targetMtime), new Date(targetMtime));
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      const stat = await fs.stat(tmpFile);
      const delta = Math.abs(stat.mtimeMs - targetMtime);
      if (delta < 2000) {
        pass(`mtime preserved on output FS (delta=${delta}ms)`);
      } else {
        warn(
          `mtime NOT preserved on output FS (delta=${delta}ms). ` +
            `Recommend: use --strategy index`
        );
      }
    } catch (err) {
      warn(`mtime probe failed: ${(err as Error).message}`);
    } finally {
      await fs.unlink(tmpFile).catch(() => undefined);
    }

    process.stdout.write(
      `\n${exitCode === 0 ? "All checks passed." : "Some checks failed — see [FAIL] lines above."}\n`
    );
    process.exit(exitCode);
  },
});

// ---- init ------------------------------------------------------------------

const initCmd = defineCommand({
  meta: { name: "init", description: "Write a starter ace.config.yaml" },
  args: {
    force: {
      type: "boolean",
      description: "Overwrite existing config",
      default: false,
    },
  },
  async run({ args }) {
    const dest = path.join(process.cwd(), "ace.config.yaml");

    try {
      await fs.access(dest);
      if (!args.force) {
        process.stderr.write(
          `ace init: ${dest} already exists. Use --force to overwrite.\n`
        );
        process.exit(1);
      }
    } catch {
      // file doesn't exist — proceed
    }

    const content = `# ace.config.yaml — Agent Conversation Exporter
# Run \`ace doctor\` to validate this config.

# Output directory for rendered Markdown files.
# Uncomment the Google Drive path for cloud sync:
# output: ~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/_Brain/agent-conversations
output: ./agent-md-out

# Incrementality strategy: mtime (default) or index.
# Use "index" if your output FS doesn't preserve mtimes (e.g. some cloud drives).
strategy: mtime

# Max concurrent renders. "auto" uses os.cpus().length.
concurrency: auto

truncate:
  toolOutput: 4000
  toolInput: 4000

sources:
  claude:
    enabled: true
    roots:
      - ~/.claude/projects
    exclude:
      - "**/.tmp.*"
  codex:
    enabled: true
    roots:
      - ~/.codex/sessions
      - ~/.codex/archived_sessions
  pi:
    enabled: true
    roots:
      - ~/.pi/agent/sessions
  opencode:
    enabled: true
    roots:
      - ~/.local/share/opencode/opencode.db

# Extra plugins — file paths or npm package names.
plugins: []
`;

    await fs.writeFile(dest, content, "utf8");
    process.stdout.write(`ace init: wrote ${dest}\n`);
    process.stdout.write(
      `Next: edit the file, then run \`ace doctor\` to validate.\n`
    );
  },
});

// ---- install ---------------------------------------------------------------

const installCmd = defineCommand({
  meta: {
    name: "install",
    description: "Install a scheduler job (launchd | systemd | cron)",
  },
  args: {
    _: {
      type: "positional",
      description: "Scheduler kind: launchd | systemd | cron",
      required: true,
    },
    at: { type: "string", description: "Daily time HH:MM" },
    every: { type: "string", description: "Repeat interval e.g. 1h, 15m, 30s" },
    "cron-minute": {
      type: "string",
      description: "Hourly at minute N (e.g. 48 → runs at :48 every hour)",
    },
    label: {
      type: "string",
      description: "Job label / service name",
      default: "dev.ace.render",
    },
    log: { type: "string", description: "Log file path override" },
    "run-now": {
      type: "boolean",
      description: "Trigger job immediately after install",
      default: false,
    },
    "dry-run": {
      type: "boolean",
      description: "Print artifact + commands without executing",
      default: false,
    },
  },
  async run({ args }) {
    const kind = args._ as unknown as string;
    if (!kind || !["launchd", "systemd", "cron"].includes(kind)) {
      process.stderr.write(
        "ace install: kind must be one of: launchd, systemd, cron\n"
      );
      process.exit(1);
    }

    const cronMinuteRaw = args["cron-minute"] as string | undefined;
    const cronMinute =
      cronMinuteRaw !== undefined ? parseInt(cronMinuteRaw, 10) : undefined;

    const atArg = args.at as string | undefined;
    const everyArg = args.every as string | undefined;
    const logArg = args.log as string | undefined;

    const shared = {
      label: args.label as string,
      ...(atArg !== undefined ? { at: atArg } : {}),
      ...(everyArg !== undefined ? { every: everyArg } : {}),
      ...(cronMinute !== undefined ? { cronMinute } : {}),
      ...(logArg !== undefined ? { logPath: logArg } : {}),
      runNow: args["run-now"] as boolean,
      dryRun: args["dry-run"] as boolean,
    };

    switch (kind) {
      case "launchd":
        await installLaunchd(shared);
        break;
      case "systemd":
        await installSystemd(shared);
        break;
      case "cron":
        installCron(shared);
        break;
    }
  },
});

// ---- uninstall -------------------------------------------------------------

const uninstallCmd = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove a scheduler install",
  },
  args: {
    _: {
      type: "positional",
      description: "Scheduler kind: launchd | systemd | cron",
      required: true,
    },
    label: {
      type: "string",
      description: "Job label",
      default: "dev.ace.render",
    },
  },
  async run({ args }) {
    const kind = args._ as unknown as string;
    if (!kind || !["launchd", "systemd", "cron"].includes(kind)) {
      process.stderr.write(
        "ace uninstall: kind must be one of: launchd, systemd, cron\n"
      );
      process.exit(1);
    }

    const label = args.label as string;
    switch (kind) {
      case "launchd":
        await uninstallLaunchd(label);
        break;
      case "systemd":
        await uninstallSystemd(label);
        break;
      case "cron":
        uninstallCron(label);
        break;
    }
  },
});

// ---- logs ------------------------------------------------------------------

const logsCmd = defineCommand({
  meta: { name: "logs", description: "Show or tail the ace log file" },
  args: {
    tail: {
      type: "boolean",
      description: "Follow (tail -f) the log",
      default: false,
    },
    log: { type: "string", description: "Override log file path" },
  },
  async run({ args }) {
    const logPath = resolveLogPath(args.log as string | undefined);

    if (args.tail) {
      tailLog(logPath);
      return;
    }

    if (process.platform === "linux" && !args.log) {
      process.stderr.write(
        `Tip: on Linux you can also view logs with:\n` +
          `  journalctl --user -u dev.ace.render\n\n`
      );
    }

    try {
      const content = await fs.readFile(logPath, "utf8");
      process.stdout.write(content);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write(
          `ace logs: log file not found: ${logPath}\n` +
            `Run \`ace render\` first to generate a log.\n`
        );
        process.exit(1);
      }
      throw err;
    }
  },
});

// ---------------------------------------------------------------------------
// Root command + entry point
// ---------------------------------------------------------------------------

const main = defineCommand({
  meta: {
    name: "ace",
    description:
      "Agent Conversation Exporter — render AI agent transcripts to Markdown",
    version: "0.0.0", // citty reads this; actual version read dynamically below
  },
  args: {
    version: {
      type: "boolean",
      description: "Print version and exit",
      alias: "v",
      default: false,
    },
  },
  async run({ args }) {
    if (args.version) {
      const v = await packageVersion();
      process.stdout.write(`${v}\n`);
    }
  },
  subCommands: {
    render: renderCmd,
    "render-one": renderOneCmd,
    "list-sources": listSourcesCmd,
    doctor: doctorCmd,
    init: initCmd,
    install: installCmd,
    uninstall: uninstallCmd,
    logs: logsCmd,
  },
});

void runMain(main);
