# twitter-guest-mcp

MCP server that reads public tweets from Twitter/X using the **guest token flow** — the same anonymous access path Twitter's own web client uses before login, as implemented by [FxEmbed](https://github.com/FxEmbed/FxEmbed). No API key, no account, no cost.

## What it can (and can't) do

X only allows one GraphQL operation for guests: single-tweet lookup (`TweetResultByRestId`). That still covers a lot:

| Capability | Status |
| --- | --- |
| Tweet text, incl. long-form note tweets | ✅ |
| Photos / video / GIF URLs (+ fetched images Claude can see) | ✅ |
| Like / retweet / reply / quote / bookmark / view counts | ✅ |
| Author name, handle, avatar, follower count | ✅ |
| The quoted tweet embedded in a post | ✅ |
| Polls and link cards | ✅ |
| Replies / thread reconstruction | ❌ needs a logged-in account |
| Search, profiles, timelines, list of quote-tweets | ❌ needs a logged-in account |
| NSFW-gated tweets | ❌ X blocks these for guests |

## Setup

```sh
npm install
npm run build
```

Register with Claude Code (project or user scope):

```json
{
  "mcpServers": {
    "twitter": {
      "command": "node",
      "args": ["/path/to/twitter-guest-mcp/dist/index.js"]
    }
  }
}
```

Or: `claude mcp add twitter -- node /path/to/twitter-guest-mcp/dist/index.js`

## Tool

### `get_tweet`

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `tweet` | string | — | Tweet URL (x.com / twitter.com / mirrors) or bare numeric ID |
| `max_images` | number | `4` | Photos & video thumbnails to return as viewable images (0–6, `0` disables) |

Returns a JSON block (text, author, metrics, media URLs incl. best-bitrate MP4 for video, poll results, quoted tweet) followed by image content blocks.

## How the guest flow works

1. `POST /1.1/guest/activate.json` with the public web bearer token → `guest_token`
2. Token is cached in memory up to 1 h; dropped early when `x-rate-limit-remaining < 10` or on 401/403/429
3. GraphQL `GET /graphql/<queryId>/TweetResultByRestId` with the token, a random browser UA, and a synthesized `ct0` CSRF cookie
4. Up to 3 attempts, fresh token per retry, with a short exponential backoff between attempts

## Maintenance

The `queryId` / `features` / `fieldToggles` in `src/constants.ts` are X's moving target. When requests start failing, re-sync them from FxEmbed's [`queries.ts`](https://github.com/FxEmbed/FxEmbed/blob/main/packages/atmosphere/src/providers/twitter/graphql/queries.ts) and [`features.ts`](https://github.com/FxEmbed/FxEmbed/blob/main/packages/atmosphere/src/providers/twitter/graphql/features.ts).

## Tests

```sh
npm test           # hermetic: fixtures + mocked fetch
npm run test:live  # opt-in smoke test against the real API
```

## License

MIT. Guest-flow approach and GraphQL constants derived from [FxEmbed](https://github.com/FxEmbed/FxEmbed) (MIT).
