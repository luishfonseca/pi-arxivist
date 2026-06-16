import { Worker } from "node:worker_threads";

export interface PandocResult {
  output: string;
  stderr: string;
  warnings: Array<{ message: string; verbosity?: string }>;
}

// ── Worker IPC types ──────────────────────────────────────────────────

interface WorkerOk {
  type: "ok";
  stdout: string;
  stderr: string;
  warnings: Array<string | { message: string; verbosity?: string }>;
}

interface WorkerError {
  type: "error";
  message: string;
}

type WorkerMessage = WorkerOk | WorkerError;

// ── Worker helper ─────────────────────────────────────────────────────

/**
 * Run pandoc conversion in a dedicated worker thread.
 *
 * Spawns a fresh worker per call with work in `workerData`,
 * awaits the result via message, then terminates.  The worker
 * owns the ~40 MB WASM heap — it is freed on termination.
 *
 * The event loop stays responsive throughout because WASM
 * execution happens off the main thread.
 */
function runInWorker(source: string): Promise<WorkerOk> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pandoc-worker.js", import.meta.url), {
      workerData: { source },
    });

    worker.on("message", (msg: WorkerMessage) => {
      if (msg.type === "ok") {
        resolve(msg);
      } else {
        reject(new Error(msg.message));
      }
      void worker.terminate();
    });

    worker.on("error", (err) => {
      reject(err);
      void worker.terminate();
    });
  });
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Convert a LaTeX source string to Markdown via pandoc.
 *
 * Runs in a worker thread so the event loop stays responsive.
 */
export async function runPandoc(source: string): Promise<PandocResult> {
  const result = await runInWorker(source);

  const warnings: Array<{ message: string; verbosity?: string }> = [];
  for (const w of result.warnings) {
    if (typeof w === "string") {
      warnings.push({ message: w });
    } else if (typeof w.message === "string") {
      warnings.push({ message: w.message, verbosity: w.verbosity });
    }
  }

  return { output: result.stdout, stderr: result.stderr, warnings };
}
