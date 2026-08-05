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
    const first = session.getToken();
    const second = session.getToken();
    release(jsonResponse({ guest_token: 'sharedtoken1' }));

    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('sharedtoken1');
    expect(b).toBe('sharedtoken1');
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
    await expect(session.getToken()).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it('passes an abort signal to the activation request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ guest_token: 'abc123' });
    });
    const session = new GuestSession(fetchMock as typeof fetch);
    await session.getToken();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws on a non-ok activation response', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 503));
    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(session.getToken()).rejects.toThrow('HTTP 503');
  });

  it('throws when activation returns no guest_token', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(session.getToken()).rejects.toThrow('no guest_token');
  });

  it('rejects a malformed guest_token instead of caching it', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ guest_token: 'evil\r\nX-Injected: 1' })
    );
    const session = new GuestSession(fetchMock as unknown as typeof fetch);
    await expect(session.getToken()).rejects.toThrow('malformed');
  });

  it('re-activates once the cached token expires', async () => {
    vi.useFakeTimers();
    let activations = 0;
    const fetchMock = vi.fn(async () => {
      activations++;
      return jsonResponse({ guest_token: `token${activations}` });
    });
    const session = new GuestSession(fetchMock as unknown as typeof fetch);

    expect(await session.getToken()).toBe('token1');
    expect(await session.getToken()).toBe('token1');
    vi.advanceTimersByTime(3601 * 1000);
    expect(await session.getToken()).toBe('token2');
    expect(activations).toBe(2);
  });

  it('only invalidates when the failing token is still the cached one', async () => {
    let activations = 0;
    const fetchMock = vi.fn(async () => {
      activations++;
      return jsonResponse({ guest_token: `token${activations}` });
    });
    const session = new GuestSession(fetchMock as unknown as typeof fetch);

    const stale = await session.getToken();
    session.invalidate(stale);
    const fresh = await session.getToken();
    expect(fresh).toBe('token2');

    // A caller reporting the stale token must not wipe the fresh one.
    session.invalidate(stale);
    expect(await session.getToken()).toBe('token2');
    expect(activations).toBe(2);
  });
});

describe('buildGuestHeaders', () => {
  it('threads the guest token through headers and cookies with a matching csrf pair', () => {
    const headers = buildGuestHeaders('guesttoken99');
    expect(headers['x-guest-token']).toBe('guesttoken99');
    expect(headers['Cookie']).toContain('guest_id=v1%3Aguesttoken99');
    expect(headers['Cookie']).toContain('guest_id_ads=v1%3Aguesttoken99');
    expect(headers['Cookie']).toContain('guest_id_marketing=v1%3Aguesttoken99');
    const csrf = headers['x-csrf-token']!;
    expect(csrf).toMatch(/^[0-9a-f]{32}$/);
    expect(headers['Cookie']).toContain(`ct0=${csrf}`);
  });

  it('sends a sec-ch-ua-platform matching the User-Agent platform', () => {
    for (let i = 0; i < 20; i++) {
      const headers = buildGuestHeaders('tok1');
      const ua = headers['User-Agent']!;
      const platform = headers['sec-ch-ua-platform']!;
      if (ua.includes('Windows')) expect(platform).toBe('"Windows"');
      else if (ua.includes('Mac OS X')) expect(platform).toBe('"macOS"');
      else expect(platform).toBe('"Linux"');
    }
  });
});
