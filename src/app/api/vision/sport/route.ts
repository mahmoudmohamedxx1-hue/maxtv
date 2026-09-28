import { NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

export const dynamic = 'force-dynamic';

/**
 * Content-mismatch detection (the football→F1 guard).
 *
 * DaddyLive schedule events list *network* channels, and a network may air
 * something else right now (e.g. DAZN Spain preempts football for F1 on a
 * grand-prix weekend) even though the listing says otherwise. The player
 * captures a frame from the playing video (same-origin via the HLS proxy, so
 * the canvas is untainted) and posts it here; we classify the sport with the
 * vision model and tell the player whether it matches the event it opened.
 *
 * POST /api/vision/sport  { image: dataURL, expect: 'football' }
 *   → { sport, confidence, matches }
 */
const CATEGORY_PHRASES: Record<string, string> = {
  football: 'football (soccer) — a pitch, players kicking a ball',
  american_football: 'American football (NFL-style) — helmets, oval ball',
  basketball: 'basketball',
  baseball: 'baseball',
  cricket: 'cricket',
  mma: 'MMA / boxing / fighting',
  motorsport: 'motorsport — F1, MotoGP, NASCAR, race cars on a track',
  tennis: 'tennis',
  hockey: 'ice hockey',
  rugby: 'rugby',
  golf: 'golf',
  darts: 'darts',
  cycling: 'cycling',
  esports: 'esports / video game',
  other: 'any sport',
};

const SPORT_KEYS = Object.keys(CATEGORY_PHRASES);

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { image?: string; expect?: string };
    const { image, expect } = body;
    if (!image || !/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) {
      return NextResponse.json({ error: 'bad_image' }, { status: 400 });
    }
    if (!expect || !CATEGORY_PHRASES[expect]) {
      return NextResponse.json({ error: 'bad_expect' }, { status: 400 });
    }

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.createVision({
      model: 'glm-4.6v',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `This is a single frame from a live TV sports stream. Which sport is being broadcast? ` +
                `Pick the single best label from this list: ${SPORT_KEYS.join(', ')}. ` +
                `If the frame shows a studio, scoreboard, talking heads or an "offline/please stand by" slate, ` +
                `answer with the sport the broadcast is about when identifiable, otherwise "other". ` +
                `Reply ONLY with compact JSON: {"sport":"<label>","confidence":0-1}`,
            },
            { type: 'image_url', image_url: { url: image } },
          ],
        },
      ],
      thinking: { type: 'disabled' },
    });

    const raw = completion.choices[0]?.message?.content || '';
    const m = raw.match(/\{[\s\S]*\}/);
    let sport = 'other';
    let confidence = 0.5;
    if (m) {
      try {
        const parsed = JSON.parse(m[0]) as { sport?: string; confidence?: number };
        if (parsed.sport && SPORT_KEYS.includes(parsed.sport)) sport = parsed.sport;
        if (typeof parsed.confidence === 'number') confidence = Math.max(0, Math.min(1, parsed.confidence));
      } catch {
        /* keep defaults */
      }
    }

    return NextResponse.json({
      sport,
      confidence,
      matches: sport === expect,
      expect,
    });
  } catch {
    return NextResponse.json({ error: 'vision_failed' }, { status: 500 });
  }
}
