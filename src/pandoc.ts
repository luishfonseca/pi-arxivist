import { convert } from "pandoc-wasm";

export const PANDOC_FROM = "latex-latex_macros+raw_tex";
export const PANDOC_TO = "markdown+tex_math_dollars+raw_tex+fenced_code_attributes+bracketed_spans";

export interface PandocOptions {
  from?: string;
  to?: string;
  wrap?: "none" | "auto" | "preserve";
  standalone?: boolean;
}

export interface PandocResult {
  output: string;
  stderr: string;
  warnings: Array<{ message: string; verbosity?: string }>;
}

/**
 * Convert a LaTeX source string to Markdown via pandoc-wasm.
 *
 * Pandoc runs in-process as WebAssembly.  No system install, no PATH
 * lookup, no child_process.
 */
export async function runPandoc(
  source: string,
  options: PandocOptions = {},
): Promise<PandocResult> {
  const pandocOpts: Record<string, unknown> = {
    from: options.from ?? PANDOC_FROM,
    to: options.to ?? PANDOC_TO,
    standalone: options.standalone ?? false,
    wrap: options.wrap ?? "none",
  };

  const result = await convert(pandocOpts, source, {});

  const warnings: Array<{ message: string; verbosity?: string }> = [];
  for (const w of result.warnings) {
    if (typeof w === "string") {
      warnings.push({ message: w });
    } else if (typeof w.message === "string") {
      warnings.push({ message: w.message, verbosity: w.verbosity });
    }
  }

  return { output: result.stdout, stderr: result.stderr, warnings };
}

/**
 * Convert LaTeX source to pandoc's native JSON AST.
 *
 * Returns the parsed document so callers can inspect `meta` (title,
 * author, abstract) structurally.
 */
export async function runPandocJson(source: string): Promise<PandocJsonDoc> {
  const result = await convert({ from: PANDOC_FROM, to: "json" }, source, {});
  return JSON.parse(result.stdout) as PandocJsonDoc;
}

// ── Pandoc JSON AST types ─────────────────────────────────────────────

export interface PandocJsonDoc {
  "pandoc-api-version": [number, number];
  meta: Record<string, MetaValue>;
  blocks: Block[];
}

export interface MetaValue {
  t: string;
  c: unknown;
}

interface Block {
  t: string;
  c: unknown;
}

interface Inline {
  t: string;
  c: unknown;
}

// ── AST walkers ───────────────────────────────────────────────────────

/** Walk pandoc AST inlines and return plain text. */
export function stringifyInlines(inlines: unknown): string {
  if (!Array.isArray(inlines)) return "";
  return (inlines as Inline[])
    .map((il) => {
      switch (il.t) {
        case "Str":
          return il.c as string;
        case "Space":
          return " ";
        case "SoftBreak":
        case "LineBreak":
          return " ";
        case "Emph":
        case "Strong":
        case "Underline":
        case "Strikeout":
        case "Superscript":
        case "Subscript":
        case "SmallCaps":
        case "Span":
          return stringifyInlines(Array.isArray(il.c) ? il.c : (il.c as [unknown, Inline[]])[1]);
        case "Link":
          return stringifyInlines((il.c as [unknown, Inline[], unknown])[1]);
        case "Quoted":
          return stringifyInlines((il.c as [unknown, Inline[]])[1]);
        case "Math":
          return (il.c as [unknown, string])[1];
        case "Code":
          return (il.c as [unknown, string])[1];
        case "RawInline":
          return "";
        case "Cite":
          return "";
        case "Note":
          return "";
        default:
          return "";
      }
    })
    .join("");
}

/** Walk pandoc AST blocks (Para, Plain) and return plain text. */
export function stringifyBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as Block[])
    .map((bl) => {
      switch (bl.t) {
        case "Para":
        case "Plain":
          return stringifyInlines(bl.c) + "\n";
        default:
          return "";
      }
    })
    .join("")
    .trim();
}

// ── Metadata extraction ───────────────────────────────────────────────

export interface ExtractedMeta {
  title: string;
  authors: string;
  abstract: string;
}

/** Extract title, authors, and abstract from a pandoc JSON document's meta block. */
export function extractMeta(doc: PandocJsonDoc): ExtractedMeta {
  const meta = doc.meta;

  // Title: MetaInlines
  let title = "unknown";
  const titleVal = meta.title;
  if (titleVal?.t === "MetaInlines") {
    const t = stringifyInlines(titleVal.c);
    if (t) title = t;
  }

  // Author: MetaInlines (single) or MetaList of MetaInlines
  let authors = "unknown";
  const authorVal = meta.author;
  if (authorVal?.t === "MetaInlines") {
    const a = stringifyInlines(authorVal.c);
    if (a) authors = a;
  } else if (authorVal?.t === "MetaList") {
    const list = (authorVal.c as MetaValue[])
      .map((item) => stringifyInlines(item.c))
      .filter(Boolean);
    if (list.length > 0) authors = list.join(", ");
  }

  // Abstract: MetaBlocks (Para/Plain blocks)
  let abstract = "";
  const abstractVal = meta.abstract;
  if (abstractVal?.t === "MetaBlocks") {
    abstract = stringifyBlocks(abstractVal.c);
  }

  return { title, authors, abstract };
}
