#!/usr/bin/env python3
"""StoryPilot - Hourly Video Generator (evolved from the Google Sheet
"كود بايثون - المولد الآلي" generator by Gemini Spark).

Free stack, no API keys needed for rendering:
  Microsoft Edge TTS (ar-EG-ShakirNeural / en-US voices) + MoviePy + Pillow
  + arabic-reshaper + python-bidi  ->  1080x1920 (9:16) 24fps H.264/AAC MP4.

Reads  : story.json  (written by scripts/generate_story.py)
Writes : output/output.mp4  +  output/meta.json
"""
import asyncio
import hashlib
import json
import os
import random

import arabic_reshaper
from bidi.algorithm import get_display
from PIL import Image, ImageDraw, ImageFilter, ImageFont

try:  # MoviePy 2.x
    from moviepy import AudioFileClip, AudioClip, ImageClip, concatenate_videoclips
except ImportError:  # MoviePy 1.x (the original sheet code import)
    from moviepy.editor import AudioFileClip, AudioClip, ImageClip, concatenate_videoclips

import numpy as np

W, H, FPS = 1080, 1920, 24
OUT_DIR = os.environ.get("OUT_DIR", "output")
STORY_PATH = os.environ.get("STORY_PATH", "story.json")
VOICE_AR = os.environ.get("TTS_VOICE_AR", "ar-EG-ShakirNeural")
VOICE_EN = os.environ.get("TTS_VOICE_EN", "en-US-ChristopherNeural")
RATE = os.environ.get("TTS_RATE", "-3%")

PALETTES = [
    ((11, 16, 38), (44, 62, 122), (143, 183, 255), (236, 99, 118)),   # midnight blue
    ((26, 11, 46), (91, 44, 131), (224, 179, 255), (255, 168, 112)),  # violet dusk
    ((9, 22, 16), (31, 92, 61), (159, 227, 191), (255, 199, 95)),     # emerald night
    ((30, 13, 8), (122, 59, 30), (255, 201, 163), (120, 200, 255)),   # amber ember
    ((10, 15, 26), (58, 80, 107), (188, 212, 230), (255, 138, 138)),  # steel dusk
    ((36, 6, 20), (122, 20, 60), (255, 170, 197), (120, 255, 214)),   # rose noir
]

FONT_DIRS = [
    "/usr/share/fonts", "/usr/local/share/fonts",
    os.path.expanduser("~/.fonts"), "/Library/Fonts", "C:/Windows/Fonts",
]

_font_cache = {}


def is_ar(text):
    return any("\u0600" <= c <= "\u06FF" for c in str(text))


def shape(text):
    """Reshape + bidi for Arabic display, pass-through otherwise."""
    text = str(text)
    if is_ar(text):
        try:
            return get_display(arabic_reshaper.reshape(text))
        except Exception:
            return text
    return text


def _all_font_files():
    for root in FONT_DIRS:
        if not os.path.isdir(root):
            continue
        for dirpath, _, files in os.walk(root):
            for f in files:
                if f.lower().endswith((".ttf", ".otf")):
                    yield os.path.join(dirpath, f)


def find_font(keys):
    """First font file whose lowercased path contains one of the keys, in order."""
    for key in keys:
        for path in _all_font_files():
            if key in path.lower():
                return path
    return None


def get_font(kind, size):
    cache_key = (kind, size)
    if cache_key in _font_cache:
        return _font_cache[cache_key]
    candidates = {
        "arabic": ["notosansarabic-bold", "notonaskharabic-bold", "notosansarabic-regular", "dejavusans-bold"],
        "arabic_body": ["notosansarabic-regular", "notonaskharabic-regular", "notosansarabic-bold", "dejavusans"],
        "display": ["dejavusans-bold", "notosans-bold", "arial-bold", "notosansarabic-bold"],
        "body": ["dejavusans", "notosans-regular", "arial", "notosansarabic-regular"],
    }[kind]
    path = find_font(candidates)
    font = ImageFont.truetype(path, size) if path else ImageFont.load_default()
    _font_cache[cache_key] = font
    return font


def pick_font_for(text, size, bold=True):
    if is_ar(text):
        return get_font("arabic" if bold else "arabic_body", size)
    return get_font("display" if bold else "body", size)


def wrap_text(draw, text, font, max_width, max_lines=9):
    """Word-wrap on logical text; shaping applied per-line for measurement."""
    words = str(text).split()
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if draw.textlength(shape(trial), font=font) <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines[:max_lines]


