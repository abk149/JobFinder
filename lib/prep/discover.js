// Technology discovery — decides whether an arbitrary term is a real, studiable
// technology, so the prep engine isn't limited to the curated dictionary.
//
// This replaces the naive "any capitalised word is a skill" heuristic that produced
// German study topics like "Du", "Kunden" and "Umsetzung". Instead of guessing, we
// ask two external authorities and require real evidence:
//
//   1. Stack Overflow TAGS — a curated, human-maintained list of technology names.
//      Excellent recall for modern tooling that Wikipedia lags on (Weaviate,
//      Zustand, Milvus, Ollama all have tags; German prose words do not).
//   2. Wikipedia — good for established concepts, and a strong NEGATIVE signal:
//      common words resolve to disambiguation pages or non-technical articles.
//
// Plus one hard rule: discovered terms must be >= 3 characters. Every real 2-char
// technology (Go, R, C) is already in the curated dictionary, whereas 2-char tokens
// are exactly where false positives live — "du" is both a German pronoun and a Unix
// command with a real Stack Overflow tag, and only the length rule separates them.
//
// Verdicts are cached in the prep_terms table so we probe each term at most once.

import { get, run } from '../db.js';
import { skillNameSet } from './skills.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const MIN_LENGTH = 3;
const MIN_SO_TAG_COUNT = 100;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// NOTE the qualified "language" patterns. A bare /language/ matched the Wikipedia
// article for "The" — which says it is an article "in the English language" — and
// happily classified the definite article as a technology.
const TECH_RE =
  /software|computing|programming|computer|technolog|algorithm|database|framework|protocol|machine learning|artificial intelligence|data science|\blibrary\b|programming language|query language|markup language|scripting language|platform|cloud comput|\bnetwork\b|encryption|\bapi\b|open-source|open source|web development|operating system/;

// Words that are never study topics regardless of what an external API says.
//
// Two classes of false positive make this necessary:
//
//   1. NON-ENGLISH FUNCTION WORDS that collide with real technical terms. German
//      "Die" (the) collides with "die" as in semiconductor dies, which Wikipedia
//      happily describes as technology. Job ads in this app are frequently German,
//      so the common function words of the languages we see must be excluded.
//   2. GENERIC CATEGORY WORDS. "Frontend", "Store", "Cloud" are real technical
//      vocabulary but are not studiable topics — you cannot prepare for an
//      interview on "Store". Specific instances (Redux, S3, Weaviate) are.
const NEVER = new Set([
  // English function words. These reach here because job ads are prose: "This role…",
  // "The team…". Several also have large Stack Overflow tags ("this" → the JavaScript
  // keyword, 6000+ questions), so external validation cannot reject them.
  'the', 'this', 'that', 'these', 'those', 'there', 'their', 'they', 'them', 'then',
  'with', 'from', 'your', 'yours', 'you', 'our', 'ours', 'we', 'us', 'its', 'his', 'her',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'have',
  'has', 'had', 'been', 'being', 'are', 'was', 'were', 'and', 'but', 'for', 'not',
  'all', 'any', 'each', 'every', 'some', 'more', 'most', 'other', 'such', 'both',
  'who', 'what', 'when', 'where', 'why', 'how', 'which', 'while', 'about', 'into',
  'also', 'here', 'very', 'well', 'good', 'great', 'new', 'own', 'out', 'over', 'under',
  'join', 'help', 'work', 'working', 'looking', 'seeking', 'ideal', 'strong', 'plus',
  'apply', 'please', 'note', 'must', 'nice', 'able', 'across', 'within', 'through',
  // Generic business / role nouns
  'business', 'team', 'role', 'company', 'customer', 'customers', 'project', 'projects',
  'experience', 'knowledge', 'skills', 'english', 'german', 'remote', 'office', 'senior',
  'junior', 'lead', 'manager', 'engineer', 'developer', 'consultant', 'analyst', 'intern',
  'client', 'clients', 'partner', 'stakeholder', 'career', 'benefits', 'salary',
  // Job-title words. These survive the sentence-initial filter because they appear
  // mid-sentence ("reports to the Head of Engineering") and several collide with
  // real technical terms ("head" is a Unix command and an HTML element).
  'head', 'chief', 'director', 'president', 'officer', 'principal', 'specialist',
  'coordinator', 'supervisor', 'executive', 'founder', 'owner', 'associate',
  'assistant', 'trainee', 'graduate', 'architect', 'scientist', 'designer', 'position',
  // Generic technical categories — too broad to study
  'frontend', 'front-end', 'backend', 'back-end', 'fullstack', 'full-stack', 'store',
  'cloud', 'framework', 'frameworks', 'database', 'databases', 'server', 'servers',
  'software', 'hardware', 'system', 'systems', 'application', 'applications', 'app',
  'apps', 'code', 'tool', 'tools', 'service', 'services', 'platform', 'library',
  'web', 'mobile', 'desktop', 'internet', 'computer', 'technology', 'development',
  'engineering', 'architecture', 'infrastructure', 'solution', 'solutions', 'product',
  'cluster', 'clusters', 'dashboard', 'dashboards', 'pipeline', 'pipelines', 'workflow',
  'workflows', 'container', 'containers', 'node', 'nodes', 'queue', 'queues', 'cache',
  'index', 'schema', 'migration', 'deployment', 'environment', 'config', 'repository',
  'script', 'scripts', 'module', 'modules', 'package', 'packages', 'version', 'release',
  // German function words + common job-ad nouns (ads here are often German)
  'die', 'der', 'das', 'den', 'dem', 'des', 'und', 'oder', 'für', 'fuer', 'mit', 'von',
  'bei', 'ist', 'sind', 'wir', 'uns', 'dein', 'deine', 'deinen', 'unser', 'unsere',
  'aufgaben', 'kenntnisse', 'erfahrung', 'vorteil', 'betrieb', 'entwicklung', 'projekten',
  'raum', 'umsetzung', 'kunden', 'rolle', 'bereich', 'einsatz', 'arbeit', 'stelle',
  'ein', 'eine', 'einem', 'einer', 'auch', 'sowie', 'durch', 'aber', 'nach', 'über',
  // French / Spanish / Dutch function words seen in EU listings
  'les', 'des', 'une', 'dans', 'pour', 'avec', 'sur', 'nous', 'vous',
  'los', 'las', 'una', 'con', 'para', 'por', 'como',
  'het', 'een', 'van', 'voor', 'met',
  // Region / legal-entity acronyms
  'dach', 'emea', 'apac', 'latam', 'gmbh', 'ltd', 'inc', 'llc', 'plc', 'nyc', 'usa',
  'eur', 'usd', 'gbp', 'ceo', 'cto', 'cfo', 'hr',
]);

