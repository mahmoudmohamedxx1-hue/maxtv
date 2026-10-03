#!/usr/bin/env python3
"""StoryPilot - Hourly story source.

Primary : the Google Sheet that Gemini Spark updates every hour (tab 1 = story).
Optional: a fresh story generated KEYLESS via freellmpool (GLM Flash first,
          auto-failover to the keyless pool) when USE_AI_STORY=true or the
          sheet is unreachable.
Fallback: a built-in sample story so the pipeline never breaks.

Writes  : story.json (consumed by generate_video.py)
          sheet_code.py (the raw generator code from the sheet tab, reference only)
"""
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.parse
import urllib.request

SHEET_ID = os.environ.get("SHEET_ID", "1nNsUcwR9foKN_MTPm5bwMR5jz2HUE68UeRqJ0OFp-d4")
CODE_TAB = os.environ.get("CODE_TAB", "كود بايثون - المولد الآلي")
USE_AI_STORY = os.environ.get("USE_AI_STORY", "false").lower() in ("1", "true", "yes")
FLP_MODEL = os.environ.get("FLP_MODEL", "glm-4.7-flash")
STORY_TOPIC = os.environ.get("STORY_TOPIC", "").strip()
STORY_JSON = os.environ.get("STORY_JSON", "").strip()
OUT = os.environ.get("STORY_PATH", "story.json")
UA = {"User-Agent": "Mozilla/5.0 (compatible; StoryPilotAgent/1.0)"}

FALLBACK_STORY = {
    "title": "The Lighthouse That Counted Storms",
    "logline": "A lonely lighthouse keeper discovers his lamp flickers once for every ship the storm plans to take.",
    "genre": "Sci-Fi Mystery / Fantasy",
    "duration": "60 Seconds",
    "language": "en",
    "scenes": [
        {"index": 1, "timeRange": "0:00 - 0:10", "visual": "Waves hammer a black rock lighthouse at dusk; an old keeper climbs the spiral stairs with a storm lantern.", "aiPrompt": "Cinematic wide shot, stormy sea, gothic lighthouse, rain, moody blue palette, photorealistic", "voiceover": "Every keeper before him heard the sea speak. He was the first to hear it count.", "sfx": "thunder, rain on glass"},
        {"index": 2, "timeRange": "0:10 - 0:25", "visual": "The great lamp flares once, unbidden. The keeper looks at a logbook where every past flare is inked beside a lost ship.", "aiPrompt": "Macro shot of antique logbook, candlelight, inked ship names, tense atmosphere", "voiceover": "One flare. He checked the log. One flare meant one ship would not come home.", "sfx": "creaking iron, wind"},
        {"index": 3, "timeRange": "0:25 - 0:45", "visual": "He fights the storm to the lamp room and dims the light himself, standing in the dark while the sea screams.", "aiPrompt": "Dramatic silhouette, keeper shutting off lighthouse beam, lightning, vertical composition", "voiceover": "So he did what no keeper had dared. He turned off the light.", "sfx": "storm swell"},
        {"index": 4, "timeRange": "0:45 - 0:60", "visual": "Dawn. Calm water. Three fishing boats sail home under a pink sky; the keeper sleeps against the cold lamp.", "aiPrompt": "Sunrise over calm sea, fishing boats returning, warm pink and gold, hopeful", "voiceover": "At dawn, three boats came home. The sea had lost count... and so had the storm.", "sfx": "gentle waves, gulls"},
    ],
    "narration": "Every keeper before him heard the sea speak. He was the first to hear it count. One flare meant one ship would not come home. So he turned off the light. At dawn, three boats came home.",
}


