#!/usr/bin/env python3
"""StoryPilot - Multi-platform poster.

Posts output/output.mp4 to YouTube, TikTok and Instagram Reels.
Each platform is skipped gracefully when its credentials are missing,
so the hourly pipeline never fails because one network is unconfigured.

Usage:
  python post_video.py --all
  python post_video.py --youtube --tiktok --instagram
"""
import argparse
import json
import math
import os
import sys
import time

import requests

VIDEO = os.environ.get("VIDEO_PATH", "output/output.mp4")
META = os.environ.get("META_PATH", "output/meta.json")


def load_meta():
    try:
        with open(META, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"title": "Hourly Story", "description": "", "tags": []}


def hashtags(meta):
    base = ["#shorts", "#reels", "#storytime", "#ai"]
    genre = [t for t in meta.get("tags", []) if t]
    return " ".join("#" + g.replace(" ", "") for g in genre[:4] + base[:2])


# ---------------------------------------------------------------- YouTube ---

def youtube_upload(meta):
    refresh = os.environ.get("YOUTUBE_REFRESH_TOKEN", "")
    client_id = os.environ.get("YOUTUBE_CLIENT_ID", "")
    client_secret = os.environ.get("YOUTUBE_CLIENT_SECRET", "")
    if not (refresh and client_id and client_secret):
        print("[youtube] skipped: YOUTUBE_REFRESH_TOKEN / CLIENT_ID / CLIENT_SECRET not set", flush=True)
        return None
    tok = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": client_id,
            "client_secret": client_secret,
            "refresh_token": refresh,
            "grant_type": "refresh_token",
        },
        timeout=30,
    ).json()
    access = tok.get("access_token")
    if not access:
        print(f"[youtube] token refresh failed: {tok}", flush=True)
        return None

    title = meta.get("title", "Hourly Story")[:95]
    desc = (meta.get("description", "") + "\n" + hashtags(meta))[:4900]
    metadata = {
        "snippet": {
            "title": title,
            "description": desc,
            "tags": meta.get("tags", [])[:15],
            "categoryId": "24",
        },
        "status": {
            "privacyStatus": os.environ.get("YOUTUBE_PRIVACY", "public"),
            "selfDeclaredMadeForKids": False,
        },
    }
    init = requests.post(
        "https://www.googleapis.com/upload/youtube/v3/videos"
        "?uploadType=resumable&part=snippet,status",
        headers={"Authorization": f"Bearer {access}", "Content-Type": "application/json"},
        json=metadata,
        timeout=30,
    )
    if init.status_code >= 300:
        print(f"[youtube] upload init failed: {init.status_code} {init.text[:200]}", flush=True)
        return None
    location = init.headers["Location"]
    size = os.path.getsize(VIDEO)
    with open(VIDEO, "rb") as f:
        put = requests.put(location, data=f, headers={"Content-Type": "video/mp4"}, timeout=1800)
    if put.status_code >= 300:
        print(f"[youtube] upload failed: {put.status_code} {put.text[:200]}", flush=True)
        return None
    vid = put.json()["id"]
    url = f"https://www.youtube.com/watch?v={vid}"
    print(f"[youtube] posted: {url}", flush=True)
    return url


# ----------------------------------------------------------------- TikTok ---

