# twitter-guest-mcp

MCP server that reads public tweets from Twitter/X using the **guest token flow** — the same anonymous access path Twitter's own web client uses before you log in, as implemented by [FxEmbed](https://github.com/FxEmbed/FxEmbed). No API key, no account, no cost.

## What it can (and can't) do

X allows guests exactly one GraphQL operation: single-tweet lookup (`TweetResultByRestId`). That still covers a lot:

| Capability | Status |
| --- | --- |
| Tweet text, incl. long-form note tweets | ✅ |
| Photos / video / GIF URLs, plus the images themselves so Claude can see them | ✅ |
| Like / retweet / reply / quote / bookmark / view counts | ✅ |
| Author name, handle, avatar, follower count | ✅ |
| The quoted tweet embedded in a post | ✅ |
| Retweets — resolved to the original, with the retweeter in `retweetedBy` | ✅ |
| Polls and link cards | ✅ |
| Replies / thread reconstruction | ❌ needs a logged-in account |
| Search, profiles, timelines, who quoted a post | ❌ needs a logged-in account |
| NSFW-gated tweets | ❌ X blocks these for guests |

## Install

Requires **Node 18.17+** (Node 22.15+ additionally enables zstd responses). No API key or account setup — there's nothing to sign up for.

```sh
git clone https://github.com/sparkyfen/twitter-guest-mcp.git
cd twitter-guest-mcp
npm ci
npm run build
```

Then register it with Claude Code, using the **absolute path** to `dist/index.js`:

```sh
claude mcp add twitter -- node "$(pwd)/dist/index.js"
```

That registers it for every project. To scope it to just the current repo instead, add `-s project`.

Prefer editing config by hand? The equivalent entry:

```json
{
  "mcpServers": {
    "twitter": {
      "command": "node",
      "args": ["/absolute/path/to/twitter-guest-mcp/dist/index.js"]
    }
  }
}
```

Verify it connected with `claude mcp list` — you should see `twitter ... ✔ Connected`. Then just ask for a tweet by URL.

## Tool

### `get_tweet`

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `tweet` | string | — | Tweet URL (x.com / twitter.com / mirrors) or bare numeric ID |
| `max_images` | number | `4` | Photos & video thumbnails to return as viewable images (0–6, `0` disables) |

Returns a text block flagging the payload as untrusted third-party content, then a JSON block (text, author, metrics, media URLs including the best-bitrate MP4 for video, poll results, quoted tweet), then the images themselves. Images are capped individually and in total; anything withheld for size is reported rather than silently dropped.

Tweets that exist but can't be read as a guest — NSFW-gated, protected, suspended, tombstoned — come back as an error explaining *which*, rather than as a blank tweet.

## How the guest flow works

1. `POST /1.1/guest/activate.json` with the public web bearer token → `guest_token`
2. The token is cached in memory for up to an hour, and dropped early when `x-rate-limit-remaining` runs low or on a 401/403/429
3. `GET /graphql/<queryId>/TweetResultByRestId` carries that token plus a browser identity — User-Agent, client hints, and `ct0` CSRF cookie — minted **once per token** and reused for its whole life, so a single session doesn't present as three different browsers
4. Up to 3 attempts, a fresh token per retry, with a short exponential backoff

The budget is 500 requests per 15-minute window per token, which occasional use won't come near.

## Maintenance

Two constants rot on X's schedule, not ours:

- **`queryId` / `features` / `fieldToggles`** in `src/constants.ts`. When requests start failing, re-sync from FxEmbed's [`queries.ts`](https://github.com/FxEmbed/FxEmbed/blob/main/packages/atmosphere/src/providers/twitter/graphql/queries.ts) and [`features.ts`](https://github.com/FxEmbed/FxEmbed/blob/main/packages/atmosphere/src/providers/twitter/graphql/features.ts). The error message says so when it happens.
- **`CHROME_VERSION`** in `src/guest.ts`. A years-stale Chrome version is its own fingerprinting tell; bump it against [chromiumdash](https://chromiumdash.appspot.com/releases?platform=Windows) now and then.

Header-level realism only: undici speaks HTTP/1.1 while real x.com traffic is HTTP/2, so TLS and HTTP/2 fingerprints still read as a Node client no matter what the headers say.

## Tests

```sh
npm test           # hermetic: fixtures + mocked fetch, no network
npm run test:live  # opt-in smoke test against the real API
```

## Terms

Automated access outside X's paid API is against their developer terms, whatever the volume. This is read-only public data at a handful of requests, but it's a real term — use it knowingly.

## License

MIT — see [LICENSE](LICENSE), which also carries FxEmbed's copyright notice for the guest-flow approach and GraphQL constants derived from it.
