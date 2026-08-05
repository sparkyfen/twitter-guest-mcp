import { API_ROOT, TWEET_RESULT_BY_REST_ID } from './constants.js';
import { GuestSession, buildGuestHeaders } from './guest.js';
import { classifyResponse, type TweetLookup } from './normalize.js';

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_BASE_DELAY_MS = 250;

export class TweetFetchError extends Error {}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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
 * and retry with a fresh one (after a short backoff), up to 3 attempts.
 * Also proactively drops the token when its rate-limit bucket runs low.
 */
export async function fetchTweet(
  tweetId: string,
  session: GuestSession,
  fetchImpl: typeof fetch = fetch
): Promise<TweetLookup> {
  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Skip invalidation on the final attempt: there is no retry left, and
    // wiping the token would just force the next call to re-activate.
    const canRetry = attempt < MAX_ATTEMPTS - 1;
    if (attempt > 0) {
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }

    let token: string;
    try {
      token = await session.getToken();
    } catch (e) {
      lastError = e;
      continue;
    }

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(tweetId), {
        method: 'GET',
        headers: buildGuestHeaders(token),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch (e) {
      lastError = e;
      if (canRetry) session.invalidate(token);
      continue;
    }

    const remaining = parseInt(response.headers.get('x-rate-limit-remaining') ?? '', 10);
    if (!isNaN(remaining) && remaining < 10) {
      session.invalidate(token);
    }

    if (response.status === 401 || response.status === 403 || response.status === 429) {
      lastError = new Error(`HTTP ${response.status} from Twitter API`);
      if (canRetry) session.invalidate(token);
      continue;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (e) {
      lastError = e;
      if (canRetry) session.invalidate(token);
      continue;
    }

    if (typeof json !== 'object' || json === null) {
      lastError = new Error(`Unexpected non-object response body (HTTP ${response.status})`);
      if (canRetry) session.invalidate(token);
      continue;
    }

    const body = json as { data?: unknown; errors?: Array<{ message?: string }> };
    // Errors first: a partial response can carry both `data` and `errors`
    // (e.g. rate limiting), and must retry rather than classify as not_found.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      lastError = new Error(
        `Twitter API error: ${body.errors.map(e => e.message).join('; ')}`
      );
      if (canRetry) session.invalidate(token);
      continue;
    }
    if (body.data !== undefined) {
      return classifyResponse(body as Record<string, unknown>);
    }

    lastError = new Error(`Unexpected response shape (HTTP ${response.status})`);
    if (canRetry) session.invalidate(token);
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
  // Right-anchored so "12ab34" or an over-long digit run is rejected, not truncated.
  const match = trimmed.match(/\/(?:status|statuses)\/(\d{1,25})(?![\dA-Za-z])/);
  return match ? match[1]! : null;
}
