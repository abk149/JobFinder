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

### Applying automatically (Auto-apply tab)

Some applications finish on the job board itself — LinkedIn **Easy Apply** and Naukri's
**Apply** (as opposed to *Apply on company site*). Those, JobFinder can complete for you.

**Start with a dry run.** The button says *🧪 Dry run* until you tick **Send for real**.
A dry run fills every field, screenshots the finished form into
`data/applications/<profile>/`, and stops at the Submit button. Look at a few before you
arm it — that is when you find out that a salary box got something you would not have
written.

**It stops rather than guessing.** If a form asks something your answer bank has no
answer for, the application is abandoned and the question appears under *Questions
waiting on you* with the site's own dropdown choices where it had them. Answer it once
and every job asking the same thing continues — questions are keyed like any other
answer, so "expected CTC" is answered once, not once per employer.

Nothing you have not answered is ever filled in on your behalf, and a question waiting
on you can never be used as an answer by autofill or the LLM.

**What the outcomes mean**

| Outcome | Meaning |
|---|---|
| `applied` | Submitted. The job moves to *Applied*. |
| `dry_run` | Filled and ready; not sent, because it was not armed. |
| `needs_input` | Stopped — see the questions above the results. |
| `external` | Applies on the employer's own site. Not ours to drive; use **Apply**. |
| `already_applied` | The site says you have applied before. |
| `expired` | The posting is gone; the site redirected to its search page. |
| `error` | Something specific went wrong — the note says what. |

**Naukri is different from LinkedIn.** LinkedIn's Easy Apply is a wizard with a review
step, so a dry run can walk the whole thing and back out. On Naukri, clicking *Apply*
**is** the submission — there is nothing to stop at — so a dry run does not click it at
all and reports what it would have done.

**The cap is per board, and the boards run at the same time.** "10" means 10 LinkedIn
*and* 10 Naukri, worked through in parallel — the run takes as long as the slower board,
not the sum of both.

Within a single board it is more careful than that. A dry run opens a few tabs at once,
since it submits nothing. A live run goes one at a time with a human gap between
submissions: ten applications arriving at one board simultaneously is the clearest
automation signal either site gets, and the penalty is a restricted account — which
costs you the logged-in session everything else here depends on.

### What goes into a batch

A batch drawn purely by date ends up wherever the boards happened to be busy that
morning, which is usually all one place. The mix is set deliberately: **half local, a
third worldwide, a fifth remote**. Within each of those, freshest first.

When a bucket cannot fill its share the spare places go to the others in priority
order — **remote, then local, then worldwide**. Naukri is almost entirely domestic, so
in practice its worldwide places go to remote roles before local ones, and if there are
no remote roles either, the batch is simply all local. Nothing is ever left empty
because a bucket ran dry.

### Salary expectations abroad

Your expectation lives in the answer bank as one figure in one currency. Typing it into
a form in Berlin is not a rounding error — it is a number about thirty times too large,
and it ends the conversation. So it is converted for the employer's country.

**It converts at purchasing power, not at the exchange rate.** Both are defensible and
they give very different answers:

| | ₹30,00,000 becomes |
|---|---|
| exchange rate — what your money is worth if you change it | USD 36,000 |
| purchasing power — what it takes to live the same way there | **USD 130,000** |

Nobody in the US is hired at 36,000, so asking that underprices you roughly threefold
and is very hard to walk back. Purchasing power is the honest basis for "what would I
need to move", which is what the question is really asking.

**Be aware of what it does not know.** It has no idea what the role pays in that city.
The figure is a like-for-like translation of *your* number, not a market rate — treat it
as a starting point and sanity-check the first few in the dry-run screenshots.

To fix a figure for one market yourself, add an answer in the Answer bank keyed
`expected salary usd` (or `gbp`, `eur`, `aed`, …). Yours always wins over anything
computed.

Which currency a form wants is read from the form first and the job's country second, so
"Expected CTC in INR" on a Dubai job correctly stays in rupees. When neither says — a
bare `$` box on a job with no country — it does **not** guess, because the difference
between USD and SGD is a third of the number. It asks you instead, and the question names
the problem.

### Naukri early access

Naukri shows a set of roles recruiters are searching for *before* they post the job.
These have no application form at all — the only action is **Share Interest**, which
puts you in front of the recruiter early. Auto-apply picks these up and treats Share
Interest exactly as it treats a submission: a dry run never clicks it, and an armed run
does. Getting in before a posting exists is the point, so they are worth having in the
mix.

### LinkedIn's daily limit

LinkedIn caps how many Easy Apply submissions an account can send in a day. When you hit
it, it stops opening the form and shows *"You reached today's Easy Apply limit"* — and it
only says so **after** you click Easy Apply, never on the job page.

