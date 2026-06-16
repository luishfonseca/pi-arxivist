# pi-arxivist

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
