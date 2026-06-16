---
"pi-arxivist": patch
---

Fix cache hit: skip pipeline when output already generated

On cache hit, the pipeline was incorrectly looking for .tex files in the
`output/` subdirectory because `effectiveRoot()` was treating it as the
tarball's extraction root. Now:

- `effectiveRoot()` excludes known artifact directories (`output/`)
- `index.ts` checks for cached `output/paper.md` + `output/meta.json`
  and returns immediately, bypassing the entire pipeline
- `meta.json` is saved alongside `paper.md` during first run
