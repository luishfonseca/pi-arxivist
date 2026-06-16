/**
 * LaTeX flattener: resolves \\input and \\include commands by inlining
 * sub-file content via regex string replacement.
 *
 * Zero npm dependencies.  ~120 lines.
 *
 * All file I/O is async — nothing blocks the event loop.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

const MAX_DEPTH = 20;

// ── Public API ────────────────────────────────────────────────────────

export async function flatten(mainPath: string): Promise<string> {
  const rootDir = path.dirname(path.resolve(mainPath));

  const mainSource = await fs.readFile(mainPath, "utf-8");
  const includeOnly = parseIncludeOnly(mainSource);

  const resolving = new Set<string>();
  return resolveFile(mainPath, rootDir, resolving, includeOnly, 0);
}

// ── Core ──────────────────────────────────────────────────────────────

async function resolveFile(
  filePath: string,
  currentDir: string,
  resolving: Set<string>,
  includeOnly: Set<string> | null,
  depth: number,
): Promise<string> {
  if (depth > MAX_DEPTH) {
    throw new Error(`Max \\input depth (${String(MAX_DEPTH)}) exceeded at: ${filePath}`);
  }

  const result = await readTexFile(filePath, currentDir);
  if (result === null) return ""; // missing → leave \input as-is

  const absPath = result.absPath;

  if (resolving.has(absPath)) {
    throw new Error(`Circular reference detected: ${absPath}`);
  }
  resolving.add(absPath);

  try {
    const source = result.source;
    const newDir = path.dirname(absPath);

    // Strip whole-line comments
    let processed = source.replace(/^\s*%.*$/gm, "");

    // Resolve \input and \include asynchronously.
    // String.replace can't take an async callback, so we collect matches
    // first, resolve children, then apply replacements in reverse order.
    processed = await resolveInputs(processed, newDir, resolving, includeOnly, depth);

    return processed;
  } finally {
    resolving.delete(absPath);
  }
}

// ── Async input resolution ────────────────────────────────────────────

const INPUT_REGEX = /\\(input|include)\{([^}]*)\}/g;

interface Match {
  start: number;
  end: number;
  cmd: string;
  filename: string;
  fullMatch: string;
}

async function resolveInputs(
  source: string,
  newDir: string,
  resolving: Set<string>,
  includeOnly: Set<string> | null,
  depth: number,
): Promise<string> {
  // Collect all matches
  const matches: Match[] = [];
  let m: RegExpExecArray | null;
  while ((m = INPUT_REGEX.exec(source)) !== null) {
    matches.push({
      start: m.index,
      end: INPUT_REGEX.lastIndex,
      cmd: m[1] ?? "",
      filename: m[2] ?? "",
      fullMatch: m[0],
    });
  }

  if (matches.length === 0) return source;

  // Resolve each child asynchronously (depth-first, sequential).
  // Siblings are independent but resolving them in parallel would
  // complicate the `resolving` set management — sequential is simple
  // and fast enough for the typical number of includes in a paper.
  const resolved: string[] = [];
  for (const match of matches) {
    resolved.push(await resolveMatch(match, newDir, resolving, includeOnly, depth));
  }

  // Apply replacements in reverse order to preserve indices
  let result = source;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const r = resolved[i];
    if (m && r !== undefined) {
      result = result.slice(0, m.start) + r + result.slice(m.end);
    }
  }

  return result;
}

async function resolveMatch(
  match: Match,
  newDir: string,
  resolving: Set<string>,
  includeOnly: Set<string> | null,
  depth: number,
): Promise<string> {
  // Skip macro-based filenames (e.g. \input{\jobname-foo})
  if (match.filename.includes("\\")) return match.fullMatch;

  // Respect \includeonly allowlist
  if (match.cmd === "include" && includeOnly !== null) {
    const clean = match.filename.trim();
    if (!includeOnly.has(clean) && !includeOnly.has(clean + ".tex")) {
      return "";
    }
  }

  const child = await resolveFile(match.filename.trim(), newDir, resolving, includeOnly, depth + 1);
  return child === "" ? match.fullMatch : child;
}

// ── Helpers ───────────────────────────────────────────────────────────

interface ReadResult {
  source: string;
  absPath: string;
}

async function readTexFile(filename: string, currentDir: string): Promise<ReadResult | null> {
  const candidates = [path.resolve(currentDir, filename)];
  if (!filename.endsWith(".tex")) {
    candidates.push(path.resolve(currentDir, filename + ".tex"));
  }

  for (const candidate of candidates) {
    try {
      const source = await fs.readFile(candidate, "utf-8");
      return { source, absPath: candidate };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      // ENOENT → try next candidate
    }
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
