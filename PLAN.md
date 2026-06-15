# pi-arxivist — PLAN

## Summary

A pi extension that provides a single tool, `fetch_arxiv`, which takes an arxiv
paper ID (or URL), downloads the LaTeX source, flattens it, converts to
Markdown via pandoc, and returns the result (truncated per pi guidelines).

The extension lives as a directory with `package.json` in
`~/.pi/agent/extensions/pi-arxivist/`.

---

## Design decisions

| Decision | Choice |
|----------|--------|
| Tool name | `fetch_arxiv` |
| Output location | `/tmp/pi-arxivist/<id>/`. Deterministic path doubles as a cache. |
| Converter | Pandoc via WASM (`pandoc-wasm` npm package). No system install required. |
| Flattener | Custom JS using regex string operations. |
| Metadata extraction | Pandoc in `standalone: true` mode on the full flattened source; YAML frontmatter is parsed for title, author, abstract. |
| Pre-processor | None. `-latex_macros` disables pandoc's macro expansion, avoiding crashes from unbalanced environments inside `\newcommand` bodies. `+raw_tex` passes unknown commands through as semantic tokens. |
| Package structure | Directory with `package.json` (needed for pi discovery) |
| Markdown flavor | `markdown+tex_math_dollars+raw_tex+fenced_code_attributes+bracketed_spans` |
| ID validation | Minimal: strip URL prefixes, pass everything else through. Invalid IDs produce a 404 from arxiv. |
| Error strategy | Fail hard on structural errors (cycle, depth); skip unresolvable \input (missing file, macro filename, inside verbatim) — leave command as-is so pandoc handles or ignores it. |
| Macro filenames in \input | **Only resolve plain-string arguments**. Skip \input with embedded macros (e.g. `\input{\jobname-foo}`), leave as-is. |
| Missing file in \input | **Skip, leave command as-is**. Not an error — the file might genuinely not exist, or the \input might be literal text inside a verbatim block. |
| Missing LaTeX source | Error with clear message (source tarball only; no PDF fallback). |
| Caching | Output goes to a stable path under `/tmp/pi-arxivist/<id>/`. Repeated requests for the same paper skip download and extraction. Files are user artifacts — no automatic cleanup. |

---

## Package structure

```
~/.pi/agent/extensions/pi-arxivist/
├── package.json
├── package-lock.json
└── src/
    ├── index.ts             # Extension entry: registers fetch_arxiv tool
    ├── arxiv.ts             # Download + extract arxiv source tarball
    ├── flatten.ts           # Regex-based recursive flattener (resolves \input, \include)
    ├── pandoc.ts            # Pandoc WASM wrapper (convert API)
    └── utils.ts             # ID parsing, main.tex detection, file helpers
```

## `package.json`

```json
{
  "name": "pi-arxivist",
  "version": "0.1.0",
  "description": "Fetch arxiv papers as Markdown",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {},
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
    "typebox": "*"
  }
}
```

---

## Tool definition: `fetch_arxiv`

### Parameters

```typescript
Type.Object({
  id: Type.String({
    description:
      "Arxiv paper identifier. Accepts bare ID ('1203.6859'), " +
      "abstract URL ('https://arxiv.org/abs/1203.6859'), " +
      "or PDF URL ('https://arxiv.org/pdf/1203.6859'). " +
      "Version suffix like 'v2' is preserved.",
  }),
})
```

### Pipeline

```
fetch_arxiv(id)
  │
  ├─ 1. parseArxivId(id) → canonical ID
  │      Strip URL prefixes; pass everything else through.
  │      No format validation — invalid IDs fail at download time.
  │
  ├─ 2. Check cache:
  │      If /tmp/pi-arxivist/{id}/ exists and has content → skip to step 5.
  │
  ├─ 3. Download source tarball:
  │      GET https://arxiv.org/e-print/{id}
  │      (arxiv redirects to the actual tar.gz, respecting version suffix)
  │
  ├─ 4. Extract:
  │      tar -xzf into /tmp/pi-arxivist/{id}/
  │
  ├─ 5. Find main.tex:
  │      Heuristic: first .tex file containing \documentclass
  │      Fallback: file named "main.tex" or matching dir name
  │
  ├─ 6. Flatten \input/\include (see Flattener design below)
  │
  ├─ 7. Split preamble / body:
  │      - Find \begin{document}
  │      - Save preamble to {workdir}/preamble.tex
  │        (LLM can inspect macro definitions via read if needed)
  │
  ├─ 8. Extract metadata via pandoc JSON:
  │      pandoc-wasm convert({ from: "latex...", to: "json" }, fullSource)
  │      → JSON.parse → walk AST meta block
  │      → title, author list, abstract text (structured, no regex)
  │
  ├─ 9. Convert body to Markdown:
  │      pandoc-wasm convert({
  │        from: "latex-latex_macros+raw_tex",
  │        to: "markdown+tex_math_dollars+raw_tex+
  │             fenced_code_attributes+bracketed_spans",
  │        wrap: "none",
  │      }, body)
  │      - -latex_macros disables pandoc's \newcommand expansion
  │      - +raw_tex passes unknown commands through as raw TeX
  │
  ├─ 10. Post-process:
  │      - Strip temporary LaTeX artifacts
  │
  └─ 11. Return result:
         - Truncate body via truncateHead
         - Include: title, authors, abstract (from pandoc metadata)
         - Include: file path, line count, file size
         - Include: "Full paper at {path}. Use read to inspect."
```

