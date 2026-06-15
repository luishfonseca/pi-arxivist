/**
 * pi-arxivist extension entry point.
 *
 * Registers the `fetch_arxiv` tool: downloads arxiv LaTeX source,
 * flattens \\input/\\include, converts to Markdown via pandoc WASM,
 * and returns the result.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { downloadSource } from "./arxiv.ts";
import { flatten } from "./flatten.ts";
import { extractMeta, PANDOC_FROM, PANDOC_TO, runPandoc, runPandocJson } from "./pandoc.ts";
import { findMainTex, parseArxivId } from "./utils.ts";

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

// ── Tool registration ─────────────────────────────────────────────────

export default function arxivist(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "fetch_arxiv",
    label: "Fetch Arxiv",
    description:
      "Fetch an arxiv paper by ID or URL, download the LaTeX source, " +
      "flatten \\input/\\include references, convert to Markdown via pandoc, " +
      "and return the result.",
    parameters: Type.Object({
      id: Type.String({
        description:
          "Arxiv paper identifier. Accepts bare ID ('1203.6859'), " +
          "abstract URL ('https://arxiv.org/abs/1203.6859'), " +
          "or PDF URL ('https://arxiv.org/pdf/1203.6859'). " +
          "Version suffix like 'v2' is preserved.",
      }),
    }),
    async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
      let id = "";

      try {
        // 1. Parse ID
        id = parseArxivId(rawParams.id);
        ctx.ui.notify(`Fetching arxiv: ${id}…`);

        // 2. Download & extract (cache-aware)
        const srcDir = await downloadSource(id);

        // 3. Find main.tex
        const mainPath = findMainTex(srcDir);

        // 4. Flatten \input/\include
        const flattened = flatten(mainPath);

        // 5. Split preamble / body
        const docBegin = flattened.indexOf("\\begin{document}");
        const preamble = docBegin >= 0 ? flattened.slice(0, docBegin) : "";
        const body = docBegin >= 0 ? flattened.slice(docBegin) : flattened;
        const preamblePath = join(srcDir, "preamble.tex");
        writeFileSync(preamblePath, preamble, "utf-8");

        // 6. Extract metadata via pandoc JSON (structured AST, no regex)
        const jsonDoc = await runPandocJson(flattened);
        const metadata = extractMeta(jsonDoc);

        // 7. Convert body to Markdown
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

        // 8. Write output
        const outputDir = join(srcDir, "output");
        mkdirSync(outputDir, { recursive: true });
        const outputPath = join(outputDir, "paper.md");
        writeFileSync(outputPath, pandocResult.output, "utf-8");

        // 9. Truncate
        const totalLines = pandocResult.output.split("\n").length;
        const bytes = Buffer.byteLength(pandocResult.output);
        const truncated = truncateHead(pandocResult.output);
        const wasTruncated = pandocResult.output.length > truncated.content.length;

        const text = [
          `[fetch_arxiv] ${id}: "${metadata.title}"`,
          `Authors: ${metadata.authors}`,
          `Output: ${outputPath} (${String(totalLines)} lines, ${formatBytes(bytes)})`,
          metadata.abstract ? `\n## Abstract\n${metadata.abstract}\n` : "",
          "---",
          truncated.content,
          "",
          "---",
          `Preamble (macro definitions): ${preamblePath}`,
          `[Full paper at ${outputPath}. Use read to inspect.]`,
        ]
          .filter((s) => s !== "")
          .join("\n");

        return {
          content: [{ type: "text", text }],
          details: {
            id,
            title: metadata.title,
            authors: metadata.authors,
            abstract: metadata.abstract,
            path: outputPath,
            preamblePath,
            lines: totalLines,
            bytes,
            truncated: wasTruncated,
          },
        };
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
