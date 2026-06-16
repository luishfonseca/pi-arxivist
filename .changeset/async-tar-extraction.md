---
"pi-arxivist": patch
---

Eliminate synchronous I/O blocking + simplify metadata pipeline

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
