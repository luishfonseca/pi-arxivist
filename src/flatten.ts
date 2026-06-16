/**
 * LaTeX flattener: resolves \\input and \\include sentinels
 * embedded during graph parsing.
 *
 * Takes a pre-parsed graph from parseLatexGraph() and performs
 * a post-order DFS from the root, replacing `\0i/path\0` and
 * `\0I/path\0` sentinels with the resolved child content.
 *
 * Circular references are detected. \\includeonly is respected.
 */

import type { ParsedGraph } from "./utils.js";

const MAX_DEPTH = 20;

/** Matches sentinel tokens: `\0` + `i`|`I` + path + `\0` (no `g` flag — position tracked manually). */
const SENTINEL = /\0([iI])([^\0]+)\0/;

/**
 * Flatten a pre-parsed LaTeX graph into a single source string.
 *
 * @param graph Result from parseLatexGraph().
 * @returns The fully inlined LaTeX source.
 */
export function flatten(graph: ParsedGraph): string {
  const { rootPath, files, includeOnly } = graph;
  const resolved = new Map<string, string>();
  const resolving = new Set<string>();

  return resolve(rootPath, 0);

  function resolve(absPath: string, depth: number): string {
    if (depth > MAX_DEPTH) {
      throw new Error(`Max \\input depth (${String(MAX_DEPTH)}) exceeded at: ${absPath}`);
    }

    // Already resolved? (memoized)
    const cached = resolved.get(absPath);
    if (cached !== undefined) return cached;

    const content = files.get(absPath);
    if (content === undefined) return "";

    // Circular reference detection
    if (resolving.has(absPath)) {
      throw new Error(`Circular reference detected: ${absPath}`);
    }
    resolving.add(absPath);

    try {
      let result = "";
      let pos = 0;
      let m: RegExpExecArray | null;

      while ((m = SENTINEL.exec(content.slice(pos))) !== null) {
        const cmd = m[1];
        const childPath = m[2];
        if (cmd === undefined || childPath === undefined) continue;

        // Copy text before this sentinel
        result += content.slice(pos, pos + m.index);

        // Respect \includeonly for \include commands
        let include = true;
        if (cmd === "I" && includeOnly !== null) {
          const basename = childPath.replace(/\.tex$/, "");
          const nameOnly = basename.split("/").pop() ?? basename;
          include = includeOnly.has(nameOnly) || includeOnly.has(nameOnly + ".tex");
        }
        if (include) {
          result += resolve(childPath, depth + 1);
        }

        pos += m.index + m[0].length;
      }

      // Append remaining text after last sentinel
      result += content.slice(pos);

      resolved.set(absPath, result);
      return result;
    } finally {
      resolving.delete(absPath);
    }
  }
}
