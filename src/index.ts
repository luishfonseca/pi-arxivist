/**
 * pi-arxivist extension entry point.
 *
 * Registers the `fetch_arxiv` tool: downloads arxiv LaTeX source,
 * flattens \\input/\\include, converts to Markdown via pandoc WASM,
 * and returns the result.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { downloadSource } from "./arxiv.js";
import { flatten } from "./flatten.js";
import {
  type ExtractedMeta,
  extractMeta,
  PANDOC_FROM,
  PANDOC_TO,
  runPandoc,
  runPandocJson,
} from "./pandoc.js";
import { findMainTex, parseArxivId } from "./utils.js";

// ── Types ────────────────────────────────────────────────────────────

interface CachedResult {
  meta: ExtractedMeta;
  preamblePath: string;
  outputPath: string;
  totalLines: number;
  bytes: number;
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Fresh details object — never share across invocations. */
function emptyDetails() {
  return {
    id: "",
    title: "",
    authors: "",
    abstract: "",
    path: "",
    preamblePath: "",
    lines: 0,
    bytes: 0,
    truncated: false,
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatResult(
  id: string,
  meta: ExtractedMeta,
  outputPath: string,
  preamblePath: string,
  srcDir: string,
  totalLines: number,
  bytes: number,
  body: string,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  const truncated = truncateHead(body);
  const wasTruncated = body.length > truncated.content.length;

  const text = [
    `${id}: "${meta.title}"`,
    `Authors: ${meta.authors}`,
    `Output: ${outputPath} (${String(totalLines)} lines, ${formatBytes(bytes)})`,
    meta.abstract ? `\n## Abstract\n${meta.abstract}\n` : "",
    "---",
    truncated.content,
    "",
    "---",
    `Preamble with \\newcommand definitions: ${preamblePath} — read this if you encounter unfamiliar LaTeX commands.`,
    `Source artifacts (bib, figures): ${srcDir}`,
    `[Full paper at ${outputPath}. Use read to inspect.]`,
  ]
    .filter((s) => s !== "")
    .join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      id,
      title: meta.title,
      authors: meta.authors,
      abstract: meta.abstract,
      path: outputPath,
      preamblePath,
      lines: totalLines,
      bytes,
      truncated: wasTruncated,
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
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      let id = "";

      try {
        // 1. Parse ID
        id = parseArxivId(rawParams.id);
        ctx.ui.notify(`Fetching arxiv: ${id}…`);

        // 2. Download & extract (cache-aware, respects AbortSignal)
        const srcDir = await downloadSource(id, signal);

        // 3. If fully cached (output already generated), return immediately
        const outputPath = join(srcDir, "output", "paper.md");
        const metaPath = join(srcDir, "output", "meta.json");
        const preamblePath = join(srcDir, "preamble.tex");

        if (existsSync(outputPath) && existsSync(metaPath)) {
          const body = readFileSync(outputPath, "utf-8");
          const cached = JSON.parse(readFileSync(metaPath, "utf-8")) as CachedResult;
          return formatResult(
            id,
            cached.meta,
            outputPath,
            preamblePath,
            srcDir,
            cached.totalLines,
            cached.bytes,
            body,
          );
        }

        // 4. Find main.tex
        const mainPath = findMainTex(srcDir);

        // 5. Flatten \input/\include
        const flattened = flatten(mainPath);

        // 6. Split preamble / body
        const docBegin = flattened.indexOf("\\begin{document}");
        const preamble = docBegin >= 0 ? flattened.slice(0, docBegin) : "";
        const body = docBegin >= 0 ? flattened.slice(docBegin) : flattened;
        writeFileSync(preamblePath, preamble, "utf-8");

        // 7. Extract metadata via pandoc JSON (structured AST, no regex)
        const jsonDoc = await runPandocJson(flattened);
        const metadata = extractMeta(jsonDoc);

        // 8. Convert body to Markdown
        const pandocResult = await runPandoc(body, {
          from: PANDOC_FROM,
          to: PANDOC_TO,
          wrap: "none",
        });

        if (!pandocResult.output) {
          ctx.ui.notify(`Pandoc produced no output for ${id}: ${pandocResult.stderr}`, "error");
          return {
            content: [{ type: "text", text: `Pandoc failed: ${pandocResult.stderr}` }],
            details: { ...emptyDetails(), id },
          };
        }

        // 9. Write output
        const outputDir = join(srcDir, "output");
        mkdirSync(outputDir, { recursive: true });
        writeFileSync(outputPath, pandocResult.output, "utf-8");

        const totalLines = pandocResult.output.split("\n").length;
        const bytes = Buffer.byteLength(pandocResult.output);

        // 10. Write metadata alongside output so future cache hits skip the pipeline
        const cached: CachedResult = {
          meta: metadata,
          preamblePath,
          outputPath,
          totalLines,
          bytes,
        };
        writeFileSync(metaPath, JSON.stringify(cached), "utf-8");

        // 11. Return result
        return formatResult(
          id,
          metadata,
          outputPath,
          preamblePath,
          srcDir,
          totalLines,
          bytes,
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
