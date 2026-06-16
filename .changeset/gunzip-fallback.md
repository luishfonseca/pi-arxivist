---
"pi-arxivist": patch
---

Fix extraction for old-style arxiv papers whose source is a single gzipped .tex file (no tar wrapper). Try tar first, fall back to raw gunzip.
