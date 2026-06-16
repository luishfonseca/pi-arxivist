---
"pi-arxivist": patch
---

Errors now throw instead of returning error results. The framework sets
`context.isError = true`, which triggers the error rendering path in
`renderResult` — errors appear inline in the tool call instead of as
`ctx.ui.notify()` popups.
