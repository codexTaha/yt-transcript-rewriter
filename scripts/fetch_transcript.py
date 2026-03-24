#!/usr/bin/env python3
"""
Transcript fetcher using youtube-transcript-api.

Proxy priority (env vars read directly here):
  1. WEBSHARE_PROXY_USERNAME + WEBSHARE_PROXY_PASSWORD  -> WebshareProxyConfig (rotating residential)
  2. PROXY_URL (host:port or user:pass@host:port)        -> GenericProxyConfig
  3. CLI arg [proxy_host:port]                           -> GenericProxyConfig
  4. No proxy

Usage:
  python fetch_transcript.py <video_id> [proxy_host:port]

Outputs JSON to stdout:
  {"success": true, "text": "...", "language": "..."}
  {"success": false, "error": "..."}
"""

import sys
import json
import os

def build_api():
    """
    Build a YouTubeTranscriptApi instance with the best available proxy config.
    Returns (ytt_api, proxy_description).
    """
    from youtube_transcript_api import YouTubeTranscriptApi

    # --- Priority 1: Webshare rotating residential proxies ---
    ws_user = os.environ.get("WEBSHARE_PROXY_USERNAME", "").strip()
    ws_pass = os.environ.get("WEBSHARE_PROXY_PASSWORD", "").strip()
    if ws_user and ws_pass:
        try:
            from youtube_transcript_api.proxies import WebshareProxyConfig
            proxy_config = WebshareProxyConfig(
                proxy_username=ws_user,
                proxy_password=ws_pass,
            )
            print("[fetch_transcript] using WebshareProxyConfig (rotating residential)", file=sys.stderr)
            return YouTubeTranscriptApi(proxy_config=proxy_config), "webshare"
        except ImportError:
            print("[fetch_transcript] WARNING: WebshareProxyConfig not available, upgrade youtube-transcript-api", file=sys.stderr)
        except Exception as e:
            print(f"[fetch_transcript] WARNING: WebshareProxyConfig failed: {e}", file=sys.stderr)

    # --- Priority 2: Generic proxy from PROXY_URL env var ---
    proxy_url_env = os.environ.get("PROXY_URL", "").strip()
    # Strip scheme if present — we add http:// ourselves
    proxy_raw = proxy_url_env.replace("https://", "").replace("http://", "") if proxy_url_env else ""

    # --- Priority 3: CLI arg ---
    cli_proxy = sys.argv[2] if len(sys.argv) > 2 else ""

    proxy = proxy_raw or cli_proxy

    if proxy:
        try:
            from youtube_transcript_api.proxies import GenericProxyConfig
            proxy_url = f"http://{proxy}"
            proxy_config = GenericProxyConfig(http_url=proxy_url, https_url=proxy_url)
            print(f"[fetch_transcript] using GenericProxyConfig proxy={proxy_url}", file=sys.stderr)
            return YouTubeTranscriptApi(proxy_config=proxy_config), f"generic:{proxy}"
        except ImportError:
            print("[fetch_transcript] WARNING: GenericProxyConfig not available", file=sys.stderr)
        except Exception as e:
            print(f"[fetch_transcript] WARNING: GenericProxyConfig failed: {e}", file=sys.stderr)

    # --- Priority 4: No proxy ---
    print("[fetch_transcript] no proxy configured, using direct connection", file=sys.stderr)
    return YouTubeTranscriptApi(), "direct"


def fetch(video_id: str) -> dict:
    try:
        from youtube_transcript_api import (
            YouTubeTranscriptApi,
            NoTranscriptFound,
            TranscriptsDisabled,
            CouldNotRetrieveTranscript,
        )
    except ImportError:
        return {"success": False, "error": "youtube-transcript-api not installed. Run: pip install youtube-transcript-api"}

    try:
        ytt_api, proxy_desc = build_api()

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

        # 2. Try translatable transcript -> translate to English
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

        return {"success": True, "text": text, "language": lang_info, "proxy": proxy_desc}

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

    video_id = sys.argv[1]
    result = fetch(video_id)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)
