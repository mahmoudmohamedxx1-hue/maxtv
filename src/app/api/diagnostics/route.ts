// ─── /api/diagnostics — operator/monitoring endpoint ──────────────────────────
// Surfaces the DaddyLive edge-transport telemetry in one place:
//   • edge host + ROTATION LOG (setDlEdgeHost records every rotation; a
//     rotation inside the last 10 minutes flags `rotating: true` — the signal
//     an operator should re-check the paired fetcher against the new host)
//   • manifest micro-cache effectiveness (hit rate / coalesced requests /
//     saved edge pair-fetches)
//   • IPTV catalog health snapshot
//   • the serverless region this isolate runs in (verifies the Frankfurt
//     deployment for MENA latency)
// Read-only, no secrets, no request params.

import { NextResponse } from 'next/server';
import { getDlEdgeDiagnostics } from '@/lib/streaming/dledge';
import { isCatalogBuilt } from '@/lib/iptv/catalog';

export const dynamic = 'force-dynamic';

export async function GET() {
  const edge = getDlEdgeDiagnostics();
  const catalogBuilt = isCatalogBuilt();

  return NextResponse.json(
    {
      at: new Date().toISOString(),
      region: process.env.VERCEL_REGION || null,
      edge: {
        host: edge.edgeHost,
        rotating: edge.rotating,
        rotations: edge.rotations.map((r) => ({
          from: r.from,
          to: r.to,
          at: new Date(r.at).toISOString(),
        })),
      },
      manifestCache: edge.cache,
      catalog: {
        built: catalogBuilt,
      },
      // compact alert block — a monitor only needs to check this
      alerts: [
        ...(edge.rotating
          ? [
              {
                id: 'edge-host-rotation',
                severity: 'warning',
                message: `DaddyLive edge host rotated recently: ${edge.rotations[0].from} → ${edge.rotations[0].to}`,
              },
            ]
          : []),
      ],
    },
    { headers: { 'cache-control': 'no-store' } }
  );
}
