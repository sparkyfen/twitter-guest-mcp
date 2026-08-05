import type { NormalizedMedia, NormalizedTweet } from './normalize.js';

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

export interface FetchedImage {
  data: string;
  mimeType: string;
  sourceUrl: string;
}

/** pbs.twimg.com URLs accept a `name` size parameter; `medium` keeps payloads sane. */
function resizedUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname !== 'pbs.twimg.com') return url;
    const formatMatch = u.pathname.match(/\.(jpg|jpeg|png|webp)$/i);
    if (formatMatch) {
      u.pathname = u.pathname.slice(0, -formatMatch[0].length);
      u.searchParams.set('format', formatMatch[1]!.toLowerCase());
    }
    u.searchParams.set('name', 'medium');
    return u.toString();
  } catch {
    return url;
  }
}

async function fetchOne(
  url: string,
  fetchImpl: typeof fetch
): Promise<FetchedImage | null> {
  try {
    const response = await fetchImpl(resizedUrl(url), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    if (!mimeType.startsWith('image/')) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    return {
      data: Buffer.from(buffer).toString('base64'),
      mimeType,
      sourceUrl: url
    };
  } catch {
    return null;
  }
}

/**
 * Fetches up to `max` images for a tweet (and its quoted tweet): photos
 * directly, videos/gifs via their poster thumbnail. Failures are skipped
 * silently — images are an enhancement, not the payload.
 */
export async function fetchTweetImages(
  tweet: NormalizedTweet,
  max: number,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedImage[]> {
  const mediaList: NormalizedMedia[] = [
    ...tweet.media,
    ...(tweet.quotedTweet?.media ?? [])
  ].slice(0, Math.max(0, max));

  const results = await Promise.all(mediaList.map(m => fetchOne(m.url, fetchImpl)));
  return results.filter((r): r is FetchedImage => r !== null);
}
