const path = require('node:path');

// `output: 'standalone'` is ONLY for packaging the Windows installer. It is opt-in
// via JOBFINDER_STANDALONE=1 (set by scripts/build-windows.js) and must stay off for
// normal builds.
//
// Why: standalone makes Next trace and COPY every file it thinks the app needs into
// .next/standalone/. Its tracer follows `data/` and duplicates the whole browser
// session store — that produced a 12 GB .next/standalone on a live install, and the
// launcher runs `npm run build` on first start, so every fresh setup paid that cost.
// The outputFileTracingExcludes below did not prevent it, and the reason turned out to
// be placement, not glob semantics: on Next 14 these two keys belong under
// `experimental`. They were sitting at the top level (that is the Next 15 shape), so
// Next ignored them outright and said so on every boot —
//   "Invalid next.config.js options detected: outputFileTracingExcludes, outputFileTracingRoot"
// build-windows.js still moves `data/` aside as a belt-and-braces measure.
const STANDALONE = process.env.JOBFINDER_STANDALONE === '1';

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: false,
  ...(STANDALONE ? { output: 'standalone' } : {}),
  experimental: {
    // Next 14 reads these from `experimental`; Next 15 moved them to the top level.
    // If this project is ever upgraded, they have to move back out.
    outputFileTracingExcludes: {
      '*': [
        'data/**/*',
        '**/data/**',
        '**/.next/cache/**',
        '**/dist/**',
        '**/installer/**',
        '**/node_modules/playwright-core/.local-browsers/**',
        '**/node_modules/rebrowser-playwright-core/.local-browsers/**',
      ],
    },
    // Make tracing relative to the repo root, not a parent dir — keeps paths stable.
    outputFileTracingRoot: path.join(__dirname),
    serverComponentsExternalPackages: [
      'better-sqlite3',
      'playwright',
      'playwright-core',
      'rebrowser-playwright',
      'rebrowser-playwright-core',
      'pg',
    ],
    instrumentationHook: true,
  },
};
