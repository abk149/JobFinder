// Returns the bookmarklet URL for the UI to render as a draggable link.
// The token lives in this URL — and therefore only in your bookmarks, never in a page.
import { quickToken } from '../../../../lib/quickToken.js';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  const origin = new URL(req.url).origin;
  const t = quickToken();
  // Fetch + eval rather than <script src>: one fewer thing a page's CSP or
  // mixed-content policy can refuse.
  const code =
    `javascript:(function(){fetch('${origin}/api/toolbar?t=${t}')` +
    `.then(function(r){return r.text()}).then(function(s){(0,eval)(s)})` +
    `.catch(function(){alert('JobFinder is not running on ${origin}')})})()`;
  return Response.json({ bookmarklet: code, origin });
}
