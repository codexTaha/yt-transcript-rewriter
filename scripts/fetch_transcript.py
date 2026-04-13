#!/usr/bin/env python3
"""
Transcript fetcher — youtube-transcript-api with yt-dlp fallback.

Auth priority:
  1. YOUTUBE_COOKIES_FILE env var  -> explicit path to Netscape cookies.txt
  2. Auto-detected cookies.txt     -> ~/cookies.txt or ~/YT-Tools/cookies.txt
  3. WEBSHARE_PROXY_USERNAME/PASSWORD -> WebshareProxyConfig (paid)
  4. PROXY_URL (host:port)           -> GenericProxyConfig
  5. Direct (no auth)
  --- if all above fail for a video ---
  6. yt-dlp subtitle fallback       -> browser UA + cookies, harder to block

Fix note: CookieConfig was added in youtube-transcript-api 0.10.0.
This script handles both old and new versions gracefully.

Usage:
  python fetch_transcript.py <video_id>

Outputs JSON to stdout:
  {"success": true, "text": "...", "language": "...", "method": "..."}
  {"success": false, "error": "..."}
"""

import sys
import json
import os
import time


# ─── Cookie file auto-detection ───────────────────────────────────────────────

def resolve_cookies_file() -> str:
    """Return the first cookies.txt path that actually exists, or empty string."""
    explicit = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if explicit and os.path.isfile(explicit):
        return explicit

    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "cookies.txt"),
        os.path.join(home, "YT-Tools", "cookies.txt"),
        os.path.join(home, "youtube_cookies.txt"),
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "cookies.txt"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            print(f"[fetch_transcript] auto-detected cookies.txt at {path}", file=sys.stderr)
            return path
    return ""


# ─── Build youtube-transcript-api instance ────────────────────────────────────

def build_api():
    """
    Build a YouTubeTranscriptApi instance with best available auth.
    Handles both:
      - New API (>=0.10.0): YouTubeTranscriptApi(cookie_config=CookieConfig(...))
      - Old API (<0.10.0):  YouTubeTranscriptApi(cookies_path=...)
    Returns (ytt_api, description_string).
    """
    from youtube_transcript_api import YouTubeTranscriptApi

    cookies_file = resolve_cookies_file()

    # --- Priority 1 & 2: cookies.txt ---
    if cookies_file:
        # Try new API first (>=0.10.0)
        try:
            from youtube_transcript_api.cookies import CookieConfig
            cookie_config = CookieConfig(cookie_file=cookies_file)
            ytt_api = YouTubeTranscriptApi(cookie_config=cookie_config)
            print(f"[fetch_transcript] using CookieConfig (new API) from {cookies_file}", file=sys.stderr)
            return ytt_api, f"cookies:{cookies_file}"
        except ImportError:
            pass  # Old version, try legacy path
        except Exception as e:
            print(f"[fetch_transcript] CookieConfig failed ({e}), trying legacy cookie path", file=sys.stderr)

        # Try old API (<0.10.0) — cookies_path kwarg
        try:
            ytt_api = YouTubeTranscriptApi(cookies_path=cookies_file)
            print(f"[fetch_transcript] using cookies_path (legacy API) from {cookies_file}", file=sys.stderr)
            return ytt_api, f"cookies_legacy:{cookies_file}"
        except TypeError:
            pass  # Neither old nor new — version in between, skip cookies
        except Exception as e:
            print(f"[fetch_transcript] legacy cookies_path failed ({e}), continuing without cookies", file=sys.stderr)

        print(
            f"[fetch_transcript] WARNING: cookies.txt found at {cookies_file} but could not be loaded. "
            f"Your youtube-transcript-api may be outdated. "
            f"Run: pip install --upgrade youtube-transcript-api",
            file=sys.stderr
        )

    # --- Priority 3: Webshare rotating residential ---
    ws_user = os.environ.get("WEBSHARE_PROXY_USERNAME", "").strip()
    ws_pass = os.environ.get("WEBSHARE_PROXY_PASSWORD", "").strip()
    if ws_user and ws_pass:
        try:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            proxy_config = WebshareProxyConfig(
                proxy_username=ws_user,
                proxy_password=ws_pass,
            )
            ytt_api = YouTubeTranscriptApi(proxy_config=proxy_config)
            print("[fetch_transcript] using WebshareProxyConfig", file=sys.stderr)
            return ytt_api, "webshare"
        except (ImportError, Exception) as e:
            print(f"[fetch_transcript] WebshareProxyConfig failed ({e}), trying next option", file=sys.stderr)

    # --- Priority 4: Generic proxy ---
    proxy_raw = os.environ.get("PROXY_URL", "").strip()
    proxy_raw = proxy_raw.replace("https://", "").replace("http://", "")
    if proxy_raw:
        try:
            from youtube_transcript_api.proxies import GenericProxyConfig
            proxy_url = f"http://{proxy_raw}"
            proxy_config = GenericProxyConfig(http_url=proxy_url, https_url=proxy_url)
            ytt_api = YouTubeTranscriptApi(proxy_config=proxy_config)
            print(f"[fetch_transcript] using GenericProxyConfig proxy={proxy_url}", file=sys.stderr)
            return ytt_api, f"proxy:{proxy_raw}"
        except (ImportError, Exception) as e:
            print(f"[fetch_transcript] GenericProxyConfig failed ({e}), falling back to direct", file=sys.stderr)

    # --- Priority 5: Direct ---
    print("[fetch_transcript] using direct connection (no auth/proxy)", file=sys.stderr)
    return YouTubeTranscriptApi(), "direct"


