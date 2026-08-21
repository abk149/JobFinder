// Connector registry. Each connector exports:
//   { id, label, loginUrl, scan(ctx, profile) -> Job[], apply(ctx, profile, job) -> { status, note } }
// Adding a new source: drop a new file under /connectors and import it here.

import linkedin from './linkedin.js';
import linkedinposts from './linkedinposts.js';
import naukri from './naukri.js';
import remoteok from './remoteok.js';
import weworkremotely from './weworkremotely.js';
import wellfound from './wellfound.js';
import remotive from './remotive.js';
import arbeitnow from './arbeitnow.js';
import jobicy from './jobicy.js';
import himalayas from './himalayas.js';
import themuse from './themuse.js';
import workingnomads from './workingnomads.js';
import hackernews from './hackernews.js';
import reddit from './reddit.js';
import psychology from './psychology.js';
import techstartups from './techstartups.js';
import bluesky from './bluesky.js';
import ycombinator from './ycombinator.js';
import otta from './otta.js';
import nodesk from './nodesk.js';
import jobspresso from './jobspresso.js';

// Order roughly by reliability: API-based sources first (no login, no CAPTCHA,
// won't break on selector changes), then the login-gated / scraping connectors.
export const CONNECTORS = [
  remotive,
  nodesk,
  jobspresso,
  remoteok,
  weworkremotely,
  ycombinator,
  arbeitnow,
  jobicy,
  himalayas,
  themuse,
  workingnomads,
  hackernews,
  psychology,
  techstartups,
  reddit,
  bluesky,
  otta,
  wellfound,
  linkedin,
  linkedinposts,
  naukri,
];

export function getConnector(id) {
  return CONNECTORS.find((c) => c.id === id) || null;
}

export function listConnectors() {
  return CONNECTORS.map(({ id, label, loginUrl, requiresAuth, requiresBrowser }) => ({
    id, label, loginUrl,
    requiresAuth: !!requiresAuth,
    // API-based sources (requiresBrowser === false) need no login and no window —
    // the UI can show them as "instant scan, no setup".
    requiresBrowser: requiresBrowser !== false,
  }));
}
