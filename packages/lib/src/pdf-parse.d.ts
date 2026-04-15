// Minimal ambient declaration for pdf-parse. The package ships no types
// and the community @types/pdf-parse is stale against the current
// maintained release. We only need numpages + text from the result, so
// declaring a narrow shape keeps the rest of the pipeline type-safe.

declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }
  function pdfParse(
    data: Buffer | Uint8Array,
    options?: Record<string, unknown>,
  ): Promise<PdfParseResult>;
  export = pdfParse;
}
