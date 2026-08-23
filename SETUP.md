# Setup

Ten minutes, most of it waiting on downloads. Everything runs locally.

---

## 1. Prerequisites

| What | Why | Check |
|---|---|---|
| **Node.js 20+** | Runs the app | `node -v` |
| **Google Chrome** | Real Chrome is what passes bot checks | `ls /Applications/"Google Chrome.app"` (macOS) |
| **Ollama** | Local LLM for drafting, cover letters, prep | `ollama --version` |

Ollama is optional. Without it you still get scanning, fit scoring, the answer bank,
exact/semantic autofill and the tracker — you lose LLM drafting, cover-letter writing and
interview prep.

Install Ollama from [ollama.com](https://ollama.com), or on macOS:

```bash
brew install ollama && brew services start ollama
```

---

## 2. Install

```bash
git clone https://github.com/abk149/JobFinder.git
cd JobFinder
npm install
```

`npm install` also downloads Playwright's Chromium and Firefox via the `postinstall`
hook. That's a few hundred MB and takes a minute or two.

---

## 3. Pull the models

```bash
ollama pull qwen2.5:7b-instruct   # synthesis: prep, cover letters  (~4.7 GB)
ollama pull all-minilm            # embeddings for semantic matching (~46 MB)
```

**On model choice.** Interview prep and cover letters need an **instruct** model, not a
reasoning model. Reasoning models (`deepseek-r1` and friends) emit a `<think>` block
before any output, so most of the token budget is spent before the first useful token.
Measured on this project: at a 2,400-token budget `deepseek-r1:8b` returned **zero
characters**; `qwen2.5:7b-instruct` returned valid JSON in 92 seconds where deepseek hit a
300-second timeout and produced nothing.

The app picks the best installed instruct model automatically — you don't have to
configure anything. Preference order:

```
qwen2.5:7b-instruct → qwen2.5:14b-instruct → llama3.1:8b → mistral:7b-instruct
```

**On the embedding model.** `all-minilm` rather than the more popular
`nomic-embed-text`, because the popular one does not work for this task. Form questions
are short ("Expected CTC", "Notice period"), and on short text nomic returns vectors
dominated by one large component that hardly moves with the wording. Cosine then compares
almost nothing: measured against a real 35-answer bank it rated *"Expected CTC"* against
*"City: Berlin"* at **1.000** and picked the right answer for 1 of 8 answerable
questions. `all-minilm` gets 8 of 10, and — more importantly — keeps unanswerable
questions well below the fill threshold so they go to the LLM instead of being filled
with a confident wrong value.

If you switch embedding models, click **Reindex bank** (or restart): vectors from
different models are not comparable, and JobFinder re-embeds any whose dimension no
longer matches the live model.

**On memory.** Each 7–8B model is ~5 GB resident. On a 16 GB machine, running two
alongside Chrome causes swapping, which looks exactly like a hang: the model stays
loaded, the runner sits near 0% CPU, and nothing is generated. If you have 16 GB, use
**one** model for both chat and synthesis.

---

## 4. Run

```bash
npm run build
npm start
```

Open <http://localhost:3737>. On startup you should see:

```
[JobFinder] Preloading Ollama models: chat=…, embed=all-minilm
[JobFinder] Prep/cover-letter synthesis will use: qwen2.5:7b-instruct (loaded on first use)
[JobFinder] LLM warmup: ✅ chat · ✅ embed
```

For development with hot reload, use `npm run dev` instead.

### Optional: desktop launcher (macOS)

```bash
npm run install-launcher
```

Creates `~/Desktop/JobFinder.command`. Double-click to start; close the Terminal window
to stop.

---

## 5. First-run configuration

1. **Create a profile** — name, email, keywords, target locations.
2. **Upload your CV** (PDF). Text is extracted for fit scoring and cover letters.
3. *(Optional)* **Add CV variants** under the CV tab — one per role family. The best match
   is scored and attached per application.
4. *(Optional)* **Write a base cover letter** in the Profile tab. Placeholders
   `{{company}}`, `{{role}}`, `{{location}}`, `{{name}}`, `{{email}}` are substituted per
   application.
5. **Log in to the sites you use.** Sources tab → *Open & log in*. This opens a plain
   Chrome window with **no automation attached**, so Google sign-in works and Cloudflare
   checks pass. Log in, then leave the window open or close it — the session persists.

Naukri and LinkedIn Posts **require** this step; they will tell you so rather than
failing silently.

---

## 6. Install the in-page toolbar (recommended)

Jobs tab → **🎯 In-page toolbar** → drag the purple button to your bookmarks bar
(`⌘⇧B` shows it).

Clicking **Apply** arms the toolbar automatically for that whole application. The
bookmarklet is the fallback for pages JobFinder didn't open.

Hotkeys, once it's on a page:

| Key | Action |
|---|---|
| `Alt`+`Shift`+`F` | Autofill |
| `Alt`+`Shift`+`L` | LLM Fill |
| `Alt`+`Shift`+`S` | Learn this page |
| `Alt`+`Shift`+`H` | Hide / show |

---

## Configuration reference

Environment variables — all optional:

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Ollama endpoint |
| `OLLAMA_MODEL` | `qwen2.5:7b-instruct` | Chat model (autofill drafting) |
| `OLLAMA_EMBED_MODEL` | `all-minilm` | Embedding model |
| `JOBFINDER_LLM_TIMEOUT_MS` | `240000` | Per-call LLM deadline |
| `JOBFINDER_TOOLBAR_KEEPER` | on | `0` disables the persistent toolbar session |
| `JOBFINDER_STANDALONE` | off | `1` for Windows packaging only |
| `TIMESCALE_URL` | unset | Use Postgres/TimescaleDB instead of SQLite |
| `PORT` | `3737` | Server port |

Per-profile settings (Profile tab → LLM settings) override the environment:
`llm_model`, `synth_model`, `embed_model`, `llm_url`.

---

## Verifying the install

```bash
node scripts/test-stealth.mjs          # expect: 23 passed, 0 failed
node scripts/check-canon-parity.mjs    # expect: parity holds across 37 cases
node scripts/clean-answer-bank.mjs     # dry run; reports, changes nothing
```

---

## Troubleshooting

**`Ollama is not running`** — `brew services start ollama`, or `ollama serve`.

**Prep or autofill hangs** — a wedged model. Every call now has a deadline and will
report it. To clear: `brew services restart ollama`. If it recurs, you are probably
running two large models on too little RAM; see §3.

**A source "returned nothing"** — usually a sign-in wall. Sources tab → *Open & log in*,
then rescan. The scan log distinguishes *no results*, *blocked*, and *needs login*.

**"Verify you are human" keeps appearing** — hit **Safe Mode**. It relaunches Chrome with
no debugging port at all, so nothing is attached. Logins persist.

**Autofill filled nothing** — new answers sit in the review queue until approved.
Answer bank → approve them.

**A second Chrome opens and the first disappears** — Chrome allows one process per
profile directory. JobFinder detects a running Chrome via its own port file and reuses
it. If this happens, close all Chrome windows for that profile and click Apply again.

**Port 3737 in use** — `lsof -nP -iTCP:3737 -sTCP:LISTEN`, then kill it or set `PORT`.
