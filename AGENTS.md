# pi-arxivist

A pi extension that provides a `fetch_arxiv` tool: download arxiv LaTeX source, flatten `\input`/`\include`, convert to Markdown via pandoc.

Full design, pipeline, and edge cases: [PLAN.md](./PLAN.md).

## Development

```bash
npm run check   # typecheck + lint + format:check
npm run format  # auto-fix formatting
```

## Changesets

Create a changeset for every non-trivial change (features, fixes, breaking changes). Skip for formatting, typo fixes, or internal refactors that don't affect behavior. Commit the changeset together with the code — never in a separate commit.

Write changeset files manually — the `npx changeset` interactive CLI does not work with piped input in a non-TTY environment. Format:

```markdown
---
"pi-arxivist": patch
---

Description of the change.
```

Save as `.changeset/<descriptive-slug>.md`. Bump types: `patch`, `minor`, `major`.

Changesets are committed alongside the code. Never run `npm publish` yourself. Run `npm run version` only when asked directly.

## Key principles

- **Fail hard.** Never degrade silently — notify the user via `ctx.ui.notify()`.
- **Type strict.** `tsconfig.json` has `strict: true`. ESLint uses `strictTypeChecked`.
- **Don't reinvent.** Search for existing libraries before writing custom solutions.
- **No belt and suspenders.** Parse at boundaries, use non-nullable fields, prefer compile-time guarantees over runtime checks.
