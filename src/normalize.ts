/**
 * Normalizes the raw TweetResultByRestId GraphQL payload into a compact,
 * stable shape for the MCP tool result. The raw payload's shape is X's and
 * shifts over time, so everything here is defensive.
 */

type Raw = Record<string, any>;

export interface NormalizedMedia {
  type: 'photo' | 'video' | 'gif';
  url: string;
  width?: number;
  height?: number;
  altText?: string;
  /** For video/gif: best-bitrate MP4. */
  videoUrl?: string;
  durationMs?: number;
}

export interface NormalizedAuthor {
  name: string;
  screenName: string;
  avatarUrl?: string;
  followers?: number;
  verified?: boolean;
  description?: string;
}

export interface NormalizedPollChoice {
  label: string;
  votes: number;
}

export interface NormalizedTweet {
  id: string;
  url: string;
  text: string;
  createdAt?: string;
  lang?: string;
  author?: NormalizedAuthor;
  metrics: {
    likes?: number;
    retweets?: number;
    replies?: number;
    quotes?: number;
    bookmarks?: number;
    views?: number;
  };
  media: NormalizedMedia[];
  poll?: { choices: NormalizedPollChoice[]; totalVotes: number; endsAt?: string };
  card?: { title?: string; description?: string; url?: string };
  quotedTweet?: NormalizedTweet;
  /** Present when this is a retweet: the account that retweeted the original. */
  retweetedBy?: NormalizedAuthor;
  /** Present when the tweet exists but content is withheld (nsfw/protected/etc). */
  note?: string;
}

export type TweetLookup =
  | { status: 'found'; tweet: NormalizedTweet }
  | { status: 'not_found' }
  | {
      status: 'unavailable';
      reason: 'nsfw' | 'protected' | 'suspended' | 'unknown';
      message: string;
    };

/** Unwraps TweetWithVisibilityResults and similar containers. */
function unwrapTweetResult(result: Raw | undefined): Raw | undefined {
  if (!result) return undefined;
  if (result.__typename === 'TweetWithVisibilityResults' && result.tweet) {
    return result.tweet as Raw;
  }
  return result;
}

/**
 * True when an (already unwrapped) tweet result cannot be normalized: an
 * explicit tombstone typename, or the empty-object form X returns for a gone
 * tweet, which carries neither a rest_id nor a legacy block.
 */
function isUnavailableResult(raw: Raw): boolean {
  if (raw.__typename === 'TweetTombstone' || raw.__typename === 'TweetUnavailable') {
    return true;
  }
  return !raw.rest_id && !raw.legacy;
}

function unwrapUserResult(result: Raw | undefined): Raw | undefined {
  if (!result) return undefined;
  if (result.__typename === 'UserWithVisibilityResults' && result.user) {
    return result.user as Raw;
  }
  return result;
}

function normalizeAuthor(userResult: Raw | undefined): NormalizedAuthor | undefined {
  const user = unwrapUserResult(userResult);
  if (!user) return undefined;
  const legacy: Raw = user.legacy ?? {};
  // Newer payloads move name/screen_name into `core` and the avatar into `avatar`.
  const core: Raw = user.core ?? {};
  const name = core.name ?? legacy.name;
  const screenName = core.screen_name ?? legacy.screen_name;
  if (!screenName && !name) return undefined;
  const avatarUrl =
    user.avatar?.image_url ?? legacy.profile_image_url_https ?? undefined;
  return {
    name: name ?? screenName,
    screenName: screenName ?? '',
    avatarUrl,
    followers: legacy.followers_count,
    verified: user.is_blue_verified ?? legacy.verified ?? undefined,
    description: legacy.description || undefined
  };
}

function bestVideoVariant(videoInfo: Raw | undefined): string | undefined {
  const variants: Raw[] = videoInfo?.variants ?? [];
  const mp4s = variants.filter(v => v.content_type === 'video/mp4' && v.url);
  if (mp4s.length === 0) return variants.find(v => v.url)?.url;
  return mp4s.reduce((best, v) => ((v.bitrate ?? 0) > (best.bitrate ?? 0) ? v : best)).url;
}

function normalizeMedia(mediaList: Raw[] | undefined): NormalizedMedia[] {
  if (!Array.isArray(mediaList)) return [];
  return mediaList.flatMap((m): NormalizedMedia[] => {
    const base = {
      url: m.media_url_https ?? m.media_url,
      width: m.original_info?.width ?? m.sizes?.large?.w,
      height: m.original_info?.height ?? m.sizes?.large?.h,
      altText: m.ext_alt_text || undefined
    };
    if (!base.url) return [];
    if (m.type === 'photo') return [{ type: 'photo', ...base }];
    if (m.type === 'video' || m.type === 'animated_gif') {
      return [
        {
          type: m.type === 'video' ? 'video' : 'gif',
          ...base,
          videoUrl: bestVideoVariant(m.video_info),
          durationMs: m.video_info?.duration_millis
        }
      ];
    }
    return [];
  });
}

