import type { ExtractState } from "./types";

// Copy for the background reading stage. Kept in sync with the mobile app
// (Sua/src/lib/extract-copy.ts) so both surfaces use identical wording.
export const EXTRACT_FAILED_MESSAGE =
  "Couldn’t read this file. Try a clearer photo or a text PDF.";

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
