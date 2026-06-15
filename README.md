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
fetch_arxiv https://arxiv.org/pdf/1203.6859v2
```

Accepts bare IDs, abstract URLs, or PDF URLs. Version suffixes are preserved.

## What it returns

- **Title, authors, abstract** — extracted from the document metadata (pandoc handles nested braces, `\thanks` footnotes)
- **Body** as Markdown — math preserved as `$...$` / `$$...$$`, unknown LaTeX commands passed through as raw TeX
- **Output path** — full paper at `output/paper.md` inside the cache directory
- **Preamble path** — macro definitions extracted to `preamble.tex` so you can inspect them on demand

The tool truncates output to fit context limits. Use `read` on the output path for the rest.

## How it works

1. Downloads the source tarball from `arxiv.org/e-print/<id>`
2. Extracts with `tar`
3. Finds the main `.tex` file (heuristic: first file with `\documentclass`)
4. Recursively resolves `\input`/`\include` commands into a single flat document
5. Splits preamble from body, writes preamble to `preamble.tex`
6. Extracts metadata (title, authors, abstract) via pandoc's JSON AST
7. Converts body to Markdown via the official [pandoc WASM binary](https://www.npmjs.com/package/pandoc-wasm)

No system pandoc or LaTeX distribution needed.
