// Prep Q&A bot — answers from the interview-prep knowledge base, and GROWS it.
//
// POST { profile_id, question, autoResearch? = true, force? = false }
//
// Flow:
//   1. Try to answer from what's already in the knowledge base.
//   2. If the KB doesn't cover it (or force=true), research the topic live, write a
//      study note, index it, and answer from the fresh material.
// That makes learning iterative: every question you ask permanently expands the KB.

import { get } from '../../../../lib/db.js';
import { askPrep } from '../../../../lib/prep/kb.js';
import { learnTopic, topicFromQuestion } from '../../../../lib/prep/learn.js';
import { readJson, requireFields, withErrorHandling, HttpError } from '../../../../lib/http.js';
import { lcmd, linfo, lok } from '../../../../lib/logger.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 600; // live research + synthesis can take a few minutes

export const POST = withErrorHandling(async (req) => {
  const { profile_id, question, autoResearch = true, force = false } = await readJson(req);
  requireFields({ profile_id, question }, ['profile_id', 'question']);

  const profile = await get('SELECT * FROM profiles WHERE id = ?', [profile_id]);
  if (!profile) throw new HttpError(404, 'profile not found');

  const q = String(question).slice(0, 2000);

  // 1) Answer from existing material unless the caller explicitly forces new research.
  let result = force ? { grounded: false, sources: [] } : await askPrep(profile, q);

  // 2) Not covered → go learn it, then answer again from the new note.
  let learned = null;
  if (!result.grounded && autoResearch) {
    const topic = topicFromQuestion(q);
    lcmd(profile_id, `▶ "${topic}" isn't in your knowledge base yet — researching it now`);
    const outcome = await learnTopic(profile, topic).catch((e) => ({ ok: false, reason: String(e?.message || e) }));

    if (outcome.ok) {
      learned = { topic: outcome.topic, sources: outcome.sources.length };
      lok(profile_id, `■ Added "${outcome.topic}" to your knowledge base — answering from it now`);
      result = await askPrep(profile, q);
      // Even if similarity ranking is unlucky, we know the note exists — surface it.
      if (!result.grounded) {
        result = {
          answer: outcome.body,
          sources: outcome.sources.map((s) => ({ topic: outcome.topic, url: s.url, kind: s.kind })),
          grounded: true,
        };
      }
      result.newlyLearned = learned;
      result.references = outcome.sources.map((s, i) => ({
        n: i + 1, kind: s.kind, title: s.title, url: s.url, purpose: s.purpose || 'reference',
      }));
    } else {
      linfo(profile_id, `■ Could not research "${topic}": ${outcome.reason}`);
      result.researchFailed = outcome.reason;
    }
  }

  return Response.json({ ok: true, ...result });
});
