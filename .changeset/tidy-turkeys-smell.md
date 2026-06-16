---
"pi-arxivist": patch
---

Add `renderCall`/`renderResult` so the TUI shows a compact one-liner instead of flooding the screen with the full truncated body. Fix truncation metadata: use correct `truncated` boolean, show accurate line/byte stats in the header, and only include truncation footer when actually truncated.
