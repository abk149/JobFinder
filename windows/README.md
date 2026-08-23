# Windows packaging

Everything needed to turn JobFinder into a Windows 11 install lives here, and nothing
here is used when running the app on macOS or Linux.

```
windows/
├── build.js                  Cross-platform build. Run from macOS/Linux/Windows.
├── verify.js                 22 checks; fails rather than shipping a broken bundle.
├── make-icon.js              Draws public/favicon.ico (no image tooling required).
├── legacy-build.sh           Superseded by build.js. Kept for reference only.
├── installer/
│   ├── Install-JobFinder.bat One-click installer. What the user double-clicks.
│   ├── launcher.bat          What the Desktop shortcut runs.
│   ├── post-install-models.ps1  Ollama + model setup; skips anything already present.
│   ├── jobfinder.iss         Optional Inno Setup script, for a signed .exe.
│   └── README.txt            Shipped to the end user inside the ZIP.
└── dist/                     Build output. Gitignored.
    ├── JobFinder/            The bundle.
    └── JobFinder-Windows.zip The single file to move to the Windows machine.
```

## Build

```bash
npm run build:windows     # produces windows/dist/JobFinder-Windows.zip
npm run verify:windows    # re-check an existing bundle
```

The build runs anywhere — it downloads the Windows Node runtime and the Windows-x64
`better-sqlite3` prebuild rather than reusing the host's native binaries.

## Install on the target machine

1. Copy `JobFinder-Windows.zip` across
2. Right-click → **Extract All**
3. Open the `JobFinder` folder → double-click **`Install-JobFinder.bat`**

No admin rights: it installs to `%LOCALAPPDATA%\Programs\JobFinder`, the same place
VS Code and Ollama use. Data lives separately in `%APPDATA%\JobFinder`, so updating or
reinstalling never touches the user's CV, answers or applications.

## Things worth knowing before changing anything here

**Installer assets must stay pure ASCII.** `cmd.exe` reads `.bat` in the OEM codepage
and Windows PowerShell 5.1 reads a BOM-less `.ps1` as ANSI; a stray en-dash in a comment
becomes mojibake or a parse error.

**`build.js` patches the generated `server.js`.** Next's standalone server calls
`process.chdir(__dirname)` on startup, which would put the database inside the install
folder. The patch makes it honour `JOBFINDER_DATA`. It touches generated output only —
never the app source.

**Dynamically imported packages need listing.** Anything loaded with `await import()`
inside a function is invisible to Next's tracer and silently absent from the bundle.
`imapflow` is the current case; see `RUNTIME_ONLY` in `build.js`.

**Don't add broad globs to `outputFileTracingExcludes`.** A pattern like `dist/**` also
matches `node_modules/next/dist` and cuts Next's own runtime out of the build. See the
comment in `next.config.js`.

## Not verified here

The bundle is built and boot-tested on macOS, but the `.exe`, the shortcut creation and
the PowerShell have never executed on Windows. `verify.js` checks structure — Windows PE
magic on both native binaries, module resolvability, no data leak — not behaviour.
