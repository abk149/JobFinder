# JobFinder desktop

Builds the standalone application — a real window, not a browser tab, with the model
runtime and the browser handled for the person you give it to.

```bash
npm run build:desktop           # both platforms
npm run build:desktop -- mac    # just macOS
npm run build:desktop -- win    # just Windows
npm run verify:desktop          # check the packages before handing them out
```

Output:

```
desktop/dist/mac/JobFinder.app         double-click on macOS
desktop/dist/win/JobFinder/            folder for Windows
desktop/dist/JobFinder-Windows.zip     what you actually send  (~285 MB)
```

## What the recipient does

Opens it. That is the whole instruction.

On first launch the app installs Ollama and downloads the two models (4.7 GB, once), showing
progress the entire time. Everything else — the browser, the Node runtime, the database — is
already inside the package. There is no terminal, no `npm install`, no localhost URL to type,
and no Chrome requirement.

Their data lives outside the application, so reinstalling or replacing the app never touches it:

- macOS `~/Library/Application Support/JobFinder/data`
- Windows `%APPDATA%\JobFinder\data`

## Moving an existing setup in

```bash
node desktop/import-data.js         # show what would be copied, change nothing
node desktop/import-data.js --go    # do it
```

Copies the database, resumes, screenshots, mailbox tokens and the browser profile that
holds your logins into the packaged app's data directory. Caches, the regenerable scan
profile and browser directories belonging to profiles the database no longer has are
skipped — on one machine that was 14 GB skipped against 0.2 GB copied.

Any existing destination is renamed aside rather than overwritten, and the import
re-opens the copied database afterwards and fails loudly if it will not read.

## What is inside

| | |
|---|---|
| Electron shell | the window, and the setup sequence |
| `app/` | the application server, compiled by Next.js |
| `runtime/node` | Node 20, self-contained |
| `chromium/` | the browser used for searching and applying |

Chromium is bundled so the app works on a machine with no browser installed. It is still only
the fallback: `lib/browser.js` prefers a real installed Chrome when it finds one, because a
browser with genuine history and logins passes anti-bot checks that a fresh profile does not.

## On protecting the source

Three things happen at build time:

1. Next compiles every route and library into minified chunks, which removes the comments.
2. Scripts that are **injected into pages** are stripped separately. These live inside template
   literals, so to a minifier they are strings and their comments survive untouched — and they
   are the most revealing text in the project. Whole comment lines are removed rather than the
   strings being minified, because the escaping in those files is delicate enough to have caused
   three separate bugs, and removing a line cannot change an escape sequence. The build runs
   `scripts/test-observer-escaping.mjs` against the stripped source and refuses to continue if it
   fails, so a broken injection can never be packaged.
3. `lib/toolbar.src.js` — the one file read from disk at runtime, so it never reaches the
   compiler — is minified directly, and source maps are deleted.

`npm run verify:desktop` greps the finished packages for known sentences from the source and
fails if any survive.

**What this is and is not.** It stops someone opening the package and reading how the product
works. It does not stop a determined engineer: JavaScript that runs on a machine can always be
recovered, and anyone who tells you otherwise is selling something. Function names and endpoint
paths deliberately survive — `pseudojobs` is Naukri's own URL and renaming internals buys nothing
while risking a runtime break. What is removed is the reasoning, which is the part that would
actually teach someone the product.

## Signing

Neither package is code-signed.

- **macOS** — ad-hoc signed during the build, which avoids the *"damaged and should be moved to
  the Bin"* dialog. The first launch still needs right-click → Open, once.
- **Windows** — SmartScreen will say the publisher is unknown. *More info* → *Run anyway*.

Both go away with a paid signing certificate (Apple Developer ID, or an EV certificate on
Windows). Until then, tell people to expect the warning, because an unexplained security prompt
is how software gets deleted instead of opened.

## Notes for the build machine

- Runs on macOS and cross-builds the Windows package. Node, Electron, Chromium and the native
  database module are downloaded per target and cached in `desktop/dist/.stage/`, so only the
  first build is slow.
- macOS builds target this machine's architecture. On an Apple Silicon Mac the result is
  arm64-only and will not run on an Intel Mac.
- `data/` is moved aside during the build, because Next's file tracer follows it and would copy
  every browser session into the output. If anything writes to it meanwhile, the build sets that
  aside as `.data-build-residue-*` rather than deleting it.
