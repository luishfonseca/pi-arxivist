import { Worker } from "node:worker_threads";

export const PANDOC_FROM = "latex-latex_macros+raw_tex";
export const PANDOC_TO = "markdown+tex_math_dollars+raw_tex+fenced_code_attributes+bracketed_spans";

export interface PandocOptions {
  from?: string;
  to?: string;
  wrap?: "none" | "auto" | "preserve";
  standalone?: boolean;
}

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
function runInWorker(source: string, options: Record<string, unknown>): Promise<WorkerOk> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./pandoc-worker.js", import.meta.url), {
      workerData: { source, options },
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
 * Defaults to `standalone: true` — the output includes a YAML
 * metadata block with title, authors, and abstract.
 */
export async function runPandoc(
  source: string,
  options: PandocOptions = {},
): Promise<PandocResult> {
  const pandocOpts: Record<string, unknown> = {
    from: options.from ?? PANDOC_FROM,
    to: options.to ?? PANDOC_TO,
    standalone: options.standalone ?? true,
    wrap: options.wrap ?? "none",
  };

  const result = await runInWorker(source, pandocOpts);

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
