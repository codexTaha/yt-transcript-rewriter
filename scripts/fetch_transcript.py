#!/usr/bin/env python3
"""
Transcript fetcher using youtube-transcript-api.
Logic ported from roundyyy/yt-bulk-subtitles-downloader (ytbsd.py).

Usage:
  python fetch_transcript.py <video_id> [proxy_host:port]

Outputs JSON to stdout:
  {"success": true, "text": "...", "language": "..."}
  {"success": false, "error": "..."}
"""

import sys
import json

def fetch(video_id: str, proxy: str = None) -> dict:
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
        # Build API instance with optional proxy (same pattern as ytbsd.py)
        if proxy:
            try:
                from youtube_transcript_api.proxies import GenericProxyConfig
                proxy_url = f"http://{proxy}"
                proxy_config = GenericProxyConfig(http_url=proxy_url, https_url=proxy_url)
                ytt_api = YouTubeTranscriptApi(proxy_config=proxy_config)
            except ImportError:
                # Older version of youtube-transcript-api — no proxy config class
                ytt_api = YouTubeTranscriptApi()
        else:
            ytt_api = YouTubeTranscriptApi()

        transcript_list = ytt_api.list(video_id)

        transcript = None
        lang_info = None

        # 1. Try English first (same order as ytbsd.py)
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

        # Fetch the actual content (same as ytbsd.py fetch_content_with_timeout)
        fetched = transcript.fetch()
        # FetchedTranscript is iterable of FetchedTranscriptSnippet
        # Each snippet has .text attribute
        try:
            text = " ".join(snippet.text for snippet in fetched)
        except AttributeError:
            # Older API returns list of dicts
            text = " ".join(item.get("text", "") for item in fetched)

        text = " ".join(text.split())  # Normalize whitespace

        if len(text) < 50:
            return {"success": False, "error": "Transcript too short or empty"}

        return {"success": True, "text": text, "language": lang_info}

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
        print(json.dumps({"success": False, "error": "Usage: fetch_transcript.py <video_id> [proxy_host:port]"}))
        sys.exit(1)

    video_id = sys.argv[1]
    proxy = sys.argv[2] if len(sys.argv) > 2 else None

    result = fetch(video_id, proxy)
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result["success"] else 1)