// Null-prototype: a plain object literal would resolve `&constructor;` and
// friends through Object.prototype and rewrite them into tweet text.
const NAMED_ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
});

/** X escapes `&`, `<` and `>` in full_text; undo that so callers get real text. */
function unescapeHtml(text: string): string {
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, ref: string) => {
    if (ref.startsWith('#')) {
      const code =
        ref[1] === 'x' || ref[1] === 'X'
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      if (isNaN(code) || code < 0 || code > 0x10ffff) return match;
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? match;
  });
}

/**
 * Unescape HTML entities, then expand t.co links to their real URLs and drop
 * trailing media t.co links (each attached media item repeats as a t.co URL at
 * the end of full_text).
 */
function cleanText(
  text: string,
  urls: Raw[] | undefined,
  media: Raw[] | undefined
): string {
  // Unescaping first: expanded_url values are substituted in afterwards, so
  // they keep exactly the form X resolved rather than being unescaped too.
  const source = unescapeHtml(text);
  const replacements: { from: string; to: string }[] = [
    ...(urls ?? [])
      .filter(u => u.url && u.expanded_url)
      .map(u => ({ from: String(u.url), to: String(u.expanded_url) })),
    ...(media ?? []).filter(m => m.url).map(m => ({ from: String(m.url), to: '' }))
  ];
  // Longest first: a shorter t.co slug can be a strict prefix of a longer one,
  // and replacing it first would corrupt the longer URL.
  replacements.sort((a, b) => b.from.length - a.from.length);
  // Single non-overlapping pass, emitting into a separate buffer: sequential
  // whole-string replacement would let an inserted expanded_url that happens to
  // contain another t.co slug be rewritten by a later entity.
  let out = '';
  for (let i = 0; i < source.length; ) {
    const match = replacements.find(r => r.from && source.startsWith(r.from, i));
    if (match) {
      out += match.to;
      i += match.from.length;
    } else {
      out += source[i];
      i++;
    }
  }
  return out.trim();
}

/** parseInt that yields undefined rather than NaN (which serializes to null). */
function toCount(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = parseInt(String(value), 10);
  return isNaN(parsed) ? undefined : parsed;
}

/** Flattens a card's binding_values array into a keyed map of string values. */
function bindingValues(card: Raw | undefined): Record<string, string> {
  const values: Raw[] = card?.legacy?.binding_values ?? [];
  const byKey: Record<string, string> = {};
  for (const v of values) {
    if (typeof v.value?.string_value === 'string') byKey[v.key] = v.value.string_value;
  }
  return byKey;
}

function normalizePoll(card: Raw | undefined): NormalizedTweet['poll'] {
  const cardName: string | undefined = card?.legacy?.name;
  if (!cardName || !cardName.includes('poll')) return undefined;
  const byKey = bindingValues(card);
  const choices: NormalizedPollChoice[] = [];
  for (let i = 1; i <= 4; i++) {
    const label = byKey[`choice${i}_label`];
    if (label === undefined) continue;
    choices.push({ label, votes: toCount(byKey[`choice${i}_count`]) ?? 0 });
  }
  if (choices.length === 0) return undefined;
  return {
    choices,
    totalVotes: choices.reduce((sum, c) => sum + c.votes, 0),
    endsAt: byKey['end_datetime_utc']
  };
}

function normalizeCard(card: Raw | undefined): NormalizedTweet['card'] {
  const cardName: string | undefined = card?.legacy?.name;
  if (!cardName || cardName.includes('poll')) return undefined;
  const byKey = bindingValues(card);
  const out = {
    title: byKey['title'],
    description: byKey['description'],
    url: byKey['card_url']
  };
  if (!out.title && !out.description && !out.url) return undefined;
  return out;
}

