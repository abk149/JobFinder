// Behavioral humanization. Cloudflare/PerimeterX/Akamai don't just fingerprint the
// browser — they also score mouse trajectories, scroll velocity, focus events, and
// time-between-interactions. A page that never receives a mousemove between page-load
// and the first click looks robotic even if every JS check passes.
//
// This module exposes small helpers that simulate natural pre-interaction behavior.
// We invoke them inside connector scan/apply flows and inside the autofill engine.

function rand(min, max) { return Math.random() * (max - min) + min; }

// Bezier-ish curve through three points (start → control → end), generating N waypoints.
function curve(x0, y0, x1, y1, steps) {
  const cx = (x0 + x1) / 2 + rand(-100, 100);
  const cy = (y0 + y1) / 2 + rand(-50, 50);
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t ** 2 * x1;
    const y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t ** 2 * y1;
    pts.push([x + rand(-1.5, 1.5), y + rand(-1.5, 1.5)]); // micro-jitter
  }
  return pts;
}

// Move the mouse along a curve from current position to (x, y) over ~150-400ms.
export async function humanMouseTo(page, x, y) {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 900 };
    const startX = rand(50, vp.width - 50);
    const startY = rand(50, vp.height - 50);
    const steps = Math.max(8, Math.floor(rand(15, 28)));
    for (const [px, py] of curve(startX, startY, x, y, steps)) {
      await page.mouse.move(px, py, { steps: 1 });
      await new Promise((r) => setTimeout(r, rand(8, 22)));
    }
  } catch { /* mouse moves are best-effort */ }
}

// Random "settling" behavior right after a page loads: a couple of mouse moves,
// a small scroll, brief pause. Mirrors what a real visitor would do.
export async function humanSettle(page) {
  try {
    const vp = page.viewportSize() || { width: 1280, height: 900 };
    await humanMouseTo(page, rand(200, vp.width - 200), rand(150, vp.height / 2));
    await new Promise((r) => setTimeout(r, rand(300, 800)));
    await page.mouse.wheel(0, rand(80, 240));
    await new Promise((r) => setTimeout(r, rand(400, 900)));
    await humanMouseTo(page, rand(200, vp.width - 200), rand(200, vp.height - 200));
  } catch { /* best-effort */ }
}

// Type into an input with realistic per-key timing instead of setting value all at once.
export async function humanType(locator, text) {
  try {
    await locator.click({ delay: rand(50, 150) });
    for (const ch of String(text)) {
      await locator.page().keyboard.type(ch, { delay: rand(40, 140) });
    }
  } catch { /* best-effort */ }
}
