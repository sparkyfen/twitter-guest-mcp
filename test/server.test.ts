import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import photoQuote from './fixtures/photo-quote-tweet.json';
import tombstones from './fixtures/tombstones.json';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function imageResponse() {
  return new Response(new Uint8Array(64).fill(1), {
    status: 200,
    headers: { 'content-type': 'image/jpeg' }
  });
}

/** Routes activation, GraphQL, and image fetches; anything else 404s. */
function makeFetchMock(graphqlBody: unknown) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/1.1/guest/activate.json')) {
      return jsonResponse({ guest_token: 'testtoken1' });
    }
    if (url.includes('/graphql/')) return jsonResponse(graphqlBody);
    if (url.includes('twimg.com')) return imageResponse();
    return new Response('not found', { status: 404 });
  });
}

// Stub fetch BEFORE createServer() so GuestSession and fetchTweetImages use the mock.
async function connect(fetchMock: ReturnType<typeof makeFetchMock>) {
  vi.stubGlobal('fetch', fetchMock);
  const server = createServer();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport)
  ]);
  return client;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('get_tweet tool', () => {
  it('rejects unparseable input without any network call', async () => {
    const fetchMock = makeFetchMock(photoQuote);
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: 'get_tweet',
      arguments: { tweet: 'not a tweet at all' }
    });
    const content = result.content as ContentBlock[];

    expect(result.isError).toBe(true);
    expect(content[0]).toMatchObject({ type: 'text' });
    expect((content[0] as { text: string }).text).toContain('Could not extract a tweet ID');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports not_found as an error naming the tweet ID', async () => {
    const client = await connect(makeFetchMock(tombstones.notFound));

    const result = await client.callTool({
      name: 'get_tweet',
      arguments: { tweet: 'https://x.com/user/status/123456789' }
    });
    const content = result.content as ContentBlock[];

    expect(result.isError).toBe(true);
    expect((content[0] as { text: string }).text).toContain('123456789');
  });

  it('surfaces the unavailable message for NSFW-gated tweets', async () => {
    const client = await connect(makeFetchMock(tombstones.nsfw));

    const result = await client.callTool({
      name: 'get_tweet',
      arguments: { tweet: '123456789' }
    });
    const content = result.content as ContentBlock[];

    expect(result.isError).toBe(true);
    expect((content[0] as { text: string }).text).toContain('age-restricted');
  });

  it('returns the untrusted-content notice, normalized JSON, and images by default', async () => {
    const fetchMock = makeFetchMock(photoQuote);
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: 'get_tweet',
      arguments: { tweet: 'https://x.com/example/status/1700000000000000001' }
    });
    const content = result.content as ContentBlock[];

    expect(result.isError).toBeFalsy();
    expect(content[0]!.type).toBe('text');
    expect((content[0] as { text: string }).text).toContain('UNTRUSTED');
    expect(content[1]!.type).toBe('text');
    const tweet = JSON.parse((content[1] as { text: string }).text);
    expect(tweet.id).toBe('1700000000000000001');
    const images = content.filter(c => c.type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect((images[0] as { mimeType: string }).mimeType).toBe('image/jpeg');
  });

  it('skips image fetching entirely when max_images is 0', async () => {
    const fetchMock = makeFetchMock(photoQuote);
    const client = await connect(fetchMock);

    const result = await client.callTool({
      name: 'get_tweet',
      arguments: { tweet: '1700000000000000001', max_images: 0 }
    });
    const content = result.content as ContentBlock[];

    expect(result.isError).toBeFalsy();
    expect(content.every(c => c.type === 'text')).toBe(true);
    const imageFetches = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('twimg.com')
    );
    expect(imageFetches).toHaveLength(0);
  });
});
