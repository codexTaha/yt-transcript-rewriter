/**
 * Fetches a YouTube transcript by spawning scripts/fetch_transcript.py.
 *
 * Auth priority (all handled in Python, just set env vars):
 *   1. YOUTUBE_COOKIES_FILE  -> path to Netscape cookies.txt exported from your browser
 *   2. WEBSHARE_PROXY_USERNAME + WEBSHARE_PROXY_PASSWORD -> paid rotating residential
 *   3. PROXY_URL             -> generic proxy host:port
 *   4. Direct connection     -> works locally, gets blocked on cloud VPS
 *
 * For local dev without a proxy, export cookies.txt from your browser:
 *   Chrome/Firefox extension: "Get cookies.txt LOCALLY" or "Cookie-Editor"
 *   Then set: YOUTUBE_COOKIES_FILE=/absolute/path/to/cookies.txt
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'fetch_transcript.py');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';

export interface TranscriptResult {
  text: string;
  language: string;
}

/**
 * Fetch transcript for a YouTube video ID.
 * All auth/proxy config is read from environment variables by the Python script.
 */
export async function fetchTranscript(
  videoId: string,
  timeoutMs = 60_000   // raised to 60s to handle slow proxy retries
): Promise<TranscriptResult> {
  const authMode =
    process.env.YOUTUBE_COOKIES_FILE                ? `cookies:${process.env.YOUTUBE_COOKIES_FILE}` :
    process.env.WEBSHARE_PROXY_USERNAME             ? 'webshare' :
    process.env.PROXY_URL                           ? `proxy:${process.env.PROXY_URL}` :
                                                      'direct';

  console.log(`[fetchTranscript] video=${videoId} auth=${authMode}`);

  // Forward all relevant env vars explicitly to the subprocess
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    YOUTUBE_COOKIES_FILE:       process.env.YOUTUBE_COOKIES_FILE       ?? '',
    WEBSHARE_PROXY_USERNAME:    process.env.WEBSHARE_PROXY_USERNAME    ?? '',
    WEBSHARE_PROXY_PASSWORD:    process.env.WEBSHARE_PROXY_PASSWORD    ?? '',
    PROXY_URL:                  process.env.PROXY_URL                  ?? '',
  };

  let stdout = '';
  let stderr = '';

  try {
    const result = await execFileAsync(PYTHON, [SCRIPT_PATH, videoId], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env,
    });
    stdout = result.stdout;
    stderr = result.stderr ?? '';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    if (!stdout.trim()) {
      const killed = e.killed ? ' (process timed out)' : '';
      const detail = stderr.trim() ? `\nstderr: ${stderr.slice(0, 500)}` : '';
      throw new Error(`Python script failed${killed}: ${e.message ?? 'unknown'}${detail}`);
    }
  }

  if (stderr.trim()) {
    console.log(`[fetchTranscript] py[${videoId}]: ${stderr.trim().slice(0, 300)}`);
  }

  let parsed: { success: boolean; text?: string; language?: string; error?: string };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Invalid JSON from script: ${stdout.slice(0, 200)}`);
  }

  if (!parsed.success || !parsed.text) {
    throw new Error(parsed.error ?? 'Transcript fetch failed');
  }

  return { text: parsed.text, language: parsed.language ?? 'en' };
}
