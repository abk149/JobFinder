// Serves the in-page toolbar script to the bookmarklet.
//
// The bookmarklet stays tiny — it fetches this and eval()s it — which means the
// toolbar can be changed here without you re-dragging the bookmark.
//
// Requires the same token as /api/quickfill, so a random site cannot pull the script
// and read the token out of it.

import fs from 'node:fs';
import path from 'node:path';
import { tokenValid, quickToken, corsHeaders } from '../../../lib/quickToken.js';

export const dynamic = 'force-dynamic';

export async function OPTIONS(req) {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const cors = corsHeaders(req);
  if (!tokenValid(searchParams.get('t'))) {
    return new Response('/* invalid toolbar token */', {
      status: 401,
      headers: { ...cors, 'content-type': 'application/javascript' },
    });
  }

  let src = '';
  try {
    src = fs.readFileSync(path.join(process.cwd(), 'lib', 'toolbar.src.js'), 'utf8');
  } catch {
    return new Response('/* toolbar source missing */', {
      status: 500,
      headers: { ...cors, 'content-type': 'application/javascript' },
    });
  }

  // The origin the page should call back on — same host it just fetched from, so this
  // keeps working if the app is ever served on a different port.
  const origin = new URL(req.url).origin;
  src = src
    .replaceAll('__JOBFINDER_TOKEN__', quickToken())
    .replaceAll('__JOBFINDER_ORIGIN__', origin);

  return new Response(src, {
    headers: {
      ...cors,
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