def fetch_url(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_csv(text):
    rows, row, cell, q = [], [], "", False
    for i, c in enumerate(text):
        if q:
            if c == '"':
                if i + 1 < len(text) and text[i + 1] == '"':
                    cell += '"'
                else:
                    q = False
            else:
                cell += c
        elif c == '"':
            q = True
        elif c == ",":
            row.append(cell); cell = ""
        elif c == "\n":
            row.append(cell); rows.append(row); row = []; cell = ""
        elif c != "\r":
            cell += c
    if cell or row:
        row.append(cell); rows.append(row)
    return rows


def detect_language(t):
    ar = len(re.findall(r"[\u0600-\u06FF]", t))
    la = len(re.findall(r"[A-Za-z]", t))
    return "ar" if ar > la else "en"


def story_from_sheet():
    base = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
    csv_text = fetch_url(f"{base}/export?format=csv")
    rows = parse_csv(csv_text)
    story = {"title": "Untitled Story", "logline": "", "genre": "", "duration": "60 Seconds", "scenes": [], "narration": ""}
    header_idx, narration_idx = None, None
    for i, r in enumerate(rows):
        cells = [c.strip() for c in r]
        first = (cells[0] if cells else "").rstrip(":").lower()
        if first in ("story title", "العنوان") and len(cells) > 1 and cells[1]:
            story["title"] = cells[1]
        elif first in ("logline", "الفقرة التعريفية") and len(cells) > 1 and cells[1]:
            story["logline"] = cells[1]
        elif first in ("genre", "النوع") and len(cells) > 1 and cells[1]:
            story["genre"] = cells[1]
        elif ("duration" in first or "المدة" in first) and len(cells) > 1 and cells[1]:
            story["duration"] = cells[1]
        if cells and cells[0] in ("Scene #", "المشهد"):
            header_idx = i
        joined = " ".join(cells)
        if "Complete Voiceover Narration" in joined or "التعليق الصوتي الكامل" in joined:
            narration_idx = i
    if header_idx is not None:
        for i in range(header_idx + 1, len(rows)):
            if narration_idx is not None and i >= narration_idx:
                break
            cells = [c.strip() for c in rows[i]]
            if not cells or not cells[0]:
                continue
            story["scenes"].append({
                "index": len(story["scenes"]) + 1,
                "timeRange": cells[1] if len(cells) > 1 else "",
                "visual": cells[2] if len(cells) > 2 else "",
                "aiPrompt": cells[3] if len(cells) > 3 else "",
                "voiceover": cells[4] if len(cells) > 4 else "",
                "sfx": cells[5] if len(cells) > 5 else "",
            })
    if narration_idx is not None:
        parts = []
        for i in range(narration_idx + 1, len(rows)):
            line = " ".join(c.strip() for c in rows[i] if c.strip())
            if line:
                parts.append(line)
        story["narration"] = " ".join(parts)
    if not story["narration"] and story["scenes"]:
        story["narration"] = " ".join(s["voiceover"] for s in story["scenes"] if s["voiceover"])
    story["language"] = detect_language(story["title"] + " " + story["narration"])
    if not story["scenes"]:
        raise ValueError("sheet has no scene rows")
    return story


def save_sheet_code():
    """Also save the raw Python code tab from the sheet (reference)."""
    try:
        base = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}"
        url = f"{base}/gviz/tq?tqx=out:csv&sheet={urllib.parse.quote(CODE_TAB)}"
        rows = parse_csv(fetch_url(url))
        lines = []
        started = False
        for r in rows:
            cell = r[1] if len(r) > 1 else ""
            if not started and (cell.startswith("import ") or cell.startswith("#!")):
                started = True
            if started:
                lines.append(cell)
        if lines:
            with open("sheet_code.py", "w", encoding="utf-8") as f:
                f.write("\n".join(lines))
            print(f"[story] saved sheet generator code ({len(lines)} lines) -> sheet_code.py", flush=True)
    except Exception as e:
        print(f"[story] sheet code tab not saved: {e}", flush=True)


SYSTEM_PROMPT = (
    "You are StoryPilot, an expert short-form video scriptwriter. "
    "Reply with ONE JSON object and nothing else. No markdown fences. Schema: "
    '{"title": str, "logline": str, "genre": str, "duration": "60 Seconds", '
    '"scenes": [{"timeRange": str, "visual": str, "aiPrompt": str, "voiceover": str, "sfx": str}] , '
    '"narration": str}. Exactly 4-6 scenes, each voiceover is 1-3 spoken sentences, '
    "visual is one cinematic sentence, aiPrompt is a short image-generation prompt. "
    "Match the language of the topic."
)


