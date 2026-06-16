import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

// ── Arxiv ID parsing ─────────────────────────────────────────────────

/**
 * Parse an arxiv paper identifier from various input formats.
 *
 * Accepts:
 * - Bare ID: "1203.6859", "1203.6859v3", "hep-th/9901001"
 * - Abstract URL: "https://arxiv.org/abs/1203.6859"
 * - PDF URL: "https://arxiv.org/pdf/1203.6859v3"
 *
 * Returns the canonical ID. Format validation is deliberately minimal —
 * invalid IDs produce a 404 from arxiv at download time.
 *
 * Throws only on empty input.
 */
export function parseArxivId(raw: string): string {
  const trimmed = raw.trim();

  if (!trimmed) {
    throw new Error("Empty arxiv ID.");
  }

  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^/\s?#]+)/i.exec(trimmed);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  return trimmed;
}

// ── LaTeX graph parsing ───────────────────────────────────────────────

/** Regex for \\input and \\include commands. */
const INPUT_REGEX = /\\(input|include)\{([^}]*)\}/g;

/** Sentinel inserted in place of resolved \\input/\\include references. */
const SENTINEL_DELIM = "\0";

/**
 * Result of parsing all .tex files in a source directory.
 *
 * `files` maps absolute paths to sentinelized content.
 * Whole-line comments (`%...`) are stripped, then every resolved
 * \\input{foo} is replaced by `\0i/path/to/foo.tex\0`
 * and every resolved \\include{bar} by `\0I/path/to/bar.tex\0`.
 * Unresolvable references and macro-based filenames are left as-is.
 */
export interface ParsedGraph {
  /** Absolute path to the root .tex file (largest reachable set). */
  rootPath: string;
  /** Map from absolute path to sentinelized content. */
  files: Map<string, string>;
  /** Parsed \\includeonly allowlist from the root (null if absent). */
  includeOnly: Set<string> | null;
}

/**
 * Parse all .tex files in `rootDir`, build a dependency graph, and
 * pick the indegree-0 node with the largest reachable set as the root.
 *
 * Throws if no .tex files are found or every file has an incoming edge.
 */
export function parseLatexGraph(rootDir: string): ParsedGraph {
  // 1. Find all .tex files recursively
  const texFiles = findAllTexFiles(rootDir);

  if (texFiles.size === 0) {
    throw new Error(`No .tex files found in ${rootDir}`);
  }

  // 2. Read each file, replace resolved \input/\include with sentinels,
  //    and build adjacency + indegree maps.
  const adjacency = new Map<string, string[]>(); // absPath → [childPath, ...]
  const indegree = new Map<string, number>(); // absPath → count
  const files = new Map<string, string>(); // absPath → sentinelized content

  // Initialize indegree for all files (so unref'd files still show up)
  for (const absPath of texFiles) {
    indegree.set(absPath, 0);
  }

  for (const absPath of texFiles) {
    let content = fs.readFileSync(absPath, "utf-8");

    // Strip whole-line comments (same behaviour as old flattener)
    content = content.replace(/^\s*%.*$/gm, "");

    const dir = path.dirname(absPath);
    const refs: string[] = [];

    let result = "";
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    INPUT_REGEX.lastIndex = 0;
    while ((m = INPUT_REGEX.exec(content)) !== null) {
      const cmd = m[1];
      const name = m[2];
      if (cmd === undefined || name === undefined) continue;

      // Skip macro-based filenames (e.g. \input{\jobname-foo})
      if (name.includes("\\")) {
        // Leave as-is: copy everything up to and including this match
        result += content.slice(lastIndex, m.index + m[0].length);
        lastIndex = m.index + m[0].length;
        continue;
      }

      const resolved = resolveTexFile(name.trim(), dir);
      if (resolved && texFiles.has(resolved)) {
        // Replace with sentinel
        result += content.slice(lastIndex, m.index);
        const prefix = cmd === "include" ? "I" : "i";
        result += `${SENTINEL_DELIM}${prefix}${resolved}${SENTINEL_DELIM}`;
        refs.push(resolved);
      } else {
        // Unresolvable — leave original \input/\include text as-is
        result += content.slice(lastIndex, m.index + m[0].length);
      }
      lastIndex = m.index + m[0].length;
    }
    result += content.slice(lastIndex);

    adjacency.set(absPath, refs);
    files.set(absPath, result);

    // Update indegree for referenced files
    for (const ref of refs) {
      indegree.set(ref, (indegree.get(ref) ?? 0) + 1);
    }
  }

  // 3. Find roots: files with indegree 0
  const roots = [...indegree.entries()].filter(([, deg]) => deg === 0).map(([p]) => p);

  if (roots.length === 0) {
    throw new Error(
      `No root .tex file found in ${rootDir} ` +
        `(every .tex file is \\input/\\include'd by another)`,
    );
  }

  // 4. Pick root with largest reachable set (roots is non-empty — checked above)
  const firstRoot = roots[0];
  if (firstRoot === undefined) {
    throw new Error(`No root .tex file found in ${rootDir}`);
  }
  let rootPath = firstRoot;
  let maxReachable = 0;
  for (const root of roots) {
    const reachable = countReachable(root, adjacency);
    if (reachable > maxReachable) {
      maxReachable = reachable;
      rootPath = root;
    }
  }

  // 5. Parse \includeonly from the root
  const rootContent = files.get(rootPath) ?? "";
  const includeOnly = parseIncludeOnly(rootContent);

  return { rootPath, files, includeOnly };
}

