import type { ExtractState } from "./notes";

// Copy for the server-side reading stage. Kept in one place so the Uploads
// queue and the note reader say exactly the same thing.
export const EXTRACT_FAILED_MESSAGE =
  "Couldn't read this file. Try a clearer photo or a text PDF.";

export function isReading(state: ExtractState | null | undefined) {
  return state === "pending" || state === "running";
}

export function readingLabel(
  state: ExtractState,
  extractedPages: number,
  totalPages: number,
): string {
  if (state === "partial") {
    const used = extractedPages > 0 ? extractedPages : totalPages;
    return used > 0
      ? `Used the first ${used} pages. Upload the rest by chapter.`
      : "Upload the rest of this file by chapter.";
  }
  if (totalPages > 0) {
    const read = Math.min(extractedPages, totalPages);
    return read > 0
      ? `Reading your file (${read} of ${totalPages} pages)`
      : `Reading your file (${totalPages} pages)`;
  }
  return "Reading your file";
}
