/**
 * pi-arxivist extension entry point.
 *
 * Registers the `fetch_arxiv` tool: downloads arxiv LaTeX source,
 * flattens \\input/\\include, converts to Markdown via pandoc WASM,
 * and returns the result.
 *
 * Pandoc --standalone produces YAML frontmatter which is parsed into
 * meta.json. A human-readable title/abstract heading is injected at
 * the top of the Markdown output instead. Preamble macros that pandoc
 * couldn't process are extracted to preamble.tex.
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
import { findMainTex, parseArxivId, splitPandocOutput } from "./utils.js";

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
    parts.push(theme.fg("dim", abstract));
  }
  parts.push(theme.fg("muted", `(${String(lines)} lines, ${formatBytes(bytes)})`));

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

  let resultText = truncation.content;

  if (truncation.truncated) {
    const omittedLines = truncation.totalLines - truncation.outputLines;
    const omittedBytes = truncation.totalBytes - truncation.outputBytes;
    resultText += `\n\n[Output truncated: showing ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines`;
    resultText += ` (${formatBytes(truncation.outputBytes)} of ${formatBytes(truncation.totalBytes)}).`;
    resultText += ` ${String(omittedLines)} lines (${formatBytes(omittedBytes)}) omitted.`;
    resultText += ` Full output saved to: ${outputPath}]`;
  }

  return {
    content: [{ type: "text", text: resultText }],
    details: {
      id,
      title,
      abstract,
      path: outputPath,
      preamblePath,
      srcDir,
      lines: totalLines,
      bytes: totalBytes,
      truncated: truncation.truncated,
      truncation: {
        outputLines: truncation.outputLines,
        outputBytes: truncation.outputBytes,
        totalLines: truncation.totalLines,
        totalBytes: truncation.totalBytes,
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
      "Returns the full paper as Markdown with YAML frontmatter (truncated to fit context). " +
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

        if (existsSync(outputPath)) {
          const body = readFileSync(outputPath, "utf-8");
          let title: string | null = null;
          let abstract: string | null = null;
          if (existsSync(metaPath)) {
            const meta = JSON.parse(readFileSync(metaPath, "utf-8")) as PaperMeta;
            title = meta.title;
            abstract = meta.abstract;
          }
          return formatResult(id, title, abstract, outputPath, preamblePath, srcDir, body);
        }

        // 4. Find main.tex
        const mainPath = findMainTex(srcDir);

        // 5. Flatten \input/\include (async — reads files without blocking)
        const flattened = await flatten(mainPath);

        // 6. Convert full source to Markdown via pandoc (standalone → YAML frontmatter)
        mkdirSync(outputDir, { recursive: true });
        const pandocResult = await runPandoc(flattened);

        if (!pandocResult.output) {
          ctx.ui.notify(`Pandoc produced no output for ${id}: ${pandocResult.stderr}`, "error");
          return {
            content: [{ type: "text", text: `Pandoc failed: ${pandocResult.stderr}` }],
            details: { ...emptyDetails(), id },
          };
        }

        // 7. Split pandoc output: frontmatter (→ meta.json), preamble (→ preamble.tex), body
        const split = splitPandocOutput(pandocResult.output);

        const title =
          typeof split.frontmatterParsed.title === "string" ? split.frontmatterParsed.title : null;
        const abstract =
          typeof split.frontmatterParsed.abstract === "string"
            ? split.frontmatterParsed.abstract
            : null;

        writeFileSync(metaPath, JSON.stringify({ title, abstract } satisfies PaperMeta), "utf-8");

        if (split.preamble) {
          writeFileSync(preamblePath, split.preamble, "utf-8");
        }

        // 8. Write cleaned paper.md: injected # title + abstract, then body (no YAML frontmatter)
        const heading = title ? `# ${title}\n\n` : "";
        const abstractBlock = abstract ? `${abstract}\n\n` : "";
        const cleanOutput = heading + abstractBlock + split.body;
        writeFileSync(outputPath, cleanOutput, "utf-8");

        // 9. Return result
        return formatResult(id, title, abstract, outputPath, preamblePath, srcDir, cleanOutput);
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
