#!/usr/bin/env python3
"""
Transcript fetcher using youtube-transcript-api.

Auth priority:
  1. YOUTUBE_COOKIES_FILE env var  -> path to a Netscape cookies.txt from your browser
  2. WEBSHARE_PROXY_USERNAME/PASSWORD -> WebshareProxyConfig (paid rotating residential only)
  3. PROXY_URL (host:port)           -> GenericProxyConfig
  4. Direct (no auth)

Usage:
  python fetch_transcript.py <video_id>

Outputs JSON to stdout:
  {"success": true, "text": "...", "language": "..."}
  {"success": false, "error": "..."}
"""

import sys
import json
import os


def build_api():
    """
    Build a YouTubeTranscriptApi instance with best available auth.
    Returns (ytt_api, description_string).
    """
    from youtube_transcript_api import YouTubeTranscriptApi

    # --- Priority 1: cookies.txt (most reliable, no proxy needed) ---
    cookies_file = os.environ.get("YOUTUBE_COOKIES_FILE", "").strip()
    if cookies_file and os.path.isfile(cookies_file):
        try:
            from youtube_transcript_api.cookies import CookieConfig
            cookie_config = CookieConfig(cookie_file=cookies_file)
            ytt_api = YouTubeTranscriptApi(cookie_config=cookie_config)
            print(f"[fetch_transcript] using CookieConfig from {cookies_file}", file=sys.stderr)
            return ytt_api, f"cookies:{cookies_file}"
        except (ImportError, Exception) as e:
            print(f"[fetch_transcript] CookieConfig failed ({e}), trying next option", file=sys.stderr)

    # --- Priority 2: Webshare rotating residential (paid tier required) ---
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

    # --- Priority 3: Generic proxy from PROXY_URL env var ---
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

    # --- Priority 4: Direct (works fine locally, gets blocked on cloud servers) ---
    print("[fetch_transcript] using direct connection (no auth/proxy)", file=sys.stderr)
    return YouTubeTranscriptApi(), "direct"


def fetch(video_id: str) -> dict:
    try:
        from youtube_transcript_api import (
            NoTranscriptFound,
            TranscriptsDisabled,
            CouldNotRetrieveTranscript,
        )
    except ImportError:
        return {"success": False, "error": "youtube-transcript-api not installed. Run: pip install youtube-transcript-api"}

    try:
        ytt_api, auth_desc = build_api()
        transcript_list = ytt_api.list(video_id)

        transcript = None
        lang_info = None

        # 1. Try English first
        try:
            transcript = transcript_list.find_transcript(["en"])
            lang_type = "auto-generated" if transcript.is_generated else "manual"
            lang_info = f"English ({lang_type})"
        except NoTranscriptFound:
            pass

        # 2. Try translatable -> translate to English
        if transcript is None:
            for available in transcript_list:
                if available.is_translatable:
                    codes = [l.get("language_code", "") for l in available.translation_languages]
                    if "en" in codes:
                        transcript = available.translate("en")
                        lang_info = f"Translated from {available.language}"
                        break

        # 3. Fall back to any available language
        if transcript is None:
            available_list = list(transcript_list)
            if available_list:
                transcript = available_list[0]
                lang_info = f"{transcript.language} (no English available)"

        if transcript is None:
            return {"success": False, "error": "No transcript available in any language"}

        fetched = transcript.fetch()
        try:
            text = " ".join(snippet.text for snippet in fetched)
        except AttributeError:
            text = " ".join(item.get("text", "") for item in fetched)

        text = " ".join(text.split())

        if len(text) < 50:
            return {"success": False, "error": "Transcript too short or empty"}

        return {"success": True, "text": text, "language": lang_info, "auth": auth_desc}

    except TranscriptsDisabled:
        return {"success": False, "error": "Transcripts are disabled for this video"}
    except NoTranscriptFound:
        return {"success": False, "error": "No transcript found for this video"}
    except CouldNotRetrieveTranscript as e:
        return {"success": False, "error": f"Could not retrieve transcript: {e}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"success": False, "error": "Usage: fetch_transcript.py <video_id>"}))
        sys.exit(1)

    result = fetch(sys.argv[1])
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)
