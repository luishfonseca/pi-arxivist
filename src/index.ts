/**
 * pi-arxivist extension entry point.
 *
 * Registers the `fetch_arxiv` tool: downloads arxiv LaTeX source,
 * flattens \\input/\\include, converts to Markdown via pandoc WASM,
 * and returns the result.
 *
 * Metadata is extracted via regex from the LaTeX source and stored in
 * meta.json alongside the Markdown output.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { downloadSource } from "./arxiv.js";
import { flatten } from "./flatten.js";
import { runPandoc } from "./pandoc.js";
import { findMainTex, parseArxivId } from "./utils.js";

// ── Helpers ───────────────────────────────────────────────────────────

/** Fresh details object — never share across invocations. */
function emptyDetails() {
  return {
    id: "",
    title: null as string | null,
    abstract: null as string | null,
    path: "",
    preamblePath: "",
    lines: 0,
    bytes: 0,
    truncated: false,
  };
}

interface PaperMeta {
  title: string | null;
  abstract: string | null;
}

/** Extract \title[...]{...} from LaTeX source (handles optional arg). */
function extractTitle(source: string): string | null {
  const m = /\\title(?:\[[^\]]*\])?\{([^}]*)\}/.exec(source);
  return m?.[1]?.trim() ?? null;
}

