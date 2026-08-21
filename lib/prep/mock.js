// Mock interview: the LLM asks, you answer, it grades.
//
// Reading study notes creates a false sense of readiness — you feel fluent because
// you're recognising material, not producing it. Saying an answer out loud (or
// typing it) is the thing that actually transfers, and getting it marked against
// what a strong answer contains is what closes the gap.
//
// Questions come from the prep knowledge base, so you're rehearsing the topics your
// own saved job ads actually demand. Grading is grounded in the same material.
//
// Deliberately STATELESS: the client holds the transcript and posts it back. No
// session table, no expiry, and you can close the tab and resume later.

import { all } from '../db.js';
import { chat } from '../llm.js';
import { retrievePrep } from './kb.js';

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const open = t[start]; const close = open === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === open) depth++;
    else if (t[i] === close) { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}

/**
 * Pick the next question.
 *
 * Prefers questions already written into your prep notes (they're grounded in real
 * job requirements and were generated with sources). Falls back to generating one
 * when the KB is empty or every stored question has been asked.
 */
export async function nextQuestion(profile, { topic = null, asked = [] } = {}) {
  const pid = profile.id;
  const rows = await all(
    `SELECT topic, body FROM prep_notes
      WHERE profile_id = ? AND kind IN ('skill','asked','topic')
      ${topic ? 'AND lower(topic) = lower(?)' : ''}`,
    topic ? [pid, topic] : [pid]
  );

  // Prep notes store questions as "*Q: …*" lines — harvest them.
  const pool = [];
  for (const r of rows) {
    for (const m of String(r.body || '').matchAll(/\*Q:\s*(.+?)\*/g)) {
      const q = m[1].trim();
      if (q.length > 12) pool.push({ q, topic: r.topic });
    }
  }
  const askedSet = new Set(asked.map((a) => String(a).toLowerCase().trim()));
  const remaining = pool.filter((p) => !askedSet.has(p.q.toLowerCase().trim()));

  if (remaining.length) {
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    return { ok: true, question: pick.q, topic: pick.topic, source: 'prep-notes', remaining: remaining.length - 1 };
  }

  if (!rows.length) {
    return {
      ok: false,
      reason: 'Your prep knowledge base is empty. Hit "Refresh prep" first, or ask the bot about a topic to add one.',
    };
  }

  // Everything stored has been asked — generate a fresh one on a covered topic.
  const topics = [...new Set(rows.map((r) => r.topic))].slice(0, 8);
  const raw = await chat(profile, [
    {
      role: 'system',
      content: [
        'You are a senior interviewer. Ask ONE realistic interview question on one of the given topics.',
        'It must be answerable out loud in 2-4 minutes. No preamble.',
        'Avoid these already-asked questions.',
        'Respond with ONLY: {"question":"…","topic":"…"}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `TOPICS: ${topics.join(', ')}\n\nALREADY ASKED:\n${asked.slice(-15).map((a) => '- ' + a).join('\n') || '(none)'}`,
    },
  ], { num_predict: 900, temperature: 0.8, json: true, useSynthModel: true });

  const parsed = extractJson(raw);
  if (!parsed?.question) return { ok: false, reason: 'Could not generate a question. Try again.' };
  return { ok: true, question: parsed.question, topic: parsed.topic || topics[0], source: 'generated', remaining: 0 };
}

/**
 * Grade an answer against the prep material.
 *
 * Grounded in retrieved notes so the feedback reflects the production-grade answer
 * the material teaches, not just the model's opinion. Scores 1-5 with the specific
 * things that were missing — vague encouragement is useless for improving.
 */
export async function gradeAnswer(profile, question, answer) {
  const a = String(answer || '').trim();
  if (a.length < 15) {
    return {
      ok: true, score: 1,
      verdict: 'Too short to assess.',
      missing: ['A substantive answer — aim for 4-8 sentences covering the what, the trade-offs, and a concrete example.'],
      strengths: [], modelAnswer: '',
    };
  }

  const hits = await retrievePrep(profile, question, { k: 5 });
  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] (${h.topic})\n${h.text}`).join('\n\n')
    : '(no matching study material — grade on general senior-engineer standards)';

  const system = [
    'You are a demanding but fair senior interviewer grading a candidate\'s spoken answer.',
    'Grade against what a STRONG PRODUCTION-GRADE answer would contain — the study material below describes it.',
    '',
    'Be specific and honest. "Good job" helps nobody. Name exactly what was missing.',
    'Score 1-5: 1 wrong/absent, 2 superficial, 3 acceptable, 4 strong, 5 exceptional (depth + trade-offs + concrete example).',
    '',
    'Respond with ONLY a JSON object:',
    '{"score":3,"verdict":"one or two sentences of overall judgement","strengths":["what they did well"],"missing":["specific things a strong answer would have included"],"follow_up":"the follow-up question a real interviewer would now ask","model_answer":"a concise strong answer, 4-6 sentences"}',
  ].join('\n');

  const raw = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: `STUDY MATERIAL:\n${context}\n\nQUESTION: ${question}\n\nCANDIDATE ANSWER:\n${a}` },
  ], { num_predict: 1400, temperature: 0.3, json: true, useSynthModel: true });

  const parsed = extractJson(raw);
  if (!parsed) return { ok: false, reason: 'Could not grade that answer. Try again.' };

  return {
    ok: true,
    score: Math.max(1, Math.min(5, Number(parsed.score) || 3)),
    verdict: parsed.verdict || '',
    strengths: parsed.strengths || [],
    missing: parsed.missing || [],
    followUp: parsed.follow_up || '',
    modelAnswer: parsed.model_answer || '',
    grounded: hits.length > 0,
  };
}
