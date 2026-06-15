# pi-arxivist

A pi extension that provides a `fetch_arxiv` tool: download arxiv LaTeX source, flatten `\input`/`\include`, convert to Markdown via pandoc.

Full design, pipeline, and edge cases: [PLAN.md](./PLAN.md).

## Development

```bash
npm run check   # typecheck + lint + format:check
npm run format  # auto-fix formatting
```

## Key principles

- **Fail hard.** Never degrade silently — notify the user via `ctx.ui.notify()`.
- **Type strict.** `tsconfig.json` has `strict: true`. ESLint uses `strictTypeChecked`.
- **Don't reinvent.** Search for existing libraries before writing custom solutions.
- **No belt and suspenders.** Parse at boundaries, use non-nullable fields, prefer compile-time guarantees over runtime checks.
