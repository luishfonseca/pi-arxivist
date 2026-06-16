# pi-arxivist

## 0.1.6

### Patch Changes

- 252e22f: Gate source extraction on Content-Type instead of guessing. Arxiv returns `application/pdf` when no LaTeX source is available — previously this was saved as a `.tar.gz` and hit a cryptic zlib error. Now unsupported content types fail immediately with the actual type in the message. Also handle pre-2007 single-gzipped-.tex format via `gunzipSync` fallback instead of `tar` only.
- 267d9ab: Replace heuristic `findMainTex` with graph-based `parseLatexGraph` that recursively maps all `.tex` files, builds dependency edges from `\input`/`\include`, and picks the indegree-0 node with the largest reachable set as root. `flatten` is now synchronous, operating on sentinelized content rather than doing async file I/O during resolution. Drop `effectiveRoot` in favor of recursive file discovery.
- 252e22f: Fix extraction for old-style arxiv papers whose source is a single gzipped .tex file (no tar wrapper). Try tar first, fall back to raw gunzip.
- 00252ea: Errors now throw instead of returning error results. The framework sets
  `context.isError = true`, which triggers the error rendering path in
  `renderResult` — errors appear inline in the tool call instead of as
  `ctx.ui.notify()` popups.

## 0.1.5

### Patch Changes

- 2004c93: Remove standalone pandoc mode, simplify pandoc options, and fix README claims about author extraction.
- f0a2eb0: Post-pandoc splitting: YAML frontmatter parsed to meta.json, preamble macros extracted to preamble.tex, headings shifted down, title/abstract injected as human-readable header.
- ce2aa92: Simplify truncation output: remove implementation headers, follow truncated-tool pattern.

## 0.1.4

### Patch Changes

- 6010627: Add `renderCall`/`renderResult` so the TUI shows a compact one-liner instead of flooding the screen with the full truncated body. Fix truncation metadata: use correct `truncated` boolean, show accurate line/byte stats in the header, and only include truncation footer when actually truncated.

## 0.1.3

### Patch Changes

- a2c4261: Eliminate synchronous I/O blocking + simplify metadata pipeline

  ### No more event-loop blocking
  1. **`execSync` → async spawn** (`arxiv.ts`): tar extraction no longer
     blocks the event loop. `AbortSignal` support for cancellation.
  2. **`readFileSync` → async fs/promises** (`flatten.ts`): the recursive
     `\input`/`\include` resolver is now fully async.
  3. **Pandoc WASM → worker thread** (`pandoc.ts` + `pandoc-worker.ts`):
     pandoc conversion runs off the main thread. Fresh worker per call,
     work sent via `workerData`, result via message, then terminated.

  ### Simplified metadata
  - Single pandoc call with `standalone: true` — YAML frontmatter in the
    Markdown output replaces the old `meta.json` + `runPandocJson` +
    `extractMeta` + AST walker chain.
  - Title regex-extracted from preamble and injected into YAML frontmatter.
  - Abstract extracted from body by pandoc.
  - `preamble.tex` now written to `output/` to avoid `findMainTex`
    misidentifying it as the main source file.

- d63304d: Fix cache hit: skip pipeline when output already generated

  On cache hit, the pipeline was incorrectly looking for .tex files in the
  `output/` subdirectory because `effectiveRoot()` was treating it as the
  tarball's extraction root. Now:

  - `effectiveRoot()` excludes known artifact directories (`output/`)
  - `index.ts` checks for cached `output/paper.md` + `output/meta.json`
    and returns immediately, bypassing the entire pipeline
  - `meta.json` is saved alongside `paper.md` during first run

## 0.1.2

### Patch Changes

- a5872df: Improve prompt engineering: outcome-oriented tool description, better preamble and artifact hints in output, remove stale version suffix claim from parameter description.

## 0.1.1

### Patch Changes

- 37a9857: Add npm packaging: emit compiled JS to dist/, exports map, LICENSE, and changesets for version management.
