import { describe, expect, it } from 'vitest';
import { GuestSession } from '../src/guest.js';
import { fetchTweet } from '../src/twitter.js';

/**
 * Opt-in smoke test against the real Twitter API: `LIVE=1 npm run test:live`.
 * Kept out of CI so the suite stays hermetic.
 */
describe.runIf(process.env.LIVE === '1')('live guest API', () => {
  it(
    'fetches a known stable tweet',
    async () => {
      const session = new GuestSession();
      // Jack Dorsey's "just setting up my twttr" — tweet #20.
      const lookup = await fetchTweet('20', session);
      expect(lookup.status).toBe('found');
      if (lookup.status !== 'found') return;
      expect(lookup.tweet.text).toContain('just setting up my twttr');
      expect(lookup.tweet.author?.screenName.toLowerCase()).toBe('jack');
      expect(lookup.tweet.metrics.likes).toBeGreaterThan(1000);
    },
    30_000
  );
});