The app recognises that now, reports it plainly, and **stops the LinkedIn board for the
rest of the run** rather than working through the queue getting the same refusal. Nothing
is recorded against the postings, so they are all still waiting tomorrow.

This matters more than it sounds. Before, the refusal looked identical to "this job
applies on the company site", and that verdict was written to the database permanently.
A single day spent at the limit wrote off nearly 600 LinkedIn jobs, including ones the
scan had positively identified from LinkedIn's own Easy Apply feed. If the board is quiet
and the log says nothing, that was why.

Naukri has no equivalent cap and keeps going.

### Running it on a schedule

The Auto-apply tab can repeat a batch by itself — every 20 minutes, hourly, or as slow
as 8 hours. Set the interval and how many jobs per board, then **Start**.

It has the same arming switch, and this one *is* remembered, because a scheduler you
must re-arm after every restart is not a scheduler. What makes that safe is the **daily
cap**: it counts applications actually sent today, read from your job list rather than
from a counter the app keeps, so restarting JobFinder, opening a second window or
crashing mid-run cannot reset it to zero. When the cap is reached the schedule holds
until tomorrow rather than stopping.

**It scans as well as applies.** A schedule that only applies works through what is
already saved and then quietly does nothing, which looks exactly like "it can't find any
new jobs". Each run scans first when it is due — at most once an hour, since a LinkedIn
scan walks four feeds and takes about a minute and a half. Untick **also scan** if you
would rather scan by hand.

Two more brakes worth knowing about: only one run happens at a time per profile (a batch
that overruns its interval delays the next one instead of stacking a second on top), and
the schedule announces itself in the terminal on every start, so a background sender can
never come back quietly after a restart.

Stop it from the same panel when you are done.

### Jobs you have already applied to

The main job list hides them by default — including everything auto-apply sent, and
anything a board told us you had already applied to. A batch of twenty otherwise leaves
twenty entries that look actionable and are not. Untick **hide applied** to see them, or
use the Tracker, which always shows the full pipeline.

**Sign in to both boards — it is the difference between a handful of applyable jobs and
a few hundred.** Naukri's recommendations are five separate tabs — *Profile*, *Applies*,
*Top Candidate*, *Preferences*, *You might like* — and all five are read, because reading
only the one that happens to be open leaves four fifths of the applyable jobs behind. On
one profile that was 200 jobs that apply on Naukri, against 46 before. A keyword search is not where either site keeps the work you can apply to
without leaving it. Naukri's signed-in homepage feeds ("jobs based on your profile" and
"based on your applies") are mostly jobs that apply on Naukri, while a keyword search of
the same profile returned 24 postings that were *all* "Apply on company site". LinkedIn
is the same story through its Easy Apply collection, and LinkedIn is searched four ways
because each reaches jobs the others miss: that collection, your keywords in your own
location, your keywords **worldwide**, and remote-only. Location is the lowest-priority
filter here — a job you can apply to in one click is worth seeing even if it sits
somewhere you would not have searched. On one profile the worldwide pass returned
34,000+ Easy Apply results against 2,000+ for India alone, and pulled in roles in
Switzerland, New Zealand, Qatar and the UAE. All of these are scanned automatically when
a signed-in session exists, and skipped silently when it does not.

**A batch of 10 means 10 real attempts.** Postings that turn out to redirect to the
employer's own site, or to have expired, are skipped in a couple of seconds and do not
use up a place — the board keeps pulling candidates until it has ten it could actually
work on. Which jobs those are is increasingly known before the run even starts: Naukri's
search tells us which postings are "Apply on company site", and LinkedIn is scanned a
second time through its Easy Apply filter. Anything discovered the slow way is
remembered, so no posting costs you that lookup twice.

**Jobs waiting on a question you have not answered are not retried, and are never
thrown away.** They would walk the same form and stop at the same blank field, so they
sit out every run until you answer — however long that takes — and return automatically
the moment you do. The questions pile up in the panel meanwhile, which is the intended
shape: answer them in a batch when it suits you and a batch of applications unblocks at
once.

Only genuine failures count against a posting's retry budget. Waiting on you is not a
failure.

**A posting that fails three times is set aside** and stops appearing in batches, so one
form this code cannot drive can't occupy a place in every future run. That is per
*posting*, never per role: if the same employer posts the same job again, it arrives as
a new entry with a clean slate and you will apply to it.

**Notice period answers itself.** Set *Last working day* on the Profile tab and any
"notice period" question is computed from that date — 45 days today, 44 tomorrow —
instead of being stored as a number that silently goes stale. Dropdowns get the bucket
the real figure falls into, always rounding **up**, because telling an employer you can
start sooner than you can is the error that costs an offer. If every option offered is
shorter than the truth, it asks you rather than picking one.