def story_from_freellmpool():
    topic = STORY_TOPIC or "a surprising 60-second micro-story with a twist ending, cinematic and emotional"
    prompt = f"Write a fresh hourly vertical-video story about: {topic}"
    exe = shutil.which("freellmpool")
    base = [exe] if exe else [sys.executable, "-m", "freellmpool"]
    # Try the configured model first (e.g. a GLM Flash route), then fail over to
    # guaranteed-keyless pool routes. "auto" lets freellmpool pick a live keyless model.
    attempts = []
    for m in [FLP_MODEL, "zhipu/glm-4.7-flash", "ovh/Qwen3-32B", "auto"]:
        if m and m not in attempts:
            attempts.append(m)
    last_err = ""
    for model in attempts:
        cmd = base + [
            "ask", "-m", model, "--json", "--timeout", "90",
            "-s", SYSTEM_PROMPT, prompt,
        ]
        print(f"[story] trying freellmpool model: {model}", flush=True)
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=240)
        except subprocess.TimeoutExpired:
            last_err = f"{model}: timed out"
            print(f"[story] {last_err}", flush=True)
            continue
        raw = (out.stdout or "") + (out.stderr or "")
        m2 = re.search(r"\{[\s\S]*\}", raw)
        if not m2:
            last_err = f"{model}: no JSON in reply ({raw[:160]})"
            print(f"[story] {last_err}", flush=True)
            continue
        try:
            data = json.loads(m2.group(0))
        except json.JSONDecodeError:
            last_err = f"{model}: unparseable JSON"
            print(f"[story] {last_err}", flush=True)
            continue
        if not data.get("scenes"):
            last_err = f"{model}: no scenes"
            print(f"[story] {last_err}", flush=True)
            continue
        data.setdefault("duration", "60 Seconds")
        data["language"] = detect_language(json.dumps(data, ensure_ascii=False))
        for i, s in enumerate(data["scenes"], 1):
            s.setdefault("index", i)
            s.setdefault("timeRange", f"scene {i}")
        print(f"[story] served by: {model}", flush=True)
        return data
    raise ValueError(f"all freellmpool attempts failed ({last_err})")


def story_from_payload():
    """Full story JSON provided by the StoryPilot app (any sheet tab, any format)."""
    data = json.loads(STORY_JSON)
    if not data.get("title") or not data.get("scenes"):
        raise ValueError("payload missing title/scenes")
    data.setdefault("duration", "60 Seconds")
    data.setdefault("narration", " ".join(s.get("voiceover", "") for s in data["scenes"]))
    data["language"] = data.get("language") or detect_language(data["title"] + " " + data["narration"])
    for i, s in enumerate(data["scenes"], 1):
        s.setdefault("index", i)
        s.setdefault("timeRange", f"scene {i}")
        s.setdefault("visual", "")
        s.setdefault("aiPrompt", "")
        s.setdefault("voiceover", "")
        s.setdefault("sfx", "")
    return data


def main():
    story = None
    source = "none"
    if STORY_JSON:
        try:
            story = story_from_payload()
            source = "storypilot library payload"
        except Exception as e:
            print(f"[story] STORY_JSON invalid ({e}); falling back to sheet", flush=True)
    if story is None and not USE_AI_STORY:
        try:
            story = story_from_sheet()
            source = "google-sheet (gemini spark hourly)"
        except Exception as e:
            print(f"[story] sheet unavailable: {e}", flush=True)
    if story is None:
        try:
            story = story_from_freellmpool()
            source = f"freellmpool keyless ({FLP_MODEL} first, auto-failover)"
        except Exception as e:
            print(f"[story] freellmpool failed: {e}", flush=True)
            story = FALLBACK_STORY
            source = "built-in fallback"
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(story, f, ensure_ascii=False, indent=2)
    if source != "storypilot library payload":
        save_sheet_code()
    print(f"[story] source = {source}", flush=True)
    print(f"[story] '{story.get('title')}' | {len(story.get('scenes', []))} scenes -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