async function getJson(url, timeoutMs = 8000) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

/** Stack Overflow tag lookup — the strongest positive signal for "is a technology". */
async function stackOverflowTag(term) {
  const tag = term.toLowerCase().trim().replace(/\s+/g, '-');
  const j = await getJson(`https://api.stackexchange.com/2.3/tags/${encodeURIComponent(tag)}/info?site=stackoverflow`);
  const item = (j?.items || [])[0];
  if (!item) return { hit: false };
  return { hit: (item.count || 0) >= MIN_SO_TAG_COUNT, count: item.count || 0 };
}

/** Wikipedia lookup — positive for established tech, and a reliable negative filter. */
async function wikipediaTech(term) {
  const j = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.trim().replace(/\s+/g, '_'))}`);
  if (!j) return { hit: false };
  if (String(j.type || '').includes('disambiguation')) return { hit: false, disambiguation: true };
  const text = `${j.extract || ''} ${j.description || ''}`.toLowerCase();
  return {
    hit: TECH_RE.test(text),
    description: (j.description || j.extract || '').slice(0, 160),
    url: j.content_urls?.desktop?.page || '',
  };
}

/**
 * Is `term` a real, studiable technology?
 * @returns { isTech, reason, description, docsHint }
 */
// Words that carry a real Stack Overflow tag but are, in a job ad, ordinary English.
//
// Measured on this database: "drive" is an SO tag with 904 questions, "build" with
// 23,638, plus "global", "operations", "hybrid". Job ads are written in imperatives —
// "Drive adoption", "Build the roadmap", "Own delivery" — so external validation alone
// happily promotes a verb into a study topic. That is how a study note titled "Drive"
// got written.
//
// These are only rejected when they are NOT in the curated skills dictionary, so a term
// that is genuinely both (e.g. a product actually named after a common word) still gets
// through by being listed there explicitly.
// Lazily built lowercase view of the curated dictionary — a term listed there is a
// deliberate decision and outranks the prose guard.
let _curated = null;
function curatedNames() {
  if (_curated) return _curated;
  try { _curated = new Set([...skillNameSet()].map((x) => String(x).toLowerCase())); }
  catch { _curated = new Set(); }
  return _curated;
}

const PROSE_UNLESS_CURATED = new Set([
  // imperative verbs that open JD bullets
  'drive', 'build', 'own', 'lead', 'leads', 'deliver', 'manage', 'support', 'ensure',
  'develop', 'design', 'create', 'execute', 'collaborate', 'partner', 'champion',
  'shape', 'scale', 'grow', 'run', 'define', 'drives', 'driving', 'building', 'owning',
  'maintain', 'improve', 'optimize', 'optimise', 'coordinate', 'facilitate', 'monitor',
  'report', 'present', 'communicate', 'influence', 'mentor', 'coach', 'enable',
  // business nouns that double as tags
  'global', 'operations', 'operation', 'hybrid', 'growth', 'strategy', 'impact',
  'stakeholder', 'stakeholders', 'delivery', 'quality', 'process', 'processes',
  'planning', 'roadmap', 'budget', 'vendor', 'client', 'clients', 'customer',
  'customers', 'business', 'team', 'teams', 'project', 'projects', 'product',
  'products', 'service', 'services', 'solution', 'solutions', 'experience',
  'knowledge', 'ability', 'skills', 'role', 'roles', 'requirements', 'responsibilities',
]);

export async function classifyTerm(term, { curated = null } = {}) {
  const clean = String(term || '').trim();
  const key = clean.toLowerCase();

  if (clean.length < MIN_LENGTH) return { isTech: false, reason: `shorter than ${MIN_LENGTH} chars` };
  if (NEVER.has(key)) return { isTech: false, reason: 'generic business word' };
  if (PROSE_UNLESS_CURATED.has(key) && !(curated && curated.has(key))) {
    return { isTech: false, reason: 'ordinary job-ad English (SO tag notwithstanding)' };
  }
  if (!/[a-z]/i.test(clean)) return { isTech: false, reason: 'no letters' };

  // Cached verdict?
  try {
    const row = await get('SELECT * FROM prep_terms WHERE term = ?', [key]);
    if (row && Date.now() - (row.checked_at || 0) < CACHE_TTL_MS) {
      return {
        isTech: !!row.is_tech,
        reason: row.reason || 'cached',
        description: row.description || '',
        docsHint: row.docs_hint || '',
        cached: true,
      };
    }
  } catch { /* table may not exist yet on a very old db */ }

  const [so, wiki] = await Promise.all([
    stackOverflowTag(clean).catch(() => ({ hit: false })),
    wikipediaTech(clean).catch(() => ({ hit: false })),
  ]);

  let isTech = false;
  let reason;
  if (so.hit) { isTech = true; reason = `Stack Overflow tag (${so.count} questions)`; }
  else if (wiki.hit) { isTech = true; reason = 'Wikipedia describes it as technology'; }
  else if (wiki.disambiguation) { reason = 'Wikipedia disambiguation page'; }
  else { reason = 'no Stack Overflow tag and not described as technology'; }

  const verdict = {
    isTech,
    reason,
    description: wiki.description || '',
    docsHint: wiki.url || '',
  };

  try {
    await run(
      `INSERT INTO prep_terms (term, is_tech, reason, description, docs_hint, checked_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(term) DO UPDATE SET
         is_tech=excluded.is_tech, reason=excluded.reason, description=excluded.description,
         docs_hint=excluded.docs_hint, checked_at=excluded.checked_at`,
      [key, isTech ? 1 : 0, reason, verdict.description, verdict.docsHint, Date.now()]
    );
  } catch { /* cache write is best-effort */ }

  return verdict;
}

/** Classify many terms with bounded concurrency. Returns only the technologies. */
export async function filterToTechnologies(terms, { concurrency = 4, onVerdict = null } = {}) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, terms.length) }, async () => {
      while (i < terms.length) {
        const idx = i++;
        const t = terms[idx];
        const v = await classifyTerm(typeof t === 'string' ? t : t.term, { curated: curatedNames() })
          .catch(() => ({ isTech: false, reason: 'error' }));
        if (onVerdict) onVerdict(t, v);
        if (v.isTech) out.push({ ...(typeof t === 'string' ? { term: t } : t), ...v });
      }
    })
  );
  return out;
}