def tiktok_upload(meta):
    token = os.environ.get("TIKTOK_ACCESS_TOKEN", "")
    if not token:
        print("[tiktok] skipped: TIKTOK_ACCESS_TOKEN not set", flush=True)
        return None
    privacy = os.environ.get("TIKTOK_PRIVACY", "SELF_ONLY").upper()
    size = os.path.getsize(VIDEO)
    chunk_size = min(size, 67108864)
    total = max(1, math.ceil(size / chunk_size))
    init = requests.post(
        "https://open.tiktokapis.com/v2/post/publish/video/init/",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json={
            "post_info": {
                "title": (meta.get("title", "") + " " + hashtags(meta))[:150],
                "privacy_level": privacy,
            },
            "source_info": {
                "source": "FILE_UPLOAD",
                "video_size": size,
                "chunk_size": chunk_size,
                "total_chunk_count": total,
            },
        },
        timeout=60,
    )
    data = init.json().get("data") or {}
    upload_url, publish_id = data.get("upload_url"), data.get("publish_id")
    if not upload_url:
        print(f"[tiktok] init failed: {init.text[:300]}", flush=True)
        return None
    with open(VIDEO, "rb") as f:
        for i in range(total):
            chunk = f.read(chunk_size)
            start = i * chunk_size
            end = min(start + len(chunk), size) - 1
            r = requests.put(
                upload_url,
                data=chunk,
                headers={
                    "Content-Type": "video/mp4",
                    "Content-Range": f"bytes {start}-{end}/{size}",
                },
                timeout=1800,
            )
            if r.status_code >= 300:
                print(f"[tiktok] chunk {i + 1}/{total} failed: {r.status_code}", flush=True)
                return None
            print(f"[tiktok] chunk {i + 1}/{total} uploaded", flush=True)
    for _ in range(30):
        time.sleep(4)
        st = requests.post(
            "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            json={"publish_id": publish_id},
            timeout=30,
        ).json()
        status = (st.get("data") or {}).get("status")
        if status in ("PUBLISH_COMPLETE", "SUCCEEDED"):
            print("[tiktok] posted successfully", flush=True)
            return "tiktok-posted"
        if status in ("FAILED", "PUBLISH_FAILED"):
            print(f"[tiktok] publish failed: {st}", flush=True)
            return None
    print("[tiktok] still processing after timeout (likely ok)", flush=True)
    return "tiktok-pending"


# ------------------------------------------------------------- Instagram ---

def _tmp_public_url():
    """Instagram needs a public URL: bounce the mp4 through a temp host."""
    for kind in ("tmpfiles", "catbox"):
        try:
            if kind == "tmpfiles":
                with open(VIDEO, "rb") as f:
                    r = requests.post("https://tmpfiles.org/api/v1/upload", files={"file": f}, timeout=600)
                u = (r.json().get("data") or {}).get("url", "")
                if u:
                    return u.replace("tmpfiles.org/", "tmpfiles.org/dl/")
            else:
                with open(VIDEO, "rb") as f:
                    r = requests.post(
                        "https://catbox.moe/user/api.php",
                        data={"reqtype": "fileupload"},
                        files={"fileToUpload": f},
                        timeout=600,
                    )
                if r.text.startswith("http"):
                    return r.text.strip()
        except Exception as e:
            print(f"[instagram] {kind} upload error: {e}", flush=True)
    return None


def instagram_upload(meta):
    token = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
    user_id = os.environ.get("INSTAGRAM_USER_ID", "")
    if not (token and user_id):
        print("[instagram] skipped: INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_USER_ID not set", flush=True)
        return None
    public_url = _tmp_public_url()
    if not public_url:
        print("[instagram] could not create a public URL for the video", flush=True)
        return None
    api = f"https://graph.facebook.com/v21.0/{user_id}"
    caption = (meta.get("title", "") + "\n" + meta.get("description", "")[:150] + "\n" + hashtags(meta))[:2200]
    c = requests.post(
        f"{api}/media",
        params={"media_type": "REELS", "video_url": public_url, "caption": caption, "access_token": token},
        timeout=60,
    ).json()
    container = c.get("id")
    if not container:
        print(f"[instagram] container failed: {c}", flush=True)
        return None
    for _ in range(40):
        time.sleep(5)
        st = requests.get(f"{api}/{container}", params={"fields": "status_code", "access_token": token}, timeout=30).json()
        code = st.get("status_code")
        if code == "FINISHED":
            pub = requests.post(
                f"{api}/media_publish",
                params={"creation_id": container, "access_token": token},
                timeout=60,
            ).json()
            print(f"[instagram] posted: {pub.get('id')}", flush=True)
            return f"instagram-posted-{pub.get('id')}"
        if code == "ERROR":
            print(f"[instagram] processing error: {st}", flush=True)
            return None
    print("[instagram] still processing after timeout", flush=True)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--youtube", action="store_true")
    ap.add_argument("--tiktok", action="store_true")
    ap.add_argument("--instagram", action="store_true")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    if not (args.all or args.youtube or args.tiktok or args.instagram):
        args.all = True
    if not os.path.exists(VIDEO):
        print(f"[post] video not found: {VIDEO}", flush=True)
        sys.exit(1)
    meta = load_meta()
    results = {}
    if args.all or args.youtube:
        results["youtube"] = youtube_upload(meta)
    if args.all or args.tiktok:
        results["tiktok"] = tiktok_upload(meta)
    if args.all or args.instagram:
        results["instagram"] = instagram_upload(meta)
    with open("output/post_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print(f"[post] results: {results}", flush=True)


if __name__ == "__main__":
    main()
