// Skill extraction — the evidence layer of the prep engine.
//
// DESIGN: curated dictionary ONLY. There is deliberately no "guess at unknown
// capitalised words" fallback.
//
// That fallback existed and was a disaster: German job ads capitalise every noun, so
// it produced study topics like "Du" (you), "Deine" (your), "Kunden" (customers),
// "Rolle" (role) and "Umsetzung" (implementation). An English stopword list cannot
// fix that, because the problem is unbounded — every language, every proper noun,
// every product name in every ad. Precision beats recall here: a missed niche tool
// costs one topic; a garbage topic costs the user's trust and ~5 minutes of LLM time.
//
// Each entry is a genuinely STUDIABLE concept — something you can be interviewed on
// and can go learn. Broad fields ("AI", "Business", "Software") are explicitly
// excluded: "study AI" is not an actionable topic, "study RAG" is.

import { all } from '../db.js';
import { htmlToText } from '../../connectors/_util.js';
import { filterToTechnologies } from './discover.js';
import { linfo, lok, lwarn } from '../logger.js';

const MAX_JOBS_TO_READ = 20;
const JD_EXCERPT = 9000;
// Discovery tuning. Validation (Stack Overflow tag + Wikipedia) is the real filter,
// so we only need the ad-count to bound how many terms we bother checking — not to
// judge quality. Requiring 2+ ads was too strict: a user with a handful of saved
// jobs would never discover a technology mentioned in just one of them.
// Verdicts are cached in prep_terms, so repeat refreshes cost nothing.
const DISCOVERY_MIN_ADS = 1;
const DISCOVERY_MAX_CANDIDATES = 30;

