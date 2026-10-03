# StoryPilot — Hourly Story Video Pipeline

This repo runs an **hourly automation** on GitHub Actions:

1. **Fetch the story** from the Google Sheet that Gemini Spark updates every hour
   (fallback: generate a fresh story **keyless** with [`freellmpool`](https://github.com/0xzr/freellmpool) — GLM Flash first, auto-failover to live keyless routes).
2. **Render a vertical 1080×1920 MP4** with Edge-TTS voiceover (free, no API keys) + MoviePy + Pillow + arabic-reshaper + python-bidi.
3. **Post** to YouTube, TikTok and Instagram Reels (each platform activates as soon as you add its secrets).

## Files

| File | Purpose |
|---|---|
| `.github/workflows/hourly-video.yml` | The hourly GitHub Actions workflow |
| `scripts/generate_story.py` | Story source: Google Sheet → keyless GLM → fallback |
| `generate_video.py` | Renders `story.json` → `output/output.mp4` |
| `post_video.py` | Posts to YouTube / TikTok / Instagram |
| `requirements.txt` | Python dependencies |

## Secrets (Settings → Secrets and variables → Actions)

Add only what you need — every platform is optional and skipped gracefully:

| Secret | Platform | How to get it |
|---|---|---|
| `YOUTUBE_REFRESH_TOKEN` | YouTube | OAuth playground with `youtube.upload` scope |
| `YOUTUBE_CLIENT_ID` | YouTube | Google Cloud Console → OAuth client |
| `YOUTUBE_CLIENT_SECRET` | YouTube | Google Cloud Console → OAuth client |
| `TIKTOK_ACCESS_TOKEN` | TikTok | TikTok for Developers → Content Posting API |
| `INSTAGRAM_ACCESS_TOKEN` | Instagram | Meta Graph API (IG business account) |
| `INSTAGRAM_USER_ID` | Instagram | Your Instagram Business account id |

### Optional repository variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Default | Meaning |
|---|---|---|
| `FLP_MODEL` | `glm-4.7-flash` | Story model tried first by freellmpool (GLM Flash; falls over to live keyless routes, then `auto`) |
| `SHEET_ID` | the Spark sheet | Google Sheet id with the hourly story |
| `TTS_VOICE_AR` | `ar-EG-ShakirNeural` | Edge-TTS Arabic voice |
| `YOUTUBE_PRIVACY` | `public` | `public` / `unlisted` / `private` |
| `TIKTOK_PRIVACY` | `SELF_ONLY` | `SELF_ONLY` until your TikTok app is approved |

## Run it now

Actions tab → **Hourly Story Video** → **Run workflow**.
Every finished run leaves the MP4 in the **hourly-video** artifact (14-day retention).

## Story sheet

https://docs.google.com/spreadsheets/d/1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4/edit

The first tab must follow the Gemini Spark layout: `Story Title / Logline / Genre / Target Duration` header rows, then a `Scene #` table with columns `Scene #, Duration, Visual Scene Description, AI Video Prompt, Voiceover Script, Audio / SFX`, then a `Complete Voiceover Narration` section.
