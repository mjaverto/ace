// src/sources/index.ts — registers all four built-in sources and exposes plugin loader

import type { AgentSource } from "../types.js";
import { Registry } from "../registry.js";
import { claudeSource } from "./claude.js";
import { codexSource } from "./codex.js";
import { piSource } from "./pi.js";
import { opencodeSource } from "./opencode.js";

// ---------------------------------------------------------------------------
// Default registry factory
// ---------------------------------------------------------------------------

export function createDefaultRegistry(): Registry {
  const r = new Registry();
  r.register(claudeSource);
  r.register(codexSource);
  r.register(piSource);
  r.register(opencodeSource);
  return r;
}

// ---------------------------------------------------------------------------
// Plugin loader
// ---------------------------------------------------------------------------

/**
 * Dynamically import each specifier and register the resulting AgentSource
 * on the given registry. Each module must default-export either:
 *   - An `AgentSource` (has `.name` + `.enumerate` + `.render`)
 *   - A factory function that returns an `AgentSource`
 */
export async function loadPlugins(
  registry: Registry,
  specifiers: string[]
): Promise<void> {
  for (const specifier of specifiers) {
    let mod: { default?: unknown };
    try {
      mod = (await import(specifier)) as { default?: unknown };
    } catch (err) {
      throw new Error(
        `[loadPlugins] Failed to import plugin "${specifier}": ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }

    let exported = mod.default;
    if (exported === undefined) {
      throw new Error(
        `[loadPlugins] Plugin "${specifier}" has no default export. ` +
          `Expected an AgentSource or a factory function returning one.`
      );
    }

    // If it's a factory function, call it
    if (typeof exported === "function") {
      exported = (exported as () => AgentSource)();
    }

    // Basic duck-type check
    const source = exported as AgentSource;
    if (
      typeof source !== "object" ||
      source === null ||
      typeof source.name !== "string" ||
      typeof source.enumerate !== "function" ||
      typeof source.render !== "function"
    ) {
      throw new Error(
        `[loadPlugins] Plugin "${specifier}" default export is not a valid AgentSource. ` +
          `Must have: name (string), enumerate (function), render (function).`
      );
    }

    registry.register(source);
  }
}

// Re-export individual sources for convenience
export { claudeSource, codexSource, piSource, opencodeSource };
