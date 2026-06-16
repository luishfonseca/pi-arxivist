# pi-arxivist

Fetch arxiv papers as clean Markdown, right inside [pi](https://github.com/earendil-works/pi). Zero config, zero system dependencies.

Arxiv provides LaTeX source tarballs for most papers. `fetch_arxiv` downloads the source, flattens `\input`/`\include` references, and converts the result to Markdown via pandoc. No PDF extraction, no garbled math, no lost structure.

## Install

```bash
pi install npm:pi-arxivist
```

## Usage

```
fetch_arxiv 1203.6859
fetch_arxiv https://arxiv.org/abs/1203.6859
fetch_arxiv https://arxiv.org/pdf/1203.6859
```

Accepts bare IDs, abstract URLs, or PDF URLs.

## What it returns

- **`paper.md`** — full paper in the cache directory, math preserved as `$...$` / `$$...$$`
- **`meta.json`** — full frontmatter as JSON (title, abstract, authors, etc.)
- **`preamble.tex`** — macro definitions that pandoc couldn't process, extracted for inspection

The tool truncates output to fit context limits. Use `read` on the output path for the full paper.

## How it works

1. Downloads the source tarball from `arxiv.org/e-print/<id>`
2. Extracts with `tar`
3. Finds the main `.tex` file (heuristic: first file with `\documentclass`)
4. Recursively resolves `\input`/`\include` commands into a single flat document
5. Converts the full source to Markdown via the official [pandoc WASM binary](https://www.npmjs.com/package/pandoc-wasm)
6. Extracts metadata from the pandoc-generated YAML frontmatter
7. Extracts unprocessed preamble macros to `preamble.tex`

No system pandoc or LaTeX distribution needed.
