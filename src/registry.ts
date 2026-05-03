// src/registry.ts — AgentSource registry

import type { AgentSource, EnumerateContext, SessionHandle } from "./types.js";

/**
 * Registry holds all registered AgentSource plugins.
 *
 * Not a true singleton (no module-level state) — callers create one instance
 * and share it. The built-in sources register themselves in src/sources/index.ts.
 */
export class Registry {
  private readonly _sources = new Map<string, AgentSource>();

  /**
   * Register an AgentSource. Throws if a source with the same name is already
   * registered (duplicate name is a programming error; explicit override is
   * handled by the caller removing the old one first).
   */
  register(source: AgentSource): void {
    if (this._sources.has(source.name)) {
      throw new Error(
        `[Registry] Duplicate source name: "${source.name}". ` +
          `Each source must have a unique name.`
      );
    }
    this._sources.set(source.name, source);
  }

  /**
   * Retrieve a source by name. Returns `undefined` if not found.
   */
  get(name: string): AgentSource | undefined {
    return this._sources.get(name);
  }

  /**
   * List all registered sources in registration order.
   */
  list(): AgentSource[] {
    return Array.from(this._sources.values());
  }

  /**
   * Return the source whose file-based plugin would match `absPath`.
   *
   * Matching is done by calling the source's `enumerate` with a synthetic
   * context containing just the file's directory as root, then checking
   * whether the session id equals absPath.
   *
   * For DB-backed plugins (e.g. opencode) this cannot match a file path, so
   * they should return false from a `matchesPath` static — but since the
   * interface has no such method, we rely on the enumerate result being empty
   * for them, or we use the heuristic that only file-based sources will ever
   * yield a SessionHandle with `id === absPath`.
   *
   * This is an O(n × files_in_dir) call; only used in render-one / doctor.
   */
  async match(absPath: string): Promise<AgentSource | undefined> {
    // We use the internal _matchPath helper if source exposes it, otherwise
    // fall back to a try-enumerate approach using the source's defaultRoots
    // as context. Since we don't want to actually walk, we define a tiny
    // synthetic enumerate call.
    //
    // For JSONL sources that use jsonlEnumerate internally, the SessionHandle
    // id is the absPath. We check that by constructing an EnumerateContext
    // with the file's parent dir as root and seeing if absPath is yielded.
    const { dirname } = await import("node:path");
    const dir = dirname(absPath);

    const noop = (): void => undefined;
    const logger = { debug: noop, info: noop, warn: noop, error: noop };
    const ctx: EnumerateContext = { roots: [dir], logger };

    for (const source of this._sources.values()) {
      try {
        for await (const handle of source.enumerate(ctx)) {
          if ((handle as SessionHandle).id === absPath) {
            return source;
          }
          // Only look at first handle to avoid full enumeration
          break;
        }
      } catch {
        // source failed to enumerate — skip
      }
    }

    return undefined;
  }
}
