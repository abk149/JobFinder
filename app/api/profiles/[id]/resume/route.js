import { get, run } from '../../../../../lib/db.js';
import { saveResume, getResume, clearResume } from '../../../../../lib/resume.js';
import { extractPdfText } from '../../../../../lib/pdftext.js';
import { parseFilters, serializeFilters } from '../../../../../lib/profileSettings.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(_req, { params }) {
  const entry = getResume(params.id);
  if (!entry) return Response.json({ resume: null });
  return Response.json({
    resume: { filename: entry.filename, size: entry.buffer.length, path: entry.path },
  });
}

export async function POST(req, { params }) {
  const profile = await get('SELECT id FROM profiles WHERE id = ?', [params.id]);
  if (!profile) return Response.json({ error: 'profile not found' }, { status: 404 });

  const form = await req.formData();
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return Response.json({ error: 'no file uploaded' }, { status: 400 });
  }
  if (file.type && !file.type.includes('pdf')) {
    return Response.json({ error: 'must be a PDF' }, { status: 400 });
  }

  const saved = await saveResume(params.id, file);
  await run('UPDATE profiles SET resume_path = ? WHERE id = ?', [saved.path, params.id]);

  // Extract the CV text so fit scoring and CV tailoring have something to work with.
  // Text-based PDFs (Word/Docs/LaTeX exports) work; scanned ones don't, and in that
  // case we tell the user to paste instead rather than silently scoring on nothing.
  let extraction = { ok: false, reason: 'not attempted' };
  try {
    const entry = getResume(params.id);
    if (entry?.buffer) {
      extraction = extractPdfText(entry.buffer);
      if (extraction.ok) {
        const full = await get('SELECT filters FROM profiles WHERE id = ?', [params.id]);
        const filters = parseFilters(full);
        filters.cv_text = extraction.text.slice(0, 40000);
        await run('UPDATE profiles SET filters = ? WHERE id = ?', [serializeFilters(filters), params.id]);
      }
    }
  } catch (e) {
    extraction = { ok: false, reason: String(e?.message || e) };
  }

  return Response.json({
    ok: true,
    ...saved,
    cvText: {
      extracted: extraction.ok,
      chars: extraction.ok ? extraction.text.length : 0,
      reason: extraction.ok ? null : extraction.reason,
    },
  });
}

export async function DELETE(_req, { params }) {
  clearResume(params.id);
  await run('UPDATE profiles SET resume_path = ? WHERE id = ?', ['', params.id]);
  return Response.json({ ok: true });
}