### Return value shape

```typescript
{
  content: [{
    type: "text",
    text: `
[fetch_arxiv] {id}: "{title}"
Authors: {authors}
Output: {path} ({lines} lines, {size})

## Abstract
{abstract}

---

{truncatedBody}

[Full paper at {path}. Use read to inspect.]
    `.trim()
  }],
  details: {
    id: string,
    title: string,
    authors: string,
    abstract: string,
    path: string,        // absolute path to output.md
    preamblePath: string, // absolute path to preamble.tex
    lines: number,
    bytes: number,
    truncated: boolean,
  }
}
```

---

## Flattener design (`flatten.ts`)

### Core algorithm

```
function flatten(mainPath: string): string
  1. rootDir = dirname(mainPath)
  2. resolving = new Set()    // cycle detection (chain tracker)
  3. return resolveFile(mainPath, rootDir, resolving, 0)

function resolveFile(path, currentDir, resolving, depth):
  1. absPath = resolve(currentDir, path) + auto-append .tex
  2. if file not found → return "" (leave \input as-is)
  3. if depth > MAX_DEPTH → throw
  4. if absPath in resolving → throw (circular reference)
  5. resolving.add(absPath)
  6. source = readFile(absPath)
  7. strip whole-line comments (^%)
  8. regex-replace \input{file} / \include{file} with
     recursively resolved content
  9. if child resolution returns "" → leave original command
 10. finally: resolving.delete(absPath)
 11. return source

Regex: /\\(input|include)\{([^}]*)\}/g
  - Skip if backslash inside braces (macro filename)
  - For \include, check \includeonly allowlist
  - If child returns "" (missing file), leave match unchanged
    (handles verbatim, typos, draft references without special code)
```

### Edge cases handled

- `\input{file}` without `.tex` extension → append `.tex`, try both
- `\include{file}` → same resolution
- `\includeonly{file1,file3}` → scanned from main source before resolution; only resolve listed includes
- Nested `\input` → recursive resolution with depth limit (max 20)
- `\input` anywhere (preamble, document body, inside environments) → resolved if file exists
- Circular references → detected via `resolving` set → **throw**
- File not found → **return empty, leave command unchanged** (handles verbatim, typos, draft references naturally — no special verbatim code needed)
- Macro-based filenames (e.g. `\input{\jobname-foo}`) → skip, leave as-is
- Comment lines (`%...`) → stripped before resolution
- `\input` inside verbatim → naturally protected: the filename (e.g. `literal`) won't resolve to a real file, so the command stays as-is
- `\input@path` / `\graphicspath` → not resolved (require TeX execution, not static parsing)

---

## Pandoc invocation strategy

We use `from: "latex-latex_macros+raw_tex"` and `standalone: true`:

- **`-latex_macros`**: Disables pandoc's `\newcommand` expansion.  Without
  this, pandoc expands macro bodies during parsing and crashes on bodies
  containing `\ifthenelse` with unbalanced environments (e.g.
  `\end{minipage}` in both branches).  The preamble is extracted to
  `preamble.tex` so the LLM can inspect macro definitions if needed.
- **`+raw_tex`**: Passes unknown commands through as raw TeX in the output.
  Macro names like `\SL`, `\wpCh` carry semantic meaning — more useful to
  an LLM than their LaTeX implementations.
- **`standalone: true`**: Pandoc emits a YAML metadata block at the top of
  the output. This is parsed to extract title, author, and abstract — more
  robust than regex matching (handles nested braces, `\thanks` footnotes,
  and multi-line fields).

---

## Arxiv source download (`arxiv.ts`)

### Download

```
Check /tmp/pi-arxivist/{id}/ → if directory exists with content, skip download.

Otherwise:
  GET https://arxiv.org/e-print/{id}
    → 301/302 redirect to actual .tar.gz
    → Stream to /tmp/pi-arxivist/{id}/source.tar.gz
    → Handle errors (invalid ID, no source available, network errors)
```

ID validation is deliberately minimal: URL prefixes are stripped, the rest is
passed through. Invalid IDs produce a 404 from arxiv, surfaced as a clear error.

