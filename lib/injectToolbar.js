// Put the toolbar on the page automatically, so Apply is all you have to click.
//
// The bookmarklet still exists as a manual fallback (after a hard reload, or on a page
// JobFinder didn't open), but requiring it every time was the wrong default — and if
// you never clicked it there were no hotkeys registered at all, which is exactly what
// "the shortcuts don't work" looked like.
//
// Injected into EVERY frame, not just the top document: application forms sit in an
// iframe, keystrokes go to the focused frame's window, and a listener only on the top
// document never sees them. The script itself decides what to do per frame — UI in the
// top frame, hotkey relay in the children.

import fs from 'node:fs';
import path from 'node:path';
import { quickToken } from './quickToken.js';

const PORT = process.env.PORT || 3737;
let cachedSrc = '';

function toolbarSource(origin) {
  if (!cachedSrc) {
    cachedSrc = fs.readFileSync(path.join(process.cwd(), 'lib', 'toolbar.src.js'), 'utf8');
  }
  return cachedSrc
    .replaceAll('__JOBFINDER_TOKEN__', quickToken())
    .replaceAll('__JOBFINDER_ORIGIN__', origin || `http://127.0.0.1:${PORT}`);
}

/**
 * Evaluate the toolbar into every frame of every open page.
 * Safe to call repeatedly — the script no-ops if already loaded in that frame.
 * @returns {Promise<number>} frames that accepted it
 */
export async function injectToolbar(ctx, { origin } = {}) {
  let src;
  try { src = toolbarSource(origin); } catch { return 0; }

  let n = 0;
  for (const page of ctx.pages()) {
    if (page.isClosed()) continue;
    for (const frame of page.frames()) {
      let url = '';
      try { url = frame.url(); } catch { continue; }
      if (!url || url === 'about:blank' || url.startsWith('chrome')) continue;
      try {
        await frame.evaluate(src);
        n++;
      } catch { /* navigating, or a frame we can't reach — skip */ }
    }
  }
  return n;
}
