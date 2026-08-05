import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuestSession, buildGuestHeaders } from '../src/guest.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GuestSession', () => {
  it('dedupes concurrent activations onto one in-flight request', async () => {
    let activations = 0;
    let release!: (value: Response) => void;
    const gate = new Promise<Response>(resolve => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      activations++;
      return gate;
    });

    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    const first = session.getSession();
    const second = session.getSession();
    release(jsonResponse({ guest_token: 'sharedtoken1' }));

    const [a, b] = await Promise.all([first, second]);
    expect(a.token).toBe('sharedtoken1');
    expect(b.token).toBe('sharedtoken1');
    expect(a.identity).toEqual(b.identity);
    expect(activations).toBe(1);
  });

  it('aborts an activation that never responds once the timeout elapses', async () => {
    // Real timers only: AbortSignal.timeout does not run on vitest's fake timers.
    const hangingFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })
    );
    const session = new GuestSession(hangingFetch as unknown as typeof fetch, 5);
    await expect(session.getSession()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('passes an abort signal to the activation request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ guest_token: 'abc123' });
    });
    const session = new GuestSession(fetchMock as typeof fetch);
    await session.getSession();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on a non-ok activation response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(session.getSession()).rejects.toThrow('HTTP 503');
  });

  it('throws when activation returns no guest_token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(session.getSession()).rejects.toThrow('no guest_token');
  });

  it('rejects a malformed guest_token instead of caching it', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ guest_token: 'evil\r\nX-Injected: 1' })
    );
    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(session.getSession()).rejects.toThrow('malformed');
  });

  it('re-activates once the cached token expires', async () => {
    vi.useFakeTimers();
    let activations = 0;
    const fetchMock = vi.fn(async () => {
      activations++;
      return jsonResponse({ guest_token: `token${activations}` });
    });
    const session = new GuestSession(fetchMock as unknown as typeof fetch);

    expect((await session.getSession()).token).toBe('token1');
    expect((await session.getSession()).token).toBe('token1');
    vi.advanceTimersByTime(3601 * 1000);
    expect((await session.getSession()).token).toBe('token2');
    expect(activations).toBe(2);
  });

  it('only invalidates when the failing token is still the cached one', async () => {
    let activations = 0;
    const fetchMock = vi.fn(async () => {
      activations++;
      return jsonResponse({ guest_token: `token${activations}` });
    });
    const session = new GuestSession(fetchMock as unknown as typeof fetch);

    const stale = await session.getSession();
    session.invalidate(stale.token);
    const fresh = await session.getSession();
    expect(fresh.token).toBe('token2');

    // A caller reporting the stale token must not wipe the fresh one.
    session.invalidate(stale.token);
    expect((await session.getSession()).token).toBe('token2');
    expect(activations).toBe(2);
  });
});

/** Activates a throwaway session and hands back its token, identity, and ct0. */
async function activateSession(token = 'tok1') {
  const session = new GuestSession(
    (async () => jsonResponse({ guest_token: token })) as unknown as typeof fetch
  );
  return session.getSession();
}

describe('browser identity coherence', () => {
  it('reuses one identity and one ct0 across every header build for a session', async () => {
    const active = await activateSession('guesttoken99');
    const builds = Array.from({ length: 5 }, () => buildGuestHeaders(active));
    for (const headers of builds) {
      expect(headers['User-Agent']).toBe(builds[0]!['User-Agent']);
      expect(headers['sec-ch-ua']).toBe(builds[0]!['sec-ch-ua']);
      expect(headers['sec-ch-ua-platform']).toBe(builds[0]!['sec-ch-ua-platform']);
      // ct0 is a cookie the server sets once; a real browser echoes it back
      // unchanged, so it must not be re-rolled per request.
      expect(headers['x-csrf-token']).toBe(builds[0]!['x-csrf-token']);
      expect(headers['Cookie']).toBe(builds[0]!['Cookie']);
    }
  });

  it('sends the same User-Agent on the activation call and the requests that follow', async () => {
    let activationHeaders: Record<string, string> | undefined;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      activationHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ guest_token: 'sametoken' });
    });
    const session = new GuestSession(fetchMock as unknown as typeof fetch);

    const headers = buildGuestHeaders(await session.getSession());
    expect(headers['User-Agent']).toBe(activationHeaders!['User-Agent']);
    expect(headers['sec-ch-ua']).toBe(activationHeaders!['sec-ch-ua']);
    expect(headers['sec-ch-ua-platform']).toBe(activationHeaders!['sec-ch-ua-platform']);
  });

  it('mints a fresh identity and ct0 when the token rotates', async () => {
    let activations = 0;
    const fetchMock = vi.fn(async () => {
      activations++;
      return jsonResponse({ guest_token: `token${activations}` });
    });
    const session = new GuestSession(fetchMock as unknown as typeof fetch);

    const first = await session.getSession();
    expect(await session.getSession()).toEqual(first);

    session.invalidate(first.token);
    const second = await session.getSession();
    expect(second.token).not.toBe(first.token);

    // Randomized, so identities may coincide; what matters is that a rotation
    // re-rolls rather than carrying the old identity object across.
    expect(second.identity).not.toBe(first.identity);
    // ct0 is a 128-bit random hex string, so a collision here would be a bug.
    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect(buildGuestHeaders(second)['x-csrf-token']).not.toBe(
      buildGuestHeaders(first)['x-csrf-token']
    );
  });

  it('keeps each identity internally consistent: version, platform, and brand agree', async () => {
    for (let i = 0; i < 20; i++) {
      const headers = buildGuestHeaders(await activateSession());
      const ua = headers['User-Agent']!;
      const secChUa = headers['sec-ch-ua']!;
      const platform = headers['sec-ch-ua-platform']!;

      if (ua.includes('Windows')) expect(platform).toBe('"Windows"');
      else if (ua.includes('Mac OS X')) expect(platform).toBe('"macOS"');
      else expect(platform).toBe('"Linux"');

      const version = ua.match(/Chrome\/(\d+)\./)![1]!;
      expect(Number(version)).toBeGreaterThanOrEqual(149);
      expect(Number(version)).toBeLessThanOrEqual(151);
      expect(secChUa).toContain(`"Chromium";v="${version}"`);

      const brand = ua.includes('Edg/') ? 'Microsoft Edge' : 'Google Chrome';
      expect(secChUa).toContain(`"${brand}";v="${version}"`);
      if (brand === 'Microsoft Edge') expect(ua).toContain(`Edg/${version}.0.0.0`);
    }
  });
});

describe('buildGuestHeaders', () => {
  it('threads the guest token through headers and cookies with a matching csrf pair', async () => {
    const headers = buildGuestHeaders(await activateSession('guesttoken99'));
    expect(headers['x-guest-token']).toBe('guesttoken99');
    expect(headers['Cookie']).toContain('guest_id=v1%3Aguesttoken99');
    expect(headers['Cookie']).toContain('guest_id_ads=v1%3Aguesttoken99');
    expect(headers['Cookie']).toContain('guest_id_marketing=v1%3Aguesttoken99');
    const csrf = headers['x-csrf-token']!;
    expect(csrf).toMatch(/^[0-9a-f]{32}$/);
    expect(headers['Cookie']).toContain(`ct0=${csrf}`);
  });

});
