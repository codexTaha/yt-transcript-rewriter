/**
 * Fetches a YouTube transcript by spawning fetch_transcript.py.
 * Uses the same proxy pattern as roundyyy/yt-bulk-subtitles-downloader:
 *   GenericProxyConfig(http_url, https_url) from youtube_transcript_api.proxies
 *
 * Proxy is auto-read from PROXY_URL env var (format: host:port or user:pass@host:port).
 * You can also pass a proxy explicitly as the second argument.
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
 * @param videoId   - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @param proxy     - Optional proxy string "host:port" or "user:pass@host:port".
 *                    Falls back to PROXY_URL env var if not supplied.
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 */
export async function fetchTranscript(
  videoId: string,
  proxy?: string,
  timeoutMs = 30_000
): Promise<TranscriptResult> {
  const resolvedProxy = proxy ?? resolveProxyFromEnv();

  const args: string[] = [SCRIPT_PATH, videoId];
  if (resolvedProxy) args.push(resolvedProxy);

  // Log what proxy is being used (helpful for debugging)
  console.log(`[fetchTranscript] video=${videoId} proxy=${resolvedProxy ?? '(none)'}`);

  let stdout: string;
  let stderr: string = '';
  try {
    const result = await execFileAsync(PYTHON, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr ?? '';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean; code?: string };
    stdout = e.stdout ?? '';
    stderr = e.stderr ?? '';
    if (!stdout.trim()) {
      const killed = e.killed ? ' (process killed — timeout?)' : '';
      const stderrDetail = stderr.trim() ? `\nstderr: ${stderr.slice(0, 500)}` : '';
      throw new Error(
        `Python script failed${killed}: ${e.message ?? 'unknown error'}${stderrDetail}`
      );
    }
  }

  if (stderr.trim()) {
    console.warn(`[fetchTranscript] stderr for ${videoId}: ${stderr.slice(0, 300)}`);
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

/**
 * Parse PROXY_URL env var into a "host:port" or "user:pass@host:port" string
 * that the Python script expects.
 *
 * Accepts any of:
 *   http://host:port
 *   http://user:pass@host:port
 *   host:port              (bare, no scheme)
 */
function resolveProxyFromEnv(): string | undefined {
  const raw = process.env.PROXY_URL?.trim();
  if (!raw) return undefined;
  // Strip scheme (http:// or https://) — Python script prepends its own
  const stripped = raw.replace(/^https?:\/\//i, '');
  return stripped || undefined;
}
