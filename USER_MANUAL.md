# User manual

Assumes you've finished [SETUP.md](SETUP.md).

---

## The daily loop

```
Scan  →  Score fit  →  Apply  →  Autofill  →  Approve what it learned  →  Track  →  Prep
```

Ten minutes of scanning and triage in the morning; the rest is applying.

---

## 1. Finding jobs

### Scanning

**Jobs tab → 🔍 Scan All Sources.** Runs all 19 connectors, most in parallel. The
terminal panel at the bottom narrates each one, and is precise about outcomes:

| Line | Meaning |
|---|---|
| `✓ source: 3 new — 30 matched` | 30 matched your keywords, 3 hadn't been seen before |
| `= source: 12 match(es), all already saved` | Working; nothing new since last scan |
| `– source: offered 45, none matched your keywords` | Working; your keywords are too narrow |
| `– source: returned nothing` | Source is down or blocking |
| `✗ source: <instructions>` | Needs action — usually a login |

That distinction matters: "none matched" is a *you* problem, "returned nothing" is a
*site* problem.

### Fresh this week

The blue **🔥 Fresh** card shows everything from the last 1/3/7/14 days across all
sources, newest first. It ignores the filters below it deliberately — it answers "what
appeared since I last looked?"

About a quarter of postings carry no publication date (Naukri, Wellfound, Y Combinator
and LinkedIn job cards don't publish one). Rather than pretend, each row states its basis:

- **green "posted"** — the source published this date
- **grey "first seen"** — we're inferring from when the scan found it

Tick **confirmed dates only** to see just the first kind.

### Pasting a link

Not every job arrives through a connector. **Jobs tab → 🔗 Paste a job link** takes any
URL — a friend's link, a newsletter, a company careers page — and turns it into a normal
job row.

| Button | What happens |
|---|---|
| **Import + Autofill** | Opens it, reads it, fills from your bank then the LLM |
| **Import + LLM Fill** | Same, but the LLM attempts every field |
| **Import only** | Adds it to your list and opens it; you fill when ready |

It opens in **your** Chrome, so a posting behind a login or a bot check reads exactly as
it does for you. Details come from the page's schema.org `JobPosting` data where present
— that's what Google indexes, so most boards and every major ATS emit it — and the LLM
reads the page text when they don't.

Once imported it's an ordinary job: fit scoring, CV matching, cover letters, the tracker
and the in-page toolbar all work on it. Pasting the same URL again updates that row
rather than creating a duplicate.

### Fit scoring

**🎯 Score fit** ranks every job against your CV, skills, level and locations, and
collapses the same role scraped from several boards into one entry. Deterministic and
instant — no LLM. Then sort by fit, or filter to *strong only (70+)*.

---

## 2. Applying

### The flow

1. **Apply** — opens the posting in Chrome and moves the job to *In progress*.
   The in-page toolbar is armed for the whole application.
2. Work through the form yourself, or press **Autofill**.
3. Before submitting, press **📚 Learn page** to bank what you typed.
4. Submit. Set the stage to *Applied*.

Apply never moves a job **backwards**. Re-opening something already at *Applied* or
*Interview* leaves the stage — and the original applied date — untouched.

### Autofill modes

| Button | Behaviour |
|---|---|
| **Autofill** | Exact answer-bank match → semantic match → LLM for the rest |
| **LLM Fill** | Ignores the bank; the LLM attempts every detected field |
| **📚 Learn page** | Captures only. Writes nothing into the form |

**Autofill never overwrites what you typed.** The form is re-checked at the moment of
writing, not when it was scanned — which matters because LLM drafting can take minutes,
and you're usually still typing. A field you've filled, or have your cursor in, is left
alone and reported:

```
🛡 Current employer: you typed "Acme Corp" while I was drafting — kept yours, discarded mine
```

It also skips **honeypots** (invisible fields only a bot would fill), **CAPTCHAs**, and
the site's own search boxes.

### The in-page toolbar

A pill at the bottom-left of the application page. Click to expand, drag to move.

`Alt`+`Shift`+ `F` autofill · `L` LLM Fill · `S` learn page · `H` hide.

It follows you through every page of the application — including inside iframes, where
most ATS forms live — until you click Apply on a different job.

Nothing stays attached while you work: each action attaches for that step and detaches.

### Cover letters

- **Base template** (Profile tab) — used verbatim when there's no LLM, and as the voice
  to match when tailoring. Supports `{{company}}`, `{{role}}`, `{{location}}`,
  `{{name}}`, `{{email}}`
- **Per job** — the **✉ Cover** button writes one from that posting's description plus
  your best-matching CV variant. Edit it, save it, and autofill uses your exact text
- Autofill routes cover-letter fields here automatically, including questions phrased as
  *"why do you want this role"*

Every employer, title, date and metric must appear in your CV — a letter contradicting
the CV is the fastest way to lose an offer.

### CV variants

Upload several CVs under the **CV** tab, one per role family. At apply time each is
scored against the posting's requirements and the best is attached:

```
✓ Attached CV "AI / ML" — 78% match on 9 requirement(s) (beat Backend 41%, Generalist 33%)
```

---

## 3. The answer bank

Everything typed into an application is captured — but **nothing is used until you
approve it**.

### The review queue

An amber card at the top of the **Answer bank** tab appears when captures are waiting.
Everything is pre-selected, so the common case is one click on **✓ Approve**. Reject
what's wrong; rejected values are remembered and won't be re-queued.

Until approved, an answer is invisible to *both* autofill and the LLM's grounding
context.

### Why the queue exists

Autofill used to learn from itself. It writes a value into a field, the page fires a
`change` event, the observer hears it and records it as though you'd typed it. One weak
guess became an exact-match answer with total confidence, and the same wrong value spread
across a dozen unrelated fields. Vector similarity can't help, because by then it's an
exact key hit that never reaches the vector stage.

Now: values written by autofill are tagged and never learned back. Only your keystrokes
create knowledge. Correct a field by hand and *that* is what gets learned.

The bank also refuses things that can't be true — a LinkedIn field that isn't a URL, an
email without an `@`, a one-word answer to an essay question, internal form IDs.

### Housekeeping

```bash
node scripts/clean-answer-bank.mjs           # report only
node scripts/clean-answer-bank.mjs --apply   # fix (backs up the DB first)
```

Removes impossible rows, merges duplicate keys for the same fact, and renames keys to
canonical form so a differently-worded field on the next site still matches.

---

## 4. Tracking

Stages: New → Shortlisted → In progress → Applied → Screening → Interview → Offer,
plus Rejected / Skipped.

The tracker panel shows the funnel and surfaces overdue follow-ups (`⏰ follow up now`).
Change a stage from the main table or the Fresh panel; both stay in sync.

---

## 5. Mail: recruiter replies

**Replies tab.** Two ways in, and the second stores nothing at all:

**Connected (Gmail).** Read-only. Click *Check mail* and JobFinder searches only for
messages matching the companies you've applied to plus recruiting vocabulary, within a
window you choose. Each message is matched to the job it's about and read for meaning.

What you see per message: the stage it implies (`screening`, `interview`, `offer`,
`rejected`), a one-line summary, and — the part that matters most — **a separate list of
everything HR is asking you for**, because those are what stall an application when one
gets missed inside a paragraph. Any deadline is pulled out too.

If the mail implies a stage change, a button appears (`→ screening`) that moves the job
and marks the message done.

*Setup is one-time and takes about five minutes:* Google requires every app to have its
own OAuth credentials — unavoidable for a self-hosted tool. The panel walks you through
creating a Google Cloud project, enabling the Gmail API, and pasting a client ID and
secret. They're stored in `data/gmail.json` (mode 0600, gitignored) and go nowhere but
Google.

**What it can't do:** send, reply, delete, or read anything outside the search. Revoke
whenever at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).

