import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

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

  // Strip arxiv URLs down to the ID
  const urlMatch = /arxiv\.org\/(?:abs|pdf)\/([^/\s?#]+)/i.exec(trimmed);
  if (urlMatch?.[1]) {
    return urlMatch[1];
  }

  // Pass through everything else — let arxiv's 404 validate
  return trimmed;
}

/**
 * Find the main .tex file in a directory.
 *
 * Heuristic:
 * 1. Scan all .tex files for one containing \documentclass (case-insensitive).
 * 2. Fallback: look for "main.tex" in the directory.
 * 3. Fallback: look for a .tex file matching the directory name.
 *
 * Throws if no candidate is found.
 */
export function findMainTex(dir: string): string {
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tex"))
    .map((e) => e.name);

  if (entries.length === 0) {
    throw new Error(`No .tex files found in ${dir}`);
  }

  // 1. First .tex containing \documentclass
  for (const entry of entries) {
    const full = path.join(dir, entry);
    const head = readHead(full, 4096);
    if (/\bdocumentclass\b/i.test(head)) {
      return full;
    }
  }

  // 2. main.tex
  const mainTex = entries.find((e) => e.toLowerCase() === "main.tex");
  if (mainTex) {
    return path.join(dir, mainTex);
  }

  // 3. .tex file matching directory name
  const dirName = path.basename(dir).toLowerCase();
  const matchingDir = entries.find((e) => e.toLowerCase().replace(/\.tex$/, "") === dirName);
  if (matchingDir) {
    return path.join(dir, matchingDir);
  }

  throw new Error(
    `Could not find main .tex file in ${dir}. ` + `Candidates: ${entries.join(", ")}`,
  );
}

/** Read the first `maxBytes` bytes of a file. */
function readHead(filePath: string, maxBytes: number): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString("utf-8", 0, n);
  } finally {
    fs.closeSync(fd);
  }
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
  // Extract frontmatter: between first --- and second ---
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

  // Find first markdown heading (any level — pandoc may shift them)
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
