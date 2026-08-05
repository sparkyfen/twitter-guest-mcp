import type { NormalizedMedia, NormalizedTweet } from './normalize.js';

const MAX_IMAGE_BYTES = 1 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

/** Only Twitter's own media CDNs may be fetched — never arbitrary upstream URLs. */
const ALLOWED_IMAGE_HOSTS = new Set(['pbs.twimg.com', 'video.twimg.com']);

export interface FetchedImage {
  data: string;
  mimeType: string;
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

/** Reads the body with a running byte cap so an oversized response is never fully buffered. */
async function readCapped(response: Response): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return total === 0 ? null : Buffer.concat(chunks);
}

async function fetchOne(
  url: string,
  fetchImpl: typeof fetch
): Promise<FetchedImage | null> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) {
      return null;
    }
    const response = await fetchImpl(resizedUrl(url), {
      // A redirect could point off the allowlisted host — refuse to follow.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
    if (!response.ok) return null;
    const mimeType = response.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg';
    if (!mimeType.startsWith('image/')) return null;
    const contentLength = parseInt(response.headers.get('content-length') ?? '', 10);
    if (!isNaN(contentLength) && contentLength > MAX_IMAGE_BYTES) return null;
    const body = await readCapped(response);
    if (!body) return null;
    return {
      data: Buffer.from(body).toString('base64'),
      mimeType
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
  ].slice(0, max);

  const results = await Promise.all(mediaList.map(m => fetchOne(m.url, fetchImpl)));
  return results.filter((r): r is FetchedImage => r !== null);
}
