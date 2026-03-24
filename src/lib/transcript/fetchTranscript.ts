/**
 * Fetches a YouTube transcript by spawning fetch_transcript.py.
 *
 * Proxy priority (handled entirely in the Python script via env vars):
 *   1. WEBSHARE_PROXY_USERNAME + WEBSHARE_PROXY_PASSWORD -> WebshareProxyConfig (rotating residential)
 *   2. PROXY_URL                                         -> GenericProxyConfig
 *   3. No proxy (direct)
 *
 * No proxy configuration needed here — just set the right env vars in .env.local.
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
 * Proxy config is resolved automatically from environment variables by the Python script.
 * @param videoId   - YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @param timeoutMs - Timeout in milliseconds (default 30s)
 */
export async function fetchTranscript(
  videoId: string,
  timeoutMs = 30_000
): Promise<TranscriptResult> {
  const args: string[] = [SCRIPT_PATH, videoId];

  // Pass relevant env vars through to the Python subprocess
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Explicitly forward proxy env vars in case they aren't inherited
    WEBSHARE_PROXY_USERNAME: process.env.WEBSHARE_PROXY_USERNAME ?? '',
    WEBSHARE_PROXY_PASSWORD: process.env.WEBSHARE_PROXY_PASSWORD ?? '',
    PROXY_URL: process.env.PROXY_URL ?? '',
  };

  const proxyMode =
    env.WEBSHARE_PROXY_USERNAME ? 'webshare' :
    env.PROXY_URL               ? `generic:${env.PROXY_URL}` :
                                   'direct';
  console.log(`[fetchTranscript] video=${videoId} proxy_mode=${proxyMode}`);

  let stdout: string;
  let stderr = '';
  try {
    const result = await execFileAsync(PYTHON, args, {
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
      const killed = e.killed ? ' (process killed — timeout)' : '';
      const stderrDetail = stderr.trim() ? `\nstderr: ${stderr.slice(0, 500)}` : '';
      throw new Error(
        `Python script failed${killed}: ${e.message ?? 'unknown error'}${stderrDetail}`
      );
    }
  }

  if (stderr.trim()) {
    console.log(`[fetchTranscript] py stderr [${videoId}]: ${stderr.trim().slice(0, 300)}`);
  }

  let parsed: { success: boolean; text?: string; language?: string; error?: string; proxy?: string };
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
