// Small helpers for API route handlers so a malformed request body returns a
// clean 400 instead of an unhandled exception (which Next.js surfaces as an
// opaque 500). Keeps every route's parsing consistent.

/**
 * Parse a JSON request body, tolerating an empty body (returns {}).
 * Throws an HttpError(400) on invalid JSON so the caller's catch can respond cleanly.
 */
export async function readJson(req) {
  let text;
  try {
    text = await req.text();
  } catch {
    throw new HttpError(400, 'Could not read request body');
  }
  if (!text || !text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON');
  }
}

/** Assert that every named field is present (not null/undefined/empty-string). */
export function requireFields(obj, fields) {
  const missing = fields.filter((f) => obj?.[f] == null || obj[f] === '');
  if (missing.length) {
    throw new HttpError(400, `Missing required field(s): ${missing.join(', ')}`);
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Wrap an async route handler so thrown HttpErrors become proper JSON responses
 * and any other error becomes a 500 with a safe message (full detail is logged).
 *
 *   export const POST = withErrorHandling(async (req) => { ... });
 */
export function withErrorHandling(handler) {
  return async (req, ctx) => {
    try {
      return await handler(req, ctx);
    } catch (e) {
      if (e instanceof HttpError) {
        return Response.json({ error: e.message }, { status: e.status });
      }
      console.error('[api] Unhandled error:', e);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
  };
}
