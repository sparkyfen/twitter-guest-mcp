import { describe, expect, it, vi } from 'vitest';
import { fetchTweetImages } from '../src/media.js';
import type { NormalizedMedia, NormalizedTweet } from '../src/normalize.js';

function tweetWith(media: Partial<NormalizedMedia>[], quotedMedia: Partial<NormalizedMedia>[] = []): NormalizedTweet {
  const fill = (m: Partial<NormalizedMedia>): NormalizedMedia => ({
    type: 'photo',
    url: 'https://pbs.twimg.com/media/DEFAULT.jpg',
    ...m
  });
  const tweet: NormalizedTweet = {
    id: '1',
    url: 'https://x.com/u/status/1',
    text: '',
    metrics: {},
    media: media.map(fill)
  };
  if (quotedMedia.length > 0) {
    tweet.quotedTweet = {
      id: '2',
      url: 'https://x.com/u/status/2',
      text: '',
      metrics: {},
      media: quotedMedia.map(fill)
    };
  }
  return tweet;
}

function imageResponse(bytes = 100, contentType = 'image/jpeg', status = 200) {
  return new Response(new Uint8Array(bytes).fill(1), {
    status,
    headers: { 'content-type': contentType }
  });
}

describe('fetchTweetImages', () => {
  it('rewrites pbs.twimg.com URLs to the medium-size variant and refuses redirects', async () => {
    const requested: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requested.push(String(input));
      expect(init?.redirect).toBe('error');
      return imageResponse();
    });

    const tweet = tweetWith([{ url: 'https://pbs.twimg.com/media/ABC.jpg' }]);
    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);

    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe('image/jpeg');
    const url = new URL(requested[0]!);
    expect(url.pathname).toBe('/media/ABC');
    expect(url.searchParams.get('format')).toBe('jpg');
    expect(url.searchParams.get('name')).toBe('medium');
  });

  it('skips failed, non-image, and oversized responses while keeping good siblings', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('NOTFOUND')) return imageResponse(100, 'image/jpeg', 404);
      if (url.includes('HTML')) return imageResponse(100, 'text/html');
      if (url.includes('HUGE')) return imageResponse(1024 * 1024 + 1);
      return imageResponse();
    });

    const tweet = tweetWith([
      { url: 'https://pbs.twimg.com/media/NOTFOUND.jpg' },
      { url: 'https://pbs.twimg.com/media/HTML.jpg' },
      { url: 'https://pbs.twimg.com/media/HUGE.jpg' },
      { url: 'https://pbs.twimg.com/media/GOOD.jpg' }
    ]);
    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);

    expect(images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('skips a response whose content-length header exceeds the cap', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array(10).fill(1), {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(1024 * 1024 + 1)
          }
        })
    );
    const tweet = tweetWith([{ url: 'https://pbs.twimg.com/media/CLAIMSHUGE.jpg' }]);

    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);
    expect(images).toEqual([]);
  });

  it('accepts image mime types case-insensitively but rejects svg and missing types', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('UPPER')) return imageResponse(100, 'IMAGE/JPEG');
      if (url.includes('SVG')) return imageResponse(100, 'image/svg+xml');
      // No content-type at all.
      return new Response(new Uint8Array(100).fill(1), { status: 200 });
    });

    const tweet = tweetWith([
      { url: 'https://pbs.twimg.com/media/UPPER.jpg' },
      { url: 'https://pbs.twimg.com/media/SVG.jpg' },
      { url: 'https://pbs.twimg.com/media/NOTYPE.jpg' }
    ]);
    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);

    expect(images).toHaveLength(1);
    expect(images[0]!.mimeType).toBe('image/jpeg');
  });

  it('rejects allowlisted hosts carrying a port or embedded credentials', async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    const tweet = tweetWith([
      { url: 'https://pbs.twimg.com:8080/media/A.jpg' },
      { url: 'https://user:pw@pbs.twimg.com/media/B.jpg' }
    ]);

    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(images).toEqual([]);
  });

  it('stops adding images once the combined byte budget is reached', async () => {
    // 3 x 1 MiB exceeds the 2 MiB combined budget, so only two survive.
    const fetchMock = vi.fn(async () => imageResponse(1024 * 1024));
    const tweet = tweetWith([
      { url: 'https://pbs.twimg.com/media/ONE.jpg' },
      { url: 'https://pbs.twimg.com/media/TWO.jpg' },
      { url: 'https://pbs.twimg.com/media/THREE.jpg' }
    ]);

    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);
    expect(images).toHaveLength(2);
  });

  it('caps combined tweet + quoted-tweet media at max', async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    const tweet = tweetWith(
      [{ url: 'https://pbs.twimg.com/media/MAIN.jpg' }],
      [{ url: 'https://pbs.twimg.com/media/QUOTED.jpg' }]
    );

    const images = await fetchTweetImages(tweet, 1, fetchMock as typeof fetch);
    expect(images).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('performs no fetch when max is 0', async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    const tweet = tweetWith([{ url: 'https://pbs.twimg.com/media/MAIN.jpg' }]);

    const images = await fetchTweetImages(tweet, 0, fetchMock as typeof fetch);
    expect(images).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects non-twimg and non-https URLs without fetching them', async () => {
    const fetchMock = vi.fn(async () => imageResponse());
    const tweet = tweetWith([
      { url: 'https://evil.example.com/img.jpg' },
      { url: 'http://pbs.twimg.com/media/PLAIN.jpg' },
      { url: 'http://169.254.169.254/latest/meta-data/' },
      { url: 'https://video.twimg.com/ext_tw_video_thumb/1/thumb.jpg' }
    ]);

    const images = await fetchTweetImages(tweet, 4, fetchMock as typeof fetch);
    // Only the allowlisted https video.twimg.com URL is fetched.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('video.twimg.com');
    expect(images).toHaveLength(1);
  });
});
