---
"pi-arxivist": patch
---

Replace heuristic `findMainTex` with graph-based `parseLatexGraph` that recursively maps all `.tex` files, builds dependency edges from `\input`/`\include`, and picks the indegree-0 node with the largest reachable set as root. `flatten` is now synchronous, operating on sentinelized content rather than doing async file I/O during resolution. Drop `effectiveRoot` in favor of recursive file discovery.
