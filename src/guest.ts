import {
  API_ROOT,
  BASE_HEADERS,
  GUEST_BEARER_TOKEN,
  GUEST_TOKEN_MAX_AGE_SECONDS
} from './constants.js';

const CHROME_VERSION = 145;
const ACTIVATE_TIMEOUT_MS = 10_000;
const GUEST_TOKEN_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/** Random plausible Chrome/Edge UA + matching client hints, like FxEmbed's generateUserAgent. */
function generateUserAgent(): {
  userAgent: string;
  secChUa: string;
  secChUaPlatform: string;
} {
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

interface CachedToken {
  token: string;
  fetchedAt: number;
}

/**
 * Manages the guest token lifecycle: activate, cache in memory for up to an
 * hour, and invalidate when the caller sees rate-limit pressure or auth errors.
 */
export class GuestSession {
  private cached: CachedToken | null = null;
  private activating: Promise<string> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async getToken(): Promise<string> {
    if (
      this.cached &&
      Date.now() - this.cached.fetchedAt < GUEST_TOKEN_MAX_AGE_SECONDS * 1000
    ) {
      return this.cached.token;
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

  private async activate(): Promise<string> {
    const { userAgent, secChUa, secChUaPlatform } = generateUserAgent();
    const response = await this.fetchImpl(`${API_ROOT}/1.1/guest/activate.json`, {
      method: 'POST',
      headers: {
        ...BASE_HEADERS,
        'Authorization': GUEST_BEARER_TOKEN,
        'User-Agent': userAgent,
        'sec-ch-ua': secChUa,
        'sec-ch-ua-platform': secChUaPlatform
      },
      body: '',
      signal: AbortSignal.timeout(ACTIVATE_TIMEOUT_MS)
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
    this.cached = { token: json.guest_token, fetchedAt: Date.now() };
    return json.guest_token;
  }
}

/** Request headers for a guest GraphQL call, mirroring FxEmbed's twitterFetch. */
export function buildGuestHeaders(guestToken: string): Record<string, string> {
  const { userAgent, secChUa, secChUaPlatform } = generateUserAgent();
  const csrfToken = crypto.randomUUID().replace(/-/g, '');
  return {
    ...BASE_HEADERS,
    'Authorization': GUEST_BEARER_TOKEN,
    'User-Agent': userAgent,
    'sec-ch-ua': secChUa,
    'sec-ch-ua-platform': secChUaPlatform,
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
