// Server-Sent Events stream of the per-profile log bus.
//
// The UI terminal panel opens an EventSource on this endpoint with ?profile_id=X.
// We push the rolling backlog immediately (so the panel isn't blank on first open),
// then stream every new entry as it's logged. A heartbeat keeps the connection
// alive across idle-proxy timeouts.

import { recent, subscribe } from '../../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const profileId = searchParams.get('profile_id');
  if (!profileId) {
    return new Response('profile_id required', { status: 400 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (event, data) => {
        try {
          controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch { /* connection closed */ }
      };

      // 1) Replay the rolling buffer so the panel renders something immediately.
      for (const entry of recent(profileId)) send('log', entry);

      // 2) Live stream new entries.
      const unsub = subscribe(profileId, (entry) => send('log', entry));

      // 3) Heartbeat every 25s so idle-proxy timeouts (typically 30-60s) don't kill us.
      const hb = setInterval(() => {
        try { controller.enqueue(enc.encode(`: heartbeat\n\n`)); } catch { /* gone */ }
      }, 25000);

      // 4) Clean up when the client disconnects.
      req.signal.addEventListener('abort', () => {
        clearInterval(hb);
        unsub();
        try { controller.close(); } catch { /* already closed */ }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Prevent Next.js / Nginx from buffering the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
