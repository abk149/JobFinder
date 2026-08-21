// The synthesis engine.
//
// Pipeline (evidence-driven — we never invent study topics):
//   1. skills.js reads the user's saved JOB DESCRIPTIONS and extracts the skills
//      those roles actually demand, validated against the source text and ranked by
//      how many jobs ask for each one.
//   2. research.js gathers citable material for each skill (Wikipedia, HN, Stack
//      Overflow, dev.to, Reddit, optionally LinkedIn) — every item has a real URL.
//   3. This module asks the LLM to write a deep-dive on that skill FROM those
//      sources, citing them by number.
//   4. Everything is stored with its source list so the UI can render clickable
//      links, and embedded so the Q&A bot can answer from it.
//
// The user can always check our work: each topic shows the verbatim JD sentence that
// put it on the list, plus links to every source the material was written from.

import crypto from 'node:crypto';
import { all, run } from '../db.js';
import { chat } from '../llm.js';
import { listAnswers } from '../answerBank.js';
import { extractSkillsFromJobs } from './skills.js';
import { researchSkill } from './research.js';
import { indexNote } from './kb.js';
import { linfo, lok, lwarn, lerr } from '../logger.js';

// Six skills x ~9 min each on deepseek-r1:8b is roughly an hour, which is fine for a
// daily background build but painful to wait on. A non-reasoning instruct model
// (qwen2.5:7b-instruct, llama3.1:8b) is 3-5x faster here AND more reliable at long
// JSON, because it wastes nothing on <think>. Set it per profile via filters.synth_model.
const MAX_SKILLS = 6;
// ONE skill at a time.
//
// Two concurrent generations against a single 8B model at num_ctx 8192 is what wedged
// a build: both connections open, model loaded, runner at 3.7% CPU, generating nothing.
// The GPU is the bottleneck anyway, so parallelism bought little and risked a stall that
// had no timeout to recover from. Sequential is slower on paper and finishes more often.
const SKILL_CONCURRENCY = 1;
const SOURCE_EXCERPT = 1100;

/** Pull the first JSON value out of an LLM response, tolerating fences and prose. */
function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const openCh = t[start];
  const closeCh = openCh === '[' ? ']' : '}';
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === openCh) depth++;
    else if (t[i] === closeCh) {
      depth--;
      if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } }
    }
  }
  return null;
}

function candidateContext(profile, answers) {
  const bits = [
    `NAME: ${profile.name || '(not set)'}`,
    `TARGET ROLES / KEYWORDS: ${profile.keywords || '(not set)'}`,
  ];
  let bio = '';
  try {
    const f = typeof profile.filters === 'string' ? JSON.parse(profile.filters) : profile.filters || {};
    bio = f.bio || '';
  } catch { /* ignore */ }
  if (bio) bits.push(`BACKGROUND:\n${bio}`);
  if (answers.length) {
    bits.push(
      'FACTS THE CANDIDATE HAS GIVEN ON APPLICATIONS (ground truth — never contradict):\n' +
        answers.slice(0, 20).map((a) => `  - ${a.label || a.field_key}: ${a.value}`).join('\n')
    );
  }
  return bits.join('\n');
}

/**
 * Render a synthesized note to markdown.
 *
 * Answers lead with the PRODUCTION-GRADE response; the candidate's own angle is a
 * clearly-marked secondary line so it reads as "here's how you could tie your
 * experience in" rather than capping the answer at what they've personally done.
 * Exported so on-demand learning (learn.js) renders identically.
 */
