/**
 * pandoc-wasm worker thread.
 *
 * Runs pandoc conversion off the main thread so the event loop
 * stays responsive.  Created fresh per call, terminated after.
 *
 * Work arrives via workerData at construction time (single-use worker).
 * The result is posted back via parentPort and the worker exits.
 */

import { parentPort, workerData } from "node:worker_threads";
import { convert } from "pandoc-wasm";

const input = workerData as { source: string };

async function main(): Promise<void> {
  try {
    const result = await convert(
      {
        from: "latex-latex_macros+raw_tex",
        to: "markdown+tex_math_dollars+raw_tex+fenced_code_attributes+bracketed_spans",
        standalone: false,
        wrap: "none",
      },
      input.source,
      {},
    );
    parentPort?.postMessage({
      type: "ok",
      stdout: result.stdout,
      stderr: result.stderr,
      warnings: result.warnings,
    });
  } catch (err: unknown) {
    parentPort?.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

void main();