### Extraction

```
tar -xzf {tarball} -C {workDir}
  → Handle nested directories (some arxiv tarballs wrap in a subdir)
  → Detect if the tarball extracted into a single subdirectory → use that as root
```

### Caching

Output goes to `/tmp/pi-arxivist/<id>/` — a deterministic path that doubles
as a cache. Subsequent requests for the same paper skip download and
extraction entirely. Files are treated as user artifacts and are not
auto-cleaned.

---

## Pandoc wrapper (`pandoc.ts`)

### API

```typescript
import { convert } from "pandoc-wasm";

interface PandocOptions {
  from: string;
  to: string;
  wrap?: "none" | "auto" | "preserve";
  standalone?: boolean;
}

async function runPandoc(
  source: string,              // flattened LaTeX source
  options: PandocOptions,
): Promise<{
  output: string;              // converted markdown
  stderr: string;
  warnings: Array<{ message: string }>;
}>
```

### How it works

Pandoc runs as WebAssembly in the same Node.js process. Input is passed
via stdin (the `source` parameter). Output is captured from stdout.

No `child_process`, no PATH lookup, no install instructions. Pandoc is
an npm dependency.

---

## Post-processing

After pandoc conversion:
1. **YAML metadata**: Parsed from the `standalone` output frontmatter, then
   stripped from the displayed body.
2. **LaTeX artifacts**: Strip any `\hypertarget{...}{...}` or similar that
   leaked through.

---

## Dependencies

| Dependency | Source | Purpose |
|-----------|--------|---------|
| `pandoc-wasm` ^1.1.0 | npm | Pandoc compiled to WebAssembly — LaTeX → Markdown in-process (conversion + metadata extraction) |
| `tar` | system | Extract arxiv tarballs (available on all systems) |
| `@earendil-works/pi-coding-agent` | pi SDK | `registerTool`, `truncateHead` |
| `typebox` | pi SDK | Tool parameter schema |
| `@earendil-works/pi-tui` | pi SDK | Custom rendering (optional) |

Note: the flattener uses only `node:fs` and `node:path` (no npm dependencies).

---

## Known risks / hard problems

### 1. Regex edge cases
The `\input` regex `/([^}]*)/` doesn't handle nested braces in filenames or
multi-line `\input` commands. Both are vanishingly rare in arxiv papers.

**Mitigation**: the "file not found → leave as-is" strategy means a missed
`\input` simply stays in the document. Pandoc will either process it (it has
some native `\input` support) or produce a warning. No data is lost.

### 2. Pandoc WASM limitations
The WASM build cannot produce PDFs (requires external LaTeX engine),
can't fetch HTTP resources, and JSON filters are unsupported. Memory is
limited by the WASM heap (64MB configured). Large papers with many images
may hit memory limits.

**Mitigation**: our use case (LaTeX → Markdown, no PDF, no HTTP, no
filters) stays within WASM capabilities. `raw_tex` preserves unknown
LaTeX in the markdown output.

### 3. Arxiv tarball structure variability
Some tarballs are flat, some wrap in a subdirectory, some have multiple
subdirectories. Some include generated files (`.aux`, `.bbl`) alongside
source. Some rename the main file to something unexpected.

**Mitigation**: the `\documentclass` heuristic + fallback filename matching.
If neither works, list all `.tex` files and let the user specify.

### 4. Encoding issues
Old papers may use latin1/ISO-8859-1. Arxiv source is typically utf8 but
there are exceptions.

**Mitigation**: read files as utf8. If reading fails, try latin1. Pandoc
handles both encodings — the flattener passes bytes through unchanged.

### 5. Rate limiting
Arxiv's `/e-print/` endpoint is not a public API and may rate-limit
aggressive use.

**Mitigation**: respect `Retry-After` headers. The caching layer reduces
repeat requests.

---

## Non-goals (for v1)

- **No LaTeXML fallback** — pandoc only
- **No PDF download** — source tarball only (papers without sources get an error)
- **No automatic cache cleanup** — files are user artifacts under `/tmp/pi-arxivist/`
- **No custom TUI rendering** — default tool rendering is fine for v1
- **No bibliography processing** — `.bib` files remain in the artifact directory
  for the LLM to search if needed; `\cite` commands appear as-is in the output
- **No TeX primitive expansion** — `\expandafter`, `\csname`, `\@ifnextchar`,
  `\ifx` and other TeX-level constructs are left as-is (pandoc ignores them).
  Only `\newcommand`/`\renewcommand`/`\newenvironment`/`\newtheorem`/`\def`
  are expanded.
- **No deep catcode support** — `\makeatletter` is handled (allows `@` in
  command names), but arbitrary catcode changes are not.
