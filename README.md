# JobFinder

A local-first job-application assistant. It scans 19 job boards, scores each posting
against your CV, fills in application forms from an answer bank you approve, and builds
evidence-based interview prep from the job descriptions you actually saved.

Everything runs on your own machine. Your CV, answers, cookies and database never leave
it — there is no server component and no account.

```
Scan 19 sources  →  Score fit  →  Apply + autofill  →  Track pipeline  →  Interview prep
```

## Why it exists

Applying to jobs is mostly repetition: the same twenty answers typed into forms that all
ask slightly different questions, on sites that increasingly resist automation. JobFinder
does the repetition, learns from what you type, and stays out of the way when a site asks
you to prove you're human.

## What it does

**Finding work**
- 21 connectors: Arbeitnow, Bluesky, Hacker News, Himalayas, Jobicy, Jobspresso,
  LinkedIn, LinkedIn Posts, Naukri, NoDesk, Otta, Psychology, Reddit, RemoteOK,
  Remotive, TechStartups, The Muse, Wellfound, We Work Remotely, Working Nomads,
  Y Combinator
- **Paste any link** — a posting from a site JobFinder doesn't scan becomes a normal
  job: opened in your browser, read via schema.org JobPosting data (LLM fallback when
  a page has none), then filled like any other
- **Fit scoring** — ranks every posting against your CV, skills and locations.
  Deterministic and instant; no LLM
- **Fresh this week** — everything posted in the last N days across all sources, newest
  first, with an honest distinction between "the source published this date" and
  "this is when we first saw it"
- Cross-board de-duplication: the same role scraped from four sites collapses to one
- **Hiring-contact directory** — addresses that ads publish themselves ("send your CV
  to …") are captured during scanning into an editable, CSV-exportable directory with
  company and, where stated, name and designation

**Applying**
- **Answer bank** — captures what you type into application forms and replays it. New
  captures land in a **review queue** and are invisible to autofill until you approve them
- **Autofill** with three modes: bank-only, bank-then-LLM, or LLM-for-everything
- **In-page toolbar** — a floating widget with hotkeys on the application itself, so you
  never have to go back to the dashboard mid-form
- **CV variants** — keep several CVs, and the best match for each posting is scored and
  attached automatically
- **Cover letters** — a base template with placeholders, plus per-job letters written
  from that posting's description and your best-matching CV

**After applying**
- Pipeline tracker with stages, follow-up reminders and a funnel view
- **Mailbox (optional)** — recruiter replies are pulled in, matched to the job they're
  about, and the specific things HR asks you for are listed separately so none gets
  buried in a paragraph. One click moves the job to the stage the mail implies.
  Connect with an app password (2 minutes, works with Gmail/Outlook/Yahoo/iCloud) or
  Google OAuth. Paste-in still works and stores nothing
- **Interview prep** — reads your saved job descriptions, extracts the skills actually
  demanded, researches each one, and writes study notes with mental models, trade-offs,
  real numbers, level-by-level answers and cited sources
- Ask-anything Q&A over the prep knowledge base

## Privacy

This is the design constraint, not a footnote.

- **Local only.** SQLite on disk, Ollama on localhost. No telemetry, no cloud calls except
  to the job boards themselves and the sources prep cites
- **`data/` is gitignored in full** — database, résumés, cover letters, browser profiles,
  cookies. Nothing personal is in this repository, and nothing you add will be
- **Mail access is narrow.** Every sync runs a search built from your own applied
  companies — unrelated mail is never requested, downloaded or stored. OAuth uses the
  read-only `gmail.readonly` scope; an app password grants full mailbox access but
  JobFinder only ever reads. Credentials live in `data/gmail.json` / `data/mail.json`,
  mode 0600, gitignored, and are revocable from your Google account page
- **The contact directory only reads text already fetched** for a posting. Nothing is
  crawled to find addresses, and none is ever guessed from a name-and-domain pattern.
  Job-seeker posts and staffing-vendor pitches are filtered out
- **Sensitive fields are never captured.** Passwords, CVV, SSN, OTP and similar are
  excluded at the point of capture, before anything is stored
- **Honeypots and CAPTCHAs are never filled.** Completing an invisible field is a
  self-inflicted bot verdict

## Requirements

- **Node.js 20+**
- **Google Chrome** (real Chrome, not just the bundled Chromium)
- **[Ollama](https://ollama.com)** for the local LLM — optional, but autofill drafting,
  cover letters and interview prep need it

## Quick start

```bash
git clone https://github.com/abk149/JobFinder.git
cd JobFinder
npm install
ollama pull qwen2.5:7b-instruct
ollama pull nomic-embed-text
npm run build
npm start
```

Open <http://localhost:3737>.

Full instructions, including model choice and the browser-session model, are in
**[SETUP.md](SETUP.md)**. How to actually use it day to day is in
**[USER_MANUAL.md](USER_MANUAL.md)**.

## How it works

**Lazy attach.** Chrome runs with a debugging port but *no* automation client connected.
When you press Autofill, JobFinder attaches for a couple of seconds, fills, and detaches.
The window you get verified in has nothing attached to it.

**Anti-detection.** Uses `rebrowser-playwright`, which avoids the `Runtime.enable` CDP
call that commercial bot-detectors fingerprint, plus an init script covering
`navigator.webdriver`, plugin identity, WebGL vendor and the `chrome.*` surface.
`scripts/test-stealth.mjs` asserts 23 fingerprint probes.

**Retrieval.** Answers are matched by exact key first, then by cosine similarity over
`nomic-embed-text` embeddings, and only then handed to the LLM — which is told to return
a literal `[BLANK]` rather than invent a phone number.

## Project layout

```
app/            Next.js App Router — UI (app/page.jsx) and API routes (app/api/*)
connectors/     One module per job board; each exports scan() and apply()
lib/            Core: browser control, autofill, answer bank, retrieval, cover letters
lib/prep/       Interview prep: skill extraction, research, synthesis, Q&A
scripts/        Launcher install, Windows packaging, stealth + data-hygiene checks
data/           Local state. Gitignored in full. Created on first run
```

## Useful commands

```bash
npm run dev                              # dev server on :3737
npm run build && npm start               # production
node scripts/test-stealth.mjs            # 23 anti-detection probes
node scripts/clean-answer-bank.mjs       # audit the answer bank (dry run)
node scripts/check-canon-parity.mjs      # field-key canonicaliser parity check
npm run install-launcher                 # desktop launcher (macOS)
```

## Status and honest limitations

Built for one person's job search, then generalised. Expect rough edges.

- **Site markup changes break scrapers.** LinkedIn's content search now uses per-build
  hashed class names; that connector reads structure instead, and returns author profile
  links because post permalinks are no longer in the DOM
- **Naukri and LinkedIn Posts need a logged-in session.** Use *Open & log in* on those
  sources first; they fail fast with instructions rather than hanging
- **Local models are slow.** A full interview-prep refresh is roughly 40 minutes on an
  8B model. It runs one skill at a time and writes each note as it completes
- **Reasoning models are the wrong tool for structured output.** `deepseek-r1` spends its
  token budget inside `<think>` before emitting JSON. Use an instruct model for synthesis;
  the app auto-selects one if installed

## Licence

MIT — see [LICENSE](LICENSE).

Use it on your own applications. Respect each site's terms of service; you are
responsible for how you use it.
