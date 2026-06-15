/**
 * LaTeX flattener: resolves \\input and \\include commands by inlining
 * sub-file content via regex string replacement.
 *
 * Zero npm dependencies.  ~100 lines.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const MAX_DEPTH = 20;

// ── Public API ────────────────────────────────────────────────────────

export function flatten(mainPath: string): string {
  const rootDir = path.dirname(path.resolve(mainPath));

  const mainSource = fs.readFileSync(mainPath, "utf-8");
  const includeOnly = parseIncludeOnly(mainSource);

  const resolving = new Set<string>();
  return resolveFile(mainPath, rootDir, resolving, includeOnly, 0);
}

// ── Core ──────────────────────────────────────────────────────────────

function resolveFile(
  filePath: string,
  currentDir: string,
  resolving: Set<string>,
  includeOnly: Set<string> | null,
  depth: number,
): string {
  if (depth > MAX_DEPTH) {
    throw new Error(`Max \\input depth (${String(MAX_DEPTH)}) exceeded at: ${filePath}`);
  }

  const absPath = resolveFilePath(filePath, currentDir);
  if (absPath === null) return ""; // missing → leave \input as-is

  if (resolving.has(absPath)) {
    throw new Error(`Circular reference detected: ${absPath}`);
  }
  resolving.add(absPath);

  try {
    const source = fs.readFileSync(absPath, "utf-8");
    const newDir = path.dirname(absPath);

    // Strip whole-line comments
    let processed = source.replace(/^\s*%.*$/gm, "");

    // Resolve \input and \include
    processed = processed.replace(
      /\\(input|include)\{([^}]*)\}/g,
      (match, cmd: string, filename: string) => {
        if (filename.includes("\\")) return match; // macro filename

        if (cmd === "include" && includeOnly !== null) {
          const clean = filename.trim();
          if (!includeOnly.has(clean) && !includeOnly.has(clean + ".tex")) {
            return "";
          }
        }

        const child = resolveFile(filename.trim(), newDir, resolving, includeOnly, depth + 1);
        return child === "" ? match : child;
      },
    );

    return processed;
  } finally {
    resolving.delete(absPath);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function resolveFilePath(filename: string, currentDir: string): string | null {
  const exact = path.resolve(currentDir, filename);
  if (fs.existsSync(exact)) return exact;

  if (!filename.endsWith(".tex")) {
    const withTex = path.resolve(currentDir, filename + ".tex");
    if (fs.existsSync(withTex)) return withTex;
  }

  return null;
}

function parseIncludeOnly(source: string): Set<string> | null {
  const match = /\\includeonly\s*\{([^}]*)\}/.exec(source);
  if (!match?.[1]) return null;

  const files = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return files.length > 0 ? new Set(files) : null;
}
