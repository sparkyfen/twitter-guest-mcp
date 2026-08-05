import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GuestSession } from './guest.js';
import { fetchTweet, parseTweetId, TweetFetchError } from './twitter.js';
import { fetchTweetImages } from './media.js';

type ToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'twitter-guest-mcp',
    version: '0.1.0'
  });

  const session = new GuestSession();

  server.registerTool(
    'get_tweet',
    {
      title: 'Get tweet',
      description:
        'Fetch a public tweet/X post by URL or ID using the anonymous guest-token flow (no API key or account). ' +
        'Returns text (including long-form), author, like/retweet/reply/quote/bookmark/view counts, media URLs, ' +
        'polls, and any quoted tweet — plus the images themselves unless disabled. ' +
        'Cannot access replies/threads, search, profiles/timelines, or NSFW-gated tweets (those need a logged-in account).',
      inputSchema: {
        tweet: z
          .string()
          .describe('Tweet URL (x.com, twitter.com, or mirror) or bare numeric tweet ID'),
        include_images: z
          .boolean()
          .optional()
          .describe('Fetch photos/video thumbnails as viewable images (default true)'),
        max_images: z
          .number()
          .int()
          .min(0)
          .max(8)
          .optional()
          .describe('Maximum images to fetch (default 4)')
      }
    },
    async ({ tweet, include_images, max_images }) => {
      const tweetId = parseTweetId(tweet);
      if (!tweetId) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Could not extract a tweet ID from "${tweet}". Pass a status URL like https://x.com/user/status/123... or a numeric ID.`
            }
          ]
        };
      }

      let lookup;
      try {
        lookup = await fetchTweet(tweetId, session);
      } catch (e) {
        const message =
          e instanceof TweetFetchError
            ? `${e.message}\n\nTwitter may be rate-limiting guest tokens or has changed its API surface. Retrying later sometimes helps; if this persists, the query constants may need re-syncing from FxEmbed.`
            : `Unexpected error: ${e instanceof Error ? e.message : String(e)}`;
        return { isError: true, content: [{ type: 'text' as const, text: message }] };
      }

      if (lookup.status === 'not_found') {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Tweet ${tweetId} was not found. It may have been deleted, or the ID is wrong.`
            }
          ]
        };
      }

      if (lookup.status === 'unavailable') {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: lookup.message }]
        };
      }

      const content: ToolContent[] = [
        { type: 'text', text: JSON.stringify(lookup.tweet, null, 2) }
      ];

      if (include_images !== false) {
        const images = await fetchTweetImages(lookup.tweet, max_images ?? 4);
        for (const image of images) {
          content.push({ type: 'image', data: image.data, mimeType: image.mimeType });
        }
      }

      return { content };
    }
  );

  return server;
}
