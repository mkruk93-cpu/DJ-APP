"""
Bridge script — polls Supabase for approved music requests and downloads via yt-dlp.
Also watches RekordBoxSongExporter output files to push now-playing track info.
Run:  python bridge.py  (or use the .exe)
Stop: Ctrl+C
"""

import os
import re
import shutil
import sys
import time
import threading
import urllib.parse
import urllib.request
import json
from datetime import datetime
from dotenv import load_dotenv
from supabase import create_client
import yt_dlp

HAS_FFMPEG = shutil.which("ffmpeg") is not None

def get_base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(get_base_dir(), ".env"))

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
DOWNLOAD_PATH = os.environ.get("DOWNLOAD_PATH", "C:/Music/StreamRequests/")
REKORDBOX_OUTPUT_PATH = os.environ.get("REKORDBOX_OUTPUT_PATH", "")
POLL_INTERVAL = 5
NOW_PLAYING_POLL = 2

sb = create_client(SUPABASE_URL, SUPABASE_KEY)


def safe_filename(text: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", text)


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def download(request: dict):
    rid = request["id"]
    url = request["url"]
    nickname = safe_filename(request["nickname"])

    log(f"Downloading: {url} voor {nickname}")

    try:
        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(DOWNLOAD_PATH, "%(artist,uploader,creator|Unknown)s - %(title)s.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "js_runtimes": {"nodejs": {}},
        }

        if HAS_FFMPEG:
            ydl_opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }]
            ydl_opts["keepvideo"] = False
        else:
            log("ffmpeg niet gevonden — audio wordt gedownload in origineel formaat")

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        sb.table("requests").update({"status": "downloaded"}).eq("id", rid).execute()
        log(f"Done: {url}")

    except Exception as e:
        sb.table("requests").update({"status": "error"}).eq("id", rid).execute()
        log(f"Download error: {e}")


def read_file_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except (OSError, UnicodeDecodeError):
        return ""


def fetch_artwork(artist: str, title: str) -> str | None:
    """Search iTunes for album artwork. Returns a 600x600 image URL or None."""
    try:
        query = f"{artist} {title}".strip()
        if not query:
            return None
        url = "https://itunes.apple.com/search?" + urllib.parse.urlencode({
            "term": query, "media": "music", "limit": 1,
        })
        with urllib.request.urlopen(url, timeout=5) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        if not results:
            return None
        art_url = results[0].get("artworkUrl100", "")
        return art_url.replace("100x100bb", "600x600bb") if art_url else None
    except Exception:
        return None


def now_playing_watcher():
    """Poll RekordBoxSongExporter output files and push changes to Supabase."""
    title_path = os.path.join(REKORDBOX_OUTPUT_PATH, "TrackTitle.txt")
    artist_path = os.path.join(REKORDBOX_OUTPUT_PATH, "TrackArtist.txt")
    last_title = ""
    last_artist = ""

    log(f"Now-playing watcher gestart — map: {REKORDBOX_OUTPUT_PATH}")

    while True:
        title = read_file_text(title_path)
        artist = read_file_text(artist_path)

        if title != last_title or artist != last_artist:
            last_title = title
            last_artist = artist
            artwork_url = fetch_artwork(artist, title)
            if artwork_url:
                log(f"Artwork gevonden: {artwork_url[:60]}...")
            try:
                sb.table("now_playing").update({
                    "title": title or None,
                    "artist": artist or None,
                    "artwork_url": artwork_url,
                    "updated_at": datetime.utcnow().isoformat(),
                }).eq("id", 1).execute()
                log(f"Now playing: {artist} — {title}")
            except Exception as e:
                log(f"Now-playing update error: {e}")

        time.sleep(NOW_PLAYING_POLL)


def main():
    os.makedirs(DOWNLOAD_PATH, exist_ok=True)
    log(f"Bridge gestart — download map: {DOWNLOAD_PATH}")

    if REKORDBOX_OUTPUT_PATH and os.path.isdir(REKORDBOX_OUTPUT_PATH):
        watcher = threading.Thread(target=now_playing_watcher, daemon=True)
        watcher.start()
    else:
        log("REKORDBOX_OUTPUT_PATH niet ingesteld of map bestaat niet — now-playing watcher overgeslagen.")

    log("Druk Ctrl+C om te stoppen.\n")

    while True:
        try:
            resp = sb.table("requests").select("*").eq("status", "approved").execute()
            for req in resp.data:
                download(req)
        except Exception as e:
            log(f"Poll error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
