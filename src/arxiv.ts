/**
 * Arxiv source download and extraction.
 *
 * Downloads the LaTeX source tarball from arxiv's /e-print/ endpoint,
 * extracts it with `tar`, and returns the working directory.
 *
 * Uses a deterministic path under /tmp/pi-arxivist/<id>/ that doubles
 * as a cache — repeated requests for the same paper skip download.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ARXIV_E_PRINT = "https://arxiv.org/e-print/";

function cacheDir(id: string): string {
  return join(tmpdir(), "pi-arxivist", id);
}

function effectiveRoot(workDir: string): string {
  const entries = readdirSync(workDir, { withFileTypes: true });
  const subdirs = entries.filter((e) => e.isDirectory());

  // If the tarball extracted into a single subdirectory (common arxiv
  // packaging pattern), use that as the effective root.
  if (subdirs.length === 1) {
    const nested = join(workDir, subdirs[0]?.name ?? "");
    if (existsSync(nested)) {
      return nested;
    }
  }

  return workDir;
}

/**
 * Download and extract an arxiv paper's LaTeX source.
 *
 * @param id Canonical arxiv ID (e.g. "1203.6859v3").
 * @returns Path to the directory containing the extracted source files.
 */
export async function downloadSource(id: string): Promise<string> {
  const workDir = cacheDir(id);

  // Cache hit: directory already exists with extracted content
  if (existsSync(workDir) && readdirSync(workDir).length > 0) {
    return effectiveRoot(workDir);
  }

  mkdirSync(workDir, { recursive: true });
  const tarball = join(workDir, "source.tar.gz");

  try {
    // Download
    const response = await fetch(`${ARXIV_E_PRINT}${id}`, {
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(
        `Failed to download arxiv source for "${id}": HTTP ${String(response.status)}`,
      );
    }

    // Arxiv returns HTML when no source is available
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("html")) {
      await response.text(); // consume body
      throw new Error(
        `No LaTeX source available for "${id}". Arxiv returned an HTML page (no source tarball).`,
      );
    }

    const buf = Buffer.from(await response.arrayBuffer());
    writeFileSync(tarball, buf);

    // Extract (tarball persists for debugging)
    execSync(`tar -xzf "${tarball}" -C "${workDir}"`, {
      encoding: "utf-8",
      stdio: "pipe",
    });

    return effectiveRoot(workDir);
  } catch (err) {
    // Remove the empty cache directory on download/extraction failure
    // so a retry starts fresh.
    try {
      rmdirSync(workDir, { recursive: true });
    } catch {
      /* best-effort */
    }
    throw err;
  }
}
