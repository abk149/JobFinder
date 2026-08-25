// Where things live.
//
// Everything used to be resolved against process.cwd(), which is fine when the app runs
// from its own source folder and wrong the moment it is packaged: user data would land
// inside the application bundle, where an update or a reinstall silently takes the
// answer bank, the logins and the job history with it.
//
// The Windows build worked around that by chdir()-ing into the data directory at
// startup. That moved the user data correctly and broke everything else resolved the
// same way — most visibly lib/toolbar.src.js, which is read from disk at runtime and
// would then be looked for inside the data folder.
//
// So there are two roots, named separately:
//   dataDir()  things the USER owns   — database, sessions, resumes, screenshots
//   appDir()   things the APP ships   — read-only, replaced wholesale by an update
//
// Both fall back to cwd, so running from source behaves exactly as before.

import path from 'node:path';

export function dataDir() {
  return process.env.JOBFINDER_DATA || path.join(process.cwd(), 'data');
}

export function dataPath(...parts) {
  return path.join(dataDir(), ...parts);
}

export function appDir() {
  return process.env.JOBFINDER_APP_ROOT || process.cwd();
}

export function appPath(...parts) {
  return path.join(appDir(), ...parts);
}