export function renderNoteBody(topic, note) {
  const L = (arr, f) => (arr?.length ? arr.map(f).join('\n') : '');

  return [
    `## ${topic}`,
    '',
    // The framing a senior reaches for first. Everything else hangs off this.
    note.mental_model ? `**The mental model**\n${note.mental_model}` : '',
    '',
    note.brief || '',
    '',
    note.how_it_works ? `**How it actually works**\n${note.how_it_works}` : '',
    '',
    L(note.key_points, (k) => `- ${k}`) && '**Key points**\n' + L(note.key_points, (k) => `- ${k}`),
    '',
    // Decision framework. Interviews at senior level are mostly "why this and not that".
    note.tradeoffs?.length
      ? '**Trade-offs you will be asked to defend**\n' +
        note.tradeoffs
          .map((t) => `- **${t.choice}** — pick when ${t.pick_when}. Cost: ${t.cost}`)
          .join('\n')
      : '',
    '',
    // Concrete magnitudes. Quoting real numbers is the single clearest senior signal.
    note.numbers?.length
      ? '**Numbers worth knowing**\n' + note.numbers.map((n) => `- ${n}`).join('\n')
      : '',
    '',
    L(note.production_notes, (k) => `- ${k}`) && '**In production**\n' + L(note.production_notes, (k) => `- ${k}`),
    '',
    // Makes the gap between levels explicit instead of leaving it to be guessed.
    note.level_ladder
      ? '**Same question, three levels**\n' +
        [
          note.level_ladder.question ? `*${note.level_ladder.question}*` : '',
          note.level_ladder.junior ? `- **Junior answer:** ${note.level_ladder.junior}` : '',
          note.level_ladder.senior ? `- **Senior answer:** ${note.level_ladder.senior}` : '',
          note.level_ladder.staff ? `- **Staff answer:** ${note.level_ladder.staff}` : '',
        ].filter(Boolean).join('\n')
      : '',
    '',
    note.questions?.length
      ? '**Likely questions**\n' +
        note.questions
          .map((q) => {
            const bits = [`\n*Q: ${q.q}*${q.level ? `  \`${q.level}\`` : ''}`];
            if (q.tests) bits.push(`\n> What they're testing: ${q.tests}`);
            bits.push(`\n${q.a}`);
            if (q.followups?.length) {
              bits.push('\n**They will then ask:** ' + q.followups.map((f) => `_${f}_`).join(' · '));
            }
            const angle = (q.your_angle || '').trim();
            if (angle) bits.push(`\n> Your angle: ${angle}`);
            return bits.join('\n');
          })
          .join('\n')
      : '',
    '',
    // What makes an otherwise-correct answer land badly.
    note.red_flags?.length
      ? '**Answers that sound junior**\n' + note.red_flags.map((r) => `- ${r}`).join('\n')
      : '',
    '',
    note.story_prompt ? `**Story to have ready**\n${note.story_prompt}` : '',
    '',
    note.drill ? `**Drill**\n${note.drill}` : '',
    '',
    note.gap ? `**Watch out**\n${note.gap}` : '',
  ].filter((x) => x !== '' && x !== undefined && x !== false).join('\n');
}

function noteId(profileId, kind, key) {
  return crypto.createHash('sha1').update(`${profileId}|${kind}|${key}`).digest('hex').slice(0, 20);
}

