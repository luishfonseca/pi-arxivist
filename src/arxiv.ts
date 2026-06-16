/**
 * Arxiv source download and extraction.
 *
 * Downloads the LaTeX source tarball from arxiv's /e-print/ endpoint,
 * extracts it with `tar`, and returns the working directory.
 *
 * Uses a deterministic path under /tmp/pi-arxivist/<id>/ that doubles
 * as a cache — repeated requests for the same paper skip download.
 *
 * All I/O is async — nothing blocks the event loop.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const ARXIV_E_PRINT = "https://arxiv.org/e-print/";

function cacheDir(id: string): string {
  return join(tmpdir(), "pi-arxivist", id);
}

/**
 * Download and extract an arxiv paper's LaTeX source.
 *
 * @param id Canonical arxiv ID (e.g. "1203.6859v3").
 * @param signal Optional AbortSignal to cancel the operation.
 * @returns Path to the directory containing the extracted source files.
 */
export async function downloadSource(id: string, signal?: AbortSignal): Promise<string> {
  const workDir = cacheDir(id);

  // Cache hit: directory already exists with extracted content
  if (existsSync(workDir) && readdirSync(workDir).length > 0) {
    return workDir;
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

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();

    // Arxiv returns gzip for LaTeX source (either a tar.gz tarball or a
    // single gzipped .tex file for older pre-2007 submissions).  Anything
    // else means no LaTeX source is available.
    if (!contentType.includes("gzip") && !contentType.includes("x-gzip")) {
      await response.body?.cancel();
      throw new Error(`No LaTeX source available for "${id}" (Content-Type: ${contentType}).`);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    writeFileSync(tarball, buf);

    // Most papers ship as tar.gz, but older submissions (pre-2007,
    // old-style IDs) are a single gzipped .tex file with no tar wrapper.
    // Content-Type alone can't distinguish them — try tar first.
    try {
      await spawnAsync("tar", ["-xzf", tarball, "-C", workDir], signal);
    } catch {
      // Not a tar archive — decompress as a single gzipped file.
      try {
        const tex = gunzipSync(buf);
        writeFileSync(join(workDir, "paper.tex"), tex);
      } catch (gunzipErr) {
        const msg = gunzipErr instanceof Error ? gunzipErr.message : String(gunzipErr);
        throw new Error(
          `Failed to extract arxiv source for "${id}": not a gzipped tar archive, ` +
            `and not a gzipped file either (${msg}).`,
        );
      }
    }

    return workDir;
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

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Spawn a child process and wait for it to exit.
 *
 * Returns a promise that resolves on success (exit code 0) or rejects on
 * error (non-zero exit, spawn failure, or abort).
 *
 * Unlike `execSync`, this does NOT block the event loop.
 */
function spawnAsync(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Already aborted before we even spawn
    if (signal?.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const child = spawn(command, args, {
      stdio: "pipe",
    });

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });

    const onAbort = (): void => {
      child.kill("SIGTERM");
      // SIGKILL after 2s grace period
      setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 2000).unref();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (code === 0) {
        resolve();
      } else if (signal?.aborted) {
        reject(new Error("Aborted"));
      } else {
        reject(
          new Error(`tar exited with code ${String(code)}${stderr ? `: ${stderr.trim()}` : ""}`),
        );
      }
    });
  });
}