**Paste-in.** Don't want to connect a mailbox? Paste a reply into the box below the
Gmail panel. Same parser, same stage suggestion, nothing stored, no credential involved.

---

## 6. Interview prep

**Prep tab → Refresh.** It reads the job descriptions *you saved*, extracts the skills
actually demanded, researches each, and writes study notes.

It builds from evidence, not guesses: every skill is on the list because a posting you
saved asked for it, and each note shows the verbatim requirement and how many of your
jobs demand it.

### What a note contains

| Section | What it's for |
|---|---|
| **The mental model** | How an expert frames the problem, before any definition |
| **How it actually works** | The mechanism, not a description |
| **Key points** | What you must be able to explain |
| **Trade-offs** | Choice / when to pick it / what it costs — senior interviews are mostly this |
| **Numbers worth knowing** | Latencies, costs, limits. Quoting real magnitudes is the clearest senior signal |
| **In production** | What breaks at real scale |
| **Same question, three levels** | Junior vs senior vs staff answering the *same* question |
| **Likely questions** | Tagged by level, with *what they're testing* and *what they'll ask next* |
| **Answers that sound junior** | What makes a correct answer land badly |
| **Story to have ready** | A STAR prompt from your own background |
| **Drill** | One hands-on exercise |

Every claim carries a `[n]` citation to a source you can open.

### Asking questions

The **Ask** box answers from the prep knowledge base. If you ask about something not yet
covered, it researches it, writes a note, and adds it — with links. That's how you extend
the KB: just ask.

### Speed

Roughly 40 minutes for a full refresh on a local 8B model, one skill at a time, writing
each note as it completes — so partial runs are still useful. Progress is narrated per
step. Run it overnight or while you work.

---

## 7. When a site fights back

**Safe Mode** relaunches Chrome with no debugging port at all — nothing attached, no
automation of any kind. Logins persist. Use it if a human-verification step keeps failing.

General approach: use *Open & log in* first for each site, clear any check manually, and
let the session persist. Automation only ever attaches for the seconds it's filling.

---

## Keyboard reference

| Key | Where | Action |
|---|---|---|
| `Alt`+`Shift`+`F` | Application page | Autofill |
| `Alt`+`Shift`+`L` | Application page | LLM Fill |
| `Alt`+`Shift`+`S` | Application page | Learn page |
| `Alt`+`Shift`+`H` | Application page | Hide / show toolbar |
| `⌘`+`⇧`+`B` | Chrome | Show bookmarks bar |

---

## A workable rhythm

**Morning (15 min)** — Scan. Skim *Fresh*. Score fit. Shortlist.
**Blocks (2×90 min)** — Apply. Autofill. Learn page before each submit. Approve captures
at the end of the block, not per application.
**Evening (10 min)** — Update stages, clear follow-ups, read one prep note.
**Overnight** — Prep refresh.