function toIsoDate(twitterDate: string | undefined): string | undefined {
  if (!twitterDate) return undefined;
  const parsed = new Date(twitterDate);
  return isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function normalizeTweet(rawResult: Raw, includeQuoted = true): NormalizedTweet {
  const result = unwrapTweetResult(rawResult) ?? {};
  const legacy: Raw = result.legacy ?? {};

  // On a retweet, legacy.full_text is a truncated "RT @orig: …" wrapper and the
  // real text/media/counts live on the retweeted status. No-op when absent.
  const retweeted = unwrapTweetResult(legacy.retweeted_status_result?.result);
  const retweetedGone = retweeted !== undefined && isUnavailableResult(retweeted);
  if (retweeted && !retweetedGone) {
    const original = normalizeTweet(retweeted, includeQuoted);
    const retweeter = normalizeAuthor(result.core?.user_results?.result);
    return retweeter ? { ...original, retweetedBy: retweeter } : original;
  }

  const id: string = result.rest_id ?? legacy.id_str ?? '';
  const author = normalizeAuthor(result.core?.user_results?.result);

  const noteText: string | undefined =
    result.note_tweet?.note_tweet_results?.result?.text;
  const noteEntities: Raw | undefined =
    result.note_tweet?.note_tweet_results?.result?.entity_set;
  const attachedMedia: Raw[] | undefined =
    legacy.extended_entities?.media ?? legacy.entities?.media;
  const text = noteText
    ? cleanText(noteText, noteEntities?.urls, attachedMedia)
    : cleanText(legacy.full_text ?? '', legacy.entities?.urls, attachedMedia);

  const views = toCount(result.views?.count);

  const tweet: NormalizedTweet = {
    id,
    url: `https://x.com/${author?.screenName || 'i'}/status/${id}`,
    text,
    createdAt: toIsoDate(legacy.created_at),
    lang: legacy.lang,
    author,
    metrics: {
      likes: toCount(legacy.favorite_count),
      retweets: toCount(legacy.retweet_count),
      replies: toCount(legacy.reply_count),
      quotes: toCount(legacy.quote_count),
      bookmarks: toCount(legacy.bookmark_count),
      views
    },
    media: normalizeMedia(attachedMedia),
    poll: normalizePoll(result.card),
    card: normalizeCard(result.card)
  };

  if (retweetedGone) {
    tweet.note = "Retweeted original is unavailable; text is X's truncated RT wrapper.";
  }

  if (includeQuoted && result.quoted_status_result?.result) {
    // Unwrap before classifying: a tombstone can arrive inside a
    // TweetWithVisibilityResults container.
    const quotedRaw = unwrapTweetResult(result.quoted_status_result.result) ?? {};
    if (isUnavailableResult(quotedRaw)) {
      tweet.quotedTweet = {
        id: '',
        url: '',
        text: '',
        metrics: {},
        media: [],
        note: 'Quoted tweet is unavailable (deleted, protected, or withheld).'
      };
    } else {
      tweet.quotedTweet = normalizeTweet(quotedRaw, false);
    }
  }

  return tweet;
}

/** Classifies the top-level TweetResultByRestId response. */
export function classifyResponse(response: Raw | null | undefined): TweetLookup {
  // Unwrap before classifying: a tombstone, an unavailable result or an empty
  // result can each arrive inside a TweetWithVisibilityResults container.
  const result: Raw | undefined = unwrapTweetResult(response?.data?.tweetResult?.result);

  if (!result) {
    return { status: 'not_found' };
  }

  if (result.__typename === 'TweetTombstone') {
    const tombstoneText: string =
      result.tombstone?.text?.text ?? 'Tweet is unavailable.';
    // Specific reasons win: "from a suspended account that no longer exists"
    // is a suspension, not a wrong ID.
    let reason: 'nsfw' | 'protected' | 'suspended' | undefined;
    if (/age-restricted|adult content|sensitive content/i.test(tombstoneText)) {
      reason = 'nsfw';
    } else if (/limits who can view|protected/i.test(tombstoneText)) reason = 'protected';
    else if (/suspended/i.test(tombstoneText)) reason = 'suspended';
    // A deleted author's posts are gone rather than withheld.
    if (!reason && /no longer exists/i.test(tombstoneText)) return { status: 'not_found' };
    return { status: 'unavailable', reason: reason ?? 'unknown', message: tombstoneText };
  }

  if (result.__typename === 'TweetUnavailable') {
    switch (result.reason) {
      case 'NsfwLoggedOut':
        return {
          status: 'unavailable',
          reason: 'nsfw',
          message:
            'This tweet is age-restricted/NSFW-gated and requires a logged-in account, which this guest-only server does not use.'
        };
      case 'Protected':
        return {
          status: 'unavailable',
          reason: 'protected',
          message:
            'This account is protected; its tweets are only visible to approved followers.'
        };
      case 'Suspended':
        return {
          status: 'unavailable',
          reason: 'suspended',
          message: 'The author of this tweet is suspended.'
        };
      default:
        return {
          status: 'unavailable',
          reason: 'unknown',
          message: `Tweet is unavailable (reason: ${result.reason ?? 'unspecified'}).`
        };
    }
  }

  // No usable tweet (empty-object form, or a container with nothing inside).
  if (isUnavailableResult(result)) return { status: 'not_found' };

  return { status: 'found', tweet: normalizeTweet(result) };
}