// ── Curated skill dictionary ────────────────────────────────────────────────
//
//   aliases : phrases to match, case-insensitive, word-boundary anchored.
//   docs    : canonical place to actually LEARN it (official docs / primary source).
//
// Adding a skill: pick something an interviewer could ask a real question about.
export const SKILLS = {
  // ── AI / LLM engineering ────────────────────────────────────────────────
  'RAG (Retrieval-Augmented Generation)': {
    aliases: ['rag', 'retrieval augmented generation', 'retrieval-augmented'],
    docs: 'https://www.pinecone.io/learn/retrieval-augmented-generation/',
  },
  'Model Context Protocol (MCP)': {
    aliases: ['model context protocol', 'mcp'],
    docs: 'https://modelcontextprotocol.io/docs/getting-started/intro',
  },
  'Fine-tuning LLMs': {
    aliases: ['fine-tuning', 'fine tuning', 'finetuning', 'lora', 'qlora', 'peft'],
    docs: 'https://huggingface.co/docs/peft/index',
  },
  'Prompt Engineering': {
    aliases: ['prompt engineering', 'prompting', 'few-shot', 'chain of thought'],
    docs: 'https://www.promptingguide.ai/',
  },
  'Vector Databases': {
    aliases: ['vector database', 'vector db', 'pinecone', 'weaviate', 'qdrant', 'chroma', 'pgvector', 'faiss'],
    docs: 'https://www.pinecone.io/learn/vector-database/',
  },
  'Embeddings': {
    aliases: ['embedding', 'embeddings', 'semantic search', 'sentence transformers'],
    docs: 'https://huggingface.co/blog/getting-started-with-embeddings',
  },
  'LLM Agents': {
    aliases: ['ai agent', 'agentic', 'llm agent', 'autonomous agent', 'tool calling', 'function calling'],
    docs: 'https://www.anthropic.com/engineering/building-effective-agents',
  },
  'LangChain': { aliases: ['langchain', 'langgraph'], docs: 'https://python.langchain.com/docs/introduction/' },
  'LlamaIndex': { aliases: ['llamaindex', 'llama index'], docs: 'https://docs.llamaindex.ai/' },
  'Model Evaluation': {
    aliases: ['model evaluation', 'evals', 'benchmarking models', 'hallucination'],
    docs: 'https://huggingface.co/docs/evaluate/index',
  },
  'MLOps': { aliases: ['mlops', 'llmops', 'model deployment', 'model serving', 'mlflow'], docs: 'https://ml-ops.org/' },
  'Transformers': { aliases: ['transformer', 'transformers', 'attention mechanism', 'bert', 'gpt architecture'], docs: 'https://huggingface.co/docs/transformers/index' },
  'Machine Learning': { aliases: ['machine learning', 'supervised learning', 'unsupervised learning'], docs: 'https://scikit-learn.org/stable/user_guide.html' },
  'Deep Learning': { aliases: ['deep learning', 'neural network'], docs: 'https://www.deeplearningbook.org/' },
  'NLP': { aliases: ['nlp', 'natural language processing'], docs: 'https://huggingface.co/learn/nlp-course' },
  'Computer Vision': { aliases: ['computer vision', 'opencv', 'image recognition'], docs: 'https://opencv.org/' },
  'PyTorch': { aliases: ['pytorch'], docs: 'https://pytorch.org/tutorials/' },
  'TensorFlow': { aliases: ['tensorflow', 'keras'], docs: 'https://www.tensorflow.org/tutorials' },
  'scikit-learn': { aliases: ['scikit-learn', 'sklearn'], docs: 'https://scikit-learn.org/stable/' },

  // ── Languages ───────────────────────────────────────────────────────────
  // NOTE: single-letter languages need a qualifier. Matching a bare "R" or "C"
  // produced 9 false hits per ad before this rule existed.
  'R (statistics)': { aliases: ['r programming', 'r language', 'rstudio', 'r/shiny'], docs: 'https://cran.r-project.org/manuals.html' },
  'C': { aliases: ['c programming', 'c language'], docs: 'https://en.cppreference.com/w/c' },
  'Go': { aliases: ['golang', 'go programming'], docs: 'https://go.dev/doc/' },
  'Python': { aliases: ['python'], docs: 'https://docs.python.org/3/' },
  'JavaScript': { aliases: ['javascript'], docs: 'https://developer.mozilla.org/en-US/docs/Web/JavaScript' },
  'TypeScript': { aliases: ['typescript'], docs: 'https://www.typescriptlang.org/docs/' },
  'Java': { aliases: ['java'], docs: 'https://docs.oracle.com/en/java/' },
  'C++': { aliases: ['c\\+\\+', 'cpp'], docs: 'https://en.cppreference.com/' },
  'C#': { aliases: ['c#', 'csharp', '\\.net'], docs: 'https://learn.microsoft.com/en-us/dotnet/csharp/' },
  'Rust': { aliases: ['rust'], docs: 'https://doc.rust-lang.org/book/' },
  'Ruby': { aliases: ['ruby on rails', 'ruby'], docs: 'https://www.ruby-lang.org/en/documentation/' },
  'Scala': { aliases: ['scala'], docs: 'https://docs.scala-lang.org/' },
  'Kotlin': { aliases: ['kotlin'], docs: 'https://kotlinlang.org/docs/home.html' },
  'SQL': { aliases: ['sql queries', 'sql'], docs: 'https://www.postgresql.org/docs/current/sql.html' },

  // ── Data stores ─────────────────────────────────────────────────────────
  'PostgreSQL': { aliases: ['postgresql', 'postgres'], docs: 'https://www.postgresql.org/docs/' },
  'MySQL': { aliases: ['mysql'], docs: 'https://dev.mysql.com/doc/' },
  'MongoDB': { aliases: ['mongodb'], docs: 'https://www.mongodb.com/docs/' },
  'Redis': { aliases: ['redis'], docs: 'https://redis.io/docs/latest/' },
  'Elasticsearch': { aliases: ['elasticsearch', 'opensearch'], docs: 'https://www.elastic.co/guide/index.html' },
  'Snowflake': { aliases: ['snowflake'], docs: 'https://docs.snowflake.com/' },
  'BigQuery': { aliases: ['bigquery'], docs: 'https://cloud.google.com/bigquery/docs' },
  'Databricks': { aliases: ['databricks'], docs: 'https://docs.databricks.com/' },

  // ── Infra / cloud ───────────────────────────────────────────────────────
  'Kubernetes': { aliases: ['kubernetes', 'k8s'], docs: 'https://kubernetes.io/docs/home/' },
  'Docker': { aliases: ['docker', 'containeriz'], docs: 'https://docs.docker.com/' },
  'Terraform': { aliases: ['terraform', 'infrastructure as code'], docs: 'https://developer.hashicorp.com/terraform/docs' },
  'AWS': { aliases: ['aws', 'amazon web services'], docs: 'https://docs.aws.amazon.com/' },
  'Azure': { aliases: ['azure'], docs: 'https://learn.microsoft.com/en-us/azure/' },
  'GCP': { aliases: ['gcp', 'google cloud platform'], docs: 'https://cloud.google.com/docs' },
  'CI/CD': { aliases: ['ci/cd', 'continuous integration', 'continuous deployment'], docs: 'https://docs.github.com/en/actions' },
  'Linux': { aliases: ['linux'], docs: 'https://tldp.org/guides.html' },

  // ── Architecture / distributed systems ──────────────────────────────────
  'Distributed Systems': { aliases: ['distributed system'], docs: 'https://martinfowler.com/architecture/' },
  'Microservices': { aliases: ['microservice'], docs: 'https://microservices.io/patterns/index.html' },
  'System Design': { aliases: ['system design', 'systems design', 'solution architecture'], docs: 'https://github.com/donnemartin/system-design-primer' },
  'REST APIs': { aliases: ['rest api', 'restful'], docs: 'https://developer.mozilla.org/en-US/docs/Web/HTTP' },
  'GraphQL': { aliases: ['graphql'], docs: 'https://graphql.org/learn/' },
  'gRPC': { aliases: ['grpc'], docs: 'https://grpc.io/docs/' },
  'Kafka': { aliases: ['kafka'], docs: 'https://kafka.apache.org/documentation/' },
  'Event-Driven Architecture': { aliases: ['event-driven', 'event driven', 'event sourcing', 'pub/sub'], docs: 'https://martinfowler.com/articles/201701-event-driven.html' },
  'Idempotency': { aliases: ['idempotent', 'idempotency'], docs: 'https://stripe.com/docs/api/idempotent_requests' },
  'Caching': { aliases: ['caching strategy', 'cache invalidation', 'caching'], docs: 'https://aws.amazon.com/caching/best-practices/' },
  'Observability': { aliases: ['observability', 'distributed tracing', 'opentelemetry'], docs: 'https://opentelemetry.io/docs/' },
  'SLOs': { aliases: ['slo', 'service level objective', 'error budget'], docs: 'https://sre.google/workbook/implementing-slos/' },
  'Incident Response': { aliases: ['incident response', 'on-call', 'postmortem'], docs: 'https://response.pagerduty.com/' },
  'Scalability': { aliases: ['scalability', 'high throughput', 'horizontal scaling'], docs: 'https://github.com/donnemartin/system-design-primer#scalability' },

  // ── Data engineering ────────────────────────────────────────────────────
  'ETL / ELT': { aliases: ['etl', 'elt', 'data pipeline'], docs: 'https://docs.getdbt.com/docs/introduction' },
  'Apache Spark': { aliases: ['spark', 'pyspark'], docs: 'https://spark.apache.org/docs/latest/' },
  'Airflow': { aliases: ['airflow', 'dagster', 'prefect'], docs: 'https://airflow.apache.org/docs/' },
  'dbt': { aliases: ['dbt'], docs: 'https://docs.getdbt.com/' },
  'Data Modelling': { aliases: ['data model', 'dimensional model', 'star schema'], docs: 'https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/' },
  'A/B Testing': { aliases: ['a/b test', 'ab testing', 'experimentation'], docs: 'https://www.evanmiller.org/ab-testing/' },
  'Statistics': { aliases: ['statistical analysis', 'statistics', 'hypothesis testing'], docs: 'https://www.statlearning.com/' },

  // ── Frontend ────────────────────────────────────────────────────────────
  'React': { aliases: ['react', 'reactjs'], docs: 'https://react.dev/learn' },
  'Next.js': { aliases: ['next.js', 'nextjs'], docs: 'https://nextjs.org/docs' },
  'Vue': { aliases: ['vue.js', 'vuejs'], docs: 'https://vuejs.org/guide/introduction.html' },
  'Angular': { aliases: ['angular'], docs: 'https://angular.dev/overview' },

  // ── Security ────────────────────────────────────────────────────────────
  'OAuth / OIDC': { aliases: ['oauth', 'oidc', 'openid connect', 'sso'], docs: 'https://oauth.net/2/' },
  'Encryption': { aliases: ['encryption', 'cryptography', 'tls'], docs: 'https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html' },
  'Application Security': { aliases: ['appsec', 'owasp', 'application security', 'penetration testing'], docs: 'https://owasp.org/www-project-top-ten/' },
  'GDPR / Data Privacy': { aliases: ['gdpr', 'data privacy', 'dsgvo'], docs: 'https://gdpr-info.eu/' },

  // ── Enterprise / ERP (present in this user's saved roles) ───────────────
  'Workday': { aliases: ['workday'], docs: 'https://doc.workday.com/' },
  'SAP': { aliases: ['sap'], docs: 'https://help.sap.com/' },
  'Salesforce': { aliases: ['salesforce'], docs: 'https://developer.salesforce.com/docs' },
  'Robotic Process Automation': { aliases: ['rpa', 'uipath', 'robotic process automation', 'power automate'], docs: 'https://learn.microsoft.com/en-us/power-automate/' },

  // ── Engineering practice ────────────────────────────────────────────────
  'Testing & TDD': { aliases: ['unit test', 'test-driven', 'tdd', 'integration testing'], docs: 'https://martinfowler.com/testing/' },
  'Git': { aliases: ['git', 'version control'], docs: 'https://git-scm.com/doc' },
  'Agile / Scrum': { aliases: ['agile', 'scrum', 'kanban'], docs: 'https://scrumguides.org/' },

  // ── Psychology / clinical (the other profile shape this app supports) ───
  'CBT': { aliases: ['cbt', 'cognitive behavioural therapy', 'cognitive behavioral therapy'], docs: 'https://www.apa.org/ptsd-guideline/patients-and-families/cognitive-behavioral' },
  'Psychological Assessment': { aliases: ['psychological assessment', 'psychometric'], docs: 'https://www.apa.org/science/programs/testing' },
  'Clinical Supervision': { aliases: ['clinical supervision'], docs: 'https://www.apa.org/education-career/grad/supervision' },
  'Trauma-Informed Care': { aliases: ['trauma-informed', 'trauma informed'], docs: 'https://www.samhsa.gov/resource/dbhis/samhsas-concept-trauma-guidance-trauma-informed-approach' },
  'DSM-5': { aliases: ['dsm-5', 'dsm 5'], docs: 'https://www.psychiatry.org/psychiatrists/practice/dsm' },
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Precompile one regex per skill. Every alias must be >= 2 chars — single letters
// match far too much (a bare /r/ matched 9 times per German ad).
const SKILL_PATTERNS = Object.entries(SKILLS)
  .map(([canonical, def]) => {
    const terms = (def.aliases || [])
      .filter((a) => a.replace(/\\/g, '').length >= 2)
      .map((a) => (a.includes('\\') ? a : escapeRe(a)));
    if (!terms.length) return null;
    return {
      canonical,
      docs: def.docs || '',
      re: new RegExp(`(?<![a-z0-9])(?:${terms.join('|')})(?![a-z0-9])`, 'i'),
    };
  })
  .filter(Boolean);

/**
 * Match the curated dictionary against ONE block of text.
 *
 * Shared by fit scoring (job description vs CV) and CV tailoring, so a skill is
 * recognised identically everywhere — the same "Kubernetes" that puts a topic on
 * your study list is the one matched against your CV.
 *
 * Dictionary-only (no discovery) because callers compare two texts and need the
 * comparison to be fast, deterministic, and free of network calls.
 *
 * @returns [{ skill, docs, evidence }]
 */
export function matchSkillsInText(text, { withEvidence = false } = {}) {
  const t = String(text || '');
  if (t.length < 20) return [];
  const out = [];
  for (const { canonical, re, docs } of SKILL_PATTERNS) {
    if (!re.test(t)) continue;
    out.push({ skill: canonical, docs, evidence: withEvidence ? findEvidence(t, re) : '' });
  }
  return out;
}

/** Just the skill names, lowercased — convenient for set operations. */
export function skillNameSet(text) {
  return new Set(matchSkillsInText(text).map((s) => s.skill.toLowerCase()));
}

/** Find the sentence mentioning the skill, so the user sees the verbatim requirement. */
function findEvidence(text, re) {
  for (const s of String(text || '').split(/(?<=[.!?;])\s+|\n+/)) {
    if (re.test(s)) {
      const t = s.trim().replace(/\s+/g, ' ');
      if (t.length > 15) return t.slice(0, 260);
    }
  }
  return '';
}

/**
 * Read the profile's saved jobs and return the ranked, evidence-backed skill list.
 * @returns [{ skill, count, jobs:[{title,company,url}], evidence, docs }]
 */
export async function extractSkillsFromJobs(profile, { limit = MAX_JOBS_TO_READ } = {}) {
  const pid = profile.id;
  const jobs = await all(
    `SELECT id, title, company, url, description FROM jobs
      WHERE profile_id = ? AND description IS NOT NULL AND LENGTH(description) > 150
      ORDER BY discovered_at DESC LIMIT ?`,
    [pid, limit]
  );

  if (!jobs.length) {
    lwarn(pid, '  No saved jobs with descriptions — run a Scan first so prep has real requirements to read.');
    return [];
  }
  linfo(pid, `  Reading ${jobs.length} job description(s) against ${SKILL_PATTERNS.length} known skills…`);

  const agg = new Map();
  for (const job of jobs) {
    const jd = htmlToText(job.description, JD_EXCERPT);
    if (jd.length < 100) continue;
    for (const { canonical, re, docs } of SKILL_PATTERNS) {
      if (!re.test(jd)) continue;
      let e = agg.get(canonical);
      if (!e) { e = { skill: canonical, count: 0, jobs: [], evidence: '', docs }; agg.set(canonical, e); }
      e.count++;
      if (!e.jobs.some((j) => j.title === job.title && j.company === job.company)) {
        e.jobs.push({ title: job.title, company: job.company || '', url: job.url || '' });
      }
      if (!e.evidence) e.evidence = findEvidence(jd, re);
    }
  }

  // ── Discovery: technologies the dictionary doesn't know yet ───────────────
  //
  // The dictionary is a starting point, not a ceiling. We collect capitalised /
  // acronym-ish candidates that the dictionary missed and appear in several ads,
  // then VALIDATE each against Stack Overflow tags + Wikipedia (see discover.js).
  // Only terms an external authority recognises as a technology get through, which
  // is what keeps German prose words like "Umsetzung" out.
  const discovered = await discoverUnknownSkills(jobs, agg, pid);
  for (const d of discovered) agg.set(d.skill, d);

  const ranked = [...agg.values()].sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill));
  lok(pid, `  ${ranked.length} skill(s) across ${jobs.length} job description(s)` +
    (discovered.length ? ` (${discovered.length} newly discovered)` : ''));
  if (ranked.length) {
    linfo(pid, `  Most demanded: ${ranked.slice(0, 8).map((s) => `${s.skill}(${s.count})`).join(', ')}`);
  } else {
    lwarn(pid, '  No skills matched — these ads may be in a domain not covered yet.');
  }
  return ranked;
}

