"""
Bridge script — polls Supabase for approved music requests and downloads via yt-dlp.
Run:  python bridge.py  (or use the .exe)
Stop: Ctrl+C
"""

import os
import re
import sys
import time
from datetime import datetime
from dotenv import load_dotenv
from supabase import create_client
import yt_dlp

def get_base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

load_dotenv(os.path.join(get_base_dir(), ".env"))

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
DOWNLOAD_PATH = os.environ.get("DOWNLOAD_PATH", "C:/Music/StreamRequests/")
POLL_INTERVAL = 5

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
        files_before = set(os.listdir(DOWNLOAD_PATH))

        ydl_opts = {
            "format": "bestaudio/best",
            "outtmpl": os.path.join(DOWNLOAD_PATH, "%(artist,uploader,creator|Unknown)s - %(title)s.%(ext)s"),
            "noplaylist": True,
            "postprocessors": [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }],
            "keepvideo": False,
            "quiet": True,
            "js_runtimes": ["nodejs"],
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])

        # Wait for ffmpeg to release files, then clean up non-mp3
        time.sleep(2)
        files_after = set(os.listdir(DOWNLOAD_PATH))
        for f in files_after - files_before:
            if not f.lower().endswith(".mp3"):
                path = os.path.join(DOWNLOAD_PATH, f)
                try:
                    os.remove(path)
                    log(f"Opgeruimd: {f}")
                except OSError:
                    pass

        sb.table("requests").update({"status": "downloaded"}).eq("id", rid).execute()
        log(f"Done: {url}")

    except Exception as e:
        sb.table("requests").update({"status": "rejected"}).eq("id", rid).execute()
        log(f"Error: {e}")


def main():
    os.makedirs(DOWNLOAD_PATH, exist_ok=True)
    log(f"Bridge gestart — download map: {DOWNLOAD_PATH}")
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