/** Extract the body of \begin{abstract}...\end{abstract} from LaTeX source. */
function extractAbstract(source: string): string | null {
  const m = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/.exec(source);
  if (!m?.[1]) return null;
  return m[1].trim() || null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Minimal theme interface for TUI rendering helpers. */
interface RenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Build the collapsed summary text shown when the tool result isn't expanded. */
function formatCollapsedSummary(result: { details: unknown }, theme: RenderTheme): string {
  const details = result.details as Record<string, unknown> | null | undefined;
  const title = typeof details?.title === "string" ? details.title : null;
  const abstract = typeof details?.abstract === "string" ? details.abstract : null;
  const lines = typeof details?.lines === "number" ? details.lines : 0;
  const bytes = typeof details?.bytes === "number" ? details.bytes : 0;

  const parts: string[] = [];

  if (title) {
    parts.push(theme.fg("toolOutput", `"${title}"`));
  }
  if (abstract) {
    const short = abstract.length > 300 ? `${abstract.slice(0, 300)}…` : abstract;
    parts.push(theme.fg("dim", short));
  }
  parts.push(
    theme.fg("muted", `(${String(lines)} lines, ${formatBytes(bytes)}) — use expand to read`),
  );

  return parts.join("\n");
}

/** Extract text content from a tool result for TUI rendering. */
function getTextFromResult(result: {
  content: Array<{ type: string; text?: string }>;
}): string | null {
  for (const block of result.content) {
    if (block.type === "text" && block.text !== undefined) {
      return block.text;
    }
  }
  return null;
}

function formatResult(
  id: string,
  title: string | null,
  abstract: string | null,
  outputPath: string,
  preamblePath: string,
  srcDir: string,
  body: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const totalLines = body.split("\n").length;
  const totalBytes = Buffer.byteLength(body);
  const truncation = truncateHead(body);

  // Build the output header line
  let outputHeader: string;
  if (truncation.truncated) {
    const by = String(truncation.truncatedBy);
    outputHeader = [
      `Output: ${outputPath}`,
      `(${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines`,
      `${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}`,
      `— truncated by ${by})`,
    ].join(" ");
  } else {
    outputHeader = `Output: ${outputPath} (${String(totalLines)} lines, ${formatBytes(totalBytes)})`;
  }

  const parts = [id, outputHeader, "", truncation.content];

  // Truncation footer — only when truncated
  if (truncation.truncated) {
    parts.push(
      "",
      `[Truncated by ${String(truncation.truncatedBy)}: showing ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines (${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}). Full paper at ${outputPath}. Use read to inspect.]`,
    );
  }

  parts.push(
    "",
    `Preamble with \\newcommand definitions: ${preamblePath} — read this if you encounter unfamiliar LaTeX commands.`,
    `Source artifacts (bib, figures): ${srcDir}`,
  );

  // Always include the "full paper" hint when there's more to read
  if (!truncation.truncated) {
    parts.push(`[Full paper at ${outputPath}. Use read to inspect.]`);
  }

  return {
    content: [{ type: "text", text: parts.join("\n") }],
    details: {
      id,
      title,
      abstract,
      path: outputPath,
      preamblePath,
      lines: totalLines,
      bytes: totalBytes,
      truncated: truncation.truncated,
      truncation: {
        outputLines: truncation.outputLines,
        outputBytes: truncation.outputBytes,
        totalLines: truncation.totalLines,
        totalBytes: truncation.totalBytes,
        truncatedBy: truncation.truncatedBy,
      } satisfies Partial<TruncationResult>,
    },
  };
}

// ── Tool registration ─────────────────────────────────────────────────

export default function arxivist(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fetch_arxiv",
    label: "Fetch Arxiv",
    description:
      "Download an arxiv paper as clean Markdown with metadata. " +
      "Returns title, authors, abstract, and the full paper body (truncated to fit context). " +
      "Use this whenever the user asks about a specific arxiv paper — the structured Markdown " +
      "is far better than scraping a PDF.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "Arxiv paper identifier. Accepts bare ID ('1203.6859'), " +
          "abstract URL ('https://arxiv.org/abs/1203.6859'), " +
          "or PDF URL ('https://arxiv.org/pdf/1203.6859').",
      }),
    }),
    renderCall(args, theme, _context) {
      return new Text(`${theme.bold("fetch_arxiv")} ${theme.fg("accent", args.id)}`, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Fetching arxiv paper…"), 0, 0);
      }

      // Error: show the error text even when collapsed
      if (context.isError) {
        const text = getTextFromResult(result);
        if (text !== null) return new Text(theme.fg("toolOutput", text), 0, 0);
        return new Text("", 0, 0);
      }

      // Collapsed: show title and abstract with "expand to read" hint
      if (!expanded) {
        return new Text(formatCollapsedSummary(result, theme), 0, 0);
      }

      // Expanded: show the full output
      const text = getTextFromResult(result);
      if (text === null) return new Text("", 0, 0);
      return new Text(theme.fg("toolOutput", text), 0, 0);
    },
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      let id = "";

      try {
        // 1. Parse ID
        id = parseArxivId(rawParams.id);
        ctx.ui.notify(`Fetching arxiv: ${id}…`);

        // 2. Download & extract (cache-aware, respects AbortSignal)
        const srcDir = await downloadSource(id, signal);

        // 3. If fully cached (output already generated), return immediately
        const outputDir = join(srcDir, "output");
        const outputPath = join(outputDir, "paper.md");
        const preamblePath = join(outputDir, "preamble.tex");

        const metaPath = join(outputDir, "meta.json");

        if (existsSync(outputPath) && existsSync(metaPath)) {
          const body = readFileSync(outputPath, "utf-8");
          const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PaperMeta;
          return formatResult(
            id,
            meta.title,
            meta.abstract,
            outputPath,
            preamblePath,
            srcDir,
            body,
          );
        }

        // 4. Find main.tex
        const mainPath = findMainTex(srcDir);

        // 5. Flatten \input/\include (async — reads files without blocking)
        const flattened = await flatten(mainPath);

        // 6. Split preamble / body; save preamble for inspection
        const docBegin = flattened.indexOf("\\begin{document}");
        const preamble = docBegin >= 0 ? flattened.slice(0, docBegin) : "";
        const body = docBegin >= 0 ? flattened.slice(docBegin) : flattened;
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(preamblePath, preamble, "utf-8");

        // 7. Extract metadata from LaTeX source
        const title = extractTitle(body);
        const abstract = extractAbstract(body);

        // 8. Convert body to Markdown
        const pandocResult = await runPandoc(body);

        if (!pandocResult.output) {
          ctx.ui.notify(`Pandoc produced no output for ${id}: ${pandocResult.stderr}`, "error");
          return {
            content: [{ type: "text", text: `Pandoc failed: ${pandocResult.stderr}` }],
            details: { ...emptyDetails(), id },
          };
        }

        // 9. Write output (doubles as cache for future requests)
        writeFileSync(outputPath, pandocResult.output, "utf-8");
        writeFileSync(metaPath, JSON.stringify({ title, abstract } satisfies PaperMeta), "utf-8");

        // 10. Return result
        return formatResult(
          id,
          title,
          abstract,
          outputPath,
          preamblePath,
          srcDir,
          pandocResult.output,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`fetch_arxiv error: ${msg}`, "error");
        return {
          content: [{ type: "text", text: `fetch_arxiv failed: ${msg}` }],
          details: { ...emptyDetails(), id },
        };
      }
    },
  });
}
