---
"pi-arxivist": patch
---

Gate source extraction on Content-Type instead of guessing. Arxiv returns `application/pdf` when no LaTeX source is available — previously this was saved as a `.tar.gz` and hit a cryptic zlib error. Now unsupported content types fail immediately with the actual type in the message. Also handle pre-2007 single-gzipped-.tex format via `gunzipSync` fallback instead of `tar` only.