def lerp3(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rgba(c, alpha):
    return (c[0], c[1], c[2], alpha)


def make_bg(palette, seed, variant=0):
    dark, mid, light, accent = palette
    strip = Image.new("RGB", (1, H))
    for y in range(H):
        t = (y / H) ** 1.25
        strip.putpixel((0, y), lerp3(dark, mid, t))
    img = strip.resize((W, H)).convert("RGBA")

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    rng = random.Random(seed + variant)
    for _ in range(3):
        x, y = rng.randint(-100, W + 100), rng.randint(-100, H + 100)
        r = rng.randint(340, 720)
        color = [light, accent, mid][rng.randint(0, 2)]
        d.ellipse([x - r, y - r, x + r, y + r], fill=rgba(color, rng.randint(20, 42)))
    glow = glow.filter(ImageFilter.GaussianBlur(150))
    img = Image.alpha_composite(img, glow)

    vin = Image.new("L", (W, H), 0)
    dv = ImageDraw.Draw(vin)
    dv.ellipse([-W * 0.35, -H * 0.18, W * 1.35, H * 1.18], fill=255)
    vin = vin.filter(ImageFilter.GaussianBlur(220))
    black = Image.new("RGBA", (W, H), (0, 0, 0, 130))
    img = Image.composite(img, Image.alpha_composite(img, black), vin).convert("RGB")
    return img


def draw_chip(d, xy, text, fg, font, pad_x=26, pad_y=14):
    x, y = xy
    tw = d.textlength(shape(text), font=font)
    h = font.size + pad_y * 2
    d.rounded_rectangle([x, y, x + tw + pad_x * 2, y + h], radius=h // 2, fill=(255, 255, 255, 26))
    d.text((x + pad_x, y + pad_y - 2), shape(text), font=font, fill=fg)
    return x + tw + pad_x * 2


def render_title_card(story, palette, seed):
    dark, mid, light, accent = palette
    img = make_bg(palette, seed).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    body_font = pick_font_for(story["title"], 56, bold=False)
    title_font = pick_font_for(story["title"], 118, bold=True)

    eyebrow = "STORYPILOT · HOURLY STORY" if not is_ar(story["title"]) else "ستوري بايلوت · قصة الساعة"
    d.text((96, 300), shape(eyebrow), font=pick_font_for(eyebrow, 40), fill=rgba(light, 200))

    y = 400
    for line in wrap_text(d, story["title"], title_font, W - 200, max_lines=4):
        d.text((96, y), shape(line), font=title_font, fill=(255, 255, 255))
        y += title_font.size + 26

    y += 30
    d.rounded_rectangle([96, y, 96 + 160, y + 10], radius=5, fill=rgba(accent, 255))

    y += 70
    for line in wrap_text(d, story.get("logline", ""), body_font, W - 220, max_lines=5):
        d.text((96, y), shape(line), font=body_font, fill=rgba(light, 235))
        y += body_font.size + 22

    cy = H - 320
    cx = 96
    for label in [story.get("genre", ""), story.get("duration", "60 seconds")]:
        if label:
            cx = draw_chip(d, (cx, cy), label, light, pick_font_for(label, 40)) + 18

    tail = "Generated with free AI · edge-tts + moviepy"
    d.text((96, H - 200), shape(tail), font=pick_font_for(tail, 32), fill=rgba(light, 120))
    return img.convert("RGB")


def render_scene_card(scene, idx, total, palette, seed):
    dark, mid, light, accent = palette
    img = make_bg(palette, seed, variant=idx).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")

    big_font = pick_font_for(scene.get("visual", "x"), 76, bold=True)

    eyebrow = f"SCENE {idx:02d} / {total:02d}" + (f"   ·   {scene.get('timeRange', '')}" if scene.get("timeRange") else "")
    d.text((96, 280), shape(eyebrow), font=pick_font_for(eyebrow, 40), fill=rgba(light, 190))

    y = 380
    for line in wrap_text(d, scene.get("visual", ""), big_font, W - 200, max_lines=6):
        d.text((96, y), shape(line), font=big_font, fill=(255, 255, 255))
        y += big_font.size + 20

    quote = scene.get("voiceover", "")
    if quote:
        qy = min(y + 80, H - 780)
        d.rounded_rectangle([80, qy, W - 80, qy + 560], radius=44, fill=(255, 255, 255, 22))
        d.rounded_rectangle([80, qy, 100, qy + 560], radius=10, fill=rgba(accent, 255))
        qfont = pick_font_for(quote, 50, bold=False)
        mark_font = get_font("display", 110)
        d.text((124, qy - 26), shape('"'), font=mark_font, fill=rgba(accent, 220))
        yy = qy + 66
        for line in wrap_text(d, quote, qfont, W - 300, max_lines=6):
            d.text((130, yy), shape(line), font=qfont, fill=rgba(light, 245))
            yy += qfont.size + 20

    prompt = scene.get("aiPrompt", "")
    if prompt:
        pfont = pick_font_for(prompt, 34, bold=False)
        py = H - 190
        d.text((96, py - 44), shape("AI PROMPT"), font=pick_font_for("AI PROMPT", 30), fill=rgba(light, 110))
        for line in wrap_text(d, prompt, pfont, W - 200, max_lines=2):
            d.text((96, py), shape(line), font=pfont, fill=rgba(light, 150))
            py += pfont.size + 12
    return img.convert("RGB")


def render_end_card(story, palette, seed):
    dark, mid, light, accent = palette
    img = make_bg(palette, seed, variant=99).convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    title_font = pick_font_for(story["title"], 88, bold=True)
    y = H // 2 - 200
    for line in wrap_text(d, story["title"], title_font, W - 200, max_lines=3):
        d.text((96, y), shape(line), font=title_font, fill=(255, 255, 255))
        y += title_font.size + 22
    y += 40
    tail = "تمت ✦ StoryPilot hourly pipeline" if is_ar(story.get("narration", "")) else "The end ✦ made by the hourly StoryPilot pipeline"
    for line in wrap_text(d, tail, pick_font_for(tail, 46, bold=False), W - 220, max_lines=2):
        d.text((96, y), shape(line), font=pick_font_for(tail, 46, bold=False), fill=rgba(light, 220))
        y += 68
    return img.convert("RGB")


async def _tts(text, voice, path):
    import edge_tts
    await edge_tts.Communicate(text, voice, rate=RATE).save(path)


def tts_or_silence(text, language, tag):
    mp3 = os.path.join(OUT_DIR, f"voice_{tag}.mp3")
    voice = VOICE_AR if language == "ar" else VOICE_EN
    try:
        asyncio.run(_tts(text, voice, mp3))
        if os.path.getsize(mp3) > 1000:
            return mp3, None
    except Exception as e:
        print(f"[tts] fallback for {tag}: {e}", flush=True)
    est = max(2.5, len(str(text).split()) / 2.6)
    return None, est


def still_clip(img, mp3=None, est=None, pad=0.45):
    if mp3:
        audio = AudioFileClip(mp3)
        dur = float(audio.duration) + pad
    else:
        dur = est + pad
        audio = AudioClip(lambda t: 0.0, duration=dur, fps=44100)
    clip = ImageClip(np.asarray(img), duration=dur)
    if hasattr(clip, "with_audio"):
        clip = clip.with_audio(audio)
    else:
        clip = clip.set_audio(audio)
    return clip


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(STORY_PATH, encoding="utf-8") as f:
        story = json.load(f)

    seed = int(hashlib.sha256(story.get("title", "story").encode()).hexdigest()[:8], 16)
    palette = PALETTES[seed % len(PALETTES)]
    language = story.get("language", "en")
    scenes = story.get("scenes", [])
    print(f"[render] '{story.get('title')}' | {len(scenes)} scenes | lang={language}", flush=True)

    clips = []
    clips.append(still_clip(render_title_card(story, palette, seed), est=3.2))
    for i, sc in enumerate(scenes, start=1):
        img = render_scene_card(sc, i, len(scenes), palette, seed)
        vo = sc.get("voiceover") or ""
        if not vo:
            clips.append(still_clip(img, est=3.0))
            continue
        mp3, est = tts_or_silence(vo, language, f"s{i}")
        print(f"[tts] scene {i}: {'edge-tts ok' if mp3 else 'silence fallback'}", flush=True)
        clips.append(still_clip(img, mp3, est))
    clips.append(still_clip(render_end_card(story, palette, seed), est=3.0))

    final = concatenate_videoclips(clips, method="compose")
    out_path = os.path.join(OUT_DIR, "output.mp4")
    total = float(final.duration)
    print(f"[render] writing {out_path} ({total:.1f}s, {W}x{H}@{FPS})", flush=True)
    final.write_videofile(
        out_path, fps=FPS, codec="libx264", audio_codec="aac",
        preset="medium", threads=os.cpu_count() or 2,
        ffmpeg_params=["-pix_fmt", "yuv420p", "-crf", "23"],
    )

    tags_raw = [w for w in (story.get("genre", "") + " short story ai storytelling vertical video").split() if len(w) > 2]
    meta = {
        "title": story.get("title", "Hourly Story"),
        "description": (story.get("logline", "") + "\n\nGenerated automatically every hour by the StoryPilot pipeline (keyless GLM-5.3-Flash + Edge-TTS + MoviePy)."),
        "tags": list(dict.fromkeys(tags_raw))[:12],
        "language": language,
        "duration_sec": round(total, 1),
        "scenes": len(scenes),
    }
    with open(os.path.join(OUT_DIR, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("[render] done -> output/output.mp4 + output/meta.json", flush=True)


if __name__ == "__main__":
    main()
