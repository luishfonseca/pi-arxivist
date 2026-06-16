/**
 * pi-arxivist extension entry point.
 *
 * Registers the `fetch_arxiv` tool: downloads arxiv LaTeX source,
 * flattens \\input/\\include, converts to Markdown via pandoc WASM,
 * and returns the result.
 *
 * Metadata (title, authors, abstract) is included as YAML frontmatter
 * in the Markdown output — no separate metadata file needed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateHead } from "@earendil-works/pi-coding-agent";
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
    path: "",
    preamblePath: "",
    lines: 0,
    bytes: 0,
    truncated: false,
  };
}

/** Extract \title{...} from LaTeX preamble. */
function extractTitle(preamble: string): string | null {
  const m = /\\title\{([^}]*)\}/.exec(preamble);
  return m?.[1]?.trim() ?? null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatResult(
  id: string,
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
    id,
    `Output: ${outputPath} (${String(totalLines)} lines, ${formatBytes(bytes)})`,
    "",
    truncated.content,
    "",
    `Preamble with \\newcommand definitions: ${preamblePath} — read this if you encounter unfamiliar LaTeX commands.`,
    `Source artifacts (bib, figures): ${srcDir}`,
    `[Full paper at ${outputPath}. Use read to inspect.]`,
  ].join("\n");

  return {
    content: [{ type: "text", text }],
    details: {
      id,
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
        const outputDir = join(srcDir, "output");
        const outputPath = join(outputDir, "paper.md");
        const preamblePath = join(outputDir, "preamble.tex");

        if (existsSync(outputPath)) {
          const body = readFileSync(outputPath, "utf-8");
          const totalLines = body.split("\n").length;
          const bytes = Buffer.byteLength(body);
          return formatResult(id, outputPath, preamblePath, srcDir, totalLines, bytes, body);
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

        // 7. Extract title from preamble
        const title = extractTitle(preamble);

        // 8. Convert body to Markdown (abstract from body via standalone YAML)
        let pandocResult = await runPandoc(body);

        // 9. Inject title into YAML frontmatter (right after opening ---)
        if (title && pandocResult.output.startsWith("---\n")) {
          pandocResult = {
            ...pandocResult,
            output: "---\n" + `title: ${JSON.stringify(title)}\n` + pandocResult.output.slice(4),
          };
        }

        if (!pandocResult.output) {
          ctx.ui.notify(`Pandoc produced no output for ${id}: ${pandocResult.stderr}`, "error");
          return {
            content: [{ type: "text", text: `Pandoc failed: ${pandocResult.stderr}` }],
            details: { ...emptyDetails(), id },
          };
        }

        // 8. Write output (doubles as cache for future requests)
        writeFileSync(outputPath, pandocResult.output, "utf-8");

        const totalLines = pandocResult.output.split("\n").length;
        const bytes = Buffer.byteLength(pandocResult.output);

        // 9. Return result
        return formatResult(
          id,
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