# ─── yt-dlp fallback ──────────────────────────────────────────────────────────

def fetch_via_ytdlp(video_id: str) -> dict:
    """
    Fallback: use yt-dlp to download auto-generated subtitles.
    yt-dlp uses a browser-like user-agent and handles cookies natively.
    Retries once after 15s if it gets a 429.
    """
    import subprocess
    import tempfile
    import glob
    import re

    print(f"[fetch_transcript] trying yt-dlp fallback for {video_id}", file=sys.stderr)

    cookies_file = resolve_cookies_file()

    def run_ytdlp(tmpdir: str) -> subprocess.CompletedProcess:
        cmd = [
            "yt-dlp",
            "--write-auto-sub",
            "--skip-download",
            "--sub-format", "json3",
            "--sub-langs", "en,en-orig,en-US,en-GB",
            "--output", os.path.join(tmpdir, "%(id)s.%(ext)s"),
            "--no-playlist",
            "--quiet",
            "--no-warnings",
            "--user-agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        ]
        if cookies_file:
            cmd += ["--cookies", cookies_file]
        cmd.append(f"https://www.youtube.com/watch?v={video_id}")
        return subprocess.run(cmd, capture_output=True, text=True, timeout=90)

    def parse_json3_or_vtt(tmpdir: str):
        """Parse downloaded subtitle file into plain text. Returns text or None."""
        json3_files = glob.glob(os.path.join(tmpdir, "*.json3"))
        if json3_files:
            with open(json3_files[0], encoding="utf-8") as f:
                data = json.load(f)
            words = []
            for event in data.get("events", []):
                for seg in event.get("segs", []):
                    word = seg.get("utf8", "").strip()
                    if word and word != "\n":
                        words.append(word)
            text = " ".join(" ".join(words).split())
            if len(text) >= 50:
                return text, "yt-dlp/json3"

        vtt_files = glob.glob(os.path.join(tmpdir, "*.vtt"))
        if vtt_files:
            with open(vtt_files[0], encoding="utf-8") as f:
                raw = f.read()
            lines = []
            for line in raw.splitlines():
                if re.match(r'^\d{2}:\d{2}', line) or line.strip() == "WEBVTT" or re.match(r'^\s*$', line):
                    continue
                clean = re.sub(r'<[^>]+>', '', line).strip()
                if clean:
                    lines.append(clean)
            text = " ".join(" ".join(lines).split())
            if len(text) >= 50:
                return text, "yt-dlp/vtt"

        return None, None

    with tempfile.TemporaryDirectory() as tmpdir:
        try:
            result = run_ytdlp(tmpdir)
        except FileNotFoundError:
            return {"success": False, "error": "yt-dlp is not installed (fix: pip install yt-dlp or sudo dnf install yt-dlp)"}
        except subprocess.TimeoutExpired:
            return {"success": False, "error": "yt-dlp timed out after 90s"}

        # 429 — wait 15s and retry once
        if result.returncode != 0 and "429" in (result.stderr or ""):
            print(f"[fetch_transcript] yt-dlp got 429, waiting 15s before retry...", file=sys.stderr)
            time.sleep(15)
            try:
                result = run_ytdlp(tmpdir)
            except subprocess.TimeoutExpired:
                return {"success": False, "error": "yt-dlp retry timed out after 90s"}

        if result.returncode != 0:
            stderr_snippet = (result.stderr or "").strip()[:300]
            return {"success": False, "error": f"yt-dlp exited {result.returncode}: {stderr_snippet}"}

        text, method = parse_json3_or_vtt(tmpdir)
        if text:
            return {"success": True, "text": text, "language": "en", "method": method}

        return {"success": False, "error": "yt-dlp ran but produced no subtitle files (video may have no auto-captions)"}


# ─── Main fetch function ───────────────────────────────────────────────────────

def fetch(video_id: str) -> dict:
    try:
        from youtube_transcript_api import (
            NoTranscriptFound,
            TranscriptsDisabled,
            CouldNotRetrieveTranscript,
        )
    except ImportError:
        return {"success": False, "error": "youtube-transcript-api not installed. Run: pip install youtube-transcript-api"}

    api_error = None

    try:
        ytt_api, auth_desc = build_api()
        transcript_list = ytt_api.list(video_id)

        transcript = None
        lang_info = None

        try:
            transcript = transcript_list.find_transcript(["en"])
            lang_type = "auto-generated" if transcript.is_generated else "manual"
            lang_info = f"English ({lang_type})"
        except NoTranscriptFound:
            pass

        if transcript is None:
            for available in transcript_list:
                if available.is_translatable:
                    codes = [l.get("language_code", "") for l in available.translation_languages]
                    if "en" in codes:
                        transcript = available.translate("en")
                        lang_info = f"Translated from {available.language}"
                        break

        if transcript is None:
            available_list = list(transcript_list)
            if available_list:
                transcript = available_list[0]
                lang_info = f"{transcript.language} (no English available)"

        if transcript is None:
            api_error = "No transcript available in any language"
        else:
            fetched = transcript.fetch()
            try:
                text = " ".join(snippet.text for snippet in fetched)
            except AttributeError:
                text = " ".join(item.get("text", "") for item in fetched)

            text = " ".join(text.split())

            if len(text) < 50:
                api_error = "Transcript too short or empty"
            else:
                return {"success": True, "text": text, "language": lang_info, "auth": auth_desc, "method": "youtube-transcript-api"}

    except TranscriptsDisabled:
        return {"success": False, "error": "Transcripts are disabled for this video"}
    except NoTranscriptFound:
        api_error = "No transcript found for this video"
    except CouldNotRetrieveTranscript as e:
        api_error = f"Could not retrieve transcript: {e}"
    except Exception as e:
        api_error = str(e)

    # ── yt-dlp fallback
    print(f"[fetch_transcript] youtube-transcript-api failed ({api_error}), trying yt-dlp", file=sys.stderr)
    ytdlp_result = fetch_via_ytdlp(video_id)
    if ytdlp_result.get("success"):
        return ytdlp_result

    combined = f"{api_error} | yt-dlp: {ytdlp_result.get('error', 'unknown')}"
    return {"success": False, "error": combined}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: fetch_transcript.py <video_id>"}))
        sys.exit(1)

    result = fetch(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)