function sourceRowId(profileId, url) {
  return crypto.createHash('sha1').update(`${profileId}|${url}`).digest('hex').slice(0, 20);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Deep-dive on one skill, citing its sources ──────────────────────────────

async function synthesizeSkill(profile, entry, sources, pid) {
  const { skill, count, evidence, jobs = [] } = entry;

  const material = sources.length
    ? sources
        .map((s, i) => `[${i + 1}] (${s.kind}) ${s.title}\nURL: ${s.url}\n${(s.content || '').slice(0, SOURCE_EXCERPT)}`)
        .join('\n\n')
    : '(no external sources retrieved — rely on the job requirement and the candidate profile)';

  const demandedBy = jobs.slice(0, 4).map((j) => `${j.title}${j.company ? ' @ ' + j.company : ''}`).join('; ');


  // TWO CALLS, NOT ONE.
  //
  // Asking for depth AND a question bank in a single JSON object meant the model had to
  // budget one response across both, so both came out thin — and a long object is more
  // likely to come back malformed, which cost a whole skill when it did. Splitting them
  // lets each call spend its whole budget on one job, and a failure only loses half.
  const shared = [
    `SKILL: ${skill}`,
    `DEMANDED BY ${count} of the jobs you saved: ${demandedBy}`,
    evidence ? `VERBATIM REQUIREMENT FROM A JOB DESCRIPTION:\n"${evidence}"` : '',
    '',
    `CANDIDATE:\n${profile.__ctx}`,
    '',
    `REFERENCE SOURCES:\n${material}`,
  ].filter(Boolean).join('\n');

  const HOUSE_RULES = [
    'CRITICAL — write PRODUCTION-GRADE material, not autobiography:',
    '  - Answer as a strong staff engineer at a top company would in a real interview.',
    '  - Draw on how the industry ACTUALLY does this at scale: established patterns, the',
    '    trade-offs experienced people weigh, the failure modes that bite in production,',
    '    the numbers and rules of thumb practitioners actually cite.',
    '  - DO NOT limit anything to what this candidate has personally done. Their experience',
    '    is one data point, not the boundary of a good answer.',
    '  - Be specific and technical. No generic career advice, no "it depends" without saying',
    '    what it depends ON, no filler.',
    'Cite sources inline as [1], [2] wherever a claim comes from one. Never invent a citation.',
    'Facts about the CANDIDATE (employers, dates, numbers) may come only from their background.',
    'Facts about the INDUSTRY should be as rich and specific as the sources support.',
    'Respond with ONLY the JSON object.',
  ].join('\n');

  async function ask(label, schemaLines, budget) {
    const system = [
      'You are a staff-level practitioner writing interview preparation material.',
      'You are given: the skill, the job-description requirement that demands it, the',
      'candidate background, and numbered reference sources.',
      '',
      HOUSE_RULES,
      '',
      'Produce a JSON object with exactly these keys:',
      '{',
      ...schemaLines,
      '}',
    ].join('\n');

    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      linfo(pid, `      … ${skill}: ${label}${attempt > 1 ? ' (retry)' : ''}`);
      const raw = await chat(profile, [
        { role: 'system', content: attempt === 1 ? system : system + '\nIMPORTANT: output a single JSON object and nothing else. Keep reasoning brief.' },
        { role: 'user', content: shared },
      ], {
        // Retry with MORE room, never less. deepseek-r1 spends num_predict on its
        // <think> block before emitting a single character of JSON — measured here at
        // budget 2400 the reply was 0 chars, at 4000 it was 5500 chars and parsed.
        // The old retry used 0.75x, which made a second failure certain.
        num_predict: attempt === 1 ? budget : Math.round(budget * 1.3),
        temperature: attempt === 1 ? 0.45 : 0.25,
        json: true,
        useSynthModel: true,
        // Generous, but bounded: a wedged model must not stall the whole build.
        timeoutMs: 300000,
      }).catch((e) => {
        lwarn(pid, `      ✗ ${skill}: ${label} — ${String(e?.message || e).slice(0, 120)}`);
        return '';
      });
      const parsed = extractJson(raw);
      if (parsed && typeof parsed === 'object') {
        linfo(pid, `      ✓ ${skill}: ${label} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
        return parsed;
      }
      if (!String(raw || '').trim()) {
        lwarn(pid, `    ↻ "${skill}" (${label}): model returned nothing — reasoning consumed the whole budget. Retrying with more room…`);
      } else if (attempt === 1) {
        lwarn(pid, `    ↻ "${skill}" (${label}): unparseable JSON, retrying…`);
      }
    }
    lwarn(pid, `    ⚠ "${skill}" (${label}): unparseable twice — that section will be missing`);
    return null;
  }

  // THREE SMALL CALLS, NOT ONE BIG ONE.
  //
  // Only deepseek-r1 (a reasoning model) is available locally, and it spends num_predict
  // on its <think> block before emitting any JSON — measured: budget 2400 produced a
  // 0-character reply, 4000 produced valid JSON. It also degrades as the schema grows:
  // asking for nine keys at once returned one question instead of eight.
  //
  // Small schemas are reliable schemas. Each call below asks for a few related keys, so
  // any single failure costs one section rather than the whole skill.
  const core = await ask('core', [
    '  "mental_model": "2-3 sentences: the framing an expert uses to reason about this. Not a definition — the way they THINK about it.",',
    '  "brief": "150-220 words: what this is, why employers ask for it, and what interviewers probe. Industry perspective, cited inline.",',
    '  "how_it_works": "120-180 words on the actual mechanism — what happens under the hood. Concrete, not hand-wavy."',
  ], 2600);

  const lists = await ask('depth', [
    '  "key_points": ["5-7 things a strong candidate must be able to explain — concrete and technical"],',
    '  "tradeoffs": [{"choice":"the option","pick_when":"conditions that make it right","cost":"what you give up"}],',
    '  "numbers": ["4-6 concrete magnitudes a practitioner would cite: latencies, costs, limits, typical scales. Cite [n] where a source gives the figure. Omit any you cannot support."],',
    '  "production_notes": ["3-5 things that only show up at real production scale"],',
    '  "red_flags": ["3-4 things that make an otherwise-correct answer sound junior"],',
    '  "gap": "one sentence: what THIS candidate most likely needs to shore up here"',
  ], 3200);

  // Questions come in TWO batches. Asked for six at once the model returned two —
  // long arrays are where it gives up first. Two calls of three, split by level, also
  // stops every question landing at screening difficulty.
  const QSHAPE = '{"q":"a realistic interview question","level":"screening|senior|staff","tests":"what the interviewer is really assessing, one short line","a":"the production-grade model answer, 5-8 sentences","followups":["the 1-2 questions they drill into next"],"your_angle":"how THIS candidate ties their experience in, or empty string"}';

  const qaEasy = await ask('questions (screening)', [
    `  "questions": [${QSHAPE}]`,
    '',
    'Exactly THREE questions, at screening-to-senior level: the ones almost every',
    'interview on this skill opens with. Answer them the way a senior would, not a beginner.',
  ], 3000);

  const qaHard = await ask('questions (senior/staff)', [
    `  "questions": [${QSHAPE}],`,
    '  "level_ladder": {"question":"one canonical question","junior":"how a junior answers","senior":"how a senior answers the SAME question","staff":"how a staff engineer answers it — scope, trade-offs, org impact"},',
    '  "story_prompt": "one specific STAR story this candidate should prepare for this skill",',
    '  "drill": "one concrete hands-on exercise to do today"',
    '',
    'Exactly THREE questions, at senior-to-staff level: design trade-offs, failure',
    'handling, scale, and judgement calls — not definitions.',
  ], 3600);

  const qa = {
    ...(qaHard || {}),
    questions: [...(qaEasy?.questions || []), ...(qaHard?.questions || [])],
  };

  if (!core && !lists && !qa) return null;
  return { ...(core || {}), ...(lists || {}), ...(qa || {}) };
}

// ── Daily plan ──────────────────────────────────────────────────────────────

async function buildDailyPlan(profile, written, pid) {
  const summary = written.map((n) => `- ${n.skill} (in ${n.count} job ads): ${(n.gap || '').slice(0, 130)}`).join('\n');
  const system = [
    'You are an interview coach writing ONE short study plan for TODAY.',
    'Given the skills the candidate must learn (ranked by how many job ads demand them) and their weak spots, write a focused, time-boxed plan totalling 60-90 minutes.',
    'Prioritise the skills demanded by the most job ads.',
    'Respond with ONLY a JSON object: {"focus":"the single skill to prioritise today","plan":["step 1","step 2","step 3","step 4"],"warmup":"a 5-minute question to answer out loud"}',
  ].join('\n');

  const raw = await chat(profile, [
    { role: 'system', content: system },
    { role: 'user', content: `CANDIDATE:\n${profile.__ctx}\n\nSKILLS AND GAPS:\n${summary}` },
  ], { num_predict: 1200, temperature: 0.5, json: true, useSynthModel: true });
  return extractJson(raw);
}

// ── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Full prep build: extract skills from JDs → research each → synthesize with
 * citations → persist + embed.
 *
 * @param ctx  optional logged-in browser context; enables LinkedIn research
 * @returns { skills, notesWritten, dailyPlan, sourcesStored }
 */
export async function buildPrep(profile, { maxSkills = MAX_SKILLS, ctx = null } = {}) {
  const pid = profile.id;

  // ── 1. What do the target roles actually require? ──
  const skills = await extractSkillsFromJobs(profile);
  if (!skills.length) {
    return { skills: [], notesWritten: 0, dailyPlan: null, sourcesStored: 0, reason: 'no-jobs' };
  }
  const chosen = skills.slice(0, maxSkills);

  const answers = await listAnswers(pid).catch(() => []);
  profile.__ctx = candidateContext(profile, answers);

  const day = today();
  const now = Date.now();
  let sourcesStored = 0;
  const written = [];

  // ── 2+3. Research each skill, then write a cited deep-dive. ──
  linfo(pid, `  Researching + writing ${chosen.length} skill(s), ${SKILL_CONCURRENCY} at a time…`);
  const drafted = new Array(chosen.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(SKILL_CONCURRENCY, chosen.length) }, async () => {
      while (cursor < chosen.length) {
        const i = cursor++;
        const entry = chosen[i];
        try {
          const sources = await researchSkill(entry.skill, { docsUrl: entry.docs, ctx, pid });
          linfo(pid, `    ✍️  "${entry.skill}" (in ${entry.count} job ad${entry.count === 1 ? '' : 's'})…`);
          const note = await synthesizeSkill(profile, entry, sources, pid);
          drafted[i] = { entry, sources, note };
        } catch (e) {
          lerr(pid, `    ✗ "${entry.skill}": ${String(e?.message || e).slice(0, 120)}`);
          drafted[i] = { entry, sources: [], note: null };
        }
      }
    })
  );

  // ── 4. Persist (sequential — keeps the log readable and writes are cheap). ──
  for (const d of drafted) {
    if (!d || !d.note) continue;
    const { entry, sources, note } = d;

    // Store raw sources so they're inspectable and reusable.
    for (const s of sources) {
      try {
        await run(
          `INSERT INTO prep_sources (id, profile_id, kind, title, url, content, meta, collected_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, collected_at=excluded.collected_at`,
          [sourceRowId(pid, s.url), pid, s.kind, s.title || '', s.url, s.content || '', JSON.stringify({ ...(s.meta || {}), skill: entry.skill }), now]
        );
        sourcesStored++;
      } catch { /* skip bad row */ }
    }

    const body = renderNoteBody(entry.skill, note);

    const id = noteId(pid, 'skill', entry.skill);
    await run(
      `INSERT INTO prep_notes (id, profile_id, topic, kind, title, body, source_ids, created_at, day, evidence, demand, sources_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         body=excluded.body, title=excluded.title, created_at=excluded.created_at, day=excluded.day,
         evidence=excluded.evidence, demand=excluded.demand, sources_json=excluded.sources_json`,
      [
        id, pid, entry.skill, 'skill', entry.skill, body, '[]', now, day,
        entry.evidence || '',
        entry.count,
        JSON.stringify({
          references: sources.map((s, i) => ({
            n: i + 1, kind: s.kind, title: s.title, url: s.url, purpose: s.purpose || 'reference',
          })),
          jobs: entry.jobs,
          docs: entry.docs || '',
        }),
      ]
    );
    written.push({ id, skill: entry.skill, count: entry.count, gap: note.gap });
    lok(pid, `    ✓ "${entry.skill}" — ${note.questions?.length || 0} question(s), ${sources.length} source(s) cited`);
    await indexNote(profile, { id, topic: entry.skill, title: entry.skill, body }).catch(() => {});
  }

  // ── 5. Daily plan ──
  let dailyPlan = null;
  if (written.length) {
    try {
      dailyPlan = await buildDailyPlan(profile, written, pid);
      if (dailyPlan) {
        const body = [
          `## Today's focus — ${dailyPlan.focus || ''}`,
          '',
          dailyPlan.warmup ? `**Warm-up (5 min):** ${dailyPlan.warmup}` : '',
          '',
          Array.isArray(dailyPlan.plan) ? dailyPlan.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') : '',
        ].filter(Boolean).join('\n');
        const id = noteId(pid, 'daily', day);
        await run(
          `INSERT INTO prep_notes (id, profile_id, topic, kind, title, body, source_ids, created_at, day, evidence, demand, sources_json)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET body=excluded.body, created_at=excluded.created_at`,
          [id, pid, dailyPlan.focus || 'Daily plan', 'daily', `Daily plan — ${day}`, body, '[]', now, day, '', 0, '{}']
        );
        await indexNote(profile, { id, topic: 'daily plan', title: `Daily plan ${day}`, body }).catch(() => {});
        lok(pid, `  ✓ Daily plan: ${dailyPlan.focus || '(untitled)'}`);
      }
    } catch (e) {
      lwarn(pid, `  Daily plan failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  }

  delete profile.__ctx;
  return {
    skills: chosen.map((s) => ({ skill: s.skill, count: s.count })),
    notesWritten: written.length,
    dailyPlan,
    sourcesStored,
  };
}
