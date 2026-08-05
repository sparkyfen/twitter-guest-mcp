import { describe, expect, it, vi } from 'vitest';
import { GuestSession } from '../src/guest.js';
import { fetchTweet, parseTweetId, TweetFetchError } from '../src/twitter.js';
import photoQuote from './fixtures/photo-quote-tweet.json';

describe('parseTweetId', () => {
  it('accepts bare numeric IDs', () => {
    expect(parseTweetId('1700000000000000001')).toBe('1700000000000000001');
    expect(parseTweetId('  42  ')).toBe('42');
  });

  it('extracts IDs from status URLs on any host', () => {
    expect(parseTweetId('https://x.com/user/status/123456789')).toBe('123456789');
    expect(parseTweetId('https://twitter.com/user/status/123456789?s=20')).toBe(
      '123456789'
    );
    expect(parseTweetId('https://nitter.net/user/status/987/photo/1')).toBe('987');
    expect(parseTweetId('https://x.com/i/statuses/555')).toBe('555');
  });

  it('rejects garbage', () => {
    expect(parseTweetId('https://x.com/someuser')).toBeNull();
    expect(parseTweetId('not a tweet')).toBeNull();
    expect(parseTweetId('')).toBeNull();
  });

  it('rejects malformed IDs instead of truncating them', () => {
    // Alphanumeric run after digits must not silently become tweet "12".
    expect(parseTweetId('https://x.com/user/status/12ab34')).toBeNull();
    // Over-long digit runs must not be truncated to 25 digits.
    expect(parseTweetId(`https://x.com/user/status/${'1'.repeat(28)}`)).toBeNull();
    expect(parseTweetId('1'.repeat(28))).toBeNull();
  });
});

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

const activation = () =>
  jsonResponse({ guest_token: 'tok' + Math.random().toString(36).slice(2) });

describe('fetchTweet', () => {
  it('activates a guest token then fetches and classifies the tweet', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/1.1/guest/activate.json')) return activation();
      return jsonResponse(photoQuote);
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    const lookup = await fetchTweet(
      '1700000000000000001',
      session,
      fetchMock as typeof fetch
    );

    expect(lookup.status).toBe('found');
    expect(calls[0]).toContain('/1.1/guest/activate.json');
    expect(calls[1]).toContain('/graphql/');
    expect(calls[1]).toContain('TweetResultByRestId');
    expect(calls[1]).toContain('1700000000000000001');
  });

  it('reuses the cached guest token across fetches', async () => {
    let activations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/1.1/guest/activate.json')) {
        activations++;
        return activation();
      }
      return jsonResponse(photoQuote);
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    await fetchTweet('1', session, fetchMock as typeof fetch);
    await fetchTweet('2', session, fetchMock as typeof fetch);

    expect(activations).toBe(1);
  });

  it('retries with a fresh token on 429 and succeeds', async () => {
    let graphqlCalls = 0;
    let activations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/1.1/guest/activate.json')) {
        activations++;
        return activation();
      }
      graphqlCalls++;
      if (graphqlCalls === 1) return jsonResponse({}, 429);
      return jsonResponse(photoQuote);
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    // Tiny backoff: the subject here is the retry, not the delay (see the
    // fake-timer test below, which guards the real backoff values).
    const lookup = await fetchTweet('1', session, fetchMock as typeof fetch, undefined, 1);

    expect(lookup.status).toBe('found');
    expect(graphqlCalls).toBe(2);
    expect(activations).toBe(2);
  });

  it('invalidates the token when the rate-limit bucket runs low', async () => {
    let activations = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/1.1/guest/activate.json')) {
        activations++;
        return activation();
      }
      return jsonResponse(photoQuote, 200, { 'x-rate-limit-remaining': '3' });
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    await fetchTweet('1', session, fetchMock as typeof fetch);
    await fetchTweet('2', session, fetchMock as typeof fetch);

    // Each fetch saw remaining < 10 and dropped the token, so both activated.
    expect(activations).toBe(2);
  });

  it('retries when a partial response carries both data and errors', async () => {
    let graphqlCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/1.1/guest/activate.json')) return activation();
      graphqlCalls++;
      if (graphqlCalls === 1) {
        return jsonResponse({
          data: { tweetResult: {} },
          errors: [{ message: 'Rate limit exceeded' }]
        });
      }
      return jsonResponse(photoQuote);
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    const lookup = await fetchTweet('1', session, fetchMock as typeof fetch, undefined, 1);

    // Must not classify the partial payload as not_found; must retry instead.
    expect(lookup.status).toBe('found');
    expect(graphqlCalls).toBe(2);
  });

  it('wraps a literal-null JSON body in TweetFetchError instead of a raw TypeError', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/1.1/guest/activate.json')) return activation();
      return jsonResponse(null);
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    await expect(
      fetchTweet('1', session, fetchMock as typeof fetch, undefined, 1)
    ).rejects.toThrow(TweetFetchError);
  });

  it('aborts a GraphQL request that never responds once the timeout elapses', async () => {
    // Real timers only: AbortSignal.timeout does not run on vitest's fake timers.
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/1.1/guest/activate.json')) {
        return Promise.resolve(activation());
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    });

    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(
      fetchTweet('1', session, fetchMock as unknown as typeof fetch, 5, 1)
    ).rejects.toThrow(/timeout|abort/i);
  });

  it('backs off between retries, doubling the delay each time', async () => {
    // Fake timers are safe here: the backoff uses setTimeout, not AbortSignal.timeout.
    vi.useFakeTimers();
    try {
      let graphqlCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/1.1/guest/activate.json')) return activation();
        graphqlCalls++;
        return jsonResponse({ errors: [{ message: 'Denied' }] });
      });

      const session = new GuestSession(fetchMock as typeof fetch);
      const promise = fetchTweet('1', session, fetchMock as typeof fetch);
      const rejection = expect(promise).rejects.toThrow(TweetFetchError);

      await vi.advanceTimersByTimeAsync(0);
      expect(graphqlCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(249);
      expect(graphqlCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(graphqlCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(499);
      expect(graphqlCalls).toBe(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(graphqlCalls).toBe(3);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors an injected retry base delay', async () => {
    vi.useFakeTimers();
    try {
      let graphqlCalls = 0;
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/1.1/guest/activate.json')) return activation();
        graphqlCalls++;
        return jsonResponse({ errors: [{ message: 'Denied' }] });
      });

      const session = new GuestSession(fetchMock as typeof fetch);
      const promise = fetchTweet('1', session, fetchMock as typeof fetch, undefined, 1000);
      const rejection = expect(promise).rejects.toThrow(TweetFetchError);

      await vi.advanceTimersByTimeAsync(0);
      expect(graphqlCalls).toBe(1);
      // Still 1 past the module default, so the injected delay is the one in use.
      await vi.advanceTimersByTimeAsync(999);
      expect(graphqlCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(graphqlCalls).toBe(2);

      await vi.advanceTimersByTimeAsync(2000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after 3 attempts with a descriptive error', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/1.1/guest/activate.json')) return activation();
      return jsonResponse({ errors: [{ message: 'Denied' }] }, 200);
    });

    const session = new GuestSession(fetchMock as typeof fetch);
    await expect(
      fetchTweet('1', session, fetchMock as typeof fetch, undefined, 1)
    ).rejects.toThrow(TweetFetchError);
    const graphqlCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/graphql/')
    );
    expect(graphqlCalls).toHaveLength(3);
  });
});