// Candidate tokens for discovery: CamelCase / ALLCAPS / dotted names, i.e. the shape
// product names take. Deliberately permissive — discover.js does the real filtering.
const CANDIDATE_RE = /\b([A-Z][a-zA-Z0-9]{2,}(?:\.[a-z]{2,})?|[A-Z]{3,8})\b/g;

/**
 * Is this match capitalised only because it starts a sentence?
 *
 * This is the structural defence against prose words entering the skill list.
 * "The" and "This" are capitalised ONLY at sentence start; real product names like
 * "Weaviate" or "Kubernetes" also appear capitalised mid-sentence. Requiring at
 * least one mid-sentence occurrence eliminates an entire class of noise that no
 * stopword list could ever fully cover — and it's needed, because Stack Overflow
 * genuinely has a "this" tag with 6000+ questions (the JavaScript keyword), so
 * external validation alone cannot reject it.
 */
function isSentenceInitial(text, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return true;                       // start of the document
  return /[.!?:;•\-–—*)\]]/.test(text[i]);      // after terminator or list bullet
}

async function discoverUnknownSkills(jobs, known, pid) {
  const knownLower = new Set();
  for (const k of known.keys()) {
    knownLower.add(k.toLowerCase());
    for (const w of k.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 2) knownLower.add(w);
  }

  // Count candidates by how many DISTINCT ads mention them.
  const adCounts = new Map();     // token -> Set(jobIndex)
  const midSentence = new Set();  // tokens seen capitalised mid-sentence at least once
  const evidenceFor = new Map();
  jobs.forEach((job, idx) => {
    const jd = htmlToText(job.description, JD_EXCERPT);
    const seenHere = new Set();
    for (const m of jd.matchAll(CANDIDATE_RE)) {
      const tok = m[1];
      const lower = tok.toLowerCase();
      if (knownLower.has(lower)) continue;
      if (!isSentenceInitial(jd, m.index)) midSentence.add(lower);
      if (seenHere.has(lower)) continue;
      seenHere.add(lower);
      if (!adCounts.has(tok)) adCounts.set(tok, new Set());
      adCounts.get(tok).add(idx);
      if (!evidenceFor.has(tok)) {
        evidenceFor.set(tok, { evidence: findEvidence(jd, new RegExp(`\\b${escapeRe(tok)}\\b`)), job });
      }
    }
  });

  // Drop anything only ever capitalised at the start of a sentence.
  for (const tok of [...adCounts.keys()]) {
    if (!midSentence.has(tok.toLowerCase())) adCounts.delete(tok);
  }

  const candidates = [...adCounts.entries()]
    .filter(([, ads]) => ads.size >= DISCOVERY_MIN_ADS)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, DISCOVERY_MAX_CANDIDATES)
    .map(([term, ads]) => ({ term, ads }));

  if (!candidates.length) return [];
  linfo(pid, `  Validating ${candidates.length} unknown term(s) against Stack Overflow / Wikipedia…`);

  const accepted = await filterToTechnologies(candidates, { concurrency: 4 });
  const rejected = candidates.length - accepted.length;
  if (rejected) linfo(pid, `  Rejected ${rejected} non-technology term(s).`);

  return accepted.map((a) => {
    const ev = evidenceFor.get(a.term) || {};
    const jobsFor = [...a.ads].map((i) => jobs[i]).filter(Boolean);
    return {
      skill: a.term,
      count: a.ads.size,
      jobs: jobsFor.map((j) => ({ title: j.title, company: j.company || '', url: j.url || '' })),
      evidence: ev.evidence || '',
      docs: a.docsHint || '',
      discovered: true,
    };
  });
}
