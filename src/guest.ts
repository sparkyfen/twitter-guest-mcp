// Imported rather than taken off the global: `globalThis.crypto` is only
// exposed unflagged from Node 19, so bare `crypto` breaks on the declared floor.
import { randomUUID } from 'node:crypto';

import {
  API_ROOT,
  BASE_HEADERS,
  GUEST_BEARER_TOKEN,
  GUEST_TOKEN_MAX_AGE_SECONDS
} from './constants.js';

/**
 * Current Chrome stable. Rots like the GraphQL constants do: a years-stale
 * Chrome version is itself a fingerprinting tell, so bump this periodically
 * against https://chromiumdash.appspot.com/releases?platform=Windows.
 */
const CHROME_VERSION = 151;
const ACTIVATE_TIMEOUT_MS = 10_000;
const GUEST_TOKEN_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/** The browser a guest session presents as, fixed for that token's lifetime. */
export interface BrowserIdentity {
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
}

/** Random plausible Chrome/Edge UA + matching client hints, like FxEmbed's generateUserAgent. */
function generateBrowserIdentity(): BrowserIdentity {
  const version = CHROME_VERSION - Math.floor(Math.random() * 3);
  const isEdge = Math.random() > 0.5;
  const platforms: Array<[string, string]> = [
    ['Windows NT 10.0; Win64; x64', '"Windows"'],
    ['Macintosh; Intel Mac OS X 10_15_7', '"macOS"'],
    ['X11; Linux x86_64', '"Linux"']
  ];
  const [platform, secChUaPlatform] =
    platforms[Math.floor(Math.random() * platforms.length)]!;
  const edgeSuffix = isEdge ? ` Edg/${version}.0.0.0` : '';
  const brand = isEdge ? 'Microsoft Edge' : 'Google Chrome';
  return {
    userAgent: `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36${edgeSuffix}`,
    secChUa: `".Not/A)Brand";v="99", "${brand}";v="${version}", "Chromium";v="${version}"`,
    secChUaPlatform
  };
}

/**
 * A guest token plus the browser identity and CSRF cookie every request
 * carrying it presents. `csrfToken` is the `ct0` value: a real browser is
 * handed one by the server and echoes it back unchanged for the session, so
 * it is minted with the token rather than per request.
 */
export interface ActiveSession {
  token: string;
  identity: BrowserIdentity;
  csrfToken: string;
}

interface CachedSession extends ActiveSession {
  fetchedAt: number;
}

/**
 * Manages the guest token lifecycle: activate, cache in memory for up to an
 * hour, and invalidate when the caller sees rate-limit pressure or auth errors.
 *
 * The browser identity and the ct0 CSRF cookie are minted with the token and
 * reused for every request that carries it, so one token+cookie+CSRF triple
 * always looks like one browser. They only change when the token rotates.
 */
export class GuestSession {
  private cached: CachedSession | null = null;
  private activating: Promise<ActiveSession> | null = null;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly activateTimeoutMs: number = ACTIVATE_TIMEOUT_MS
  ) {}

  async getSession(): Promise<ActiveSession> {
    if (
      this.cached &&
      Date.now() - this.cached.fetchedAt < GUEST_TOKEN_MAX_AGE_SECONDS * 1000
    ) {
      const { token, identity, csrfToken } = this.cached;
      return { token, identity, csrfToken };
    }
    if (!this.activating) {
      this.activating = this.activate().finally(() => {
        this.activating = null;
      });
    }
    return this.activating;
  }

  /** Drops the cached token, but only if it is still the one the caller saw fail. */
  invalidate(token: string): void {
    if (this.cached?.token === token) {
      this.cached = null;
    }
  }

  private async activate(): Promise<ActiveSession> {
    const identity = generateBrowserIdentity();
    const csrfToken = randomUUID().replace(/-/g, '');
    const response = await this.fetchImpl(`${API_ROOT}/1.1/guest/activate.json`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Authorization': GUEST_BEARER_TOKEN,
        'User-Agent': identity.userAgent,
        'sec-ch-ua': identity.secChUa,
        'sec-ch-ua-platform': identity.secChUaPlatform
      },
      body: '',
      signal: AbortSignal.timeout(this.activateTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Guest activation failed: HTTP ${response.status}`);
    }
    const json = (await response.json()) as { guest_token?: string };
    if (!json.guest_token) {
      throw new Error('Guest activation returned no guest_token');
    }
    if (!GUEST_TOKEN_PATTERN.test(json.guest_token)) {
      throw new Error('Guest activation returned a malformed guest_token');
    }
    this.cached = {
      token: json.guest_token,
      identity,
      csrfToken,
      fetchedAt: Date.now()
    };
    return { token: json.guest_token, identity, csrfToken };
  }
}

/** Request headers for a guest GraphQL call, mirroring FxEmbed's twitterFetch. */
export function buildGuestHeaders({
  token: guestToken,
  identity,
  csrfToken
}: ActiveSession): Record<string, string> {
  return {
    ...BASE_HEADERS,
    'Authorization': GUEST_BEARER_TOKEN,
    'User-Agent': identity.userAgent,
    'sec-ch-ua': identity.secChUa,
    'sec-ch-ua-platform': identity.secChUaPlatform,
    'Cookie': [
      `guest_id_ads=v1%3A${guestToken}`,
      `guest_id_marketing=v1%3A${guestToken}`,
      `guest_id=v1%3A${guestToken}`,
      `ct0=${csrfToken};`
    ].join('; '),
    'x-csrf-token': csrfToken,
    'x-guest-token': guestToken
  };
}