// ── Graph helpers ─────────────────────────────────────────────────────

/** Recursively find all .tex files, skipping the `output/` directory. */
function findAllTexFiles(dir: string): Set<string> {
  const result = new Set<string>();
  const stack = [dir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue; // skip unreadable directories
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "output") {
          stack.push(full);
        }
      } else if (entry.isFile() && entry.name.endsWith(".tex")) {
        result.add(full);
      }
    }
  }

  return result;
}

/** Resolve a bare filename to an absolute path, trying `.tex` extension. */
function resolveTexFile(filename: string, dir: string): string | null {
  const candidates = [path.resolve(dir, filename)];
  if (!filename.endsWith(".tex")) {
    candidates.push(path.resolve(dir, filename + ".tex"));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Count nodes reachable from `start` via the adjacency graph (BFS). */
function countReachable(start: string, adjacency: Map<string, string[]>): number {
  const visited = new Set<string>();
  const queue = [start];
  let head = 0;

  while (head < queue.length) {
    const node = queue[head];
    if (node === undefined) break;
    head++;
    if (visited.has(node)) continue;
    visited.add(node);
    for (const child of adjacency.get(node) ?? []) {
      queue.push(child);
    }
  }

  return visited.size;
}

/** Parse \\includeonly{...} from source, returning the set of files or null. */
function parseIncludeOnly(source: string): Set<string> | null {
  const match = /\\includeonly\s*\{([^}]*)\}/.exec(source);
  if (!match?.[1]) return null;

  const files = match[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return files.length > 0 ? new Set(files) : null;
}

// ── Post-pandoc splitting ─────────────────────────────────────────────

export interface SplitResult {
  frontmatterRaw: string;
  frontmatterParsed: Record<string, unknown>;
  preamble: string;
  body: string;
}

/**
 * Split pandoc standalone output into frontmatter, preamble, and body.
 *
 * Frontmatter is the YAML block between the first `---` delimiters.
 * Preamble is everything between the frontmatter and the first `#` heading.
 * Body is everything from the first `#` heading onwards.
 */
export function splitPandocOutput(output: string): SplitResult {
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(output);

  let frontmatterRaw = "";
  let frontmatterParsed: Record<string, unknown> = {};
  let afterFm = output;

  if (fmMatch) {
    frontmatterRaw = fmMatch[0];
    const fmYaml = fmMatch[1] ?? "";
    try {
      const parsed: unknown = parseYaml(fmYaml);
      if (typeof parsed === "object" && parsed !== null) {
        frontmatterParsed = parsed as Record<string, unknown>;
      }
    } catch {
      // Frontmatter parse failure is non-fatal
    }
    afterFm = output.slice(fmMatch.index + fmMatch[0].length);
  }

  const headingMatch = /(?:^|\n)(#{1,6} .*)/.exec(afterFm);

  let preamble = "";
  let body = afterFm;

  if (headingMatch) {
    const leadingNewline = afterFm[headingMatch.index] === "\n" ? 1 : 0;
    const headingStart = headingMatch.index + leadingNewline;
    preamble = afterFm.slice(0, headingStart).trim();
    body = afterFm.slice(headingStart);
  }

  return { frontmatterRaw, frontmatterParsed, preamble, body };
}
