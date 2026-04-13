/**
 * Fetches a YouTube transcript by spawning scripts/fetch_transcript.py.
 *
 * Auth priority (all handled in Python, just set env vars):
 *   1. YOUTUBE_COOKIES_FILE  -> path to Netscape cookies.txt exported from your browser
 *      AUTO-DETECT: if YOUTUBE_COOKIES_FILE is not set, we check ~/cookies.txt
 *                   and ~/YT-Tools/cookies.txt automatically.
 *   2. WEBSHARE_PROXY_USERNAME + WEBSHARE_PROXY_PASSWORD -> paid rotating residential
 *   3. PROXY_URL             -> generic proxy host:port
 *   4. Direct connection     -> works locally, gets blocked on cloud VPS
 *   --- fallback ---
 *   5. yt-dlp subtitle fetch -> browser UA + cookies, much harder to block
 *
 * PYTHON RESOLUTION ORDER (fix for venv isolation):
 *   1. PYTHON_BIN env var  -> explicit path e.g. /home/taha/venv/bin/python3
 *   2. <cwd>/venv/bin/python3 (Linux/Mac) or <cwd>/venv/Scripts/python.exe (Windows)
 *   3. python3 / python     -> system fallback
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'fetch_transcript.py');

/**
 * Resolve the Python executable to use, preferring the project venv.
 */
function resolvePython(): string {
  const explicit = process.env.PYTHON_BIN?.trim();
  if (explicit) return explicit;

  const venvUnix = path.join(process.cwd(), 'venv', 'bin', 'python3');
  if (fs.existsSync(venvUnix)) return venvUnix;

  const venvWin = path.join(process.cwd(), 'venv', 'Scripts', 'python.exe');
  if (fs.existsSync(venvWin)) return venvWin;

  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Auto-detect a cookies.txt file on the local machine when
 * YOUTUBE_COOKIES_FILE env var is not explicitly set.
 * Priority: ~/cookies.txt → ~/YT-Tools/cookies.txt → project root cookies.txt
 */
function autoDetectCookiesFile(): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'cookies.txt'),
    path.join(home, 'YT-Tools', 'cookies.txt'),
    path.join(home, 'youtube_cookies.txt'),
    path.join(process.cwd(), 'cookies.txt'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      console.log(`[fetchTranscript] auto-detected cookies.txt at ${p}`);
      return p;
    }
  }
  return '';
}

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
  timeoutMs = 90_000   // raised to 90s to account for yt-dlp fallback latency
): Promise<TranscriptResult> {
  const PYTHON = resolvePython();

  // Resolve cookies file — explicit env var first, then auto-detect
  const cookiesFile =
    process.env.YOUTUBE_COOKIES_FILE?.trim()
      ? process.env.YOUTUBE_COOKIES_FILE.trim()
      : autoDetectCookiesFile();

  const authMode =
    cookiesFile                                     ? `cookies:${cookiesFile}` :
    process.env.WEBSHARE_PROXY_USERNAME             ? 'webshare' :
    process.env.PROXY_URL                           ? `proxy:${process.env.PROXY_URL}` :
                                                      'direct';

  console.log(`[fetchTranscript] video=${videoId} auth=${authMode} python=${PYTHON}`);

  // Forward all relevant env vars explicitly to the subprocess
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Inject auto-detected cookies path so the Python script picks it up
    YOUTUBE_COOKIES_FILE:       cookiesFile                                  || '',
    WEBSHARE_PROXY_USERNAME:    process.env.WEBSHARE_PROXY_USERNAME          ?? '',
    WEBSHARE_PROXY_PASSWORD:    process.env.WEBSHARE_PROXY_PASSWORD          ?? '',
    PROXY_URL:                  process.env.PROXY_URL                        ?? '',
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

  let parsed: { success: boolean; text?: string; language?: string; error?: string; method?: string };
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`Invalid JSON from script: ${stdout.slice(0, 200)}`);
  }

  if (!parsed.success || !parsed.text) {
    throw new Error(parsed.error ?? 'Transcript fetch failed');
  }

  if (parsed.method) {
    console.log(`[fetchTranscript] video=${videoId} method=${parsed.method}`);
  }

  return { text: parsed.text, language: parsed.language ?? 'en' };
}
