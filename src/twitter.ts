import { API_ROOT, TWEET_RESULT_BY_REST_ID } from './constants.js';
import { GuestSession, buildGuestHeaders } from './guest.js';
import { classifyResponse, type TweetLookup } from './normalize.js';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

export class TweetFetchError extends Error {}

function buildUrl(tweetId: string): string {
  const q = TWEET_RESULT_BY_REST_ID;
  const params = new URLSearchParams({
    variables: JSON.stringify({ ...q.variables, tweetId }),
    features: JSON.stringify(q.features),
    fieldToggles: JSON.stringify(q.fieldToggles)
  });
  return `${API_ROOT}/graphql/${q.queryId}/${q.queryName}?${params}`;
}

/**
 * Fetches one tweet via the guest-token GraphQL endpoint, with FxEmbed's
 * retry discipline: on parse/HTTP/validation failure, drop the guest token
 * and retry with a fresh one, up to 3 attempts. Also proactively drops the
 * token when its rate-limit bucket runs low.
 */
export async function fetchTweet(
  tweetId: string,
  session: GuestSession,
  fetchImpl: typeof fetch = fetch
): Promise<TweetLookup> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      const token = await session.getToken();
      response = await fetchImpl(buildUrl(tweetId), {
        method: 'GET',
        headers: buildGuestHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      lastError = e;
      session.invalidate();
      continue;
    }

    const remaining = parseInt(response.headers.get('x-rate-limit-remaining') ?? '', 10);
    if (!isNaN(remaining) && remaining < 10) {
      session.invalidate();
    }

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      lastError = new Error(`HTTP ${response.status} from Twitter API`);
      session.invalidate();
      continue;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      lastError = e;
      session.invalidate();
      continue;
    }

    const body = json as { data?: unknown; errors?: Array<{ message?: string }> };
    if (body.data !== undefined) {
      return classifyResponse(body as Record<string, unknown>);
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      lastError = new Error(
        `Twitter API error: ${body.errors.map(e => e.message).join('; ')}`
      );
      session.invalidate();
      continue;
    }

    lastError = new Error(`Unexpected response shape (HTTP ${response.status})`);
    session.invalidate();
  }

  throw new TweetFetchError(
    `Failed to fetch tweet ${tweetId} after ${MAX_ATTEMPTS} attempts: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
}

/** Accepts x.com/twitter.com/nitter status URLs, or a bare numeric ID. */
export function parseTweetId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{1,25}$/.test(trimmed)) return trimmed;
  const match = trimmed.match(/\/(?:status|statuses)\/(\d{1,25})/);
  return match ? match[1]! : null;
}
