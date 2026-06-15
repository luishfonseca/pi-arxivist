declare module "pandoc-wasm" {
  export interface ConvertOptions {
    from?: string;
    to?: string;
    standalone?: boolean;
    wrap?: "none" | "auto" | "preserve";
    citeproc?: boolean;
    bibliography?: string[];
    "extract-media"?: string;
    "output-file"?: string;
    [key: string]: unknown;
  }

  export interface ConvertResult {
    stdout: string;
    stderr: string;
    warnings: Array<string | { message: string; verbosity?: string }>;
    files: Record<string, Blob>;
    mediaFiles: Record<string, Blob>;
  }

  export function convert(
    options: ConvertOptions,
    stdin?: string,
    files?: Record<string, string>,
  ): Promise<ConvertResult>;

  export function query(options: ConvertOptions): Promise<unknown>;

  export function pandoc(
    args: string,
    inData?: string | Blob,
    resources?: Array<{ filename: string; contents: string | Blob }>,
  ): Promise<{ out: string | Blob; mediaFiles: Map<string, string | Blob> }>;
}
