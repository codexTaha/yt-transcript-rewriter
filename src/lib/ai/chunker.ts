/**
 * src/lib/ai/chunker.ts
 * Transcript chunking utility — Phase 4.2
 *
 * - If word count < 6000  → single chunk, no splitting
 * - If word count ≥ 6000  → 4000-word chunks with 200-word overlap
 */

const CHUNK_SIZE   = 4000; // words per chunk
const OVERLAP_SIZE =  200; // words of overlap between consecutive chunks
const SINGLE_LIMIT = 6000; // below this word count → no splitting

/**
 * Split a transcript into overlapping chunks.
 * Returns a single-element array if the text is short enough.
 */
export function chunkTranscript(text: string): string[] {
  const words = text.trim().split(/\s+/);

  if (words.length <= SINGLE_LIMIT) {
    return [text.trim()];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < words.length) {
    const end   = Math.min(start + CHUNK_SIZE, words.length);
    chunks.push(words.slice(start, end).join(' '));
    if (end >= words.length) break;
    start = end - OVERLAP_SIZE; // back up by overlap for next chunk
  }

  return chunks;
}

/**
 * Join rewritten chunk results with a clear separator.
 */
export function mergeChunks(chunks: string[]): string {
  return chunks.join('\n\n');
}
