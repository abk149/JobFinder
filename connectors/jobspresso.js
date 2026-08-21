import {
  jobId, keywordList, matchesKeywords, htmlToText, externalApply, withFetched,
  fetchFeedItems, feedTag, feedLink,
} from './_util.js';

// Jobspresso — hand-screened remote roles on WP Job Manager.
//
// The plain /feed/ is the blog; the JOB feed is ?feed=job_feed, which is the WP Job
// Manager endpoint. Worth being precise about: the same mistake makes SkipTheDrive look
// like a job source when its only feed is articles.
//
// WP Job Manager adds a <job_listing:*> namespace carrying company and location, so
// those come through structured rather than parsed out of the title.
const FEED = 'https://jobspresso.co/?feed=job_feed';

export default {
  id: 'jobspresso',
  label: 'Jobspresso',
  loginUrl: 'https://jobspresso.co/',
  requiresAuth: false,
  requiresBrowser: false,

  async scan(ctx, profile) {
    const kws = keywordList(profile);
    const items = await fetchFeedItems(FEED);
    const out = [];

    for (const item of items) {
      const title = feedTag(item, 'title');
      const url = feedLink(item);
      if (!title || !url) continue;

      const company = feedTag(item, 'job_listing:company') || feedTag(item, 'dc:creator') || 'Jobspresso';
      const location = feedTag(item, 'job_listing:location') || 'Remote';
      const description = htmlToText(
        feedTag(item, 'content:encoded') || feedTag(item, 'description'),
        2500
      );
      if (!matchesKeywords(`${title} ${company} ${description}`, kws)) continue;

      const ext = url.split('?')[0];
      out.push({
        id: jobId('jobspresso', ext),
        external_id: ext,
        title: title.slice(0, 160),
        company,
        location,
        url,
        salary: '',
        posted_at: feedTag(item, 'pubDate') || '',
        description,
      });
    }
    return withFetched(out, items.length);
  },

  apply: externalApply('Jobspresso listing opened — apply on the employer’s own page.'),
};