**Stale postings are skipped, not tried.** Naukri listings are only considered for 10
days and LinkedIn for 21, and within that window today's jobs are always tried first.
This matters more than it sounds: a run ordered by fit score alone spent its entire
budget on high-scoring postings that had expired weeks earlier — 8 expired, 1 already
applied, 1 external, nothing applied to. If a board shows few eligible jobs, scan again
rather than widening the window.

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

The tab holds two separate things, because they behave differently.

### Personal information

Your name, email, phone, LinkedIn, GitHub, website, and where you live. A short fixed
list you confirm once. Each field is checked for **shape**: an email needs an @ and a
domain, a phone needs digits, a LinkedIn link has to mention linkedin.com. Type something
that does not fit and it is refused with a reason rather than saved.

That check exists because of a real failure. Field labels are collapsed to a shared key
so "E-mail address", "Email ID" and "Your email" all resolve to one answer — but the rule
matched the label alone, so a question that merely *mentioned* email ("Do you consent to
email updates?") collapsed to the same key and wrote its **Yes** over the address.
Autofill then typed "Yes" into an employer's email box, and nothing noticed, because to
the bank one approved string is as good as another. Four fields were corrupted this way.

The shape check now runs twice: when an answer is saved, and again when a form is filled
— because a bank that is already wrong should not be able to put "Yes" in an email box
tomorrow either. If a stored personal detail fails its own check at fill time, the field
is treated as unanswered and you are asked.

### Answers to questions

Everything else: the replies employers' forms have asked you for. This list grows, gets
reviewed, and is matched semantically. It is the part that is *supposed* to be messy.


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

## 5. Contacts directory

**Contacts tab.** Job ads sometimes print a hiring address — "send your CV to
careers@…", "reach out to lukasz@…". Scanning captures those into a directory with the
company and, where the ad states them, a name and designation. Editable inline, filter
by status (new → contacted → replied → ignored), and **Export CSV** for a mail merge.

**↻ Harvest from saved jobs** re-reads postings you saved before the feature existed.

Set expectations: only about **2% of ads include an address**, and on a 1,232-posting
database that yielded 26. Hacker News "Who is hiring" threads are by far the richest
source, since a contact line is the convention there. This is a slow-filling,
high-quality list rather than a bulk one.

**What it does not do:** it never crawls anywhere to find addresses, and never guesses
one from a name-and-domain pattern. Everything comes from text already fetched for the
posting. Job-seeker posts (Hacker News runs "Who wants to be hired?" alongside "Who is
hiring?") and staffing-vendor pitches are filtered out — mailing those is backwards.

---

## 6. Mail: recruiter replies

**Replies tab.** Two ways in, and the second stores nothing at all:

**Connected mailbox.** Click *Check mail* and JobFinder searches only for messages
matching the companies you've applied to plus recruiting vocabulary, within a window you
choose. Each message is matched to the job it's about and read for meaning.

There are two ways to connect, and they differ in more than convenience:

| | App password *(recommended)* | Google OAuth |
|---|---|---|
| Setup | ~2 minutes | ~10 minutes, needs a Google Cloud project |
| Expiry | Never | **Every 7 days** while the app is unverified |
| Access | Full mailbox (JobFinder only reads) | Read-only, enforced by Google |
| Revoke | Google account → App passwords | Google account → Permissions |

**Why there's no one-click "Sign in with Google":** Gmail's read scopes are classed by
Google as *restricted*. Only a **verified** app may request them, and verification
requires an annual third-party security assessment. No self-hosted tool can clear that
bar, so a shared sign-in button is not available to anyone — which is exactly why mail
clients have always used app passwords.

**App password, step by step:**
1. Turn on **2-Step Verification** — the app-password option does not appear without it.
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
   and create one named "JobFinder".
3. Paste the 16-character password into the Replies tab. Spaces don't matter.

It's verified against the mail server before anything is saved, then stored in
`data/mail.json` (mode 0600, gitignored). Outlook, Yahoo and iCloud work the same way —
pick the provider from the dropdown.

What you see per message: the stage it implies (`screening`, `interview`, `offer`,
`rejected`), a one-line summary, and — the part that matters most — **a separate list of
everything HR is asking you for**, because those are what stall an application when one
gets missed inside a paragraph. Any deadline is pulled out too.

If the mail implies a stage change, a button appears (`→ screening`) that moves the job
and marks the message done.

**Paste-in.** Don't want to connect a mailbox? Paste a reply into the box below the
Gmail panel. Same parser, same stage suggestion, nothing stored, no credential involved.

---

## 7. Interview prep

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

## 8. When a site fights back

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
