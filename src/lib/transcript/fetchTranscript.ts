/**
 * Fetches a YouTube transcript by spawning fetch_transcript.py.
 * Uses the same logic as roundyyy/yt-bulk-subtitles-downloader:
 *   1. Try English
 *   2. Try translatable -> translate to English
 *   3. Fallback to any available language
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

// Path to the Python script (relative to project root)
const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'fetch_transcript.py');

// Detect python binary (python3 preferred)
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export interface TranscriptResult {
  text: string;
  language: string;
}

/**
 * Fetch transcript for a YouTube video ID.
 * @param videoId  - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @param proxy    - Optional proxy string "host:port"
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 */
export async function fetchTranscript(
  videoId: string,
  proxy?: string,
  timeoutMs = 30_000
): Promise<TranscriptResult> {
  const args: string[] = [SCRIPT_PATH, videoId];
  if (proxy) args.push(proxy);

  let stdout: string;
  try {
    const result = await execFileAsync(PYTHON, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile rejects on non-zero exit code; stdout may still contain JSON
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? '';
    if (!stdout.trim()) {
      throw new Error(
        `Python script failed: ${e.stderr?.slice(0, 200) ?? e.message ?? 'unknown error'}`
      );
    }
  }

  let parsed: { success: boolean; text?: string; language?: string; error?: string };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Invalid JSON from transcript script: ${stdout.slice(0, 200)}`);
  }

  if (!parsed.success || !parsed.text) {
    throw new Error(parsed.error ?? 'Transcript fetch failed');
  }

  return { text: parsed.text, language: parsed.language ?? 'en' };
}
