import { describe, expect, it } from 'vitest';
import { classifyResponse } from '../src/normalize.js';
import photoQuote from './fixtures/photo-quote-tweet.json';
import videoTweet from './fixtures/video-tweet.json';
import notePoll from './fixtures/note-poll-tweet.json';
import noteMedia from './fixtures/note-media-tweet.json';
import tombstones from './fixtures/tombstones.json';

describe('classifyResponse', () => {
  it('normalizes a photo tweet with a quoted tweet', () => {
    const lookup = classifyResponse(photoQuote);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.id).toBe('1700000000000000001');
    expect(tweet.url).toBe('https://x.com/example/status/1700000000000000001');
    expect(tweet.text).toBe(
      'Check out this photo of the launch! https://example.com/launch'
    );
    expect(tweet.createdAt).toBe('2025-07-21T15:04:05.000Z');
    expect(tweet.author).toMatchObject({
      name: 'Example Person',
      screenName: 'example',
      followers: 54321,
      verified: true
    });
    expect(tweet.metrics).toEqual({
      likes: 1500,
      retweets: 320,
      replies: 45,
      quotes: 12,
      bookmarks: 89,
      views: 123456
    });
    expect(tweet.media).toEqual([
      {
        type: 'photo',
        url: 'https://pbs.twimg.com/media/ABCDEF.jpg',
        width: 4096,
        height: 2730,
        altText: 'A rocket on the launch pad'
      }
    ]);

    expect(tweet.quotedTweet).toBeDefined();
    expect(tweet.quotedTweet?.text).toBe('Original announcement here.');
    // Quoted author uses the old legacy user shape.
    expect(tweet.quotedTweet?.author).toMatchObject({
      name: 'Legacy Shape User',
      screenName: 'legacyuser',
      avatarUrl: 'https://pbs.twimg.com/profile_images/456/old_normal.jpg'
    });
    // Quote nesting stops at depth 1.
    expect(tweet.quotedTweet?.quotedTweet).toBeUndefined();
  });

  it('unwraps TweetWithVisibilityResults and picks the best mp4 variant', () => {
    const lookup = classifyResponse(videoTweet);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.id).toBe('1700000000000000003');
    expect(tweet.media).toHaveLength(1);
    expect(tweet.media[0]).toMatchObject({
      type: 'video',
      url: 'https://pbs.twimg.com/ext_tw_video_thumb/111/pu/img/thumb.jpg',
      videoUrl: 'https://video.twimg.com/ext_tw_video/111/pu/vid/avc1/1280x720/high.mp4',
      durationMs: 30500
    });
  });

  it('prefers note-tweet long text and parses polls', () => {
    const lookup = classifyResponse(notePoll);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    const tweet = lookup.tweet;

    expect(tweet.text).toContain('https://example.org/full-article');
    expect(tweet.text).not.toContain('t.co');
    expect(tweet.text).not.toContain('…');
    expect(tweet.poll).toEqual({
      choices: [
        { label: 'Yes', votes: 70 },
        { label: 'No', votes: 30 }
      ],
      totalVotes: 100,
      endsAt: '2025-07-25T00:00:00Z'
    });
    // A poll card must not also be reported as a link card.
    expect(tweet.card).toBeUndefined();
  });

  it('classifies not-found and unavailable tombstones', () => {
    expect(classifyResponse(tombstones.notFound)).toEqual({ status: 'not_found' });
    expect(classifyResponse(null)).toEqual({ status: 'not_found' });

    const nsfw = classifyResponse(tombstones.nsfw);
    expect(nsfw).toMatchObject({ status: 'unavailable', reason: 'nsfw' });

    const isProtected = classifyResponse(tombstones.protected);
    expect(isProtected).toMatchObject({ status: 'unavailable', reason: 'protected' });

    const suspended = classifyResponse(tombstones.suspended);
    expect(suspended).toMatchObject({ status: 'unavailable', reason: 'suspended' });
  });

  it('falls back to an unknown reason for unrecognized TweetUnavailable reasons', () => {
    const unknown = classifyResponse(tombstones.unknownReason);
    expect(unknown).toMatchObject({ status: 'unavailable', reason: 'unknown' });
    if (unknown.status !== 'unavailable') return;
    expect(unknown.message).toContain('SomethingNew');
  });

  it('classifies top-level TweetTombstone as unavailable, not found', () => {
    const nsfw = classifyResponse(tombstones.tombstoneNsfw);
    expect(nsfw).toMatchObject({ status: 'unavailable', reason: 'nsfw' });
    if (nsfw.status !== 'unavailable') return;
    expect(nsfw.message).toContain('Age-restricted');

    const suspended = classifyResponse(tombstones.tombstoneSuspended);
    expect(suspended).toMatchObject({ status: 'unavailable', reason: 'suspended' });

    const generic = classifyResponse(tombstones.tombstoneGeneric);
    expect(generic).toMatchObject({ status: 'unavailable', reason: 'unknown' });
    if (generic.status !== 'unavailable') return;
    expect(generic.message).toContain('violated the X Rules');
  });

  it('strips the trailing media t.co link from note tweets', () => {
    const lookup = classifyResponse(noteMedia);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.text).toBe(
      'A very long note tweet body with a link https://example.org/article and an attached photo.'
    );
    expect(lookup.tweet.media).toHaveLength(1);
    expect(lookup.tweet.media[0]).toMatchObject({
      type: 'photo',
      url: 'https://pbs.twimg.com/media/NOTEPIC.jpg'
    });
  });

  it('renders an unavailable placeholder for a tombstoned quoted tweet', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '42',
            legacy: { full_text: 'quoting something gone' },
            quoted_status_result: {
              result: { __typename: 'TweetTombstone' }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.quotedTweet?.note).toContain('unavailable');
  });

  it('normalizes a link/summary card', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '43',
            legacy: { full_text: 'look at this article' },
            card: {
              legacy: {
                name: 'summary_large_image',
                binding_values: [
                  { key: 'title', value: { string_value: 'An Article' } },
                  { key: 'description', value: { string_value: 'About things' } },
                  { key: 'card_url', value: { string_value: 'https://example.com/a' } }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.card).toEqual({
      title: 'An Article',
      description: 'About things',
      url: 'https://example.com/a'
    });
    expect(lookup.tweet.poll).toBeUndefined();
  });

  it('normalizes animated_gif media as a gif with a video URL', () => {
    const payload = {
      data: {
        tweetResult: {
          result: {
            __typename: 'Tweet',
            rest_id: '44',
            legacy: {
              full_text: 'gif time https://t.co/gif',
              extended_entities: {
                media: [
                  {
                    type: 'animated_gif',
                    url: 'https://t.co/gif',
                    media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/GIF.jpg',
                    video_info: {
                      variants: [
                        {
                          content_type: 'video/mp4',
                          url: 'https://video.twimg.com/tweet_video/GIF.mp4'
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      }
    };
    const lookup = classifyResponse(payload);
    expect(lookup.status).toBe('found');
    if (lookup.status !== 'found') return;
    expect(lookup.tweet.media[0]).toMatchObject({
      type: 'gif',
      url: 'https://pbs.twimg.com/tweet_video_thumb/GIF.jpg',
      videoUrl: 'https://video.twimg.com/tweet_video/GIF.mp4'
    });
    expect(lookup.tweet.text).toBe('gif time');
  });
});
